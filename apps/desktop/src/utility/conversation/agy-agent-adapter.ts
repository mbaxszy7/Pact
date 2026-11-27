import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  agentPromptImageGroups,
  type AgentAdapter,
  type AgentCollaborationSourceReader,
  type AgentNativeCheckContext,
  type AgentNativeCheckOperation,
  type AgentNativeContextRebuildInput,
  type AgentNativeContextRebuildResult,
  type AgentNativeForkBoundary,
  type AgentNativeForkInput,
  type AgentNativeForkInspection,
  type AgentNativeForkResult,
  type AgentNativeForkSourceInput,
  type AgentNativeForkWitness,
  type AgentNativeInitializedBindingProbeInput,
  type AgentNativeInputProbeInput,
  type AgentNativeProbeInput,
  type AgentProbeResult,
  type AgentPromptImage,
  type AgentRunInput,
  type AgentShutdownSettlement,
  type AgentSourceReadForm,
  type AgentSteerInput,
  type AgentSteerResult,
} from '@pact/agent-runtime'
import {
  COLLABORATION_PUBLISHED_PLAN_MAX_BYTES,
  buildBoundedNativePlanId,
  collaborationAskMode,
  collaborationPlanMode,
  NATIVE_PERMISSION_REQUESTS,
  nativeBackgroundReportIdentitySchema,
  RUNTIME_MINIMUM_VERSIONS,
  sessionTitleInputSchema,
  type CollaborationInputObservation,
  type CollaborationReviewObservation,
  type NativeContextRebuildChunk,
  type NativeEvidenceIdentity,
  type NativeInitializationWitness,
  type NativeProbeResult,
  type NativeUserInputRequest,
  type NormalizedAgentEvent,
  type RunEffectiveExecutionSettings,
  type SessionPermissionMode,
  type SkillBinding,
} from '@pact/contracts'

import type { AgyTrajectoryIdentityClientResult } from './native-fork-files'

import { recordDiagnostic } from '../../diagnostics/utility-log'
import { OwnedProcessGroup } from '../owned-process-group'
import { AgentActivityDetail } from './agent-activity-detail'
import { AgentAnswerAssembler } from './agent-answer-assembler'
import {
  AgentExecutionError,
  classifyAgentError,
  NativeCapacityError,
  NativeInputWithheldError,
  PermissionModeRejectedError,
} from './agent-execution-error'
import {
  AGY_CONTROL_RPC_TIMEOUT_MS,
  AGY_MAX_CONTEXTS,
  AGY_PROMPT_ACCEPT_TIMEOUT_MS,
  AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS,
  AgyAcpConnection,
  AgyAcpConnectionPool,
  createAgyRootFrameNotWrittenProof,
  type AgyIngress,
  type AgyOrderedSessionStream,
  type AgyPoolLease,
  type AgyServerRequestOwnerHandle,
  type AgySessionCloseFailureReason,
} from './agy-acp-connection'
import { resolveAgyAppDataDir } from './agy-native-storage'
import {
  buildCompactPostCutoffBackgroundRecord,
  computeRetainedPlanTextBytes,
  estimateCompactBackgroundRecordBytes,
  hasValidArtifactMetadata,
  isMarkdownBrainPlanArtifact,
  isVerifiedDirectBrainPlanWriteTarget,
  mergePlainArgsRecords,
  parseAgyPromptTerminalReply,
  recheckValidatedFrameAgainstRootBoundary,
  validateAgyFrame,
  validateBackgroundUpdateForRun,
  type AcpToolCallAdmissionResult,
  type CompactPostCutoffBackgroundRecord,
  type ParsedAgyPromptTerminalReply,
  type ValidatedBackgroundOwnership,
} from './agy/frame-validator'
import { AgyRunMcpServer } from './agy/peer-mcp-server'
import {
  agyElicitationRequest,
  buildAgyPermissionCard,
  findAllowOnceOptionId,
  findRejectOnceOptionId,
  parseAcpSessionDescriptor,
  parseConfigOptions,
} from './agy/permission-and-elicitation'
import {
  AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS,
  AGY_EVIDENCE_CACHE_LIMIT,
  AGY_MAX_FOREIGN_EXECUTION_IDS,
  AGY_MAX_FOREIGN_EXECUTION_ID_BYTES,
  AGY_MAX_FOREGROUND_DEDUP_BYTES,
  AGY_MAX_FOREGROUND_DEDUP_ID_COUNT,
  AGY_MAX_PENDING_EVENTS,
  AGY_MAX_PENDING_EVENT_BYTES,
  AGY_MAX_POST_CUTOFF_BG_BYTES,
  AGY_MAX_POST_CUTOFF_BG_PENDING,
  AGY_MAX_PRE_PROMPT_REPLAY_TOOL_IDS,
  AGY_MAX_REASONING_BYTES,
  AGY_MAX_REASONING_ITEMS,
  AGY_MAX_STAGED_PRE_BIND_BYTES,
  AGY_MAX_STAGED_PRE_BIND_FRAMES,
  AGY_MAX_STEERING_INPUTS,
  AGY_MAX_TOOL_STATES,
  AGY_MAX_TOOL_STATE_BYTES,
  AGY_PHYSICAL_SETTLEMENT_GRACE_MS,
  AGY_PLAN_SUBMISSION_INSTRUCTIONS,
  AGY_PROBE_MAX_BYTES,
  AGY_PROBE_TIMEOUT_MS,
  AGY_READ_ONLY_STAGE_INSTRUCTIONS,
  AGY_REBUILD_RECEIPT_LIMIT,
  AGY_SESSION_METADATA_UPDATES,
  AGY_SESSION_MODE_CACHE_LIMIT,
  asString,
  awaitPhysicalCompletionBounded,
  buildAgyPactMcpServerName,
  classifyAgyCloseFailureDiagnostic,
  classifyIdentityWorkerError,
  compareSemver,
  delayAbortable,
  deterministicUuid,
  estimateJsonPayloadBytes,
  estimateNormalizedEventBytes,
  extractUserChunkPactIdentity,
  identityStatusPriority,
  isEligibleAgyBackgroundReportId,
  isPlainObject,
  type AcpConfigOptionEntry,
  type AcpSessionDescriptor,
  type ActiveAgyRun,
  type AgyAgentAdapterOptions,
  type AgyCompletedPactPublishPlanCall,
  type AgyNativeStorageClient,
  type AgyRebuildSeedChunkRecord,
  type AgyRebuildSeedWriteResult,
  type AgySteerConsumptionReceipt,
  type AgySteerEntry,
  type AgyToolState,
  type OwnedAgyProbeProcess,
  type SessionModeState,
  type ValidatedAgyFrame,
} from './agy/types'
import { mergeWorkflowInput, mergeWorkflowReview } from './collaboration-answer'
import {
  buildSourceInstructions,
  collaborationInstructions,
  collaborationReadOnly,
} from './collaboration-prompt'
import { cutoffSourceNavigator } from './frozen-source-reader'
import { NativeCheckOperation } from './native-check-operation'
import {
  AgyRoundEffectsTracker,
  collectAgyTargetPaths,
  nativeEffectsUncertain,
  nativeFileChangesSettled,
  recordNativeChanges,
} from './native-file-changes'
import { NativeForkFiles } from './native-fork-files'
import {
  agyPromptInput,
  nativeImagePreparationBytes,
  requireNativeImageReference,
} from './native-image-content'
import { NativePermissionWait, safeNativePermissionText } from './native-permission-wait'
import {
  AgySkillProbeOwner,
  bindAgySkillSelections,
  discoverAgySkills,
} from './native-skill-catalog'
import { NativeWorkingMemory, type NativeMemoryReservation } from './native-working-memory'
import { PEER_ASSISTANCE_INSTRUCTIONS } from './peer-assistance-policy'

export {
  agyElicitationRequest,
  buildAgyPactMcpServerName,
  type AgyAgentAdapterOptions,
  type AgyCompletedPactPublishPlanCall,
  type AgyNativeStorageClient,
  type AgyRebuildSeedChunkRecord,
  type AgyRebuildSeedWriteResult,
  type AgySteerConsumptionReceipt,
  type OwnedAgyProbeProcess,
}

export class AgyAgentAdapter implements AgentAdapter {
  readonly id = 'agy' as const
  private readonly executablePath: string
  private readonly appDataDirs: readonly string[]
  private readonly primaryAppDataDir: string
  private readonly pool: AgyAcpConnectionPool
  private readonly ownsPool: boolean
  private readonly unsubscribePoolPhysicalOps: () => void
  private readonly unsubscribeStoragePhysicalOps: (() => void) | undefined
  private readonly nativeChecks: NativeCheckOperation
  private readonly evidenceCacheWork = new NativeWorkingMemory().reserve(0)
  private readonly nativeEvidence = new Map<string, NativeProbeResult>()
  private readonly sessionModes = new Map<string, SessionModeState>()
  private readonly nativeRebuildReceipts = new Map<
    string,
    {
      nativeSessionId: string
      sourceHash?: string | undefined
      seedHash: string
      cwd: string
      executorId: string
      initializationWitness?: NativeInitializationWitness | undefined
    }
  >()
  private readonly activeRuns = new Map<string, ActiveAgyRun>()
  private readonly ownedRunHandles = new Set<{
    readonly runId: string
    readonly cancel: () => void
    readonly closeZeroInputSession: (deadlineAt?: number) => Promise<void>
    readonly forceCleanup: () => Promise<void>
    readonly finalized: Promise<void>
  }>()
  private readonly skillProbeOwner = new AgySkillProbeOwner()
  private ownedForkFiles: NativeForkFiles | undefined
  private readonly activeOwnedForkFiles = new Set<NativeForkFiles>()
  private disposalPromise: Promise<void> | undefined
  private skillCatalogListener: (() => void) | undefined
  private nextTurnEpoch = 1
  private disposed = false

  private getOwnedForkFiles(): NativeForkFiles {
    if (this.disposed) {
      throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
    }
    if (!this.ownedForkFiles) {
      this.ownedForkFiles = new NativeForkFiles(this.options.ipcTraffic)
      this.activeOwnedForkFiles.add(this.ownedForkFiles)
    }
    return this.ownedForkFiles
  }

  constructor(private readonly options: AgyAgentAdapterOptions = {}) {
    this.executablePath = options.executablePath ?? 'agy'
    this.primaryAppDataDir = options.appDataDir
      ? resolvePath(options.appDataDir)
      : options.relativeAppDataDir
        ? resolvePath(join(homedir(), '.gemini', options.relativeAppDataDir))
        : resolveAgyAppDataDir(process.env)
    const explicitGeminiDir = process.env['ANTIGRAVITY_GEMINI_DIR']?.trim()
    const geminiBaseDir =
      explicitGeminiDir && isAbsolute(explicitGeminiDir)
        ? resolvePath(explicitGeminiDir)
        : join(homedir(), '.gemini')
    const fallbackDir = resolvePath(join(geminiBaseDir, 'antigravity'))
    this.appDataDirs =
      options.appDataDir || options.relativeAppDataDir || this.primaryAppDataDir === fallbackDir
        ? [this.primaryAppDataDir]
        : [this.primaryAppDataDir, fallbackDir]

    this.nativeChecks = new NativeCheckOperation(() => !this.disposed)
    if (options.connectionPool) {
      this.pool = options.connectionPool
      this.ownsPool = false
    } else {
      this.pool = new AgyAcpConnectionPool({
        executablePath: this.executablePath,
        clientInfo: options.clientInfo,
        relativeAppDataDir: options.relativeAppDataDir,
        idleTimeoutMs: options.idleTimeoutMs,
        processFactory: options.processFactory,
        ipcTraffic: options.ipcTraffic,
      })
      this.ownsPool = true
    }
    this.unsubscribePoolPhysicalOps = this.pool.subscribePhysicalOperations(
      (signal, physicalCompletion) => {
        this.nativeChecks.observeRequest(signal, physicalCompletion)
      },
    )
    this.unsubscribeStoragePhysicalOps = options.subscribeStoragePhysicalOperations?.(
      (signal, physicalCompletion) => {
        this.nativeChecks.observeRequest(signal, physicalCompletion)
      },
    )
  }

  get executorId(): string {
    return this.pool.executorId
  }

  hasExecutor(executorId: string): boolean {
    return this.pool.hasExecutor(executorId)
  }

  poolSnapshot() {
    return this.pool.poolSnapshot()
  }

  get unconfirmedClosedSessionCount(): number {
    return this.pool.unconfirmedClosedSessionCount
  }

  hasUnconfirmedClosedSession(sessionId: string): boolean {
    return this.pool.hasUnconfirmedClosedSession(sessionId)
  }

  retireFullAccess(options: { sessionId?: string; cwd?: string } = {}): Promise<void> {
    return this.pool.retireFullAccess(options)
  }

  setSkillCatalogListener(listener: (() => void) | undefined): void {
    this.skillCatalogListener = listener
  }

  async discoverSkills(cwd: string, signal: AbortSignal): Promise<SkillBinding[]> {
    return discoverAgySkills(cwd, this.executablePath, signal, {
      ...this.options.skillDiscoveryOptions,
      probeOwner: this.options.skillDiscoveryOptions?.probeOwner ?? this.skillProbeOwner,
    })
  }

  preflightPrompt(input: AgentRunInput): void {
    if (input.promptEnvelope.skillInvocation) {
      for (const binding of input.promptEnvelope.skillInvocation.bindings) {
        if (binding.agentId === 'agy' && !binding.name) {
          throw new AgentExecutionError(
            'protocol_error',
            'Invalid Antigravity Skill binding.',
            false,
          )
        }
      }
    }
  }

  retireSourceGrant(owner: { runId: string; grant: string }): void {
    const active = this.activeRuns.get(owner.runId)
    if (active) {
      active.retireSourceReader?.()
    }
  }

  hasActiveBackgroundWork(runId?: string): boolean {
    if (runId !== undefined) {
      const run = this.activeRuns.get(runId)
      if (!run) return false
      return run.backgroundUnconfirmed || run.activeBackgroundTasks.size > 0
    }
    for (const run of this.activeRuns.values()) {
      if (run.backgroundUnconfirmed || run.activeBackgroundTasks.size > 0) return true
    }
    return false
  }

  backgroundWork(runId: string, executorId: string): 'working' | 'stoppable' | undefined {
    const run = this.activeRuns.get(runId)
    if (!run || run.executorId !== executorId) return undefined
    if (run.backgroundUnconfirmed) return 'working'
    if (run.activeBackgroundTasks.size > 0) return 'stoppable'
    return undefined
  }

  async stopBackgroundWork(runId: string, executorId: string, signal: AbortSignal): Promise<void> {
    const run = this.activeRuns.get(runId)
    if (!run || run.executorId !== executorId || !run.connection.isOpen) return
    await run.connection.notify('session/cancel', { sessionId: run.nativeSessionId }, { signal })
  }

  async probe(signal?: AbortSignal): Promise<AgentProbeResult> {
    const effectiveSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(AGY_PROBE_TIMEOUT_MS)])
      : AbortSignal.timeout(AGY_PROBE_TIMEOUT_MS)
    if (effectiveSignal.aborted) {
      return { id: 'agy', available: false, reason: 'Antigravity version check was cancelled.' }
    }

    let owned: OwnedAgyProbeProcess | undefined
    try {
      const args = ['--version'] as const
      if (this.options.probeProcessFactory) {
        const supplied = this.options.probeProcessFactory(this.executablePath, args)
        owned = 'then' in supplied ? await supplied : supplied
      } else {
        const isWinCmd = process.platform === 'win32' && /\.cmd$/iu.test(this.executablePath)
        if (isWinCmd && /[&|<>^%!"\r\n]/u.test(this.executablePath)) {
          return { id: 'agy', available: false, reason: 'Unsafe Antigravity executable path.' }
        }
        const group = new OwnedProcessGroup()
        const target = isWinCmd ? (process.env.ComSpec ?? 'cmd.exe') : this.executablePath
        const spawnArgs = isWinCmd
          ? ['/d', '/s', '/c', `""${this.executablePath}" --version"`]
          : ['--version']
        const child = group.spawn(target, spawnArgs, {
          windowsHide: true,
          windowsVerbatimArguments: isWinCmd,
        })
        owned = { child, close: (deadline) => group.close(deadline) }
      }

      const output = await new Promise<{ code: number | null; text: string }>(
        (resolveOut, rejectOut) => {
          let settled = false
          let bytes = 0
          const chunks: Buffer[] = []
          const finish = (code: number | null, err?: Error): void => {
            if (settled) return
            settled = true
            effectiveSignal.removeEventListener('abort', onAbort)
            owned!.child.stdout.off('data', onData)
            owned!.child.stderr.off('data', onData)
            owned!.child.off('error', onError)
            owned!.child.off('close', onClose)
            if (err) rejectOut(err)
            else resolveOut({ code, text: Buffer.concat(chunks, bytes).toString('utf8') })
          }
          const onAbort = (): void => finish(null, new Error('Antigravity probe timed out.'))
          const onData = (chunk: Buffer): void => {
            const remaining = AGY_PROBE_MAX_BYTES - bytes
            if (remaining <= 0) return
            const slice = chunk.subarray(0, remaining)
            bytes += slice.length
            chunks.push(slice)
          }
          const onError = (err: Error): void => finish(null, err)
          const onClose = (code: number | null): void => finish(code)

          effectiveSignal.addEventListener('abort', onAbort, { once: true })
          owned!.child.stdout.on('data', onData)
          owned!.child.stderr.on('data', onData)
          owned!.child.once('error', onError)
          owned!.child.once('close', onClose)
          owned!.child.stdin.end()
        },
      )

      const versionMatch = /(\d+\.\d+\.\d+)/u.exec(output.text)
      const version = versionMatch?.[1]
      if (output.code !== 0 || !version) {
        return {
          id: 'agy',
          available: false,
          ...(version ? { version } : {}),
          reason: 'Antigravity CLI did not report a valid version.',
        }
      }
      const minVersion = RUNTIME_MINIMUM_VERSIONS.agy
      if (compareSemver(version, minVersion) < 0) {
        return {
          id: 'agy',
          available: false,
          version,
          reason: `Antigravity ${version} is older than required ${minVersion}.`,
        }
      }
      return { id: 'agy', available: true, version }
    } catch (error) {
      return {
        id: 'agy',
        available: false,
        reason: safeNativePermissionText(
          error instanceof Error ? error.message : 'Antigravity CLI is unavailable.',
          240,
        ),
      }
    } finally {
      if (owned?.close) {
        await owned.close(Date.now() + 1_000).catch(() => undefined)
      } else if (owned && owned.child.exitCode === null) {
        try {
          owned.child.kill('SIGKILL')
        } catch {
          // Ignore concurrent exit.
        }
      }
    }
  }

  async *run(input: AgentRunInput, signal: AbortSignal): AsyncIterable<NormalizedAgentEvent> {
    signal.throwIfAborted()
    if (this.disposed) {
      throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
    }
    if (this.activeRuns.size >= AGY_MAX_CONTEXTS) {
      throw new NativeCapacityError(
        'Antigravity has too many active native contexts. Wait for one to settle; no new task was submitted.',
      )
    }

    const workflow = input.promptEnvelope.collaboration
    const authorization = input.promptEnvelope.collaborationAuthorization ?? workflow?.authorization
    const readOnlyStage = collaborationReadOnly(workflow, authorization)
    const planModeStage = collaborationPlanMode(workflow, authorization)
    const askOnlyStage = Boolean(workflow && collaborationAskMode(workflow, authorization))
    const effectivePermissionMode: SessionPermissionMode = input.permissionMode ?? 'native'
    const permissionScope =
      !readOnlyStage && effectivePermissionMode === 'full' ? 'full' : 'standard'

    const tools = new Map<string, AgyToolState>()
    const approvedBrainPlanCalls = new Map<
      string,
      { readonly toolName: string; readonly args: Record<string, unknown> }
    >()
    let brainPlanTouched = false
    const activeBrainPlanOpCallIds = new Set<string>()
    const hasUnresolvedBrainPlanWrite = (): boolean => activeBrainPlanOpCallIds.size > 0
    let latestBrainPlanCandidate: { nativeId: string; text: string } | undefined
    let brainPlanReadbackRequired = false
    let brainPlanCaptureFailed = false
    let unresolvedPreBindOutput = false

    let sourceRetired = false
    const retireSourceReader = (): void => {
      if (sourceRetired) return
      sourceRetired = true
      input.collaborationSourceReader?.retire()
    }

    let resolvedSessionId: string | undefined = input.nativeSessionId
    let createdFreshSession = false
    let activeExecutorId = this.pool.executorId
    let rootFirstByteWritten = false
    let promptEnteredTransport = false
    let rootConfirmedNotSent = false
    const isConfirmedZeroBytesSent = (): boolean =>
      (!promptEnteredTransport && !rootFirstByteWritten) || rootConfirmedNotSent
    let promptReplyReceived = false
    let userCancelRequested = false
    let rootTerminal = false
    let rootReleasing = false
    let foregroundReleased = false

    let lease: AgyPoolLease | undefined
    let sessionStream: AgyOrderedSessionStream | undefined
    let promptMemoryReservation: NativeMemoryReservation | undefined
    let toolStateMemoryReservation: NativeMemoryReservation | undefined
    let foregroundDedupMemoryReservation: NativeMemoryReservation | undefined
    let mcpCorrelationMemoryReservation: NativeMemoryReservation | undefined
    let publishedPlanMemoryReservation: NativeMemoryReservation | undefined
    let pendingEventsMemoryReservation: NativeMemoryReservation | undefined
    let stagedPreBindMemoryReservation: NativeMemoryReservation | undefined
    let foreignExecIdsMemoryReservation: NativeMemoryReservation | undefined
    let postCutoffBgMemoryReservation: NativeMemoryReservation | undefined
    let serverRequestOwner: AgyServerRequestOwnerHandle | undefined
    let unsubscribeBackground: (() => void) | undefined
    let activeRun: ActiveAgyRun | undefined
    let cancelGraceTimer: ReturnType<typeof setTimeout> | undefined
    let promptSettled = false
    const promptRpcAbort = new AbortController()
    const runDisposeAbort = new AbortController()
    const runSignal = AbortSignal.any([signal, runDisposeAbort.signal])
    const observation = new AbortController()
    const runFinalizer = Promise.withResolvers<void>()
    let stopStreamPump: (() => void) | undefined
    let stopPrePromptDrain: ((drainRemaining?: boolean) => Promise<void>) | undefined
    let handoffOrderedStreamToBackground: (() => void) | undefined

    const loadHostTrajectoryIdentity = async (
      loadSignal: AbortSignal,
    ): Promise<AgyTrajectoryIdentityClientResult> => {
      if (!resolvedSessionId) return { status: 'missing' }
      let bestNonOk: Exclude<AgyTrajectoryIdentityClientResult, { status: 'ok' }> | undefined
      for (const appDataDir of this.appDataDirs) {
        if (this.disposed || observation.signal.aborted) {
          throw new AgentExecutionError(
            'agent_process_crash',
            'Antigravity is shutting down.',
            false,
          )
        }
        loadSignal.throwIfAborted()
        let identity: AgyTrajectoryIdentityClientResult | undefined
        for (let busyAttempt = 0; busyAttempt < 4; busyAttempt += 1) {
          if (this.disposed || observation.signal.aborted) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity is shutting down.',
              false,
            )
          }
          try {
            if (this.options.storageClient?.readTrajectoryIdentity) {
              // oxlint-disable-next-line no-await-in-loop -- Bounded short retry when shared fork worker is momentarily busy.
              identity = await this.options.storageClient.readTrajectoryIdentity(
                {
                  appDataDir,
                  cwd: lease?.canonicalCwd ?? input.cwd,
                  nativeSessionId: resolvedSessionId,
                },
                loadSignal,
              )
            } else {
              // oxlint-disable-next-line no-await-in-loop -- Bounded short retry when standalone adapter fork worker is momentarily busy.
              const workerRes = await this.getOwnedForkFiles().readAgyTrajectoryIdentity(
                {
                  cwd: lease?.canonicalCwd ?? input.cwd,
                  storageRoot: appDataDir,
                  nativeSessionId: resolvedSessionId,
                },
                loadSignal,
              )
              identity =
                workerRes.status === 'ok'
                  ? {
                      status: 'ok',
                      trajectoryId: workerRes.trajectoryId,
                      stepCount: workerRes.stepCount,
                    }
                  : {
                      status: workerRes.status,
                      ...(workerRes.reason !== undefined ? { reason: workerRes.reason } : {}),
                    }
            }
            break
          } catch (error) {
            if (signal.aborted) throw error
            if (this.disposed || observation.signal.aborted) {
              throw new AgentExecutionError(
                'agent_process_crash',
                'Antigravity is shutting down.',
                false,
              )
            }
            if (loadSignal.aborted) {
              return {
                status: 'timeout',
                reason: 'Antigravity trajectory identity inspection exceeded its deadline.',
              }
            }
            if (
              busyAttempt < 3 &&
              error instanceof Error &&
              error.message.includes('already active')
            ) {
              // oxlint-disable-next-line no-await-in-loop -- Bounded 15ms retry for active storage worker.
              await delayAbortable(15, loadSignal)
              continue
            }
            identity = classifyIdentityWorkerError(error)
            break
          }
        }
        const resolvedIdentity: AgyTrajectoryIdentityClientResult = identity ?? {
          status: 'timeout',
          reason: 'Antigravity trajectory identity worker remained busy.',
        }
        if (resolvedIdentity.status === 'ok') return resolvedIdentity
        if (
          resolvedIdentity.status === 'invalid' ||
          resolvedIdentity.status === 'budget_exceeded'
        ) {
          return resolvedIdentity
        }
        if (
          !bestNonOk ||
          identityStatusPriority(resolvedIdentity.status) > identityStatusPriority(bestNonOk.status)
        ) {
          bestNonOk = resolvedIdentity
        }
      }
      return bestNonOk ?? { status: 'no_storage_root' }
    }

    const loadHostTrajectoryIdentityBeforePrompt = async (
      loadSignal: AbortSignal,
    ): Promise<AgyTrajectoryIdentityClientResult> => {
      const backoffMs = [25, 50, 100, 200]
      let latest: AgyTrajectoryIdentityClientResult = { status: 'no_storage_root' }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (signal.aborted) signal.throwIfAborted()
        if (this.disposed || observation.signal.aborted) {
          throw new AgentExecutionError(
            'agent_process_crash',
            'Antigravity is shutting down.',
            false,
          )
        }
        if (loadSignal.aborted) {
          return {
            status: 'timeout',
            reason: 'Antigravity trajectory identity inspection exceeded its pre-prompt deadline.',
          }
        }
        try {
          // oxlint-disable-next-line no-await-in-loop -- Bounded backoff retry strictly for transient WAL churn before prompt.
          latest = await loadHostTrajectoryIdentity(loadSignal)
        } catch (error) {
          if (signal.aborted) throw error
          if (this.disposed || observation.signal.aborted) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity is shutting down.',
              false,
            )
          }
          if (loadSignal.aborted) {
            return {
              status: 'timeout',
              reason:
                'Antigravity trajectory identity inspection exceeded its pre-prompt deadline.',
            }
          }
          return classifyIdentityWorkerError(error)
        }
        if (latest.status !== 'transient_churn') return latest
        if (attempt < backoffMs.length) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- Bounded backoff delay before retrying transient WAL churn.
            await delayAbortable(backoffMs[attempt]!, loadSignal)
          } catch (error) {
            if (signal.aborted) throw error
            if (this.disposed || observation.signal.aborted) {
              throw new AgentExecutionError(
                'agent_process_crash',
                'Antigravity is shutting down.',
                false,
              )
            }
            return loadSignal.aborted
              ? {
                  status: 'timeout',
                  reason:
                    'Antigravity trajectory identity inspection exceeded its pre-prompt deadline.',
                }
              : latest
          }
        }
      }
      return latest
    }

    const mcpServer = new AgyRunMcpServer({
      runId: input.runId,
      getNativeSessionId: () => resolvedSessionId,
      getExecutorId: () => activeExecutorId,
      getExecutionId: () => activeRun?.providerExecutionId,
      getRootStepIdx: () => activeRun?.rootStepIdx,
      hasZeroTurnStepBoundary: () => createdFreshSession,
      tryLoadHostTrajectoryId: async () => {
        const res = await loadHostTrajectoryIdentity(
          AbortSignal.any([observation.signal, AbortSignal.timeout(500)]),
        ).catch(() => ({ status: 'transient_churn' as const }))
        return res.status === 'ok'
          ? { trajectoryId: res.trajectoryId, stepCount: res.stepCount }
          : undefined
      },
      bindingGeneration: input.bindingGeneration ?? 1,
      isRootCurrent: () =>
        !this.disposed &&
        rootFirstByteWritten &&
        !promptReplyReceived &&
        !rootTerminal &&
        !rootReleasing &&
        !foregroundReleased &&
        !signal.aborted,
      isSourceCurrent: () =>
        !this.disposed &&
        rootFirstByteWritten &&
        !promptReplyReceived &&
        !rootTerminal &&
        !sourceRetired &&
        !signal.aborted,
      workflow,
      authorization,
      requestSessionTitle: input.promptEnvelope.requestSessionTitle === true,
      peerAssistanceAllowed: !workflow && input.peerAssistanceAllowed !== false,
      peerTargetAgentId: this.options.peerTargetAgentId,
      sourceGrant: input.promptEnvelope.sourceGrant,
      sourceReader: input.collaborationSourceReader,
      legacySourceReader: input.readCollaborationSourcePart,
      isPlanRetentionCurrent: () => !brainPlanTouched && !hasUnresolvedBrainPlanWrite(),
      recordOpenPlanFinalIntent: input.recordOpenPlanFinalIntent,
      reserveCorrelationBytes: (nextBytes) => {
        if (!mcpCorrelationMemoryReservation) return true
        try {
          mcpCorrelationMemoryReservation.resize(nextBytes)
          return true
        } catch {
          return false
        }
      },
    })

    const interactionControllers = new Set<AbortController>()
    const abortOutstandingInteractions = (): void => {
      for (const ctrl of interactionControllers) {
        ctrl.abort()
      }
      interactionControllers.clear()
    }
    const recordings = new Set<Promise<void>>()
    let recordingTail = Promise.resolve()
    let unknownEffectsReported = false
    let unknownEffectsReason: string | undefined

    const reportUnknown = (reason: string): void => {
      if (unknownEffectsReported) return
      unknownEffectsReported = true
      unknownEffectsReason = reason
      nativeFileChangesSettled(input, 'unknown', reason)
    }

    const recordHostBeforeRootStart = (): void => {
      if (resolvedSessionId && input.recovery) {
        input.recovery.recordConfirmedUnsent(
          { kind: 'host_before_root_start' },
          { executorId: activeExecutorId, nativeSessionId: resolvedSessionId },
        )
      }
    }

    let zeroInputClosePromise: Promise<void> | undefined
    const closeZeroInputSessionOnce = (deadlineAt?: number): Promise<void> => {
      if (zeroInputClosePromise) return zeroInputClosePromise
      if (
        !createdFreshSession ||
        !resolvedSessionId ||
        !isConfirmedZeroBytesSent() ||
        !lease?.connection.isOpen
      ) {
        return Promise.resolve()
      }
      const timeoutMs = deadlineAt !== undefined ? Math.min(1_500, deadlineAt - Date.now()) : 1_500
      if (timeoutMs <= 0) {
        return Promise.resolve()
      }
      const targetSessionId = resolvedSessionId
      const targetLease = lease
      zeroInputClosePromise = (async () => {
        const closeRes = await targetLease.closeSession(targetSessionId, { timeoutMs })
        if (closeRes.confirmed) {
          this.sessionModes.delete(targetSessionId)
        } else {
          const closeDiag = classifyAgyCloseFailureDiagnostic(closeRes.reason)
          recordDiagnostic({
            operation: 'native_check',
            phase: 'failed',
            level: 'warn',
            scope: 'run',
            sessionId: input.sessionId,
            runId: input.runId,
            agentId: 'agy',
            executorId: activeExecutorId,
            nativeMethod: 'session/close',
            failureSource: closeDiag.failureSource,
            code: closeDiag.code,
          })
        }
      })()
      return zeroInputClosePromise
    }

    let emergencyCleanedUp = false
    let finalizationPromise: Promise<void> | undefined
    const finalizeRun = (options: { emergency: boolean }): Promise<void> => {
      if (options.emergency) {
        emergencyCleanedUp = true
      }
      if (finalizationPromise) {
        return finalizationPromise
      }
      finalizationPromise = (async () => {
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer)
          cancelGraceTimer = undefined
        }
        promptRpcAbort.abort()
        await stopPrePromptDrain?.(false).catch(() => undefined)
        stopStreamPump?.()
        foregroundReleased = true
        if (options.emergency || emergencyCleanedUp) {
          rootTerminal = true
        }
        if (activeRun) {
          activeRun.foregroundReleased = true
          if (options.emergency || emergencyCleanedUp) {
            activeRun.rootTerminal = true
          }
          this.notifyRootExecutionWaiters(activeRun)
        }
        if (
          (options.emergency || emergencyCleanedUp) &&
          !unknownEffectsReported &&
          !isConfirmedZeroBytesSent()
        ) {
          reportUnknown(
            'Antigravity adapter disposed before native Turn cleanup could be confirmed.',
          )
        }
        this.invalidateNonTerminalEvidence(input.runId, resolvedSessionId)
        // Root Turn has ended: unconditionally revoke and close MCP server synchronously before releasing its reservation.
        mcpServer.revokeRun()
        await mcpServer.close().catch(() => undefined)
        mcpCorrelationMemoryReservation?.release()
        mcpCorrelationMemoryReservation = undefined
        publishedPlanMemoryReservation?.release()
        publishedPlanMemoryReservation = undefined
        promptMemoryReservation?.release()
        promptMemoryReservation = undefined
        toolStateMemoryReservation?.release()
        toolStateMemoryReservation = undefined
        pendingEventsMemoryReservation?.release()
        pendingEventsMemoryReservation = undefined
        stagedPreBindMemoryReservation?.release()
        stagedPreBindMemoryReservation = undefined
        foreignExecIdsMemoryReservation?.release()
        foreignExecIdsMemoryReservation = undefined
        for (const ctrl of interactionControllers) ctrl.abort()
        interactionControllers.clear()
        tools.clear()
        approvedBrainPlanCalls.clear()
        if (!options.emergency && !emergencyCleanedUp) {
          await closeZeroInputSessionOnce().catch(() => undefined)
        }
        serverRequestOwner?.dispose()
        serverRequestOwner = undefined
        if (
          !options.emergency &&
          !emergencyCleanedUp &&
          !this.disposed &&
          activeRun &&
          activeRun.activeBackgroundTasks.size > 0
        ) {
          handoffOrderedStreamToBackground?.()
          sessionStream?.close()
          sessionStream = undefined
          // Keep background listener & lease until active background tasks settle or pool disposes.
          const retainedRun = activeRun
          const retainedLease = lease
          lease = undefined
          let retainedCleaned = false
          const cleanupRetained = (): void => {
            if (retainedCleaned) return
            retainedCleaned = true
            unsubscribeBackground?.()
            unsubscribeBackground = undefined
            foregroundDedupMemoryReservation?.release()
            foregroundDedupMemoryReservation = undefined
            postCutoffBgMemoryReservation?.release()
            postCutoffBgMemoryReservation = undefined
            retireSourceReader()
            this.activeRuns.delete(input.runId)
            retainedLease?.release()
          }
          if (retainedRun.observation.signal.aborted || this.disposed || emergencyCleanedUp) {
            cleanupRetained()
          } else {
            retainedRun.observation.signal.addEventListener('abort', cleanupRetained, {
              once: true,
            })
          }
        } else {
          sessionStream?.close()
          sessionStream = undefined
          unsubscribeBackground?.()
          unsubscribeBackground = undefined
          foregroundDedupMemoryReservation?.release()
          foregroundDedupMemoryReservation = undefined
          postCutoffBgMemoryReservation?.release()
          postCutoffBgMemoryReservation = undefined
          retireSourceReader()
          observation.abort()
          if (activeRun) this.activeRuns.delete(input.runId)
          lease?.release()
          lease = undefined
        }
        this.ownedRunHandles.delete(runHandle)
        runFinalizer.resolve()
      })()
      return finalizationPromise
    }

    const runHandle = {
      runId: input.runId,
      cancel: (): void => {
        runDisposeAbort.abort(
          new AgentExecutionError(
            'agent_process_crash',
            'Antigravity adapter is shutting down.',
            false,
          ),
        )
        observation.abort()
        if (activeRun) {
          this.notifyRootExecutionWaiters(activeRun)
        }
        for (const ctrl of interactionControllers) ctrl.abort()
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer)
          cancelGraceTimer = undefined
        }
        if (
          rootFirstByteWritten &&
          !promptSettled &&
          !rootTerminal &&
          resolvedSessionId &&
          lease?.connection.isOpen
        ) {
          void lease.connection
            .notify('session/cancel', { sessionId: resolvedSessionId }, {})
            .catch(() => undefined)
        }
        promptRpcAbort.abort()
      },
      closeZeroInputSession: (deadlineAt?: number): Promise<void> =>
        closeZeroInputSessionOnce(deadlineAt),
      forceCleanup: (): Promise<void> => finalizeRun({ emergency: true }),
      finalized: runFinalizer.promise,
    }
    this.ownedRunHandles.add(runHandle)

    try {
      // Re-verify explicit /skill selections before acquiring or dispatching to native process.
      if (input.promptEnvelope.skillInvocation) {
        const hasAgySkill = input.promptEnvelope.skillInvocation.bindings.some(
          (b) => b.agentId === 'agy',
        )
        if (hasAgySkill) {
          const catalog = await this.discoverSkills(input.cwd, runSignal)
          bindAgySkillSelections(input.promptEnvelope.skillInvocation.bindings, catalog)
        }
      }

      const mcpDescriptor = mcpServer.hasTools ? await mcpServer.start() : undefined

      const systemAppendParts: string[] = []
      if (workflow) {
        systemAppendParts.push(
          collaborationInstructions(workflow, authorization, mcpServer.sourceCapability),
        )
        if (readOnlyStage) {
          systemAppendParts.push(AGY_READ_ONLY_STAGE_INSTRUCTIONS)
        }
        if (planModeStage) {
          systemAppendParts.push(AGY_PLAN_SUBMISSION_INSTRUCTIONS)
        }
      } else {
        if (mcpServer.allowedToolNames.has('request_peer_assistance')) {
          systemAppendParts.push(PEER_ASSISTANCE_INSTRUCTIONS)
        }
        if (mcpServer.allowedToolNames.has('read_collaboration_source')) {
          systemAppendParts.push(buildSourceInstructions(mcpServer.sourceCapability))
        }
      }
      if (mcpServer.hasTools) {
        systemAppendParts.push(mcpServer.formatToolUsageInstructions())
      }
      const systemAppend = systemAppendParts.filter(Boolean).join('\n\n')
      const systemPromptMeta = systemAppend
        ? { _meta: { antigravity: { systemPrompt: { append: systemAppend } } } }
        : {}

      lease = await this.pool.acquire({
        cwd: input.cwd,
        permissionScope,
        permissionMode: effectivePermissionMode,
        readOnly: readOnlyStage,
        sessionId: input.sessionId,
        signal: runSignal,
      })
      const connection = lease.connection
      activeExecutorId = connection.executorId
      input.recordExecutor?.(activeExecutorId)

      await lease.ensureInitialized(runSignal)

      // Event queue fed by ordered server-request interactions (approval / question) and session updates.
      pendingEventsMemoryReservation = connection.reserveWorkingMemory(0)
      const pendingEvents: Array<{ readonly event: NormalizedAgentEvent; readonly bytes: number }> =
        []
      let pendingEventsBytes = 0
      let wakeEventLoop: (() => void) | undefined
      let wakePumpForBackpressure: (() => void) | undefined
      const notifyEventLoop = (): void => {
        const wake = wakeEventLoop
        wakeEventLoop = undefined
        wake?.()
      }
      const notifyPumpForBackpressure = (): void => {
        const wake = wakePumpForBackpressure
        wakePumpForBackpressure = undefined
        wake?.()
      }
      const isPendingEventsAtSoftCap = (): boolean =>
        pendingEvents.length >= AGY_MAX_PENDING_EVENTS ||
        pendingEventsBytes >= AGY_MAX_PENDING_EVENT_BYTES
      const pushPendingEvent = (ev: NormalizedAgentEvent): void => {
        const evBytes = estimateNormalizedEventBytes(ev)
        const nextBytes = pendingEventsBytes + evBytes
        if (
          pendingEvents.length >= AGY_MAX_PENDING_EVENTS * 2 ||
          nextBytes > AGY_MAX_PENDING_EVENT_BYTES * 2
        ) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity pending event queue exceeded working-memory budget.',
            false,
          )
        }
        pendingEventsMemoryReservation?.resize(nextBytes)
        pendingEventsBytes = nextBytes
        pendingEvents.push({ event: ev, bytes: evBytes })
        notifyEventLoop()
      }
      const shiftPendingEvent = (): NormalizedAgentEvent | undefined => {
        const entry = pendingEvents.shift()
        if (!entry) return undefined
        pendingEventsBytes = Math.max(0, pendingEventsBytes - entry.bytes)
        pendingEventsMemoryReservation?.resize(pendingEventsBytes)
        if (!isPendingEventsAtSoftCap()) {
          notifyPumpForBackpressure()
        }
        return entry.event
      }
      const clearPendingEvents = (): void => {
        pendingEvents.length = 0
        pendingEventsBytes = 0
        pendingEventsMemoryReservation?.resize(0)
        notifyPumpForBackpressure()
      }

      const permissionWait = new NativePermissionWait()
      let activePermissionRequests = 0
      const releaseWaitObserver = permissionWait.subscribe(() => {
        if (activeRun?.turnAccepted && !rootTerminal && resolvedSessionId) {
          this.recordEvidence(
            input,
            resolvedSessionId,
            activeExecutorId,
            {
              kind: permissionWait.waiting ? 'waiting_user' : 'running',
              source: 'live_runtime',
            },
            activeRun.nativeTurnId,
          )
        }
      })
      observation.signal.addEventListener('abort', releaseWaitObserver, { once: true })

      let replayingHistory = false
      let promptCutoffSeq: number | undefined

      const isUnscopedDuringForeignTurn = (validated: ValidatedAgyFrame): boolean =>
        Boolean(
          activeRun &&
          activeRun.providerExecutionId === undefined &&
          activeRun.foreignTurnActiveUntilRootBound &&
          validated.executionId === undefined,
        )

      const isServerRequestIdentityContradicted = (validated: ValidatedAgyFrame): boolean =>
        validated.hasForeignOrInvalidSessionMeta ||
        validated.executionIdInvalid ||
        validated.rootEvidenceContradicted ||
        isUnscopedDuringForeignTurn(validated) ||
        (validated.executionId !== undefined &&
          activeRun?.providerExecutionId !== undefined &&
          validated.executionId !== activeRun.providerExecutionId) ||
        (validated.executionId !== undefined &&
          Boolean(activeRun?.knownForeignExecutionIds.has(validated.executionId)))

      const handleOrderedServerRequest = (
        req: Extract<AgyIngress, { kind: 'server_request' }>,
      ): boolean => {
        const { method, rpcId, message } = req
        if (method !== 'session/request_permission' && method !== 'elicitation/create') {
          void connection
            .respondError(rpcId, 'Unsupported Antigravity ACP server request.', -32_601)
            .catch(() => undefined)
          return false
        }
        const rawParams = Reflect.get(message, 'params')
        const paramsObjectValid = isPlainObject(rawParams)
        const params = paramsObjectValid ? rawParams : {}

        if (
          activeRun?.promptReplyReceived ||
          (promptCutoffSeq !== undefined && req.seq > promptCutoffSeq)
        ) {
          if (method === 'session/request_permission') {
            const rejectOnce = findRejectOnceOptionId(params.options)
            void connection
              .respond(
                rpcId,
                rejectOnce
                  ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
                  : { outcome: { outcome: 'cancelled' } },
              )
              .catch(() => undefined)
          } else {
            void connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
          }
          return true
        }

        // Validate session, execution, trajectory/step, tokens, and operation-specific payload
        // BEFORE recording acceptance, showing an interaction, or granting permission!
        const validated = validateAgyFrame(
          req,
          resolvedSessionId,
          mcpServer.pinnedTrajectory,
          mcpServer.minStepIdx,
        )
        const unscopedForeign = isUnscopedDuringForeignTurn(validated)
        const identityContradicted = isServerRequestIdentityContradicted(validated)
        const permRequestInvalid =
          method === 'session/request_permission' &&
          (!paramsObjectValid ||
            identityContradicted ||
            validated.tokens.hasInvalidToken ||
            validated.tokens.hasConflictingTokens ||
            validated.toolCallIdInvalid ||
            validated.argsEvidence.kind === 'invalid_or_conflict' ||
            (validated.statusPresent &&
              (validated.statusInvalid ||
                validated.status === 'completed' ||
                validated.status === 'failed' ||
                validated.status === 'cancelled')))
        const elicitRequestInvalid =
          method === 'elicitation/create' &&
          (!paramsObjectValid ||
            identityContradicted ||
            validated.tokens.hasInvalidToken ||
            validated.tokens.hasConflictingTokens)

        let preBuiltPermissionCard: ReturnType<typeof buildAgyPermissionCard> | undefined
        let permissionCardValid = false
        if (method === 'session/request_permission' && !permRequestInvalid) {
          try {
            preBuiltPermissionCard = buildAgyPermissionCard(params, lease!.canonicalCwd)
            permissionCardValid = true
          } catch {
            permissionCardValid = false
          }
        }

        let preParsedElicitationRequest: NativeUserInputRequest | undefined
        let elicitationPayloadValid = false
        let elicitationParseErrorMessage: string | undefined
        if (method === 'elicitation/create' && !elicitRequestInvalid) {
          try {
            preParsedElicitationRequest = agyElicitationRequest(params)
            elicitationPayloadValid = true
          } catch (error) {
            elicitationPayloadValid = false
            elicitationParseErrorMessage =
              error instanceof Error ? error.message : 'Unsupported Antigravity elicitation schema.'
          }
        }

        const requestValidForAcceptance =
          method === 'session/request_permission'
            ? !permRequestInvalid && permissionCardValid
            : !elicitRequestInvalid && elicitationPayloadValid

        // Only count as model Turn acceptance AFTER the root prompt has dispatched AND BOTH
        // attributable frame identity and operation-specific payload validation succeed!
        if (
          requestValidForAcceptance &&
          activeRun &&
          rootFirstByteWritten &&
          !activeRun.turnAccepted &&
          !activeRun.promptReplyReceived &&
          !rootTerminal &&
          !replayingHistory
        ) {
          activeRun.turnAccepted = true
          input.recordDispatch?.('accepted', activeRun.nativeSessionId, activeExecutorId)
          this.recordEvidence(
            input,
            activeRun.nativeSessionId,
            activeExecutorId,
            {
              kind: 'running',
              source: 'live_runtime',
            },
            activeRun.nativeTurnId,
          )
          pushPendingEvent({ agentId: 'agy', type: 'turn.started', turnId: input.runId })
        }

        if (method === 'session/request_permission') {
          this.handlePermissionRequest({
            connection,
            validated,
            rpcId,
            params,
            paramsObjectValid,
            unscopedDuringForeignTurn: unscopedForeign,
            preBuiltCard: preBuiltPermissionCard,
            cwd: lease!.canonicalCwd,
            input,
            activeRun,
            getSessionId: () => resolvedSessionId,
            mcpServer,
            tools,
            approvedBrainPlanCalls,
            onBrainPlanWriteApproved: (toolCallId) => {
              brainPlanTouched = true
              if (activeBrainPlanOpCallIds.size < 64) {
                activeBrainPlanOpCallIds.add(toolCallId)
              }
            },
            readOnlyStage,
            planModeStage,
            permissionMode: effectivePermissionMode,
            permissionWait,
            getActiveCount: () => activePermissionRequests,
            adjustActiveCount: (delta) => {
              activePermissionRequests += delta
            },
            interactionControllers,
            pushEvent: pushPendingEvent,
            signal,
          }).catch(() => undefined)
          return true
        }

        if (!elicitRequestInvalid && !elicitationPayloadValid) {
          void connection
            .respondError(
              rpcId,
              elicitationParseErrorMessage ?? 'Unsupported Antigravity elicitation schema.',
              -32_602,
            )
            .catch(() => undefined)
          return true
        }

        this.handleElicitationRequest({
          connection,
          validated,
          rpcId,
          params,
          paramsObjectValid,
          unscopedDuringForeignTurn: unscopedForeign,
          preParsedRequest: preParsedElicitationRequest,
          input,
          activeRun,
          askOnlyStage,
          readOnlyNonInteractive:
            readOnlyStage &&
            !planModeStage &&
            (authorization?.stage ?? workflow?.stage) !== 'reply',
          permissionWait,
          interactionControllers,
          pushEvent: pushPendingEvent,
          signal,
        }).catch(() => undefined)
        return true
      }

      // Register this Run in the connection's server-request owner registry for its full lifetime so
      // concurrent sessions sharing one connection properly reject ambiguous unscoped requests (-32601),
      // while session-scoped requests are routed in strict stdout order via `openSessionStream({ ordered: true })`.
      serverRequestOwner = connection.registerServerRequestOwner({
        ownerId: `run:${input.runId}`,
        knownSessionId: resolvedSessionId,
        handler: (message, seq?: number) => {
          const method = asString(Reflect.get(message, 'method'))
          const rpcId = Reflect.get(message, 'id')
          if (
            (typeof rpcId !== 'string' && typeof rpcId !== 'number') ||
            !method ||
            (method !== 'session/request_permission' && method !== 'elicitation/create') ||
            !isPlainObject(message)
          ) {
            return false
          }
          const effectiveSeq = seq ?? (promptCutoffSeq !== undefined ? promptCutoffSeq + 1 : 0)
          return handleOrderedServerRequest({
            kind: 'server_request',
            seq: effectiveSeq,
            rpcId,
            method,
            message,
          })
        },
      })

      const prePromptReplayedToolCallIds = new Set<string>()
      const observePrePromptNotification = (note: object, targetSessionId: string): void => {
        this.observeSessionTitleFromNotification(note, targetSessionId, input)
        if (!isPlainObject(note) || asString(Reflect.get(note, 'method')) !== 'session/update') {
          return
        }
        const params = Reflect.get(note, 'params')
        if (!isPlainObject(params)) return
        const sid = asString(params.sessionId ?? params.session_id)
        if (sid !== undefined && sid !== targetSessionId) return
        const update = params.update
        if (!isPlainObject(update)) return
        const sessionUpdate = asString(update.sessionUpdate)
        if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') return
        const toolCallId = asString(update.toolCallId ?? update.id)
        if (!toolCallId || toolCallId.length > 1024) return
        if (!prePromptReplayedToolCallIds.has(toolCallId)) {
          if (prePromptReplayedToolCallIds.size >= AGY_MAX_PRE_PROMPT_REPLAY_TOOL_IDS) {
            const oldest = prePromptReplayedToolCallIds.values().next().value
            if (oldest !== undefined) prePromptReplayedToolCallIds.delete(oldest)
          }
          prePromptReplayedToolCallIds.add(toolCallId)
        }
      }

      let descriptor: AcpSessionDescriptor
      if (input.nativeSessionId) {
        resolvedSessionId = input.nativeSessionId
        replayingHistory = true
        sessionStream = connection.openSessionStream(input.nativeSessionId, { ordered: true })
        let replayConfigOptions: AcpConfigOptionEntry[] | undefined
        const loadOp = connection.requestOwned(
          'session/load',
          {
            sessionId: input.nativeSessionId,
            cwd: lease.canonicalCwd,
            mcpServers: mcpDescriptor ? [mcpDescriptor] : [],
            ...systemPromptMeta,
          },
          {
            timeoutMs: AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS,
            signal: runSignal,
            replyTo: sessionStream,
          },
        )
        const loadResp = yield* this.awaitControlRpcWithConcurrentDrain({
          requestPromise: loadOp.result,
          requestId: loadOp.requestId,
          stream: sessionStream,
          shiftPendingEvent,
          setWakeup: (fn) => {
            wakeEventLoop = fn
          },
          onNotification: (replayed) => {
            observePrePromptNotification(replayed, input.nativeSessionId!)
            const notifiedOptions = this.extractConfigOptionsFromNotification(
              replayed,
              input.nativeSessionId,
            )
            if (notifiedOptions) replayConfigOptions = notifiedOptions
          },
          onServerRequest: (req) => {
            handleOrderedServerRequest(req)
          },
        })
        const loadError = Reflect.get(loadResp, 'error')
        const loadResult = Reflect.get(loadResp, 'result')
        if (loadError || !isPlainObject(loadResult)) {
          throw new AgentExecutionError(
            'context_resume_failed',
            loadError
              ? safeNativePermissionText(JSON.stringify(loadError), 240)
              : 'Antigravity could not load the saved native session.',
            false,
          )
        }
        descriptor = parseAcpSessionDescriptor(loadResult, input.nativeSessionId)
        if (descriptor.configOptions.length === 0 && replayConfigOptions) {
          descriptor.configOptions = replayConfigOptions
        }
        replayingHistory = false
      } else {
        const newReq = connection.request(
          'session/new',
          {
            cwd: lease.canonicalCwd,
            mcpServers: mcpDescriptor ? [mcpDescriptor] : [],
            ...systemPromptMeta,
          },
          { timeoutMs: AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS, signal: runSignal },
        )
        const newResp = yield* this.awaitControlRpcWithConcurrentDrain({
          requestPromise: newReq,
          stream: undefined,
          shiftPendingEvent,
          setWakeup: (fn) => {
            wakeEventLoop = fn
          },
          onNotification: () => undefined,
        })
        const newError = Reflect.get(newResp, 'error')
        const newResult = Reflect.get(newResp, 'result')
        if (newError || !isPlainObject(newResult)) {
          throw new AgentExecutionError(
            'protocol_error',
            newError
              ? safeNativePermissionText(JSON.stringify(newError), 240)
              : 'Antigravity ACP server did not create a session.',
            false,
          )
        }
        descriptor = parseAcpSessionDescriptor(newResult)
        resolvedSessionId = descriptor.sessionId
        createdFreshSession = true
        serverRequestOwner.updateSessionId(resolvedSessionId)
        sessionStream = connection.openSessionStream(resolvedSessionId, { ordered: true })
        // Drain any initial metadata updates or early server requests (`available_commands_update` / `config_option_update`).
        while (true) {
          const initialItem = sessionStream.shift()
          if (!initialItem) break
          if (initialItem.kind === 'server_request') {
            handleOrderedServerRequest(initialItem)
            continue
          }
          if (initialItem.kind !== 'notification') continue
          observePrePromptNotification(initialItem.message, resolvedSessionId)
          const notifiedOptions = this.extractConfigOptionsFromNotification(
            initialItem.message,
            resolvedSessionId,
          )
          if (notifiedOptions) descriptor.configOptions = notifiedOptions
        }
      }

      const sessionState = this.rememberSessionModeState(
        resolvedSessionId,
        descriptor.currentModeId,
      )

      // Enforce permission & read-only mode transitions BEFORE preparing or writing `session/prompt`.
      await this.configureSessionModeBeforePrompt({
        connection,
        sessionId: resolvedSessionId,
        descriptor,
        sessionState,
        sessionStream,
        onMetadataNotification: (note) => {
          observePrePromptNotification(note, resolvedSessionId!)
        },
        onServerRequest: (req) => {
          handleOrderedServerRequest(req)
        },
        readOnlyStage,
        permissionMode: effectivePermissionMode,
        signal: runSignal,
      })

      // Confirm applied model & thought_level via `session/set_config_option` (keeping speed: 'native').
      const appliedModelAndEffort = await this.configureModelAndEffortBeforePrompt({
        connection,
        sessionId: resolvedSessionId,
        descriptor,
        sessionStream,
        onMetadataNotification: (note) => {
          observePrePromptNotification(note, resolvedSessionId!)
        },
        onServerRequest: (req) => {
          handleOrderedServerRequest(req)
        },
        requestedModel: input.model,
        requestedEffort: input.effort,
        signal: runSignal,
      })

      let prePromptStreamEnd: Extract<AgyIngress, { kind: 'end' }> | undefined
      const handlePrePromptIngressItem = (item: AgyIngress): boolean => {
        if (item.kind === 'end') {
          prePromptStreamEnd ??= item
          return false
        }
        if (item.kind === 'server_request') {
          handleOrderedServerRequest(item)
          return true
        }
        if (item.kind === 'notification') {
          observePrePromptNotification(item.message, resolvedSessionId!)
        }
        return true
      }
      const drainPrePromptBuffered = (): void => {
        if (!sessionStream || prePromptStreamEnd) return
        while (true) {
          const item = sessionStream.shift()
          if (!item) break
          if (!handlePrePromptIngressItem(item)) break
        }
      }
      let prePromptDrainAbort: AbortController | undefined
      let prePromptDrainTask: Promise<void> | undefined
      stopPrePromptDrain = async (drainRemaining = true): Promise<void> => {
        const abort = prePromptDrainAbort
        const task = prePromptDrainTask
        prePromptDrainAbort = undefined
        prePromptDrainTask = undefined
        abort?.abort()
        if (task) {
          await task.catch(() => undefined)
        }
        if (drainRemaining) {
          drainPrePromptBuffered()
        }
      }
      if (sessionStream) {
        const activePrePromptStream = sessionStream
        const drainAbort = new AbortController()
        prePromptDrainAbort = drainAbort
        prePromptDrainTask = (async () => {
          while (!drainAbort.signal.aborted && !prePromptStreamEnd) {
            drainPrePromptBuffered()
            if (drainAbort.signal.aborted || prePromptStreamEnd) break
            let nextItem: AgyIngress
            try {
              // oxlint-disable-next-line no-await-in-loop -- Drain trailing session/load replay continuously across pre-prompt setup.
              nextItem = await activePrePromptStream.nextIngress(undefined, drainAbort.signal)
            } catch (err) {
              if (drainAbort.signal.aborted) break
              prePromptStreamEnd ??= {
                kind: 'end',
                seq: 0,
                cause: 'transport',
                incomplete: true,
                detail: err instanceof Error ? err.message : String(err),
              }
              break
            }
            handlePrePromptIngressItem(nextItem)
          }
        })()
      }
      const throwIfPrePromptStreamClosed = async (): Promise<void> => {
        if (!prePromptStreamEnd && connection.isOpen) return
        await stopPrePromptDrain?.(false)
        recordHostBeforeRootStart()
        input.recordDispatch?.('rejected', resolvedSessionId, activeExecutorId)
        if (connection.closeReason instanceof AgentExecutionError) {
          throw connection.closeReason
        }
        throw new AgentExecutionError(
          prePromptStreamEnd?.cause === 'deadline' ? 'transient_transport' : 'agent_process_crash',
          prePromptStreamEnd?.detail ??
            connection.closeReason?.message ??
            'Antigravity ACP connection closed before prompt dispatch.',
          prePromptStreamEnd?.cause === 'deadline',
        )
      }

      let earlyEvent = shiftPendingEvent()
      while (earlyEvent !== undefined) {
        yield earlyEvent
        earlyEvent = shiftPendingEvent()
      }

      const appliedSettings = this.buildEffectiveExecutionSettings(
        appliedModelAndEffort.model,
        appliedModelAndEffort.effort,
        appliedModelAndEffort.effortKnown,
        effectivePermissionMode,
      )

      if (input.recovery) {
        if (appliedSettings) {
          input.recovery.recordEffectiveSettings(appliedSettings, {
            executorId: activeExecutorId,
            nativeSessionId: resolvedSessionId,
          })
        }
        if (input.recovery.expected) {
          const exp = input.recovery.expected
          if (
            !appliedSettings ||
            exp.executorId !== activeExecutorId ||
            exp.nativeSessionId !== resolvedSessionId ||
            !isDeepStrictEqual(exp.settings, appliedSettings)
          ) {
            recordHostBeforeRootStart()
            throw new NativeInputWithheldError(
              'Antigravity replacement settings or executor differed from the expected recovery binding.',
            )
          }
        }
      }

      // Prepare prompt content with Cutoff serialization & verified ACP images.
      const images: AgentPromptImage[] = []
      const currentEnvelope = input.currentPromptEnvelope?.() ?? input.promptEnvelope
      const sourceForm: AgentSourceReadForm | undefined = mcpServer.sourceCapability.sourceReference
        ? 'sourceReference'
        : mcpServer.sourceCapability.nativeRoot
          ? 'nativeRoot'
          : mcpServer.sourceCapability.legacy
            ? 'legacy'
            : undefined
      const navigate =
        input.collaborationSourceReader && sourceForm !== undefined
          ? (target: Parameters<AgentCollaborationSourceReader['navigation']>[0]) =>
              input.collaborationSourceReader!.navigation(target, sourceForm)
          : undefined
      const navigateCutoff =
        sourceForm !== undefined
          ? cutoffSourceNavigator(input.collaborationSourceReader, sourceForm)
          : undefined

      for (const group of agentPromptImageGroups(currentEnvelope)) {
        images.push(...group.images)
      }
      promptMemoryReservation = connection.reserveWorkingMemory(
        64 * 1024 +
          Buffer.byteLength(systemAppend, 'utf8') * 2 +
          nativeImagePreparationBytes(images),
      )
      toolStateMemoryReservation = connection.reserveWorkingMemory(0)
      foregroundDedupMemoryReservation = connection.reserveWorkingMemory(0)
      mcpCorrelationMemoryReservation = connection.reserveWorkingMemory(0)
      publishedPlanMemoryReservation = connection.reserveWorkingMemory(0)
      stagedPreBindMemoryReservation = connection.reserveWorkingMemory(0)
      foreignExecIdsMemoryReservation = connection.reserveWorkingMemory(0)
      postCutoffBgMemoryReservation = connection.reserveWorkingMemory(0)
      const promptBlocks = await agyPromptInput(
        currentEnvelope,
        runSignal,
        navigate,
        navigateCutoff,
        {
          pactRunId: input.runId,
        },
      )
      if (workflow && systemAppend && promptBlocks[0]?.type === 'text') {
        promptBlocks[0] = {
          type: 'text',
          text: `Pact host instructions for this turn:\n${systemAppend}\n\n${promptBlocks[0].text}`,
        }
      }
      const expectedFullPromptText = promptBlocks
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()

      const turnEpoch = this.nextTurnEpoch++
      const roundTracker = new AgyRoundEffectsTracker(
        lease.canonicalCwd,
        mcpServer.serverName,
        this.primaryAppDataDir,
        resolvedSessionId,
      )

      const knownForeignExecutionIds = new Set<string>()
      for (const other of this.activeRuns.values()) {
        if (
          other.nativeSessionId === resolvedSessionId &&
          !other.rootTerminal &&
          other.providerExecutionId !== undefined
        ) {
          knownForeignExecutionIds.add(other.providerExecutionId)
        }
      }
      activeRun = {
        runId: input.runId,
        sessionId: input.sessionId,
        cwd: lease.canonicalCwd,
        nativeSessionId: resolvedSessionId,
        nativeTurnId: input.runId,
        providerExecutionId: undefined,
        rootStepIdx: undefined,
        resumedExistingSession: Boolean(input.nativeSessionId),
        knownForeignExecutionIds,
        foreignTurnActiveUntilRootBound: false,
        stagedPreBindNotifications: [],
        bindingGeneration: input.bindingGeneration ?? 1,
        nativeGeneration: input.nativeGeneration ?? input.runId,
        executorId: activeExecutorId,
        connection,
        turnEpoch,
        turnAccepted: false,
        promptReplyReceived: false,
        foregroundReleased: false,
        rootReleasing: false,
        rootTerminal: false,
        cancellationPending: false,
        steeringInFlight: false,
        steeredInputs: new Map(),
        pendingSteerOperations: new Set(),
        rootExecutionWaiters: new Set(),
        activeBackgroundTasks: new Set(),
        backgroundTaskAliases: new Map(),
        backgroundUnconfirmed: false,
        observation,
        retireSourceReader,
        isSteerLeaseOpen: () =>
          !this.disposed &&
          !promptReplyReceived &&
          !activeRun!.promptReplyReceived &&
          !rootTerminal &&
          !rootReleasing &&
          !foregroundReleased &&
          !activeRun!.cancellationPending &&
          activeRun!.turnAccepted &&
          connection.isOpen,
      }
      this.activeRuns.set(input.runId, activeRun)

      if (mcpServer.hasTools) {
        const hostTrajectory = await loadHostTrajectoryIdentityBeforePrompt(
          AbortSignal.any([runSignal, observation.signal, AbortSignal.timeout(2_500)]),
        )
        if (hostTrajectory.status === 'ok') {
          mcpServer.pinHostTrajectoryId(hostTrajectory.trajectoryId, hostTrajectory.stepCount)
          if (activeRun.rootStepIdx === undefined) {
            activeRun.rootStepIdx = hostTrajectory.stepCount
          }
        } else if (hostTrajectory.status === 'invalid') {
          recordHostBeforeRootStart()
          throw new AgentExecutionError(
            input.nativeSessionId ? 'context_resume_failed' : 'protocol_error',
            hostTrajectory.reason ??
              'Antigravity trajectory storage metadata is invalid or corrupted.',
            false,
          )
        } else if (
          hostTrajectory.status === 'budget_exceeded' ||
          hostTrajectory.status === 'worker_error'
        ) {
          recordHostBeforeRootStart()
          throw new AgentExecutionError(
            'runtime_incompatible',
            hostTrajectory.reason ??
              (hostTrajectory.status === 'budget_exceeded'
                ? 'Antigravity trajectory storage exceeded the bounded identity read budget.'
                : 'Antigravity trajectory identity worker failed before prompt dispatch.'),
            false,
          )
        } else if (
          hostTrajectory.status === 'transient_churn' ||
          hostTrajectory.status === 'timeout'
        ) {
          recordHostBeforeRootStart()
          throw new AgentExecutionError(
            'transient_transport',
            hostTrajectory.reason ??
              (hostTrajectory.status === 'timeout'
                ? 'Antigravity trajectory identity inspection timed out before prompt dispatch.'
                : 'Antigravity trajectory storage remained unstable before prompt dispatch.'),
            true,
          )
        } else if (hostTrajectory.status === 'missing') {
          if (activeRun.rootStepIdx === undefined) {
            recordHostBeforeRootStart()
            throw new AgentExecutionError(
              input.nativeSessionId ? 'context_resume_failed' : 'protocol_error',
              hostTrajectory.reason ??
                (input.nativeSessionId
                  ? 'Antigravity trajectory database for the resumed session is missing before prompt dispatch.'
                  : 'Antigravity trajectory database for the new session is missing before prompt dispatch.'),
              false,
            )
          }
        } else if (hostTrajectory.status === 'no_storage_root') {
          mcpServer.disallowLazyStorageDbPin()
        }
      }

      await throwIfPrePromptStreamClosed()

      yield {
        agentId: 'agy',
        type: 'session.started',
        nativeSessionId: resolvedSessionId,
      }
      yield {
        agentId: 'agy',
        type: 'run.model.resolved',
        model: appliedModelAndEffort.model,
        effort: appliedModelAndEffort.effort,
      }
      const requestedSpeed = input.speed ?? 'native'
      yield {
        agentId: 'agy',
        type: 'run.speed.resolved',
        requested: requestedSpeed,
        ...(requestedSpeed !== 'native'
          ? {
              detail:
                'Antigravity does not expose native speed controls; continuing at native provider speed.',
            }
          : {}),
      }

      input.reportNativeEffects?.({
        runId: input.runId,
        generation: activeRun.nativeGeneration,
        state: 'pending',
      })

      // Post-turn background listener & dedup state for attributable out-of-turn completion updates.
      const seenForegroundMessageIds = new Set<string>()
      let seenForegroundMessageIdBytes = 0
      let foregroundDedupIncomplete = false
      let omittedForegroundIdLacksTrustedStep = false
      let maxForegroundStepIdx: number | undefined
      const recordSeenForegroundMessageId = (
        msgIdentity: string,
        trustedStepIdx?: number,
      ): void => {
        if (!isEligibleAgyBackgroundReportId(msgIdentity)) {
          return
        }
        if (seenForegroundMessageIds.has(msgIdentity)) return
        const markOmitted = (): void => {
          foregroundDedupIncomplete = true
          if (trustedStepIdx === undefined) {
            omittedForegroundIdLacksTrustedStep = true
          }
        }
        if (seenForegroundMessageIds.size >= AGY_MAX_FOREGROUND_DEDUP_ID_COUNT) {
          markOmitted()
          return
        }
        const entryBytes = msgIdentity.length * 2 + 32
        if (seenForegroundMessageIdBytes + entryBytes > AGY_MAX_FOREGROUND_DEDUP_BYTES) {
          markOmitted()
          return
        }
        if (foregroundDedupMemoryReservation) {
          try {
            foregroundDedupMemoryReservation.resize(seenForegroundMessageIdBytes + entryBytes)
          } catch {
            markOmitted()
            return
          }
        }
        seenForegroundMessageIds.add(msgIdentity)
        seenForegroundMessageIdBytes += entryBytes
      }
      const recordForegroundStepIdx = (stepIdx: number): void => {
        if (maxForegroundStepIdx === undefined || stepIdx > maxForegroundStepIdx) {
          maxForegroundStepIdx = stepIdx
        }
      }
      const reportedBackgroundMessageIds = new Set<string>()
      let observedBackgroundTask = false
      let postCutoffBackgroundTail = Promise.resolve()
      let postCutoffBgQueuedCount = 0
      let postCutoffBgQueuedBytes = 0

      const enqueuePostCutoffBackgroundUpdate = (
        params: Record<string, unknown>,
        update: Record<string, unknown>,
        preValidatedOwnership?: ValidatedBackgroundOwnership,
      ): void => {
        if (!activeRun) return
        const ownership =
          preValidatedOwnership ??
          validateBackgroundUpdateForRun(
            params,
            update,
            activeRun,
            mcpServer.pinnedTrajectory,
            mcpServer.minStepIdx,
          )
        if (!ownership.valid) return
        const record = buildCompactPostCutoffBackgroundRecord(update, ownership)
        if (!record) return
        const recordBytes = estimateCompactBackgroundRecordBytes(record)
        const nextBytes = postCutoffBgQueuedBytes + recordBytes
        if (
          postCutoffBgQueuedCount >= AGY_MAX_POST_CUTOFF_BG_PENDING ||
          nextBytes > AGY_MAX_POST_CUTOFF_BG_BYTES
        ) {
          activeRun.backgroundUnconfirmed = true
          reportUnknown(
            'Antigravity post-cutoff background update queue exceeded working-memory budget; coverage is incomplete.',
          )
          return
        }
        try {
          postCutoffBgMemoryReservation?.resize(nextBytes)
        } catch {
          activeRun.backgroundUnconfirmed = true
          reportUnknown(
            'Antigravity post-cutoff background update queue exceeded shared working-memory budget; coverage is incomplete.',
          )
          return
        }
        postCutoffBgQueuedCount += 1
        postCutoffBgQueuedBytes = nextBytes
        postCutoffBackgroundTail = postCutoffBackgroundTail
          .then(() =>
            this.handlePostTurnBackgroundUpdate({
              record,
              input,
              activeRun: activeRun!,
              observedBackgroundTask,
              canSettleEffects: () => !unknownEffectsReported,
              isRootTerminal: () => rootTerminal,
              seenForegroundMessageIds,
              isForegroundDedupIncomplete: () => foregroundDedupIncomplete,
              hasOmittedForegroundIdWithoutStep: () => omittedForegroundIdLacksTrustedStep,
              getMaxForegroundStepIdx: () => maxForegroundStepIdx,
              getPinnedTrajectory: () => mcpServer.pinnedTrajectory,
              getMinStepIdx: () => mcpServer.minStepIdx,
              reportedBackgroundMessageIds,
              reportUnknown,
            }),
          )
          .catch(() => undefined)
          .finally(() => {
            postCutoffBgQueuedCount = Math.max(0, postCutoffBgQueuedCount - 1)
            postCutoffBgQueuedBytes = Math.max(0, postCutoffBgQueuedBytes - recordBytes)
            postCutoffBgMemoryReservation?.resize(postCutoffBgQueuedBytes)
          })
      }

      // Abort handler: distinguishes pre-write abort (`not_sent`) from post-write `session/cancel`
      // with a bounded settlement window for a real native `{ stopReason: 'cancelled' }` reply.
      const onCallerAbort = (): void => {
        if (rootTerminal) return
        userCancelRequested = true
        if (activeRun) activeRun.cancellationPending = true
        for (const ctrl of interactionControllers) ctrl.abort()
        if (!rootFirstByteWritten) {
          promptRpcAbort.abort()
          return
        }
        if (promptSettled) return
        void connection.notify('session/cancel', { sessionId: resolvedSessionId }, {}).catch(() => {
          if (!rootTerminal) {
            reportUnknown(
              'Native Antigravity cancellation could not be confirmed; observation remains active.',
            )
          }
        })
        if (cancelGraceTimer === undefined) {
          cancelGraceTimer = setTimeout(() => {
            cancelGraceTimer = undefined
            promptRpcAbort.abort()
          }, AGY_PHYSICAL_SETTLEMENT_GRACE_MS)
          cancelGraceTimer.unref?.()
        }
      }
      signal.addEventListener('abort', onCallerAbort, { once: true })
      if (signal.aborted) {
        onCallerAbort()
      }

      // Dispatch `session/prompt` with ordered reply delivery (`replyTo: sessionStream`).
      let rootWithheldByGuard = false
      const promptParams: Record<string, unknown> = {
        sessionId: resolvedSessionId,
        prompt: promptBlocks,
        ...systemPromptMeta,
      }

      await stopPrePromptDrain(true)
      await throwIfPrePromptStreamClosed()

      promptEnteredTransport = true
      const promptOp = connection.requestOwned('session/prompt', promptParams, {
        timeoutMs: undefined,
        signal: promptRpcAbort.signal,
        replyTo: sessionStream,
        canDispatch: () => {
          if (this.disposed || signal.aborted || userCancelRequested) return false
          if (input.recovery?.canDispatch && !input.recovery.canDispatch()) {
            rootWithheldByGuard = true
            return false
          }
          return true
        },
        onDispatch: () => {
          rootFirstByteWritten = true
          promptMemoryReservation?.release()
          promptMemoryReservation = undefined
          input.recordDispatch?.('possibly_sent', resolvedSessionId, activeExecutorId)
        },
      })

      let promptResponse: object | undefined
      let parsedPromptTerminalReply: ParsedAgyPromptTerminalReply | undefined
      let promptRpcResolvedResponse: object | undefined
      let promptError: Error | undefined
      let pumpError: Error | undefined
      let streamEnded = false
      const pumpAbort = new AbortController()
      stopStreamPump = (): void => {
        pumpAbort.abort()
      }

      const settlePromptFromResponse = (res: object): void => {
        promptResponse = res
        parsedPromptTerminalReply = parseAgyPromptTerminalReply(res, resolvedSessionId)
        promptSettled = true
        promptReplyReceived = true
        abortOutstandingInteractions()
        if (activeRun) {
          activeRun.promptReplyReceived = true
          if (
            parsedPromptTerminalReply.ok &&
            parsedPromptTerminalReply.executionId &&
            !activeRun.providerExecutionId &&
            !activeRun.knownForeignExecutionIds.has(parsedPromptTerminalReply.executionId)
          ) {
            this.bindRootExecutionId(activeRun, input, parsedPromptTerminalReply.executionId)
          }
          this.notifyRootExecutionWaiters(activeRun)
        }
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer)
          cancelGraceTimer = undefined
        }
        notifyEventLoop()
      }

      void promptOp.result.then(
        (res) => {
          promptRpcResolvedResponse = res
          // Normal path waits for the ordered `{ kind: 'reply', seq }` ingress frame on `sessionStream`
          // so all notifications with `seq < cutoffSeq` are guaranteed pre-cutoff.
          // If the stream already ended before delivering the reply frame, settle immediately.
          if (streamEnded && !promptSettled) {
            settlePromptFromResponse(res)
          }
          return undefined
        },
        (err: unknown) => {
          promptError ??= err instanceof Error ? err : new Error(String(err))
          promptSettled = true
          promptReplyReceived = true
          abortOutstandingInteractions()
          if (activeRun) {
            activeRun.promptReplyReceived = true
            this.notifyRootExecutionWaiters(activeRun)
          }
          if (cancelGraceTimer !== undefined) {
            clearTimeout(cancelGraceTimer)
            cancelGraceTimer = undefined
          }
          pumpAbort.abort()
          notifyEventLoop()
          return undefined
        },
      )

      const answer = new AgentAnswerAssembler(input.runId)
      let totalToolStateBytes = 0
      const resizeToolStateBytes = (state: AgyToolState, nextBytes: number): void => {
        const clamped = Math.max(0, nextBytes)
        const delta = clamped - state.reservedBytes
        if (delta === 0) return
        if (totalToolStateBytes + delta > AGY_MAX_TOOL_STATE_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity in-flight tool call payloads exceeded the 8 MiB working-memory budget.',
            false,
          )
        }
        totalToolStateBytes = Math.max(0, totalToolStateBytes + delta)
        state.reservedBytes = clamped
        toolStateMemoryReservation?.resize(totalToolStateBytes)
      }
      const reasoningItems = new Map<string, string>()
      let reasoningBytes = 0
      let currentMessageIndex = 0
      let currentThoughtIndex = 0
      let reviewResult: CollaborationReviewObservation | undefined
      let inputResult: CollaborationInputObservation | undefined
      let planRetained = false
      let publishedOpenPlan: { nativeId: string; text: string } | undefined
      let openPlanPublishFailed = false
      let openPlanUnavailableRecorded = false
      let sessionTitleEmitted = false

      const observeFiles = (evidence: Parameters<typeof recordNativeChanges>[1]): void => {
        if (recordings.size >= 8) {
          nativeEffectsUncertain(
            input,
            'Native Antigravity file observation exceeded its bounded recording queue.',
            'recorded_files',
          )
          reportUnknown('Native file recording queue exceeded capacity.')
          return
        }
        const task = recordingTail.then(() =>
          recordNativeChanges(input, evidence, observation.signal),
        )
        recordingTail = task
        recordings.add(task)
        void task.finally(() => recordings.delete(task))
      }

      const projectValidatedFrame = (
        validated: ValidatedAgyFrame,
      ): Generator<NormalizedAgentEvent> => {
        const receivedAfterPromptReply =
          promptCutoffSeq !== undefined && validated.seq > promptCutoffSeq
        return this.projectSessionNotification({
          validated,
          receivedAfterPromptReply,
          input,
          activeRun: activeRun!,
          cwd: lease!.canonicalCwd,
          mcpServer,
          roundTracker,
          answer,
          tools,
          approvedBrainPlanCalls,
          resizeToolStateBytes,
          reasoningItems,
          getReasoningBytes: () => reasoningBytes,
          setReasoningBytes: (v) => {
            reasoningBytes = v
          },
          getMessageIndex: () => currentMessageIndex,
          bumpMessageIndex: () => {
            currentMessageIndex += 1
          },
          getThoughtIndex: () => currentThoughtIndex,
          bumpThoughtIndex: () => {
            currentThoughtIndex += 1
          },
          planModeStage,
          onBrainPlanTouched: () => {
            brainPlanTouched = true
          },
          onBrainPlanOpStarted: (callId) => {
            // Invalidate any prior Plan candidate as soon as a subsequent Plan mutation begins so
            // deferred readback or the newer body is always obtained before publication.
            latestBrainPlanCandidate = undefined
            const hasOtherActivePlanOp =
              activeBrainPlanOpCallIds.size > (activeBrainPlanOpCallIds.has(callId) ? 1 : 0)
            if (hasOtherActivePlanOp) {
              // Overlapping Phase-1 Plan ops MUST verify final disk body via storage readback.
              brainPlanReadbackRequired = true
            }
            activeBrainPlanOpCallIds.add(callId)
          },
          onBrainPlanDeferredReadback: (callId) => {
            activeBrainPlanOpCallIds.delete(callId)
            latestBrainPlanCandidate = undefined
            brainPlanReadbackRequired = true
          },
          onBrainPlanCaptured: (callId, candidate) => {
            activeBrainPlanOpCallIds.delete(callId)
            if (activeBrainPlanOpCallIds.size === 0 && !brainPlanReadbackRequired) {
              latestBrainPlanCandidate = candidate
              brainPlanCaptureFailed = false
              input.recordWorkflowPlan?.(candidate)
            } else {
              // Another concurrent Plan op was in flight or readback was already latched; defer to verified storage readback.
              brainPlanReadbackRequired = true
              latestBrainPlanCandidate = undefined
            }
          },
          onBrainPlanCaptureFailed: (callId) => {
            if (callId !== undefined) activeBrainPlanOpCallIds.delete(callId)
            brainPlanCaptureFailed = true
            latestBrainPlanCandidate = undefined
            input.recordWorkflowPlanUnavailable?.()
          },
          onReviewAccepted: (obs) => {
            reviewResult = mergeWorkflowReview(reviewResult, obs)
            input.recordWorkflowReview?.(reviewResult)
          },
          onInputResultAccepted: (obs) => {
            inputResult = mergeWorkflowInput(inputResult, obs)
            input.recordWorkflowInputResult?.(inputResult)
          },
          onPlanRetainedAccepted: () => {
            if (!brainPlanTouched && !hasUnresolvedBrainPlanWrite()) {
              planRetained = true
            }
          },
          onOpenPlanPublished: (plan) => {
            try {
              publishedPlanMemoryReservation?.resize(
                computeRetainedPlanTextBytes(plan.text) + plan.nativeId.length * 2,
              )
              publishedOpenPlan = plan
              openPlanPublishFailed = false
              openPlanUnavailableRecorded = false
              input.recordWorkflowPlan?.(plan)
            } catch {
              openPlanPublishFailed = true
              publishedOpenPlan = undefined
              if (!openPlanUnavailableRecorded) {
                openPlanUnavailableRecorded = true
                input.recordWorkflowPlanUnavailable?.()
              }
            } finally {
              mcpServer.clearPendingTransferredPlanBytes()
            }
          },
          onOpenPlanPublishFailed: () => {
            openPlanPublishFailed = true
            publishedOpenPlan = undefined
            if (!openPlanUnavailableRecorded) {
              openPlanUnavailableRecorded = true
              input.recordWorkflowPlanUnavailable?.()
            }
          },
          getSessionTitleEmitted: () => sessionTitleEmitted,
          markSessionTitleEmitted: () => {
            sessionTitleEmitted = true
          },
          recordSeenForegroundMessageId,
          recordForegroundStepIdx,
          onObservedBackgroundTask: () => {
            observedBackgroundTask = true
          },
          reportUnknown,
          observeFiles,
          signal,
        })
      }

      let stagedPreBindBytes = 0
      let foreignExecIdsBytes = 0
      const addKnownForeignExecutionId = (execId: string): void => {
        if (activeRun!.knownForeignExecutionIds.has(execId)) return
        const entryBytes = Buffer.byteLength(execId, 'utf8') + 32
        const nextBytes = foreignExecIdsBytes + entryBytes
        if (
          activeRun!.knownForeignExecutionIds.size >= AGY_MAX_FOREIGN_EXECUTION_IDS ||
          nextBytes > AGY_MAX_FOREIGN_EXECUTION_ID_BYTES
        ) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity foreign execution tracking exceeded working-memory budget.',
            false,
          )
        }
        foreignExecIdsMemoryReservation?.resize(nextBytes)
        foreignExecIdsBytes = nextBytes
        activeRun!.knownForeignExecutionIds.add(execId)
      }
      const clearStagedPreBindNotifications = (): void => {
        activeRun!.stagedPreBindNotifications.length = 0
        stagedPreBindBytes = 0
        stagedPreBindMemoryReservation?.resize(0)
      }

      function* drainStagedPreBindNotes(): Generator<NormalizedAgentEvent> {
        const boundExecId = activeRun!.providerExecutionId
        if (!boundExecId || activeRun!.stagedPreBindNotifications.length === 0) return
        const queued = activeRun!.stagedPreBindNotifications.splice(0)
        stagedPreBindBytes = 0
        stagedPreBindMemoryReservation?.resize(0)
        for (const staged of queued) {
          // Retain arrival-time attribution: execution-less frames observed while a foreign turn
          // was active, or frames carrying a different execution_id, never replay into this root.
          if (staged.frame.executionId !== boundExecId) {
            continue
          }
          if (staged.arrivedDuringForeignTurn && staged.frame.executionId === undefined) {
            continue
          }
          const rechecked = recheckValidatedFrameAgainstRootBoundary(
            staged.frame,
            mcpServer.pinnedTrajectory,
            mcpServer.minStepIdx,
          )
          yield* projectValidatedFrame(rechecked)
        }
      }

      const admitAndProjectValidatedFrame = function* (
        self: AgyAgentAdapter,
        validated: ValidatedAgyFrame,
      ): Generator<NormalizedAgentEvent> {
        if (activeRun!.providerExecutionId && activeRun!.stagedPreBindNotifications.length > 0) {
          yield* drainStagedPreBindNotes()
        }
        if (validated.method !== 'session/update') {
          return
        }
        const update = validated.payload
        const sessionUpdate = validated.sessionUpdate
        if (!update || !sessionUpdate) return

        const updateExecId = validated.executionId
        // Run contradiction guard BEFORE any execution binding, foreign-ID insertion,
        // staged-frame drain, or projection! Retain ONLY negative MCP revocation for disputed frames.
        const frameRootContradictsPinned =
          validated.hasForeignOrInvalidSessionMeta ||
          validated.executionIdInvalid ||
          validated.rootEvidenceContradicted ||
          (updateExecId !== undefined &&
            activeRun!.providerExecutionId !== undefined &&
            updateExecId !== activeRun!.providerExecutionId) ||
          (updateExecId !== undefined && activeRun!.knownForeignExecutionIds.has(updateExecId))
        if (frameRootContradictsPinned || !validated.isAttributableToCurrentSession) {
          if (
            validated.sessionAttribution !== 'pure_foreign' &&
            (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update')
          ) {
            const disputedTokens = validated.tokens.allCanonicalTokens
            const tcId = validated.toolCallIdInvalid ? undefined : validated.toolCallId
            if (tcId !== undefined || disputedTokens.length > 0) {
              mcpServer.revokeDisputedTokens(tcId, disputedTokens)
            }
          }
          return
        }

        if (
          activeRun!.resumedExistingSession &&
          (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') &&
          !validated.toolCallIdInvalid &&
          validated.toolCallId !== undefined &&
          prePromptReplayedToolCallIds.has(validated.toolCallId)
        ) {
          return
        }

        const updateMeta = Reflect.get(update, '_meta')
        const steerId =
          sessionUpdate === 'user_message_chunk'
            ? (asString(update.pactSteerInputId) ??
              (isPlainObject(updateMeta) ? asString(updateMeta.pactSteerInputId) : undefined))
            : undefined

        // Once root `providerExecutionId` is bound, strictly drop any update carrying a different `execution_id`!
        if (activeRun!.providerExecutionId !== undefined) {
          if (updateExecId !== undefined && updateExecId !== activeRun!.providerExecutionId) {
            return
          }
          yield* projectValidatedFrame(validated)
          return
        }

        // Session-level metadata updates without conflicting execution_id pass through safely.
        if (
          (sessionUpdate === 'available_commands_update' ||
            sessionUpdate === 'current_mode_update' ||
            sessionUpdate === 'config_option_update' ||
            sessionUpdate === 'usage_update') &&
          updateExecId === undefined
        ) {
          yield* projectValidatedFrame(validated)
          return
        }

        // Before root `providerExecutionId` is bound:
        if (sessionUpdate === 'user_message_chunk') {
          if (steerId) {
            yield* projectValidatedFrame(validated)
            return
          }
          const chunkIdentity = extractUserChunkPactIdentity(update)
          const normalizedChunkText = chunkIdentity.text?.trim()
          const expectedPromptContent = currentEnvelope.message.content.trim()
          // Bind root execution strictly from exact host run receipt (`pactRunId === input.runId`)
          // or exact normalized full prompt proof — never substring `.includes(...)`!
          const hasExactHostRunReceipt = chunkIdentity.pactRunId === input.runId
          const hasExactFullPromptProof =
            chunkIdentity.pactRunId === undefined &&
            normalizedChunkText !== undefined &&
            expectedFullPromptText.length > 0 &&
            normalizedChunkText === expectedFullPromptText
          const hasExactPlainPromptProof =
            updateExecId === undefined &&
            chunkIdentity.pactRunId === undefined &&
            normalizedChunkText !== undefined &&
            expectedPromptContent.length > 0 &&
            normalizedChunkText === expectedPromptContent
          const matchesRootPrompt =
            hasExactHostRunReceipt || hasExactFullPromptProof || hasExactPlainPromptProof
          if (matchesRootPrompt) {
            activeRun!.foreignTurnActiveUntilRootBound = false
            if (updateExecId && (hasExactHostRunReceipt || hasExactFullPromptProof)) {
              self.bindRootExecutionId(activeRun!, input, updateExecId)
              yield* drainStagedPreBindNotes()
            }
            yield* projectValidatedFrame(validated)
            return
          }
          // Foreign user_message_chunk on the session!
          if (updateExecId) {
            addKnownForeignExecutionId(updateExecId)
          }
          activeRun!.foreignTurnActiveUntilRootBound = true
          return
        }

        const hasConcurrentRun = self.hasOtherActiveRunOnSession(activeRun!)
        const canBindFromInitialUpdate =
          updateExecId !== undefined &&
          !activeRun!.resumedExistingSession &&
          activeRun!.steeredInputs.size === 0 &&
          !activeRun!.foreignTurnActiveUntilRootBound &&
          !hasConcurrentRun

        if (canBindFromInitialUpdate) {
          self.bindRootExecutionId(activeRun!, input, updateExecId)
          yield* drainStagedPreBindNotes()
          yield* projectValidatedFrame(validated)
          return
        }

        // Execution-less frames arriving while a foreign turn is active belong to the foreign turn
        // and must NEVER be replayed into our subsequently bound root.
        if (activeRun!.foreignTurnActiveUntilRootBound && updateExecId === undefined) {
          return
        }

        if (updateExecId !== undefined) {
          const frameBytes = estimateJsonPayloadBytes(
            validated.message,
            AGY_MAX_STAGED_PRE_BIND_BYTES,
          )
          const nextStagedBytes = stagedPreBindBytes + frameBytes
          if (
            activeRun!.stagedPreBindNotifications.length >= AGY_MAX_STAGED_PRE_BIND_FRAMES ||
            nextStagedBytes > AGY_MAX_STAGED_PRE_BIND_BYTES
          ) {
            throw new AgentExecutionError(
              'response_too_large',
              'Antigravity pre-bind staged updates exceeded working-memory budget.',
              false,
            )
          }
          stagedPreBindMemoryReservation?.resize(nextStagedBytes)
          stagedPreBindBytes = nextStagedBytes
          activeRun!.stagedPreBindNotifications.push({
            frame: validated,
            bytes: frameBytes,
            arrivedDuringForeignTurn: activeRun!.foreignTurnActiveUntilRootBound,
          })
          return
        }

        yield* projectValidatedFrame(validated)
      }

      const routePostCutoffIngress = (item: AgyIngress): void => {
        if (item.kind === 'server_request') {
          handleOrderedServerRequest(item)
          return
        }
        if (item.kind !== 'notification') return
        if (asString(Reflect.get(item.message, 'method')) !== 'session/update') return
        const params = Reflect.get(item.message, 'params')
        if (!isPlainObject(params)) return
        const sid = asString(params.sessionId ?? params.session_id)
        if (sid !== resolvedSessionId || !isPlainObject(params.update)) return
        enqueuePostCutoffBackgroundUpdate(params, params.update)
      }

      const dispatchOrderedIngress = (item: AgyIngress): void => {
        if (item.kind === 'end') {
          streamEnded = true
          if (promptCutoffSeq === undefined) {
            if (promptRpcResolvedResponse && !promptSettled) {
              settlePromptFromResponse(promptRpcResolvedResponse)
            } else if (!promptError) {
              if (!activeRun!.turnAccepted && connection.isOpen) {
                void connection
                  .notify('session/cancel', { sessionId: resolvedSessionId! }, {})
                  .catch(() => undefined)
              }
              promptError ??= new AgentExecutionError(
                item.cause === 'deadline' ? 'transient_transport' : 'agent_process_crash',
                item.detail ?? 'Antigravity session stream ended before prompt settlement.',
                item.cause === 'deadline',
              )
              promptSettled = true
              promptReplyReceived = true
              abortOutstandingInteractions()
              if (activeRun) {
                activeRun.promptReplyReceived = true
                this.notifyRootExecutionWaiters(activeRun)
              }
              promptRpcAbort.abort()
              notifyEventLoop()
            }
          }
          return
        }

        if (item.kind === 'reply') {
          if (item.requestId === promptOp.requestId && promptCutoffSeq === undefined) {
            promptCutoffSeq = item.seq
            settlePromptFromResponse(item.message)
          }
          return
        }

        // Strict stdout-order post-cutoff routing: even while foreground is still yielding or
        // awaiting `waitForRootOutput()` / `recordingTail`, post-cutoff updates flow immediately
        // into the serialized background observer without blocking or contaminating foreground state.
        if (promptCutoffSeq !== undefined) {
          routePostCutoffIngress(item)
          return
        }

        // Pre-cutoff ordered frame (`item.seq < promptCutoffSeq`).
        mcpServer.beginWakeBatch()
        try {
          if (item.kind === 'server_request') {
            handleOrderedServerRequest(item)
            return
          }
          if (!rootFirstByteWritten && item.kind === 'notification') {
            const method = asString(Reflect.get(item.message, 'method'))
            const params = Reflect.get(item.message, 'params')
            const update = isPlainObject(params) ? Reflect.get(params, 'update') : undefined
            const sessionUpdate = isPlainObject(update) ? asString(update.sessionUpdate) : undefined
            if (
              method === 'session/update' &&
              (!sessionUpdate || !AGY_SESSION_METADATA_UPDATES.has(sessionUpdate))
            ) {
              if (resolvedSessionId !== undefined) {
                observePrePromptNotification(item.message, resolvedSessionId)
              }
              return
            }
          }
          const validated = validateAgyFrame(
            item,
            resolvedSessionId,
            mcpServer.pinnedTrajectory,
            mcpServer.minStepIdx,
          )
          for (const ev of admitAndProjectValidatedFrame(this, validated)) {
            pushPendingEvent(ev)
          }
        } finally {
          mcpServer.endWakeBatch()
        }
      }

      // Zero-gap handoff from `orderedStream` to `subscribeBackground` when retaining background tasks:
      // 1. Arm `subscribeBackground` FIRST (so no subsequent stdout frame can slip through).
      // 2. Synchronously drain all buffered post-cutoff frames from `sessionStream.shift()`.
      // 3. Close `sessionStream`.
      handoffOrderedStreamToBackground = (): void => {
        if (!activeRun || unsubscribeBackground) return
        const trackedRun = activeRun
        const trackedSessionId = resolvedSessionId!
        unsubscribeBackground = connection.subscribeBackground((message) => {
          if (asString(Reflect.get(message, 'method')) !== 'session/update') {
            return false
          }
          const params = Reflect.get(message, 'params')
          if (!isPlainObject(params)) return false
          const sid = asString(params.sessionId ?? params.session_id)
          if (sid !== trackedSessionId) return false
          const update = params.update
          if (!isPlainObject(update)) return false

          // Explicitly different execution, session, trajectory, step lower bound, or progressToken
          // ALWAYS vetoes alias matches!
          const ownership = validateBackgroundUpdateForRun(
            params,
            update,
            trackedRun,
            mcpServer.pinnedTrajectory,
            mcpServer.minStepIdx,
          )
          if (!ownership.valid) {
            return false
          }

          let hasNewerActiveRun = false
          for (const other of this.activeRuns.values()) {
            if (
              other !== trackedRun &&
              other.nativeSessionId === trackedSessionId &&
              !other.rootTerminal
            ) {
              hasNewerActiveRun = true
              break
            }
          }
          if (hasNewerActiveRun) {
            // Even after a newer foreground Run starts on the same nativeSessionId, allow the older
            // retained Run to consume updates ONLY when validated owner matches AND aliases/execution match.
            const rawOutput = isPlainObject(update.rawOutput) ? update.rawOutput : undefined
            const taskId =
              asString(update.taskId ?? update.backgroundTaskId) ??
              (rawOutput ? asString(rawOutput.taskId ?? rawOutput.backgroundTaskId) : undefined)
            const toolCallId = asString(update.toolCallId ?? update.id)
            const execId = ownership.executionId
            const explicitlyOwnedByOldRun =
              (taskId !== undefined &&
                (trackedRun.backgroundTaskAliases.has(taskId) ||
                  trackedRun.activeBackgroundTasks.has(taskId))) ||
              (toolCallId !== undefined &&
                (trackedRun.backgroundTaskAliases.has(toolCallId) ||
                  trackedRun.activeBackgroundTasks.has(toolCallId))) ||
              (execId !== undefined &&
                trackedRun.providerExecutionId !== undefined &&
                execId === trackedRun.providerExecutionId)
            if (!explicitlyOwnedByOldRun) {
              return false
            }
          }
          enqueuePostCutoffBackgroundUpdate(params, update, ownership)
          return true
        })

        if (sessionStream) {
          while (true) {
            const buffered = sessionStream.shift()
            if (!buffered) break
            if (promptCutoffSeq !== undefined && buffered.seq <= promptCutoffSeq) continue
            routePostCutoffIngress(buffered)
          }
          sessionStream.close()
          sessionStream = undefined
        }
      }

      // Continuous async frame pump over `sessionStream` with bounded backpressure on `pendingEvents`.
      const isPumpActive = (): boolean =>
        !pumpAbort.signal.aborted && !streamEnded && sessionStream !== undefined
      void (async () => {
        try {
          while (isPumpActive()) {
            if (isPendingEventsAtSoftCap() && promptCutoffSeq === undefined) {
              // oxlint-disable-next-line no-await-in-loop -- Apply backpressure to ordered stream when generator consumer lags.
              await new Promise<void>((resolveDrain) => {
                wakePumpForBackpressure = resolveDrain
                if (!isPumpActive() || !isPendingEventsAtSoftCap()) {
                  wakePumpForBackpressure = undefined
                  resolveDrain()
                }
              })
              if (!isPumpActive()) break
            }
            let drainedAny = false
            const canDrainPendingIngress = (): boolean =>
              !isPendingEventsAtSoftCap() || promptCutoffSeq !== undefined
            while (isPumpActive() && canDrainPendingIngress()) {
              const buffered = sessionStream?.shift()
              if (!buffered) break
              drainedAny = true
              dispatchOrderedIngress(buffered)
            }
            if (!isPumpActive() || !sessionStream) break
            if (drainedAny) continue
            let nextItem: AgyIngress
            try {
              // oxlint-disable-next-line no-await-in-loop -- Continuous ordered ingress pump independent of generator yield backpressure.
              nextItem = await sessionStream.nextIngress(undefined, pumpAbort.signal)
            } catch (waitErr) {
              if (pumpAbort.signal.aborted) break
              const err = waitErr instanceof Error ? waitErr : new Error(String(waitErr))
              if (promptCutoffSeq === undefined) {
                if (!activeRun.turnAccepted && connection.isOpen) {
                  void connection
                    .notify('session/cancel', { sessionId: resolvedSessionId }, {})
                    .catch(() => undefined)
                }
                promptError ??= err
                promptSettled = true
                promptReplyReceived = true
                abortOutstandingInteractions()
                if (activeRun) {
                  activeRun.promptReplyReceived = true
                  this.notifyRootExecutionWaiters(activeRun)
                }
                promptRpcAbort.abort()
                notifyEventLoop()
              }
              break
            }
            dispatchOrderedIngress(nextItem)
          }
        } catch (err) {
          pumpError ??= err instanceof Error ? err : new Error(String(err))
          promptError ??= pumpError
          promptSettled = true
          promptReplyReceived = true
          abortOutstandingInteractions()
          if (activeRun) {
            activeRun.promptReplyReceived = true
            this.notifyRootExecutionWaiters(activeRun)
          }
          promptRpcAbort.abort()
          notifyEventLoop()
        }
      })()

      try {
        while (true) {
          while (pendingEvents.length > 0) {
            const nextEv = shiftPendingEvent()
            if (nextEv) yield nextEv
          }
          if (activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
            for (const ev of drainStagedPreBindNotes()) {
              yield ev
            }
          }
          if (promptSettled) {
            while (pendingEvents.length > 0) {
              const nextEv = shiftPendingEvent()
              if (nextEv) yield nextEv
            }
            if (activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
              for (const ev of drainStagedPreBindNotes()) {
                yield ev
              }
            }
            break
          }
          // oxlint-disable-next-line no-await-in-loop -- Generator yields events as the independent frame pump pushes them.
          await new Promise<void>((resolveWake) => {
            wakeEventLoop = resolveWake
          })
        }

        // Fence steer dispatch BEFORE releasing the root Turn, and verify any dispatched steer receipts.
        rootReleasing = true
        activeRun.rootReleasing = true
        signal.removeEventListener('abort', onCallerAbort)
        if (cancelGraceTimer !== undefined) {
          clearTimeout(cancelGraceTimer)
          cancelGraceTimer = undefined
        }

        if (pumpError) {
          promptError = pumpError
        }
        if (promptError) {
          promptRpcAbort.abort()
          const physical = await awaitPhysicalCompletionBounded(promptOp.physicalOutcome)
          if (physical === 'not_sent' && !rootFirstByteWritten) {
            rootConfirmedNotSent = true
            input.recordDispatch?.('rejected', resolvedSessionId, activeExecutorId)
            if (input.recovery && appliedSettings) {
              const unsent = createAgyRootFrameNotWrittenProof({
                runId: input.runId,
                bindingGeneration: input.bindingGeneration ?? 1,
                nativeGeneration: input.nativeGeneration ?? input.runId,
                executorId: activeExecutorId,
                nativeSessionId: resolvedSessionId,
                inputSha256: input.recovery.inputSha256,
                appliedSettings,
                requestId: promptOp.requestId,
                physicalCompletion: physical,
              })
              if (unsent) {
                input.recovery.recordConfirmedUnsent(unsent.boundary, {
                  executorId: activeExecutorId,
                  nativeSessionId: resolvedSessionId,
                })
              }
            }
            if (rootWithheldByGuard) {
              throw new NativeInputWithheldError(
                'Antigravity root prompt was withheld by the recovery dispatch guard before any byte was written.',
              )
            }
          } else if (physical === 'invalid_reply') {
            reportUnknown(
              'Antigravity received an invalid session/prompt response after request bytes were written.',
            )
          } else {
            reportUnknown(
              userCancelRequested
                ? 'Antigravity cancellation did not receive a confirmed native terminal settlement.'
                : !activeRun.turnAccepted
                  ? 'Antigravity prompt write started without Turn acceptance confirmation.'
                  : 'Antigravity Turn ended without confirmed native terminal settlement.',
            )
          }
          throw promptError
        }

        const parsedTerminal =
          parsedPromptTerminalReply ??
          parseAgyPromptTerminalReply(promptResponse, resolvedSessionId)
        if (!parsedTerminal.ok) {
          reportUnknown(parsedTerminal.reason)
          throw new AgentExecutionError('protocol_error', parsedTerminal.message, false)
        }
        const stopReason = parsedTerminal.stopReason
        const respExecId = parsedTerminal.executionId
        if (respExecId) {
          if (activeRun.knownForeignExecutionIds.has(respExecId)) {
            reportUnknown(
              'Antigravity root session/prompt execution_id matched a known foreign execution.',
            )
            throw new AgentExecutionError(
              'protocol_error',
              'Antigravity root session/prompt execution_id matched a known foreign execution.',
              false,
            )
          }
          if (activeRun.providerExecutionId && activeRun.providerExecutionId !== respExecId) {
            reportUnknown(
              'Antigravity root session/prompt execution_id conflicted with streamed updates.',
            )
            throw new AgentExecutionError(
              'protocol_error',
              'Antigravity root session/prompt execution_id conflicted with streamed updates.',
              false,
            )
          }
          this.bindRootExecutionId(activeRun, input, respExecId)
        }
        this.notifyRootExecutionWaiters(activeRun)

        if (activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
          for (const ev of drainStagedPreBindNotes()) {
            yield ev
          }
        }
        if (!activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
          const hasSubstantiveUnresolved = activeRun.stagedPreBindNotifications.some((staged) => {
            const execId = staged.frame.executionId
            if (execId !== undefined && activeRun!.knownForeignExecutionIds.has(execId)) {
              return false
            }
            if (staged.arrivedDuringForeignTurn) return false
            const kind = staged.frame.sessionUpdate
            return (
              kind === 'agent_message_chunk' ||
              kind === 'agent_thought_chunk' ||
              kind === 'tool_call' ||
              kind === 'tool_call_update' ||
              kind === 'background_task_completed'
            )
          })
          if (hasSubstantiveUnresolved) {
            unresolvedPreBindOutput = true
            reportUnknown(
              'Antigravity terminal reply completed without binding execution_id for staged updates; output completeness cannot be confirmed.',
            )
          }
        }
        clearStagedPreBindNotifications()

        if (!activeRun.turnAccepted) {
          activeRun.turnAccepted = true
          input.recordDispatch?.('accepted', resolvedSessionId, activeExecutorId)
          yield { agentId: 'agy', type: 'turn.started', turnId: input.runId }
        }

        if (activeRun.pendingSteerOperations.size > 0) {
          await Promise.allSettled(activeRun.pendingSteerOperations)
        }

        const postReplyCheckSignal = stopReason === 'cancelled' ? signal : observation.signal

        // Verify any in-Turn steer writes before releasing the root Turn (`B8`).
        await this.verifySteerReceiptsBeforeRootRelease(
          activeRun,
          input,
          reportUnknown,
          postReplyCheckSignal,
        )

        // Complete any open reasoning items.
        for (const [idxKey, text] of reasoningItems) {
          if (text) {
            yield {
              agentId: 'agy',
              type: 'reasoning.summary.completed',
              turnId: input.runId,
              activityId: `${input.runId}:thought:${idxKey}`,
              text,
            }
          }
        }
        reasoningItems.clear()

        // If a brain plan write was touched and did not capture inline (or readback was latched due to
        // overlapping ops / deferred edit readback), inspect through the isolated storage client
        // (NEVER direct Utility `fs.open`!) for the SAME execution.
        if (
          planModeStage &&
          (latestBrainPlanCandidate === undefined || brainPlanReadbackRequired) &&
          !brainPlanCaptureFailed
        ) {
          if (brainPlanTouched && !hasUnresolvedBrainPlanWrite()) {
            const inspected = this.options.storageClient?.inspectRun
              ? await this.options.storageClient
                  .inspectRun(
                    {
                      appDataDir: this.primaryAppDataDir,
                      cwd: lease.canonicalCwd,
                      nativeSessionId: resolvedSessionId,
                      nativeTurnId: activeRun.providerExecutionId ?? activeRun.nativeTurnId,
                      includePlan: true,
                    },
                    postReplyCheckSignal,
                  )
                  .catch(() => undefined)
              : await this.getOwnedForkFiles()
                  .inspectAgyRun(
                    {
                      cwd: lease.canonicalCwd,
                      storageRoot: this.primaryAppDataDir,
                      nativeSessionId: resolvedSessionId,
                      nativeTurnId: activeRun.providerExecutionId ?? activeRun.nativeTurnId,
                      includePlan: true,
                    },
                    postReplyCheckSignal,
                  )
                  .catch(() => undefined)
            const terminal = inspected?.exists ? inspected.terminalState : undefined
            const matchesExecution =
              terminal !== undefined &&
              !terminal.planUnavailable &&
              (activeRun.providerExecutionId === undefined ||
                terminal.executionId === activeRun.providerExecutionId)
            if (matchesExecution && terminal.plan?.text.trim()) {
              latestBrainPlanCandidate = {
                nativeId:
                  terminal.plan.nativeId ||
                  buildBoundedNativePlanId(resolvedSessionId, 'implementation_plan'),
                text: terminal.plan.text,
              }
              brainPlanReadbackRequired = false
              input.recordWorkflowPlan?.(latestBrainPlanCandidate)
            } else {
              brainPlanCaptureFailed = true
              latestBrainPlanCandidate = undefined
              input.recordWorkflowPlanUnavailable?.()
            }
          }
        }

        await recordingTail
        await input.waitForRootOutput?.()
        await postCutoffBackgroundTail

        const finalSnapshot = answer.finalize()
        if (finalSnapshot !== undefined && !unresolvedPreBindOutput) {
          yield {
            agentId: 'agy',
            type: 'text.completed',
            turnId: input.runId,
            outputId: answer.outputId,
            text: finalSnapshot,
          }
        }

        // Preserve verified native `stopReason` (`end_turn` -> `completed`) even if Stop (`signal.aborted`)
        // arrived late while draining foreground output!
        const outcome: 'completed' | 'interrupted' | 'failed' =
          stopReason === 'cancelled'
            ? 'interrupted'
            : stopReason === 'end_turn' || stopReason === 'stop_sequence'
              ? 'completed'
              : 'failed'

        // Record negative plan unavailability OUTSIDE `!unknownEffectsReported` so recovery is never
        // suppressed when an open-mode final `publish_plan` was acknowledged without confirmed ACP promotion
        // or when a Phase-1 brain plan write failed.
        if (outcome === 'completed') {
          if (planModeStage) {
            if (
              hasUnresolvedBrainPlanWrite() ||
              brainPlanCaptureFailed ||
              brainPlanReadbackRequired
            ) {
              input.recordWorkflowPlanUnavailable?.()
            }
          } else if (
            openPlanPublishFailed ||
            (mcpServer.hasAcknowledgedFinalOpenPlan && !publishedOpenPlan)
          ) {
            if (!openPlanUnavailableRecorded) {
              openPlanUnavailableRecorded = true
              input.recordWorkflowPlanUnavailable?.()
            }
          }
        }

        // Promote collaboration artifacts ONLY after normal root completion & settlement (`B6`).
        if (outcome === 'completed' && !unknownEffectsReported && !unresolvedPreBindOutput) {
          if (planModeStage) {
            if (
              !hasUnresolvedBrainPlanWrite() &&
              !brainPlanCaptureFailed &&
              !brainPlanReadbackRequired
            ) {
              if (latestBrainPlanCandidate) {
                yield {
                  agentId: 'agy',
                  type: 'collaboration.plan',
                  turnId: input.runId,
                  nativeId: latestBrainPlanCandidate.nativeId,
                  text: latestBrainPlanCandidate.text,
                }
              } else if (planRetained && authorization?.planReference) {
                const planDoc = authorization.planReference.document
                input.recordWorkflowPlanRetained?.({
                  nativeId: buildBoundedNativePlanId(resolvedSessionId, 'retained'),
                  sha256: planDoc.sha256,
                  bytes: planDoc.bytes,
                  chars: planDoc.chars,
                  confirmation: 'native_root_settled_v1',
                })
              }
            }
          } else if (
            !openPlanPublishFailed &&
            !(mcpServer.hasAcknowledgedFinalOpenPlan && !publishedOpenPlan) &&
            publishedOpenPlan
          ) {
            yield {
              agentId: 'agy',
              type: 'collaboration.plan',
              turnId: input.runId,
              nativeId: publishedOpenPlan.nativeId,
              text: publishedOpenPlan.text,
            }
          }
          if (reviewResult) {
            yield {
              agentId: 'agy',
              type: 'collaboration.review',
              turnId: input.runId,
              verdict: reviewResult.verdict,
              ...(reviewResult.questions ? { questions: reviewResult.questions } : {}),
            }
          }
        }

        rootTerminal = true
        activeRun.rootTerminal = true

        const settledPlan = latestBrainPlanCandidate ?? publishedOpenPlan
        const outputCompleteness: 'complete' | 'partial' =
          outcome === 'completed' && !unresolvedPreBindOutput ? 'complete' : 'partial'
        const terminalEvidence: Parameters<AgyAgentAdapter['recordEvidence']>[3] = {
          kind: 'ended',
          source: 'live_terminal',
          outcome,
          ...(answer.text || (outcome === 'completed' && !unresolvedPreBindOutput && settledPlan)
            ? {
                output: {
                  outputId: answer.outputId,
                  text: answer.text,
                  completeness: outputCompleteness,
                  ...(outcome === 'completed' && !unresolvedPreBindOutput && settledPlan
                    ? { plan: settledPlan }
                    : {}),
                  ...(outcome === 'completed' && !unresolvedPreBindOutput && reviewResult
                    ? { reviewVerdict: reviewResult.verdict, reviewResult }
                    : {}),
                  ...(outcome === 'completed' && !unresolvedPreBindOutput && inputResult
                    ? { inputOutcome: inputResult.outcome, inputResult }
                    : {}),
                },
              }
            : {}),
        }

        if (unresolvedPreBindOutput && outcome === 'completed') {
          // When unresolved substantive pre-bind frames remain after emitting a visible prefix,
          // emit `turn.completed { outcome: 'failed' }` (without `text.completed`) so SQLite marks
          // the truncated prefix `incomplete`, then record the independently verified native
          // outcome with `completeness: 'partial'` so `nativeOutcome` stays preserved.
          yield {
            agentId: 'agy',
            type: 'turn.completed',
            turnId: input.runId,
            outcome: 'failed',
          }
          this.recordEvidence(
            input,
            resolvedSessionId,
            activeExecutorId,
            terminalEvidence,
            activeRun.nativeTurnId,
          )
        } else {
          this.recordEvidence(
            input,
            resolvedSessionId,
            activeExecutorId,
            terminalEvidence,
            activeRun.nativeTurnId,
          )

          if (
            !unknownEffectsReported &&
            !unresolvedPreBindOutput &&
            !activeRun.backgroundUnconfirmed &&
            activeRun.activeBackgroundTasks.size === 0
          ) {
            nativeFileChangesSettled(input, 'settled', 'native_work_drained')
          }

          yield {
            agentId: 'agy',
            type: 'turn.completed',
            turnId: input.runId,
            outcome,
          }
        }
      } finally {
        clearPendingEvents()
        clearStagedPreBindNotifications()
        prePromptReplayedToolCallIds.clear()
        answer.dispose()
      }
    } catch (error) {
      rootTerminal = true
      if (activeRun) {
        activeRun.rootTerminal = true
        this.notifyRootExecutionWaiters(activeRun)
      }
      if (cancelGraceTimer !== undefined) {
        clearTimeout(cancelGraceTimer)
        cancelGraceTimer = undefined
      }
      promptRpcAbort.abort()
      await stopPrePromptDrain?.(false).catch(() => undefined)
      stopStreamPump?.()
      this.invalidateNonTerminalEvidence(input.runId, resolvedSessionId)
      await recordingTail.catch(() => undefined)
      const confirmedZeroBytesSent = isConfirmedZeroBytesSent()
      if (!unknownEffectsReported) {
        if (confirmedZeroBytesSent) {
          if (activeRun) {
            nativeFileChangesSettled(input, 'settled', 'native_work_drained')
          }
        } else {
          reportUnknown(
            unknownEffectsReason ??
              'Antigravity failed before its native Turn effects could be confirmed.',
          )
        }
      }
      throw error
    } finally {
      await finalizeRun({ emergency: false })
    }
  }

  async steer(steerInput: AgentSteerInput, signal: AbortSignal): Promise<AgentSteerResult> {
    if (signal.aborted || this.disposed) {
      return { status: 'rejected', reason: 'Antigravity steer request was cancelled.' }
    }
    const activeRun = this.activeRuns.get(steerInput.runId)
    if (
      !activeRun ||
      !activeRun.isSteerLeaseOpen() ||
      activeRun.steeringInFlight ||
      activeRun.nativeSessionId !== steerInput.nativeSessionId ||
      activeRun.bindingGeneration !== steerInput.bindingGeneration ||
      activeRun.nativeGeneration !== steerInput.nativeGeneration ||
      (steerInput.nativeTurnId !== activeRun.nativeTurnId &&
        steerInput.nativeTurnId !== steerInput.runId)
    ) {
      return {
        status: 'rejected',
        reason: 'The Antigravity root Turn lease is not active for steering.',
      }
    }
    if (activeRun.steeredInputs.size >= AGY_MAX_STEERING_INPUTS) {
      return {
        status: 'rejected',
        reason: 'Antigravity reached the maximum in-Turn steer input limit (63).',
      }
    }

    // Re-verify explicit /skill selections before steering.
    if (steerInput.promptEnvelope.skillInvocation) {
      const hasAgySkill = steerInput.promptEnvelope.skillInvocation.bindings.some(
        (b) => b.agentId === 'agy',
      )
      if (hasAgySkill) {
        try {
          const catalog = await this.discoverSkills(activeRun.connection.canonicalCwd, signal)
          bindAgySkillSelections(steerInput.promptEnvelope.skillInvocation.bindings, catalog)
        } catch (error) {
          return {
            status: 'rejected',
            reason: error instanceof Error ? error.message : 'Selected Skill is unavailable.',
          }
        }
      }
    }

    const images: AgentPromptImage[] = []
    for (const group of agentPromptImageGroups(steerInput.promptEnvelope)) {
      images.push(...group.images)
    }
    let reservation: NativeMemoryReservation | undefined
    activeRun.steeringInFlight = true
    const entry: AgySteerEntry = {
      request: steerInput,
      dispatched: false,
      consumed: false,
      settled: false,
    }
    activeRun.steeredInputs.set(steerInput.inputId, entry)

    let releaseSteerSettlement: (() => void) | undefined
    const steerSettlement = new Promise<void>((resolveSteer) => {
      releaseSteerSettlement = resolveSteer
    })
    activeRun.pendingSteerOperations.add(steerSettlement)

    try {
      reservation = activeRun.connection.reserveWorkingMemory(
        32 * 1024 + nativeImagePreparationBytes(images),
      )
      const promptBlocks = await agyPromptInput(steerInput.promptEnvelope, signal)
      if (!activeRun.isSteerLeaseOpen()) {
        activeRun.steeredInputs.delete(steerInput.inputId)
        return {
          status: 'rejected',
          reason: 'The Antigravity root Turn closed before steer dispatch.',
        }
      }

      const op = activeRun.connection.requestOwned(
        'session/prompt',
        {
          sessionId: activeRun.nativeSessionId,
          prompt: promptBlocks,
          _meta: { pactSteerInputId: steerInput.inputId },
        },
        {
          timeoutMs: AGY_PROMPT_ACCEPT_TIMEOUT_MS,
          signal,
          canDispatch: () => !this.disposed && !signal.aborted && activeRun.isSteerLeaseOpen(),
          onDispatch: () => {
            entry.dispatched = true
            reservation?.release()
            reservation = undefined
            steerInput.recordDispatch('possibly_sent')
          },
        },
      )

      let rpcResponse: object | undefined
      let rpcFailure: Error | undefined
      try {
        rpcResponse = await op.result
      } catch (err) {
        rpcFailure = err instanceof Error ? err : new Error(String(err))
      }

      if (rpcFailure) {
        const physical = await awaitPhysicalCompletionBounded(op.physicalOutcome)
        if (physical === 'not_sent' && !entry.dispatched) {
          entry.settled = true
          activeRun.steeredInputs.delete(steerInput.inputId)
          steerInput.recordDispatch('rejected')
          return { status: 'rejected', reason: rpcFailure.message }
        }
        // Frame bytes crossed into NativeFrameWriter without an in-Turn receipt -> unconfirmed!
        throw new AgentExecutionError(
          'unknown_delivery',
          'Antigravity steer frame was written without a confirmed in-Turn consumption receipt.',
          false,
        )
      }

      const rpcError = rpcResponse ? Reflect.get(rpcResponse, 'error') : undefined
      const rpcResult = rpcResponse ? Reflect.get(rpcResponse, 'result') : undefined
      if (rpcError || !isPlainObject(rpcResult)) {
        if (!entry.dispatched) {
          entry.settled = true
          activeRun.steeredInputs.delete(steerInput.inputId)
          steerInput.recordDispatch('rejected')
          return { status: 'rejected', reason: 'Antigravity rejected the steer request.' }
        }
        throw new AgentExecutionError(
          'unknown_delivery',
          'Antigravity rejected or closed steer after dispatch without confirming receipt.',
          false,
        )
      }

      // Stage in-Turn consumption receipt (`step_idx` + `execution_id`); NEVER bind `activeRun.executionId`
      // from a Steer RPC reply when `!activeRun.executionId`!
      const resultStepIdx = Reflect.get(rpcResult, 'stepIdx') ?? Reflect.get(rpcResult, 'step_idx')
      const resultExecId = asString(
        Reflect.get(rpcResult, 'executionId') ?? Reflect.get(rpcResult, 'execution_id'),
      )
      if (
        typeof resultStepIdx === 'number' &&
        Number.isSafeInteger(resultStepIdx) &&
        resultStepIdx >= 0 &&
        resultExecId
      ) {
        entry.candidateStepIdx = resultStepIdx
        entry.candidateExecutionId = resultExecId
      }

      if (!entry.consumed && !activeRun.rootTerminal && activeRun.providerExecutionId) {
        this.tryPromoteStagedSteerCandidate(activeRun, steerInput.inputId, entry)
      }

      if (
        !entry.consumed &&
        this.options.storageClient?.verifySteerConsumption &&
        !activeRun.rootTerminal
      ) {
        const verified = await this.options.storageClient.verifySteerConsumption(
          {
            appDataDir: this.primaryAppDataDir,
            cwd: activeRun.cwd,
            nativeSessionId: activeRun.nativeSessionId,
            nativeTurnId: activeRun.runId,
            executionId: activeRun.providerExecutionId,
            inputId: steerInput.inputId,
            minStepIdx: activeRun.rootStepIdx,
          },
          signal,
        )
        if (verified.consumed && verified.executionId !== undefined) {
          if (!activeRun.providerExecutionId) {
            activeRun.providerExecutionId = verified.executionId
            this.notifyRootExecutionWaiters(activeRun)
          }
          if (
            verified.executionId === activeRun.providerExecutionId &&
            (entry.candidateExecutionId === undefined ||
              entry.candidateExecutionId === activeRun.providerExecutionId) &&
            typeof verified.stepIdx === 'number' &&
            this.isValidSteerStepOrder(activeRun, steerInput.inputId, verified.stepIdx)
          ) {
            entry.stepIdx = verified.stepIdx
            entry.executionId = verified.executionId
            entry.consumed = true
          }
        }
      }

      // If Steer replied early before independent root `providerExecutionId` arrived, wait boundedly for root binding.
      if (
        !entry.consumed &&
        !activeRun.providerExecutionId &&
        entry.candidateExecutionId !== undefined &&
        !activeRun.rootReleasing &&
        !activeRun.rootTerminal
      ) {
        await this.waitForRootExecutionBinding(activeRun, signal)
        if (!activeRun.rootTerminal && activeRun.providerExecutionId) {
          this.tryPromoteStagedSteerCandidate(activeRun, steerInput.inputId, entry)
        }
      }

      if (
        !entry.consumed ||
        activeRun.rootTerminal ||
        !activeRun.providerExecutionId ||
        entry.executionId !== activeRun.providerExecutionId
      ) {
        throw new AgentExecutionError(
          'unknown_delivery',
          'Antigravity steer crossed the root Turn boundary without an in-Turn (step_idx, execution_id) consumption receipt.',
          false,
        )
      }

      entry.settled = true
      steerInput.recordDispatch('accepted')
      steerInput.recordConsumption(steerInput.inputId)
      return { status: 'accepted' }
    } finally {
      reservation?.release()
      activeRun.steeringInFlight = false
      activeRun.pendingSteerOperations.delete(steerSettlement)
      releaseSteerSettlement?.()
    }
  }

  beginNativeStatusCheck(
    input: AgentNativeProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<NativeProbeResult> {
    return this.nativeChecks.begin(
      signal,
      (checkSignal) => this.probeNativeStatus(input, checkSignal),
      context,
    )
  }

  async probeNativeStatus(
    input: AgentNativeProbeInput,
    signal: AbortSignal,
  ): Promise<NativeProbeResult> {
    signal.throwIfAborted()
    if (input.target === 'initialized_binding') {
      return this.probeInitializedBinding(input, signal)
    }

    const identity = this.toEvidenceIdentity(input)
    if (input.runId) {
      const live = this.activeRuns.get(input.runId)
      const cached = this.nativeEvidence.get(this.evidenceKey(input.runId, input.nativeSessionId))
      if (
        live &&
        live.nativeSessionId === input.nativeSessionId &&
        (!input.executorId || live.executorId === input.executorId) &&
        !live.rootTerminal
      ) {
        if (cached && (cached.kind === 'running' || cached.kind === 'waiting_user')) {
          return {
            ...cached,
            identity: {
              ...cached.identity,
              requestId: input.requestId,
            },
          }
        }
        return {
          kind: 'running',
          identity: {
            ...identity,
            executorId: live.executorId,
            nativeTurnId: live.nativeTurnId,
          },
          source: 'live_runtime',
        }
      }
      if (
        cached &&
        cached.kind === 'ended' &&
        (!input.executorId || cached.identity.executorId === input.executorId) &&
        !(input.inspectMissingPlan && !cached.output?.plan)
      ) {
        return {
          ...cached,
          identity: {
            ...cached.identity,
            requestId: input.requestId,
          },
        }
      }
    }

    if (input.confirmedTerminal && !input.inspectMissingPlan) {
      return {
        ...input.confirmedTerminal,
        identity: {
          ...input.confirmedTerminal.identity,
          requestId: input.requestId,
        },
      }
    }

    if (this.options.storageClient?.probeSessionStatus) {
      const effectiveTurnId = input.nativeTurnId ?? input.runId
      const probed = await this.options.storageClient.probeSessionStatus(
        {
          ...input,
          appDataDir: this.primaryAppDataDir,
          ...(effectiveTurnId ? { nativeTurnId: effectiveTurnId } : {}),
        },
        signal,
      )
      return {
        ...probed,
        identity: {
          ...probed.identity,
          ...identity,
          ...((identity.nativeTurnId ?? effectiveTurnId ?? probed.identity.nativeTurnId)
            ? {
                nativeTurnId:
                  identity.nativeTurnId ?? effectiveTurnId ?? probed.identity.nativeTurnId,
              }
            : {}),
        },
      }
    }

    return {
      kind: 'no_evidence',
      identity,
      reason: 'Cold Antigravity SQLite trajectory inspection is not configured on this Adapter.',
    }
  }

  private async probeInitializedBinding(
    input: AgentNativeInitializedBindingProbeInput,
    signal: AbortSignal,
  ): Promise<NativeProbeResult> {
    const identity = this.toEvidenceIdentity(input)
    if (this.options.storageClient?.inspectRebuildSeed) {
      const inspected = await this.options.storageClient.inspectRebuildSeed(
        {
          appDataDir: this.primaryAppDataDir,
          cwd: input.cwd,
          nativeSessionId: input.nativeSessionId,
          sourceHash: input.confirmedInitialization.sourceHash,
          chunks: input.source,
        },
        signal,
      )
      if (inspected.verified && inspected.initializationWitness) {
        return {
          kind: 'binding_ready',
          identity,
          source: 'completed_initialization_readback',
          rebuildId: input.confirmedInitialization.rebuildId,
          sourceHash: input.confirmedInitialization.sourceHash,
          witness: inspected.initializationWitness,
        }
      }
      this.nativeRebuildReceipts.delete(input.confirmedInitialization.rebuildId)
      return {
        kind: 'no_evidence',
        identity,
        reason: 'Antigravity rebuild binding could not be verified from cold readback.',
      }
    }

    const receipt = this.nativeRebuildReceipts.get(input.confirmedInitialization.rebuildId)
    if (
      receipt &&
      receipt.nativeSessionId === input.nativeSessionId &&
      Boolean(receipt.initializationWitness) &&
      (!receipt.sourceHash || receipt.sourceHash === input.confirmedInitialization.sourceHash)
    ) {
      return {
        kind: 'binding_ready',
        identity,
        source: 'completed_initialization_readback',
        rebuildId: input.confirmedInitialization.rebuildId,
        sourceHash: input.confirmedInitialization.sourceHash,
        witness: receipt.initializationWitness!,
      }
    }

    return {
      kind: 'no_evidence',
      identity,
      reason: 'Antigravity rebuild binding could not be verified from cold readback.',
    }
  }

  beginNativeInputsCheck(
    input: AgentNativeInputProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<void> {
    return this.nativeChecks.begin(
      signal,
      (checkSignal) => this.probeNativeInputs(input, checkSignal),
      context,
    )
  }

  async probeNativeInputs(input: AgentNativeInputProbeInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (input.unresolvedInputIds.length === 0) return
    if (input.unresolvedInputIds.length > 64) {
      throw new AgentExecutionError(
        'protocol_error',
        'Too many unresolved Antigravity steer input candidates.',
        false,
      )
    }
    if (input.runId) {
      const live = this.activeRuns.get(input.runId)
      if (live) {
        for (const id of input.unresolvedInputIds) {
          if (live.steeredInputs.get(id)?.consumed) {
            input.recordConsumption(id)
          }
        }
      }
    }
    if (this.options.storageClient?.probeInputReceipts) {
      const effectiveTurnId = input.nativeTurnId ?? input.runId
      const consumed = await this.options.storageClient.probeInputReceipts(
        {
          ...input,
          appDataDir: this.primaryAppDataDir,
          ...(effectiveTurnId ? { nativeTurnId: effectiveTurnId } : {}),
        },
        signal,
      )
      const allowed = new Set(input.unresolvedInputIds)
      for (const id of consumed) {
        if (allowed.has(id)) input.recordConsumption(id)
      }
    }
  }

  beginNativeRebuildCheck(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<AgentNativeContextRebuildResult | undefined> {
    return this.nativeChecks.begin(
      signal,
      (checkSignal) => this.inspectNativeRebuild(input, source, checkSignal),
      context,
    )
  }

  async inspectNativeRebuild(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult | undefined> {
    signal.throwIfAborted()
    const receipt = this.nativeRebuildReceipts.get(input.rebuildId)
    const targetSessionId = input.nativeSessionId ?? receipt?.nativeSessionId
    if (targetSessionId && this.options.storageClient?.inspectRebuildSeed) {
      const inspected = await this.options.storageClient.inspectRebuildSeed(
        {
          appDataDir: this.primaryAppDataDir,
          cwd: input.cwd,
          nativeSessionId: targetSessionId,
          sourceHash: input.sourceHash,
          chunks: source,
        },
        signal,
      )
      if (inspected.verified && (!input.sourceHash || Boolean(inspected.initializationWitness))) {
        return {
          nativeSessionId: targetSessionId,
          ...(inspected.initializationWitness
            ? { initializationWitness: inspected.initializationWitness }
            : {}),
        }
      }
      this.nativeRebuildReceipts.delete(input.rebuildId)
      return undefined
    }
    if (
      receipt &&
      (!input.nativeSessionId || receipt.nativeSessionId === input.nativeSessionId) &&
      (!input.sourceHash ||
        (receipt.sourceHash === input.sourceHash && Boolean(receipt.initializationWitness)))
    ) {
      return {
        nativeSessionId: receipt.nativeSessionId,
        ...(receipt.initializationWitness
          ? { initializationWitness: receipt.initializationWitness }
          : {}),
      }
    }
    return undefined
  }

  async rebuildNativeContext(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult> {
    signal.throwIfAborted()
    if (!this.options.storageClient?.writeRebuildSeed) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Antigravity zero-Turn Rebuild storage writer is not configured.',
        false,
      )
    }

    const lease = await this.pool.acquire({
      cwd: input.cwd,
      permissionScope: 'standard',
      permissionMode: input.permissionMode ?? 'ask',
      readOnly: true,
      sessionId: input.sessionId,
      signal,
    })
    const executorId = lease.connection.executorId
    let candidateSessionId = input.nativeSessionId
    let creationPossiblyDelivered = Boolean(candidateSessionId)
    let controlOwner: ReturnType<typeof this.registerControlOperationServerRequests> | undefined
    try {
      await lease.ensureInitialized(signal)
      controlOwner = this.registerControlOperationServerRequests({
        connection: lease.connection,
        ownerId: `rebuild:${input.rebuildId}:${randomUUID()}`,
        initialSessionId: candidateSessionId,
        cwd: lease.canonicalCwd,
        permissionMode: input.permissionMode ?? 'ask',
        requestPermission: input.requestPermission,
        requestUserInput: input.requestUserInput,
        signal,
      })
      if (!candidateSessionId) {
        await input.onNativeCreationDispatched?.(executorId)
        candidateSessionId = await this.allocateZeroTurnSessionShell(lease, signal, {
          onCreationDispatched: () => {
            creationPossiblyDelivered = true
          },
          onCreationRejectedByServer: () => {
            creationPossiblyDelivered = false
          },
          onSessionAllocated: async (allocatedId) => {
            candidateSessionId = allocatedId
            controlOwner?.updateSessionId(allocatedId)
            await input.onNativeSessionCreated?.(allocatedId)
          },
        })
      }

      const resolveImage = input.resolveImage
      const bufferedChunks: NativeContextRebuildChunk[] = []
      const resolvedRecords: AgyRebuildSeedChunkRecord[] = []
      for await (const chunk of source) {
        signal.throwIfAborted()
        bufferedChunks.push(chunk)
        const resolvedImages = new Map<string, AgentPromptImage>()
        if (resolveImage && chunk.kind === 'image') {
          const resolved = await resolveImage(chunk.image.id, signal)
          requireNativeImageReference(resolved, chunk.image)
          resolvedImages.set(chunk.image.id, resolved)
        }
        resolvedRecords.push({ chunk, resolvedImages })
      }

      const written = await this.options.storageClient.writeRebuildSeed(
        {
          appDataDir: this.primaryAppDataDir,
          cwd: lease.canonicalCwd,
          candidateSessionId,
          ...(input.sourceHash !== undefined ? { sourceHash: input.sourceHash } : {}),
          chunks: (async function* () {
            yield* resolvedRecords
          })(),
        },
        signal,
      )

      // Cold `session/load` + `session/close` verification (0 model invocations!).
      await this.verifyZeroTurnSessionLoad(lease, candidateSessionId, signal, {
        expectReplaySteps: written.stepCount > 0,
        forbidToolUpdates: true,
        onServerRequest: (req) => {
          controlOwner?.handleServerRequest(req.message)
        },
      })
      controlOwner.dispose()
      await lease.disposeIfIdle()

      // Seal cold-load verification receipt ONLY AFTER zero-Turn `session/load` + `session/close` succeeds!
      let finalWitness: NativeInitializationWitness | undefined
      if (this.options.storageClient.confirmRebuildColdLoad) {
        if (!input.sourceHash) {
          throw new AgentExecutionError(
            'protocol_error',
            'Antigravity zero-Turn Rebuild cold-load confirmation requires a sourceHash.',
            false,
          )
        }
        const pbSha256 = written.pbSha256 ?? written.verifiedPrefixSha256
        const pbBytes = written.pbBytes ?? written.verifiedPrefixBytes
        if (written.stepCount !== 2 || !pbSha256 || pbBytes <= 0) {
          throw new AgentExecutionError(
            'context_resume_failed',
            'Antigravity zero-Turn Rebuild seed did not produce a valid 2-step payload.',
            false,
          )
        }
        finalWitness = await this.options.storageClient.confirmRebuildColdLoad(
          {
            cwd: lease.canonicalCwd,
            appDataDir: this.primaryAppDataDir,
            nativeSessionId: candidateSessionId,
            sourceHash: input.sourceHash,
            pbSha256,
            pbBytes,
            stepCount: 2,
          },
          signal,
        )
      }

      if (this.options.storageClient.inspectRebuildSeed) {
        const postLoad = await this.options.storageClient.inspectRebuildSeed(
          {
            appDataDir: this.primaryAppDataDir,
            cwd: lease.canonicalCwd,
            nativeSessionId: candidateSessionId,
            sourceHash: input.sourceHash,
            chunks: (async function* () {
              yield* bufferedChunks
            })(),
          },
          signal,
        )
        if (!postLoad.verified) {
          throw new AgentExecutionError(
            'context_resume_failed',
            'Antigravity rebuild seed failed post-load cold verification.',
            false,
          )
        }
        finalWitness = postLoad.initializationWitness ?? finalWitness
      }

      this.rememberRebuildReceipt(input.rebuildId, {
        nativeSessionId: candidateSessionId,
        sourceHash: input.sourceHash,
        seedHash: written.seedHash,
        cwd: lease.canonicalCwd,
        executorId,
        initializationWitness: finalWitness,
      })
      input.reportNativeWork?.({
        executorId,
        nativeSessionId: candidateSessionId,
        state: 'settled',
      })
      return {
        nativeSessionId: candidateSessionId,
        ...(finalWitness ? { initializationWitness: finalWitness } : {}),
      }
    } catch (error) {
      input.reportNativeWork?.({
        executorId,
        ...(candidateSessionId ? { nativeSessionId: candidateSessionId } : {}),
        state: candidateSessionId || creationPossiblyDelivered ? 'unknown' : 'settled',
      })
      throw error
    } finally {
      controlOwner?.dispose()
      lease.release()
    }
  }

  async prepareNativeFork(
    input: AgentNativeForkSourceInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkBoundary> {
    signal.throwIfAborted()
    if (!this.options.storageClient?.prepareFork) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Antigravity native Fork storage engine is not configured.',
        false,
      )
    }
    return this.options.storageClient.prepareFork(
      { ...input, appDataDir: this.primaryAppDataDir },
      signal,
    )
  }

  async inspectNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkInspection> {
    signal.throwIfAborted()
    if (!this.options.storageClient?.inspectFork) {
      return {
        kind: 'missing',
        reason: 'Antigravity native Fork storage engine is not configured.',
      }
    }
    return this.options.storageClient.inspectFork(
      { ...input, appDataDir: this.primaryAppDataDir },
      signal,
    )
  }

  async forkNativeContext(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    signal.throwIfAborted()
    if (!this.options.storageClient?.writeFork) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Antigravity native Fork storage engine is not configured.',
        false,
      )
    }
    const lease = await this.pool.acquire({
      cwd: input.cwd,
      permissionScope: 'standard',
      permissionMode: input.permissionMode,
      readOnly: true,
      sessionId: input.sessionId,
      signal,
    })
    const executorId = lease.connection.executorId
    let candidateSessionId = input.nativeSessionId
    let creationPossiblyDelivered = Boolean(candidateSessionId)
    let controlOwner: ReturnType<typeof this.registerControlOperationServerRequests> | undefined
    try {
      await lease.ensureInitialized(signal)
      controlOwner = this.registerControlOperationServerRequests({
        connection: lease.connection,
        ownerId: `fork:${input.operationId}:${randomUUID()}`,
        initialSessionId: candidateSessionId,
        cwd: lease.canonicalCwd,
        permissionMode: input.permissionMode,
        requestPermission: input.requestPermission,
        requestUserInput: input.requestUserInput,
        signal,
      })
      await input.onDispatched(executorId)
      if (!candidateSessionId) {
        candidateSessionId = await this.allocateZeroTurnSessionShell(lease, signal, {
          onCreationDispatched: () => {
            creationPossiblyDelivered = true
          },
          onCreationRejectedByServer: () => {
            creationPossiblyDelivered = false
          },
          onSessionAllocated: async (allocatedId) => {
            candidateSessionId = allocatedId
            controlOwner?.updateSessionId(allocatedId)
            await input.onCandidate(allocatedId)
          },
        })
      }
      const witness = await this.options.storageClient.writeFork(
        {
          appDataDir: this.primaryAppDataDir,
          cwd: lease.canonicalCwd,
          candidateSessionId,
          model: input.model,
          effort: input.effort,
          permissionMode: input.permissionMode,
          source: input.source,
          onCandidate: input.onCandidate,
        },
        signal,
      )
      await input.onCandidate(candidateSessionId, witness)

      // Cold `session/load` + `session/close` verification with zero model input.
      await this.verifyZeroTurnSessionLoad(lease, candidateSessionId, signal, {
        expectReplaySteps: (witness.candidatePrefixRecords ?? input.source.prefixRecords) > 0,
        forbidToolUpdates: false,
        onServerRequest: (req) => {
          controlOwner?.handleServerRequest(req.message)
        },
      })
      controlOwner.dispose()
      await lease.disposeIfIdle()

      const initializedWitness = await this.sealPostLoadForkWitness(
        input,
        lease.canonicalCwd,
        candidateSessionId,
        witness,
        signal,
      )
      await input.onCandidate(candidateSessionId, initializedWitness)
      input.reportNativeWork({ executorId, state: 'settled' })
      return { nativeSessionId: candidateSessionId, witness: initializedWitness }
    } catch (error) {
      input.reportNativeWork({
        executorId,
        state: candidateSessionId || creationPossiblyDelivered ? 'unknown' : 'settled',
      })
      throw error
    } finally {
      controlOwner?.dispose()
      lease.release()
    }
  }

  async initializeNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    signal.throwIfAborted()
    if (!input.nativeSessionId || !input.witness) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity Fork initialization requires an existing verified candidate and witness.',
        false,
      )
    }
    const lease = await this.pool.acquire({
      cwd: input.cwd,
      permissionScope: 'standard',
      permissionMode: input.permissionMode,
      readOnly: true,
      sessionId: input.sessionId,
      signal,
    })
    const executorId = lease.connection.executorId
    let controlOwner: ReturnType<typeof this.registerControlOperationServerRequests> | undefined
    try {
      await lease.ensureInitialized(signal)
      controlOwner = this.registerControlOperationServerRequests({
        connection: lease.connection,
        ownerId: `fork-init:${input.operationId}:${randomUUID()}`,
        initialSessionId: input.nativeSessionId,
        cwd: lease.canonicalCwd,
        permissionMode: input.permissionMode,
        requestPermission: input.requestPermission,
        requestUserInput: input.requestUserInput,
        signal,
      })
      await input.onDispatched(executorId)
      await this.verifyZeroTurnSessionLoad(lease, input.nativeSessionId, signal, {
        expectReplaySteps: (input.witness.candidatePrefixRecords ?? input.source.prefixRecords) > 0,
        forbidToolUpdates: false,
        onServerRequest: (req) => {
          controlOwner?.handleServerRequest(req.message)
        },
      })
      controlOwner.dispose()
      await lease.disposeIfIdle()

      const initializedWitness = await this.sealPostLoadForkWitness(
        input,
        lease.canonicalCwd,
        input.nativeSessionId,
        input.witness,
        signal,
      )
      await input.onCandidate(input.nativeSessionId, initializedWitness)
      input.reportNativeWork({ executorId, state: 'settled' })
      return { nativeSessionId: input.nativeSessionId, witness: initializedWitness }
    } catch (error) {
      input.reportNativeWork({ executorId, state: 'unknown' })
      throw error
    } finally {
      controlOwner?.dispose()
      lease.release()
    }
  }

  async closeZeroInputSessions(deadlineAt?: number): Promise<void> {
    const ownedRuns = [...this.ownedRunHandles]
    if (ownedRuns.length === 0) return
    await Promise.allSettled(ownedRuns.map((handle) => handle.closeZeroInputSession(deadlineAt)))
  }

  async dispose(shutdown?: AgentShutdownSettlement): Promise<void> {
    if (this.ownsPool && shutdown?.flushDeadlineAt !== undefined) {
      this.pool.capShutdownDeadline(shutdown.flushDeadlineAt)
    }
    if (this.disposalPromise) {
      return this.disposalPromise
    }
    const runDisposal = (async () => {
      if (shutdown?.foregroundSettlement) {
        const remaining = Math.max(0, shutdown.flushDeadlineAt - Date.now())
        await Promise.race([
          shutdown.foregroundSettlement,
          new Promise<void>((r) => setTimeout(r, remaining)),
        ]).catch(() => undefined)
      }
      this.disposed = true
      this.unsubscribePoolPhysicalOps()
      this.unsubscribeStoragePhysicalOps?.()
      this.nativeChecks.cancel()
      const ownedRuns = [...this.ownedRunHandles]
      for (const handle of ownedRuns) {
        handle.cancel()
      }
      // Give any confirmed zero-byte fresh sessions their single bounded `session/close` chance
      // BEFORE tearing down the ACP connection pool or releasing their leases.
      if (ownedRuns.length > 0) {
        await Promise.allSettled(
          ownedRuns.map((handle) => handle.closeZeroInputSession(shutdown?.flushDeadlineAt)),
        )
      }
      for (const run of this.activeRuns.values()) {
        this.notifyRootExecutionWaiters(run)
        run.observation.abort()
      }
      this.activeRuns.clear()
      this.sessionModes.clear()
      this.nativeRebuildReceipts.clear()
      this.nativeEvidence.clear()
      this.evidenceCacheWork.release()
      const joinOwnedRuns = async (): Promise<void> => {
        if (ownedRuns.length === 0) return
        const waitMs =
          shutdown?.flushDeadlineAt !== undefined
            ? Math.max(0, shutdown.flushDeadlineAt - Date.now())
            : AGY_PHYSICAL_SETTLEMENT_GRACE_MS
        let settledInTime = false
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            Promise.allSettled(ownedRuns.map((handle) => handle.finalized)).then(() => {
              settledInTime = true
              return undefined
            }),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, waitMs)
              timer.unref?.()
            }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
        if (!settledInTime) {
          const lingering = ownedRuns.filter((handle) => this.ownedRunHandles.has(handle))
          await Promise.allSettled(lingering.map((handle) => handle.forceCleanup()))
          if (lingering.length > 0 && shutdown?.flushDeadlineAt !== undefined) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity adapter disposal timed out waiting for active Run finalization.',
              false,
            )
          }
        }
      }
      const ownedForksToDispose = [...this.activeOwnedForkFiles]
      this.ownedForkFiles = undefined
      const results = await Promise.allSettled([
        joinOwnedRuns(),
        this.nativeChecks.join().catch(() => undefined),
        this.skillProbeOwner.dispose(shutdown?.flushDeadlineAt),
        ...ownedForksToDispose.map(async (forkFiles) => {
          await forkFiles.dispose(shutdown?.flushDeadlineAt)
          this.activeOwnedForkFiles.delete(forkFiles)
        }),
        ...(this.ownsPool ? [this.pool.dispose(shutdown?.flushDeadlineAt)] : []),
      ])
      const firstFailure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (firstFailure) {
        throw firstFailure.reason
      }
    })()
    const trackedDisposal = runDisposal.catch((error: unknown) => {
      if (this.disposalPromise === trackedDisposal) {
        this.disposalPromise = undefined
      }
      throw error
    })
    this.disposalPromise = trackedDisposal
    return trackedDisposal
  }

  private async allocateZeroTurnSessionShell(
    lease: AgyPoolLease,
    signal: AbortSignal,
    options: {
      onSessionAllocated?: (sessionId: string) => void | Promise<void>
      onCreationDispatched?: () => void
      onCreationRejectedByServer?: () => void
    } = {},
  ): Promise<string> {
    let creationDispatched = false
    const newOp = lease.connection.requestOwned(
      'session/new',
      { cwd: lease.canonicalCwd, mcpServers: [] },
      {
        timeoutMs: AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS,
        signal,
        canDispatch: () => !signal.aborted && !this.disposed,
        onDispatch: () => {
          creationDispatched = true
          options.onCreationDispatched?.()
        },
      },
    )
    let newResp: object
    try {
      newResp = await newOp.result
    } catch (error) {
      if (!creationDispatched) {
        const physical = await Promise.race([
          newOp.physicalOutcome,
          new Promise<'still_pending'>((r) => setTimeout(() => r('still_pending'), 0)),
        ])
        if (physical !== 'not_sent') {
          options.onCreationDispatched?.()
        }
      }
      throw error
    }
    const hasResultField = Object.hasOwn(newResp, 'result')
    const hasErrorField = Object.hasOwn(newResp, 'error')
    const newError = hasErrorField ? Reflect.get(newResp, 'error') : undefined
    const newResult = hasResultField ? Reflect.get(newResp, 'result') : undefined
    if (hasErrorField) {
      const isValidatedRejection =
        !hasResultField &&
        isPlainObject(newError) &&
        typeof newError.code === 'number' &&
        Number.isSafeInteger(newError.code) &&
        typeof newError.message === 'string'
      if (isValidatedRejection) {
        options.onCreationRejectedByServer?.()
      } else {
        options.onCreationDispatched?.()
      }
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity failed to allocate a zero-Turn session shell.',
        false,
      )
    }
    if (!isPlainObject(newResult)) {
      options.onCreationDispatched?.()
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity failed to allocate a zero-Turn session shell.',
        false,
      )
    }
    const descriptor = parseAcpSessionDescriptor(newResult)
    let callbackFailed = false
    let callbackError: unknown
    try {
      await options.onSessionAllocated?.(descriptor.sessionId)
    } catch (err) {
      callbackFailed = true
      callbackError = err
    }
    const callerAborted = signal.aborted
    const cleanupOnly = callbackFailed || callerAborted
    const closeRes = await lease.closeSession(descriptor.sessionId, {
      timeoutMs: cleanupOnly
        ? Math.min(AGY_CONTROL_RPC_TIMEOUT_MS, 1_500)
        : AGY_CONTROL_RPC_TIMEOUT_MS,
    })
    if (closeRes.confirmed) {
      this.sessionModes.delete(descriptor.sessionId)
    } else {
      const closeDiag = classifyAgyCloseFailureDiagnostic(closeRes.reason)
      recordDiagnostic({
        operation: 'native_check',
        phase: 'failed',
        level: 'warn',
        scope: 'process',
        agentId: 'agy',
        executorId: lease.connection.executorId,
        nativeMethod: 'session/close',
        failureSource: closeDiag.failureSource,
        code: closeDiag.code,
      })
      if (!cleanupOnly) {
        throw new AgentExecutionError(
          'protocol_error',
          'Antigravity failed to close the zero-Turn session shell cleanly.',
          false,
        )
      }
    }
    if (callbackFailed) {
      throw callbackError
    }
    if (callerAborted) {
      signal.throwIfAborted()
    }
    return descriptor.sessionId
  }

  private registerControlOperationServerRequests(params: {
    connection: AgyAcpConnection
    ownerId: string
    initialSessionId: string | undefined
    cwd: string
    permissionMode: SessionPermissionMode
    requestPermission: AgentRunInput['requestPermission']
    requestUserInput: AgentRunInput['requestUserInput']
    signal: AbortSignal
  }): {
    updateSessionId: (sessionId: string | undefined) => void
    handleServerRequest: (message: object) => boolean
    dispose: () => void
  } {
    const {
      connection,
      ownerId,
      initialSessionId,
      cwd,
      permissionMode,
      requestPermission,
      requestUserInput,
      signal,
    } = params
    let currentSessionId = initialSessionId
    let activePermissionRequests = 0
    let ownerDisposed = false
    const permissionWait = new NativePermissionWait()
    const interactionControllers = new Set<AbortController>()

    const isFenceCurrent = (): boolean =>
      !this.disposed && !ownerDisposed && !signal.aborted && connection.isOpen

    const handleServerRequest = (message: object, seq = 0): boolean => {
      const method = asString(Reflect.get(message, 'method'))
      const rpcId = Reflect.get(message, 'id')
      if (
        (typeof rpcId !== 'string' && typeof rpcId !== 'number') ||
        !method ||
        (method !== 'session/request_permission' && method !== 'elicitation/create') ||
        !isPlainObject(message)
      ) {
        return false
      }
      const rawParams = Reflect.get(message, 'params')
      const paramsObjectValid = isPlainObject(rawParams)
      const reqParams = paramsObjectValid ? rawParams : {}

      // Validate control-operation requests with the same frame identity validator against the
      // expected control session identity before reaching approval or elicitation callbacks!
      const validated = validateAgyFrame(
        {
          kind: 'server_request',
          seq,
          method,
          rpcId,
          message,
        },
        currentSessionId,
        undefined,
        undefined,
      )
      const controlIdentityInvalid =
        !paramsObjectValid ||
        !validated.isAttributableToCurrentSession ||
        validated.hasForeignOrInvalidSessionMeta ||
        validated.executionIdInvalid ||
        validated.rootEvidenceContradicted ||
        validated.tokens.hasInvalidToken ||
        validated.tokens.hasConflictingTokens

      if (method === 'session/request_permission') {
        const permFrameInvalid =
          controlIdentityInvalid ||
          validated.toolCallIdInvalid ||
          validated.argsEvidence.kind === 'invalid_or_conflict' ||
          (validated.statusPresent &&
            (validated.statusInvalid ||
              validated.status === 'completed' ||
              validated.status === 'failed' ||
              validated.status === 'cancelled'))
        void (async () => {
          if (permFrameInvalid || permissionMode === 'full') {
            const rejectOnce = findRejectOnceOptionId(reqParams.options)
            await connection
              .respond(
                rpcId,
                rejectOnce
                  ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
                  : { outcome: { outcome: 'cancelled' } },
              )
              .catch(() => undefined)
            return
          }
          if (!requestPermission || activePermissionRequests >= NATIVE_PERMISSION_REQUESTS) {
            const rejectOnce = findRejectOnceOptionId(reqParams.options)
            await connection
              .respond(
                rpcId,
                rejectOnce
                  ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
                  : { outcome: { outcome: 'cancelled' } },
              )
              .catch(() => undefined)
            return
          }
          let card: ReturnType<typeof buildAgyPermissionCard>
          try {
            card = buildAgyPermissionCard(reqParams, cwd)
          } catch {
            const rejectOnce = findRejectOnceOptionId(reqParams.options)
            await connection
              .respond(
                rpcId,
                rejectOnce
                  ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
                  : { outcome: { outcome: 'cancelled' } },
              )
              .catch(() => undefined)
            return
          }
          activePermissionRequests += 1
          const endConnectionWait = connection.beginPermissionWait()
          const endLocalWait = permissionWait.begin()
          const interactionAbort = new AbortController()
          interactionControllers.add(interactionAbort)
          try {
            if (!isFenceCurrent()) {
              if (connection.isOpen) {
                await connection
                  .respond(rpcId, { outcome: { outcome: 'cancelled' } })
                  .catch(() => undefined)
              }
              return
            }
            const combinedSignal = AbortSignal.any([signal, interactionAbort.signal])
            const permWork = requestPermission(card.request, combinedSignal)
            void permWork.catch(() => undefined)
            const decisionId = await NativePermissionWait.decision(permWork, combinedSignal)
            if (!isFenceCurrent()) {
              if (connection.isOpen) {
                await connection
                  .respond(rpcId, { outcome: { outcome: 'cancelled' } })
                  .catch(() => undefined)
              }
              return
            }
            const mappedResponse = card.responses.get(decisionId) ?? {
              outcome: { outcome: 'cancelled' },
            }
            await connection.respond(rpcId, mappedResponse)
            if (decisionId === 'agy-cancel' && currentSessionId) {
              await connection
                .notify('session/cancel', { sessionId: currentSessionId }, {})
                .catch(() => undefined)
            }
          } catch {
            if (connection.isOpen) {
              await connection
                .respond(rpcId, { outcome: { outcome: 'cancelled' } })
                .catch(() => undefined)
            }
          } finally {
            interactionControllers.delete(interactionAbort)
            endLocalWait()
            endConnectionWait()
            activePermissionRequests = Math.max(0, activePermissionRequests - 1)
          }
        })()
        return true
      }

      void (async () => {
        if (controlIdentityInvalid) {
          await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
          return
        }
        if (!requestUserInput) {
          await connection.respond(rpcId, { action: 'decline' }).catch(() => undefined)
          return
        }
        let uiRequest: NativeUserInputRequest
        try {
          uiRequest = agyElicitationRequest(reqParams)
        } catch (error) {
          await connection
            .respondError(
              rpcId,
              error instanceof Error
                ? error.message
                : 'Unsupported Antigravity elicitation schema.',
              -32_602,
            )
            .catch(() => undefined)
          return
        }
        const endConnectionWait = connection.beginPermissionWait()
        const endLocalWait = permissionWait.begin()
        const interactionAbort = new AbortController()
        interactionControllers.add(interactionAbort)
        try {
          if (!isFenceCurrent()) {
            if (connection.isOpen) {
              await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
            }
            return
          }
          const combinedSignal = AbortSignal.any([signal, interactionAbort.signal])
          const userWork = requestUserInput(uiRequest, combinedSignal)
          void userWork.catch(() => undefined)
          const decision = await NativePermissionWait.decision(userWork, combinedSignal)
          if (!isFenceCurrent()) {
            if (connection.isOpen) {
              await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
            }
            return
          }
          if (decision.action === 'accept') {
            await connection.respond(
              rpcId,
              uiRequest.kind === 'url'
                ? { action: 'accept' }
                : { action: 'accept', content: decision.values ?? {} },
            )
          } else {
            await connection.respond(rpcId, { action: decision.action })
          }
        } catch {
          if (connection.isOpen) {
            await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
          }
        } finally {
          interactionControllers.delete(interactionAbort)
          endLocalWait()
          endConnectionWait()
        }
      })()
      return true
    }

    const ownerHandle = connection.registerServerRequestOwner({
      ownerId,
      knownSessionId: currentSessionId,
      handler: handleServerRequest,
    })

    return {
      updateSessionId: (sessionId) => {
        currentSessionId = sessionId
        ownerHandle.updateSessionId(sessionId)
      },
      handleServerRequest,
      dispose: () => {
        if (ownerDisposed) return
        ownerDisposed = true
        for (const ctrl of interactionControllers) ctrl.abort()
        interactionControllers.clear()
        ownerHandle.dispose()
      },
    }
  }

  private async sealPostLoadForkWitness(
    input: AgentNativeForkInput,
    canonicalCwd: string,
    candidateSessionId: string,
    baseWitness: AgentNativeForkWitness,
    signal: AbortSignal,
  ): Promise<AgentNativeForkWitness> {
    const provisional: AgentNativeForkWitness = {
      ...baseWitness,
      initializedAt: baseWitness.initializedAt ?? new Date().toISOString(),
      initializedPrefixHash: baseWitness.initializedPrefixHash ?? baseWitness.candidatePrefixHash,
      ...(baseWitness.initializedPrefixBytes !== undefined
        ? { initializedPrefixBytes: baseWitness.initializedPrefixBytes }
        : {}),
      initializedPrefixRecords:
        baseWitness.initializedPrefixRecords ?? baseWitness.candidatePrefixRecords,
    }
    if (!this.options.storageClient?.inspectFork) {
      return provisional
    }
    const postLoad = await this.options.storageClient.inspectFork(
      {
        ...input,
        cwd: canonicalCwd,
        nativeSessionId: candidateSessionId,
        witness: provisional,
        appDataDir: this.primaryAppDataDir,
      },
      signal,
    )
    if (postLoad.kind !== 'verified') {
      throw new AgentExecutionError(
        'context_resume_failed',
        `Antigravity Fork failed post-load physical inspection: ${postLoad.reason}`,
        false,
      )
    }
    const mergedBase = postLoad.result.witness ?? provisional
    return {
      ...mergedBase,
      initializedAt: mergedBase.initializedAt ?? provisional.initializedAt!,
      initializedPrefixHash:
        postLoad.rawHash ?? mergedBase.initializedPrefixHash ?? mergedBase.candidatePrefixHash,
      ...(postLoad.rawBytes !== undefined
        ? { initializedPrefixBytes: postLoad.rawBytes }
        : mergedBase.initializedPrefixBytes !== undefined
          ? { initializedPrefixBytes: mergedBase.initializedPrefixBytes }
          : {}),
      initializedPrefixRecords:
        postLoad.rawRecords ??
        mergedBase.initializedPrefixRecords ??
        mergedBase.candidatePrefixRecords,
    }
  }

  private async verifyZeroTurnSessionLoad(
    lease: AgyPoolLease,
    sessionId: string,
    signal: AbortSignal,
    options: {
      expectReplaySteps?: boolean
      forbidToolUpdates?: boolean
      onServerRequest?: (req: Extract<AgyIngress, { kind: 'server_request' }>) => void
    } = {},
  ): Promise<void> {
    const connection = lease.connection
    const canonicalCwd = lease.canonicalCwd
    const stream = connection.openSessionStream(sessionId, { ordered: true })
    let sawObservedReplay = false
    let sawUserChunk = false
    let sawAgentChunk = false
    let sawForbiddenExecutionUpdate = false

    const observeReplayItem = (item: object): void => {
      const method = asString(Reflect.get(item, 'method'))
      if (method !== 'session/update') return
      const params = Reflect.get(item, 'params')
      if (!isPlainObject(params)) return
      const sid = asString(params.sessionId ?? params.session_id)
      if (sid !== undefined && sid !== sessionId) return
      const update = params.update
      if (!isPlainObject(update)) return
      sawObservedReplay = true
      const kind = asString(update.sessionUpdate)
      if (kind === 'user_message_chunk') {
        const content = isPlainObject(update.content) ? asString(update.content.text) : undefined
        if (content && content.length > 0) sawUserChunk = true
      } else if (kind === 'agent_message_chunk') {
        const content = isPlainObject(update.content) ? asString(update.content.text) : undefined
        if (content && content.length > 0) sawAgentChunk = true
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const status = asString(update.status)
        if (
          options.forbidToolUpdates ||
          status === 'pending' ||
          status === 'in_progress' ||
          status === 'running'
        ) {
          sawForbiddenExecutionUpdate = true
        }
      }
    }

    let sessionLoaded = false
    let loadPossiblyDispatched = false
    let loadRejectedByServer = false
    let sessionClosed = false

    const recordCloseFailureDiagnostic = (reason: AgySessionCloseFailureReason) => {
      const closeDiag = classifyAgyCloseFailureDiagnostic(reason)
      recordDiagnostic({
        operation: 'native_check',
        phase: 'failed',
        level: 'warn',
        scope: 'process',
        agentId: 'agy',
        executorId: lease.connection.executorId,
        nativeMethod: 'session/close',
        failureSource: closeDiag.failureSource,
        code: closeDiag.code,
      })
    }

    let loadOp: ReturnType<AgyAcpConnection['requestOwned']> | undefined
    try {
      loadOp = connection.requestOwned(
        'session/load',
        { sessionId, cwd: canonicalCwd, mcpServers: [] },
        {
          timeoutMs: AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS,
          signal,
          replyTo: stream,
          canDispatch: () => !signal.aborted && !this.disposed,
          onDispatch: () => {
            loadPossiblyDispatched = true
          },
        },
      )
      const loadResp = await this.runWithConcurrentReplayDrain(
        loadOp.result,
        stream,
        observeReplayItem,
        undefined,
        loadOp.requestId,
        options.onServerRequest,
      )
      const hasLoadResult = Object.hasOwn(loadResp, 'result')
      const hasLoadError = Object.hasOwn(loadResp, 'error')
      const loadError = hasLoadError ? Reflect.get(loadResp, 'error') : undefined
      const loadResult = hasLoadResult ? Reflect.get(loadResp, 'result') : undefined
      if (hasLoadError || !isPlainObject(loadResult)) {
        if (
          hasLoadError &&
          !hasLoadResult &&
          isPlainObject(loadError) &&
          typeof loadError.code === 'number' &&
          Number.isSafeInteger(loadError.code) &&
          typeof loadError.message === 'string'
        ) {
          loadRejectedByServer = true
        }
        throw new AgentExecutionError(
          'context_resume_failed',
          'Antigravity cold session/load verification failed.',
          false,
        )
      }
      sessionLoaded = true
      if (sawForbiddenExecutionUpdate) {
        throw new AgentExecutionError(
          'context_resume_failed',
          'Antigravity cold session/load unexpectedly emitted live tool execution updates.',
          false,
        )
      }
      if (options.expectReplaySteps && (!sawUserChunk || !sawAgentChunk)) {
        throw new AgentExecutionError(
          'context_resume_failed',
          'Antigravity cold session/load did not replay the expected user and assistant chunks.',
          false,
        )
      }
      const callerAborted = signal.aborted
      sessionClosed = true
      const closeRes = await lease.closeSession(sessionId, {
        timeoutMs: callerAborted
          ? Math.min(AGY_CONTROL_RPC_TIMEOUT_MS, 1_500)
          : AGY_CONTROL_RPC_TIMEOUT_MS,
      })
      if (closeRes.confirmed) {
        this.sessionModes.delete(sessionId)
      } else {
        recordCloseFailureDiagnostic(closeRes.reason)
        if (!callerAborted) {
          throw new AgentExecutionError(
            'protocol_error',
            'Antigravity failed to close verified cold session.',
            false,
          )
        }
      }
      if (callerAborted) {
        signal.throwIfAborted()
      }
    } finally {
      try {
        if (!loadPossiblyDispatched && loadOp && !loadRejectedByServer && !sawObservedReplay) {
          const physical = await Promise.race([
            loadOp.physicalOutcome,
            new Promise<'still_pending'>((r) => setTimeout(() => r('still_pending'), 0)),
          ])
          if (physical !== 'not_sent') {
            loadPossiblyDispatched = true
          }
        }
        const mayBeLoaded =
          sessionLoaded || sawObservedReplay || (loadPossiblyDispatched && !loadRejectedByServer)
        if (mayBeLoaded && !sessionClosed) {
          sessionClosed = true
          const cleanupClose = await lease.closeSession(sessionId, {
            timeoutMs: Math.min(AGY_CONTROL_RPC_TIMEOUT_MS, 1_500),
          })
          if (cleanupClose.confirmed) {
            this.sessionModes.delete(sessionId)
          } else {
            recordCloseFailureDiagnostic(cleanupClose.reason)
          }
        }
      } catch {
        // Preserve the original replay verification or cancellation error.
      } finally {
        stream.close()
      }
    }
  }

  private async runWithConcurrentReplayDrain(
    requestPromise: Promise<object>,
    stream: AgyOrderedSessionStream,
    onNotification: (notification: object) => void,
    onReply?: (value: object) => void,
    requestId?: number,
    onServerRequest?: (req: Extract<AgyIngress, { kind: 'server_request' }>) => void,
  ): Promise<object> {
    const drainAbort = new AbortController()
    const drainState: {
      settled: boolean
      outcome: { ok: true; value: object } | { ok: false; error: unknown } | undefined
      replyObserved: boolean
      streamEnded: boolean
      observerFailed: boolean
      observerError: unknown
    } = {
      settled: false,
      outcome: undefined,
      replyObserved: false,
      streamEnded: false,
      observerFailed: false,
      observerError: undefined,
    }

    const recordObserverFailure = (error: unknown): void => {
      if (!drainState.observerFailed) {
        drainState.observerFailed = true
        drainState.observerError = error
      }
      drainState.settled = true
      drainAbort.abort()
    }

    const handleIngressItem = (item: AgyIngress): boolean => {
      if (drainState.observerFailed) return false
      if (item.kind === 'notification') {
        try {
          onNotification(item.message)
        } catch (error) {
          recordObserverFailure(error)
          throw error
        }
        return true
      }
      if (item.kind === 'server_request') {
        try {
          onServerRequest?.(item)
        } catch (error) {
          recordObserverFailure(error)
          throw error
        }
        return true
      }
      if (item.kind === 'reply') {
        if (requestId === undefined || item.requestId === requestId) {
          drainState.replyObserved = true
          try {
            onReply?.(item.message)
          } catch (error) {
            recordObserverFailure(error)
            throw error
          }
          return false
        }
        return true
      }
      drainState.streamEnded = true
      return false
    }

    const drainBuffered = (): void => {
      while (!drainState.observerFailed && !drainState.replyObserved && !drainState.streamEnded) {
        const item = stream.shift()
        if (!item) break
        if (!handleIngressItem(item)) break
      }
    }

    const tracked = (async () => {
      try {
        const value = await requestPromise
        try {
          drainBuffered()
          if (!drainState.replyObserved && !drainState.observerFailed) {
            drainState.replyObserved = true
            onReply?.(value)
          }
        } catch (error) {
          recordObserverFailure(error)
        } finally {
          drainState.settled = true
          drainState.outcome = { ok: true, value }
          drainAbort.abort()
        }
      } catch (error) {
        try {
          drainBuffered()
        } catch (obsError) {
          recordObserverFailure(obsError)
        } finally {
          drainState.settled = true
          drainState.outcome = { ok: false, error }
          drainAbort.abort()
        }
      }
    })()

    try {
      while (!drainState.settled && !drainState.observerFailed && !drainState.streamEnded) {
        drainBuffered()
        if (drainState.settled || drainState.observerFailed || drainState.streamEnded) break
        let nextItem: AgyIngress | undefined
        try {
          // oxlint-disable-next-line no-await-in-loop -- Continuous O(1) ordered drain while RPC is in flight.
          nextItem = await stream.nextIngress(undefined, drainAbort.signal)
        } catch (waitError) {
          if (drainAbort.signal.aborted) {
            break
          }
          throw waitError
        }
        if (nextItem !== undefined) {
          handleIngressItem(nextItem)
        }
        drainBuffered()
      }
      if (!drainState.observerFailed) {
        await tracked
        await Promise.resolve()
        drainBuffered()
      }
    } finally {
      drainAbort.abort()
    }

    if (drainState.observerFailed) {
      throw drainState.observerError
    }
    if (!drainState.outcome) {
      throw new AgentExecutionError('protocol_error', 'Session load ended unexpectedly.', false)
    }
    if (!drainState.outcome.ok) {
      throw drainState.outcome.error
    }
    return drainState.outcome.value
  }

  private async *awaitControlRpcWithConcurrentDrain<TResult>(params: {
    requestPromise: Promise<TResult>
    requestId?: number | undefined
    stream: AgyOrderedSessionStream | undefined
    shiftPendingEvent: () => NormalizedAgentEvent | undefined
    setWakeup: (fn: (() => void) | undefined) => void
    onNotification: (notification: object) => void
    onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
  }): AsyncGenerator<NormalizedAgentEvent, TResult, void> {
    const {
      requestPromise,
      requestId,
      stream,
      shiftPendingEvent,
      setWakeup,
      onNotification,
      onServerRequest,
    } = params
    const drainAbort = new AbortController()
    const drainState: {
      settled: boolean
      outcome: { ok: true; value: TResult } | { ok: false; error: unknown } | undefined
      replyObserved: boolean
      streamEnded: boolean
      observerFailed: boolean
      observerError: unknown
    } = {
      settled: false,
      outcome: undefined,
      replyObserved: false,
      streamEnded: false,
      observerFailed: false,
      observerError: undefined,
    }
    let wakeLocal: (() => void) | undefined

    const triggerWake = (): void => {
      const fn = wakeLocal
      wakeLocal = undefined
      fn?.()
    }

    const recordObserverFailure = (error: unknown): void => {
      if (!drainState.observerFailed) {
        drainState.observerFailed = true
        drainState.observerError = error
      }
      drainState.settled = true
      drainAbort.abort()
      triggerWake()
    }

    const handleIngressItem = (item: AgyIngress): boolean => {
      if (drainState.observerFailed) return false
      if (item.kind === 'notification') {
        try {
          onNotification(item.message)
        } catch (error) {
          recordObserverFailure(error)
          throw error
        }
        return true
      }
      if (item.kind === 'server_request') {
        try {
          onServerRequest?.(item)
        } catch (error) {
          recordObserverFailure(error)
          throw error
        }
        return true
      }
      if (item.kind === 'reply') {
        if (requestId === undefined || item.requestId === requestId) {
          drainState.replyObserved = true
          return false
        }
        return true
      }
      drainState.streamEnded = true
      return false
    }

    const tracked = requestPromise.then(
      (value) => {
        drainState.settled = true
        drainState.outcome = { ok: true, value }
        drainAbort.abort()
        triggerWake()
        return undefined
      },
      (error: unknown) => {
        drainState.settled = true
        drainState.outcome = { ok: false, error }
        drainAbort.abort()
        triggerWake()
        return undefined
      },
    )

    const drainBuffered = (): void => {
      if (!stream) return
      while (!drainState.observerFailed && !drainState.replyObserved && !drainState.streamEnded) {
        const item = stream.shift()
        if (!item) break
        if (!handleIngressItem(item)) break
      }
    }

    let pendingStreamNext: Promise<void> | undefined
    try {
      while (!drainState.settled && !drainState.observerFailed && !drainState.streamEnded) {
        drainBuffered()
        let nextEvent = shiftPendingEvent()
        while (nextEvent !== undefined) {
          yield nextEvent
          nextEvent = shiftPendingEvent()
        }
        if (drainState.settled || drainState.observerFailed || drainState.streamEnded) break

        const wakePromise = new Promise<void>((resolveWake) => {
          wakeLocal = resolveWake
          setWakeup(() => {
            setWakeup(undefined)
            triggerWake()
          })
        })

        if (stream && !pendingStreamNext) {
          const created = stream
            .nextIngress(undefined, drainAbort.signal)
            .then(
              (item) => {
                if (pendingStreamNext === created) pendingStreamNext = undefined
                handleIngressItem(item)
                return undefined
              },
              (waitError: unknown) => {
                if (pendingStreamNext === created) pendingStreamNext = undefined
                if (!drainAbort.signal.aborted) {
                  recordObserverFailure(waitError)
                }
                return undefined
              },
            )
            .catch((obsError: unknown) => {
              recordObserverFailure(obsError)
            })
          pendingStreamNext = created
        }

        // oxlint-disable-next-line no-await-in-loop -- Concurrent init-event yield and ordered replay drain.
        await Promise.race(pendingStreamNext ? [wakePromise, pendingStreamNext] : [wakePromise])
      }

      if (!drainState.observerFailed) {
        await tracked
        await Promise.resolve()
        drainBuffered()
        let nextEvent = shiftPendingEvent()
        while (nextEvent !== undefined) {
          yield nextEvent
          nextEvent = shiftPendingEvent()
        }
      }
    } finally {
      setWakeup(undefined)
      drainAbort.abort()
    }

    if (drainState.observerFailed) {
      throw drainState.observerError
    }
    if (!drainState.outcome) {
      throw new AgentExecutionError('protocol_error', 'Control RPC ended unexpectedly.', false)
    }
    if (!drainState.outcome.ok) {
      throw drainState.outcome.error
    }
    return drainState.outcome.value
  }

  private rememberSessionModeState(
    sessionId: string,
    reportedModeId: string | undefined,
  ): SessionModeState {
    const existing = this.sessionModes.get(sessionId)
    if (existing) {
      if (reportedModeId) existing.currentModeId = reportedModeId
      this.sessionModes.delete(sessionId)
      this.sessionModes.set(sessionId, existing)
      return existing
    }
    if (this.sessionModes.size >= AGY_SESSION_MODE_CACHE_LIMIT) {
      const oldestKey = this.sessionModes.keys().next().value
      if (oldestKey !== undefined) this.sessionModes.delete(oldestKey)
    }
    const currentModeId = reportedModeId ?? 'default'
    const initialNonPlanModeId = currentModeId !== 'plan' ? currentModeId : 'default'
    const state: SessionModeState = {
      initialNonPlanModeId,
      currentModeId,
      enteredPlanModeByPact: false,
    }
    this.sessionModes.set(sessionId, state)
    return state
  }

  private async setAndConfirmSessionMode(
    connection: AgyAcpConnection,
    sessionId: string,
    modeId: string,
    signal: AbortSignal,
    options?: {
      sessionStream?: AgyOrderedSessionStream | undefined
      onMetadataNotification?: ((notification: object) => void) | undefined
      onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
    },
  ): Promise<void> {
    const sessionStream = options?.sessionStream
    const op = connection.requestOwned(
      'session/set_mode',
      { sessionId, modeId },
      {
        timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS,
        signal,
        ...(sessionStream ? { replyTo: sessionStream } : {}),
      },
    )
    const response = sessionStream
      ? await this.runWithConcurrentReplayDrain(
          op.result,
          sessionStream,
          (note) => options?.onMetadataNotification?.(note),
          undefined,
          op.requestId,
          options?.onServerRequest,
        )
      : await op.result
    const error = Reflect.get(response, 'error')
    const result = Reflect.get(response, 'result')
    if (error || !isPlainObject(result)) {
      throw new PermissionModeRejectedError(
        `Antigravity rejected permission mode "${modeId}"${
          error ? `: ${safeNativePermissionText(JSON.stringify(error), 200)}` : '.'
        }`,
      )
    }
  }

  private async configureSessionModeBeforePrompt(params: {
    connection: AgyAcpConnection
    sessionId: string
    descriptor: AcpSessionDescriptor
    sessionState: SessionModeState
    sessionStream?: AgyOrderedSessionStream | undefined
    onMetadataNotification?: ((notification: object) => void) | undefined
    onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
    readOnlyStage: boolean
    permissionMode: SessionPermissionMode
    signal: AbortSignal
  }): Promise<void> {
    const {
      connection,
      sessionId,
      descriptor,
      sessionState,
      sessionStream,
      onMetadataNotification,
      onServerRequest,
      readOnlyStage,
      permissionMode,
      signal,
    } = params
    const drainOptions = { sessionStream, onMetadataNotification, onServerRequest }

    if (readOnlyStage) {
      if (descriptor.availableModes && !descriptor.availableModes.includes('plan')) {
        throw new PermissionModeRejectedError(
          'Antigravity does not advertise native Plan mode required for read-only collaboration stages.',
        )
      }
      await this.setAndConfirmSessionMode(connection, sessionId, 'plan', signal, drainOptions)
      sessionState.currentModeId = 'plan'
      sessionState.enteredPlanModeByPact = true
      return
    }

    // Non-read-only stage: ALWAYS retire stale `plan` mode explicitly before any prompt!
    const needsPlanRetirement =
      sessionState.enteredPlanModeByPact ||
      sessionState.currentModeId === 'plan' ||
      descriptor.currentModeId === 'plan'

    if (permissionMode === 'ask') {
      await this.setAndConfirmSessionMode(connection, sessionId, 'default', signal, drainOptions)
      sessionState.currentModeId = 'default'
      sessionState.enteredPlanModeByPact = false
      return
    }

    if (permissionMode === 'auto') {
      if (descriptor.availableModes && !descriptor.availableModes.includes('auto')) {
        throw new PermissionModeRejectedError(
          'Antigravity does not offer Auto permission mode for this session.',
        )
      }
      await this.setAndConfirmSessionMode(connection, sessionId, 'auto', signal, drainOptions)
      sessionState.currentModeId = 'auto'
      sessionState.enteredPlanModeByPact = false
      return
    }

    if (permissionMode === 'native' || permissionMode === 'full') {
      if (needsPlanRetirement) {
        const restoreMode = sessionState.initialNonPlanModeId || 'default'
        await this.setAndConfirmSessionMode(
          connection,
          sessionId,
          restoreMode,
          signal,
          drainOptions,
        )
        sessionState.currentModeId = restoreMode
        sessionState.enteredPlanModeByPact = false
      }
    }
  }

  private async configureModelAndEffortBeforePrompt(params: {
    connection: AgyAcpConnection
    sessionId: string
    descriptor: AcpSessionDescriptor
    sessionStream: AgyOrderedSessionStream | undefined
    onMetadataNotification: (notification: object) => void
    onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
    requestedModel: string | null
    requestedEffort: string | null
    signal: AbortSignal
  }): Promise<{ model: string; effort: string | null; effortKnown: boolean }> {
    const {
      connection,
      sessionId,
      descriptor,
      sessionStream,
      onMetadataNotification,
      onServerRequest,
      requestedModel,
      requestedEffort,
      signal,
    } = params
    let configOptions = descriptor.configOptions
    let currentModelId = descriptor.currentModelId

    const drainNotifiedConfigOptions = async (
      accept?: (options: AcpConfigOptionEntry[]) => boolean,
    ): Promise<AcpConfigOptionEntry[] | undefined> => {
      if (!sessionStream) return undefined
      await Promise.resolve()
      let latest: AcpConfigOptionEntry[] | undefined
      while (true) {
        const item = sessionStream.shift()
        if (!item) break
        if (item.kind === 'server_request') {
          onServerRequest?.(item)
          continue
        }
        if (item.kind !== 'notification') continue
        onMetadataNotification(item.message)
        const parsed = this.extractConfigOptionsFromNotification(item.message, sessionId)
        if (parsed && (!accept || accept(parsed))) latest = parsed
      }
      return latest
    }

    const findOption = (id: string): AcpConfigOptionEntry | undefined =>
      configOptions.find((entry) => entry.id === id)

    const initialModelOption = findOption('model')
    const declaredModelFamilies = initialModelOption?.options?.map((opt) => opt.value)
    const concreteModelMatches = (actualModelId: string): boolean => {
      if (requestedModel === null) return true
      return actualModelId === requestedModel
    }
    const isFamilyPrefixOf = (family: string, concrete: string): boolean =>
      declaredModelFamilies !== undefined &&
      declaredModelFamilies.length > 0 &&
      declaredModelFamilies.includes(family) &&
      concrete.startsWith(`${family}-`)
    const configFamilyMatchesRequested = (actualValue: string): boolean => {
      if (requestedModel === null) return true
      if (actualValue === requestedModel) return true
      return isFamilyPrefixOf(actualValue, requestedModel)
    }
    const priorModelId = descriptor.currentModelId ?? initialModelOption?.currentValue
    const didSwitchModel = requestedModel !== null && priorModelId !== requestedModel
    const isAmbiguousSharedFamilyUpdate = (notifiedModel: string): boolean =>
      didSwitchModel &&
      requestedModel !== null &&
      priorModelId !== undefined &&
      notifiedModel !== requestedModel &&
      isFamilyPrefixOf(notifiedModel, requestedModel) &&
      isFamilyPrefixOf(notifiedModel, priorModelId)
    const modelAttribution = {
      didSwitchModel,
      requestedModel,
      priorModelId,
      declaredModelFamilies,
      configFamilyMatchesRequested,
      isAmbiguousSharedFamilyUpdate,
    }

    let derivedEffortFromModelVariant: string | undefined

    if (requestedModel !== null) {
      const modelOption = initialModelOption
      const matchesConfigFamily =
        modelOption?.options?.some((opt) => opt.value === requestedModel) ?? false

      if (
        matchesConfigFamily ||
        (modelOption && !descriptor.availableModels?.includes(requestedModel))
      ) {
        let targetFamily = requestedModel
        if (
          modelOption?.options &&
          !modelOption.options.some((opt) => opt.value === requestedModel)
        ) {
          // Check whether `requestedModel` is a `<family>-<thought_level>` composite ID from `models.availableModels`.
          const matchedFamily = modelOption.options
            .map((opt) => opt.value)
            .toSorted((a, b) => b.length - a.length)
            .find((family) => requestedModel.startsWith(`${family}-`))
          if (!matchedFamily) {
            throw new AgentExecutionError(
              'runtime_incompatible',
              `Antigravity does not offer model "${requestedModel}".`,
              false,
            )
          }
          targetFamily = matchedFamily
          derivedEffortFromModelVariant = requestedModel.slice(matchedFamily.length + 1)
        }
        if (modelOption?.currentValue !== targetFamily) {
          // Invalidate stale model-dependent `configOptions` BEFORE applying new model.
          configOptions = []
          configOptions = await this.setConfigOptionAndConfirm({
            connection,
            sessionId,
            configId: 'model',
            value: targetFamily,
            sessionStream,
            onMetadataNotification,
            onServerRequest,
            modelAttribution,
            signal,
          })
        }
        currentModelId = requestedModel
      } else if (descriptor.availableModels?.includes(requestedModel)) {
        const classifySetModelOptions = (
          options: AcpConfigOptionEntry[],
        ): 'match' | 'stale_prior' | 'unattributed_during_switch' | 'conflict' => {
          const notifiedModel = options.find((opt) => opt.id === 'model')?.currentValue
          if (notifiedModel === undefined) {
            if (didSwitchModel) {
              return 'unattributed_during_switch'
            }
            return 'match'
          }
          if (isAmbiguousSharedFamilyUpdate(notifiedModel)) {
            return 'unattributed_during_switch'
          }
          if (configFamilyMatchesRequested(notifiedModel)) {
            return 'match'
          }
          if (
            priorModelId !== undefined &&
            (notifiedModel === priorModelId || isFamilyPrefixOf(notifiedModel, priorModelId))
          ) {
            return 'stale_prior'
          }
          return 'conflict'
        }
        if (
          didSwitchModel ||
          (modelOption?.currentValue !== undefined &&
            !configFamilyMatchesRequested(modelOption.currentValue))
        ) {
          // Invalidate stale `configOptions` from the prior model immediately on model change.
          configOptions = []
        }
        await drainNotifiedConfigOptions()
        const setModelOp = connection.requestOwned(
          'session/set_model',
          { sessionId, modelId: requestedModel },
          {
            timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS,
            signal,
            ...(sessionStream ? { replyTo: sessionStream } : {}),
          },
        )
        const setModelReq = setModelOp.result
        const setModelTrack: {
          matched: AcpConfigOptionEntry[] | undefined
          conflictModel: string | undefined
          replyError: AgentExecutionError | undefined
          replyHadOptions: boolean
        } = {
          matched: undefined,
          conflictModel: undefined,
          replyError: undefined,
          replyHadOptions: false,
        }
        const recordSetModelOptions = (parsed: AcpConfigOptionEntry[]): void => {
          const verdict = classifySetModelOptions(parsed)
          if (verdict === 'match') {
            setModelTrack.matched = parsed
            setModelTrack.conflictModel = undefined
          } else if (verdict === 'conflict') {
            setModelTrack.matched = undefined
            setModelTrack.conflictModel =
              parsed.find((opt) => opt.id === 'model')?.currentValue ?? 'unknown'
          }
        }
        const observeSetModelReply = (resp: object): void => {
          const rErr = Reflect.get(resp, 'error')
          const rRes = Reflect.get(resp, 'result')
          if (rErr || !isPlainObject(rRes)) return
          if (!Array.isArray(Reflect.get(rRes, 'configOptions'))) return
          const parsedReply = parseConfigOptions(Reflect.get(rRes, 'configOptions'))
          setModelTrack.replyHadOptions = true
          const replyOptModel = parsedReply.find((opt) => opt.id === 'model')?.currentValue
          if (replyOptModel !== undefined && !configFamilyMatchesRequested(replyOptModel)) {
            setModelTrack.replyError = new AgentExecutionError(
              'runtime_incompatible',
              `Antigravity silently substituted model="${replyOptModel}" for requested "${requestedModel}".`,
              false,
            )
            return
          }
          setModelTrack.matched = parsedReply
          setModelTrack.conflictModel = undefined
        }
        const setModelResp = sessionStream
          ? await this.runWithConcurrentReplayDrain(
              setModelReq,
              sessionStream,
              (note) => {
                onMetadataNotification(note)
                const parsed = this.extractConfigOptionsFromNotification(note, sessionId)
                if (parsed) recordSetModelOptions(parsed)
              },
              observeSetModelReply,
              setModelOp.requestId,
              onServerRequest,
            )
          : await setModelReq
        const err = Reflect.get(setModelResp, 'error')
        const res = Reflect.get(setModelResp, 'result')
        if (err || !isPlainObject(res)) {
          throw new AgentExecutionError(
            'runtime_incompatible',
            `Antigravity rejected model "${requestedModel}".`,
            false,
          )
        }
        if (!sessionStream) {
          observeSetModelReply(setModelResp)
        }
        const replyReportedModel = asString(
          Reflect.get(res, 'modelId') ?? Reflect.get(res, 'currentModelId'),
        )
        if (replyReportedModel !== undefined && !concreteModelMatches(replyReportedModel)) {
          throw new AgentExecutionError(
            'runtime_incompatible',
            `Antigravity silently substituted model="${replyReportedModel}" for requested "${requestedModel}".`,
            false,
          )
        }
        if (setModelTrack.replyError) {
          throw setModelTrack.replyError
        }
        const throwIfSetModelConflict = (): void => {
          if (setModelTrack.conflictModel !== undefined) {
            throw new AgentExecutionError(
              'runtime_incompatible',
              `Antigravity silently substituted model="${setModelTrack.conflictModel}" for requested "${requestedModel}".`,
              false,
            )
          }
        }
        throwIfSetModelConflict()
        if (sessionStream) {
          await Promise.resolve()
          while (true) {
            const item = sessionStream.shift()
            if (!item) break
            if (item.kind === 'server_request') {
              onServerRequest?.(item)
              continue
            }
            if (item.kind !== 'notification') continue
            onMetadataNotification(item.message)
            const parsed = this.extractConfigOptionsFromNotification(item.message, sessionId)
            if (parsed) recordSetModelOptions(parsed)
          }
        }
        throwIfSetModelConflict()
        if (setModelTrack.replyHadOptions) {
          configOptions = setModelTrack.matched ?? []
        } else {
          let confirmedUpdated = setModelTrack.matched
          if (confirmedUpdated === undefined && sessionStream) {
            const awaited = await this.awaitPostReplyConfigOptionUpdate(
              sessionStream,
              onMetadataNotification,
              signal,
              AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS,
              (opts) => {
                const verdict = classifySetModelOptions(opts)
                return verdict === 'match' || verdict === 'conflict'
              },
              onServerRequest,
              sessionId,
            )
            if (awaited !== undefined) {
              if (classifySetModelOptions(awaited) === 'conflict') {
                const actualModel =
                  awaited.find((opt) => opt.id === 'model')?.currentValue ?? 'unknown'
                throw new AgentExecutionError(
                  'runtime_incompatible',
                  `Antigravity silently substituted model="${actualModel}" for requested "${requestedModel}".`,
                  false,
                )
              }
              confirmedUpdated = awaited
            }
          }
          if (confirmedUpdated !== undefined) {
            configOptions = confirmedUpdated
          }
        }
        currentModelId = requestedModel
      } else if (!modelOption && !descriptor.availableModels) {
        configOptions = []
        configOptions = await this.setConfigOptionAndConfirm({
          connection,
          sessionId,
          configId: 'model',
          value: requestedModel,
          sessionStream,
          onMetadataNotification,
          onServerRequest,
          modelAttribution,
          signal,
        })
        currentModelId = requestedModel
      } else {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity does not offer model "${requestedModel}".`,
          false,
        )
      }
    }

    const trailingBeforeEffort = await drainNotifiedConfigOptions((options) => {
      const notifiedModel = options.find((opt) => opt.id === 'model')?.currentValue
      if (notifiedModel === undefined) {
        if (didSwitchModel) return false
        return !(
          requestedModel !== null &&
          initialModelOption !== undefined &&
          configOptions.length === 0
        )
      }
      if (requestedModel !== null) {
        if (isAmbiguousSharedFamilyUpdate(notifiedModel)) return false
        if (configFamilyMatchesRequested(notifiedModel)) return true
        const currentFamily = findOption('model')?.currentValue
        if (
          priorModelId !== undefined &&
          (notifiedModel === priorModelId ||
            (declaredModelFamilies !== undefined &&
              declaredModelFamilies.length > 0 &&
              declaredModelFamilies.includes(notifiedModel) &&
              priorModelId.startsWith(`${notifiedModel}-`))) &&
          currentFamily !== priorModelId
        ) {
          return false
        }
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity silently substituted model="${notifiedModel}" for requested "${requestedModel}".`,
          false,
        )
      }
      return true
    })
    if (trailingBeforeEffort !== undefined) {
      configOptions = trailingBeforeEffort
    }

    const effectiveRequestedEffort = requestedEffort ?? derivedEffortFromModelVariant ?? null
    if (effectiveRequestedEffort !== null) {
      const thoughtOption = findOption('thought_level')
      if (configOptions.length > 0 && !thoughtOption) {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity model "${requestedModel ?? currentModelId ?? 'default'}" does not expose thought_level "${effectiveRequestedEffort}".`,
          false,
        )
      }
      if (
        thoughtOption?.options &&
        !thoughtOption.options.some((opt) => opt.value === effectiveRequestedEffort)
      ) {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity model does not support thought_level "${effectiveRequestedEffort}".`,
          false,
        )
      }
      if (!thoughtOption || thoughtOption.currentValue !== effectiveRequestedEffort) {
        configOptions = await this.setConfigOptionAndConfirm({
          connection,
          sessionId,
          configId: 'thought_level',
          value: effectiveRequestedEffort,
          sessionStream,
          onMetadataNotification,
          onServerRequest,
          modelAttribution,
          signal,
        })
      }
      const confirmedThought = findOption('thought_level')
      if (!confirmedThought || confirmedThought.currentValue !== effectiveRequestedEffort) {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity did not confirm thought_level "${effectiveRequestedEffort}".`,
          false,
        )
      }
    }

    const finalModelOption = findOption('model')
    if (
      requestedModel !== null &&
      finalModelOption?.currentValue !== undefined &&
      !configFamilyMatchesRequested(finalModelOption.currentValue)
    ) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity silently substituted model="${finalModelOption.currentValue}" for requested "${requestedModel}".`,
        false,
      )
    }
    const finalThoughtOption = findOption('thought_level')
    const modelKnown =
      requestedModel !== null ||
      finalModelOption?.currentValue !== undefined ||
      currentModelId !== undefined
    const effortKnown =
      effectiveRequestedEffort !== null ||
      (configOptions.length > 0 &&
        (finalThoughtOption?.currentValue !== undefined || !finalThoughtOption))
    const resolvedModel =
      requestedModel ?? finalModelOption?.currentValue ?? currentModelId ?? 'agy-default'
    const resolvedEffort =
      effectiveRequestedEffort !== null
        ? effectiveRequestedEffort
        : (finalThoughtOption?.currentValue ?? null)

    return { model: resolvedModel, effort: resolvedEffort, effortKnown: modelKnown && effortKnown }
  }

  private async awaitPostReplyConfigOptionUpdate(
    sessionStream: AgyOrderedSessionStream,
    onMetadataNotification: (notification: object) => void,
    signal: AbortSignal,
    windowMs = AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS,
    matches?: (options: AcpConfigOptionEntry[]) => boolean,
    onServerRequest?: (req: Extract<AgyIngress, { kind: 'server_request' }>) => void,
    sessionId?: string,
  ): Promise<AcpConfigOptionEntry[] | undefined> {
    const deadlineAt = Date.now() + windowMs
    let latest: AcpConfigOptionEntry[] | undefined
    while (true) {
      while (true) {
        const buffered = sessionStream.shift()
        if (!buffered) break
        if (buffered.kind === 'server_request') {
          onServerRequest?.(buffered)
          continue
        }
        if (buffered.kind === 'end') return matches ? undefined : latest
        if (buffered.kind !== 'notification') continue
        onMetadataNotification(buffered.message)
        const parsed = this.extractConfigOptionsFromNotification(buffered.message, sessionId)
        if (parsed) {
          latest = parsed
          if (!matches || matches(parsed)) return parsed
        }
      }
      if (latest !== undefined && !matches) return latest
      const remainingMs = deadlineAt - Date.now()
      if (remainingMs <= 0) return matches ? undefined : latest
      // oxlint-disable-next-line no-await-in-loop -- Bounded short wait for post-reply `config_option_update`.
      const nextItem = await sessionStream.nextIngress(remainingMs, signal).catch(() => undefined)
      if (!nextItem) {
        signal.throwIfAborted()
        return matches ? undefined : latest
      }
      if (nextItem.kind === 'server_request') {
        onServerRequest?.(nextItem)
        continue
      }
      if (nextItem.kind === 'end') return matches ? undefined : latest
      if (nextItem.kind !== 'notification') continue
      onMetadataNotification(nextItem.message)
      const parsed = this.extractConfigOptionsFromNotification(nextItem.message, sessionId)
      if (parsed) {
        latest = parsed
        if (!matches || matches(parsed)) return parsed
      }
    }
  }

  private async setConfigOptionAndConfirm(params: {
    connection: AgyAcpConnection
    sessionId: string
    configId: 'model' | 'thought_level'
    value: string
    sessionStream: AgyOrderedSessionStream | undefined
    onMetadataNotification: (notification: object) => void
    onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
    modelAttribution?: {
      didSwitchModel: boolean
      requestedModel: string | null
      priorModelId: string | undefined
      declaredModelFamilies: readonly string[] | undefined
      configFamilyMatchesRequested: (actualValue: string) => boolean
      isAmbiguousSharedFamilyUpdate: (notifiedModel: string) => boolean
    }
    signal: AbortSignal
  }): Promise<AcpConfigOptionEntry[]> {
    const {
      connection,
      sessionId,
      configId,
      value,
      sessionStream,
      onMetadataNotification,
      onServerRequest,
      modelAttribution,
      signal,
    } = params
    if (sessionStream) {
      while (true) {
        const buffered = sessionStream.shift()
        if (!buffered) break
        if (buffered.kind === 'server_request') {
          onServerRequest?.(buffered)
          continue
        }
        if (buffered.kind !== 'notification') continue
        onMetadataNotification(buffered.message)
      }
    }
    const isStalePriorModel = (notifiedModel: string): boolean => {
      if (!modelAttribution?.priorModelId) return false
      return (
        notifiedModel === modelAttribution.priorModelId ||
        (modelAttribution.declaredModelFamilies !== undefined &&
          modelAttribution.declaredModelFamilies.length > 0 &&
          modelAttribution.declaredModelFamilies.includes(notifiedModel) &&
          modelAttribution.priorModelId.startsWith(`${notifiedModel}-`))
      )
    }
    const classifyAsyncOptions = (
      options: AcpConfigOptionEntry[],
    ): 'match' | 'other_attributed' | 'ignore' | 'conflict' => {
      if (modelAttribution) {
        const notifiedModel = options.find((opt) => opt.id === 'model')?.currentValue
        if (notifiedModel === undefined) {
          if (modelAttribution.didSwitchModel || configId === 'model') {
            return 'ignore'
          }
        } else if (modelAttribution.isAmbiguousSharedFamilyUpdate(notifiedModel)) {
          // Same-family variant switch: family-only async notifications cannot confirm either
          // `model` OR model-dependent `thought_level`!
          return 'ignore'
        } else if (
          modelAttribution.requestedModel !== null &&
          !modelAttribution.configFamilyMatchesRequested(notifiedModel)
        ) {
          return isStalePriorModel(notifiedModel) ? 'ignore' : 'conflict'
        }
      }
      return options.find((opt) => opt.id === configId)?.currentValue === value
        ? 'match'
        : 'other_attributed'
    }
    const setOptionOp = connection.requestOwned(
      'session/set_config_option',
      { sessionId, configId, value },
      {
        timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS,
        signal,
        ...(sessionStream ? { replyTo: sessionStream } : {}),
      },
    )
    const requestPromise = setOptionOp.result
    let latestAttributedOptions: AcpConfigOptionEntry[] | undefined
    let latestAttributedMatched = false
    let conflictModelDuringSet: string | undefined
    let replyError: AgentExecutionError | undefined
    let replyHadOptions = false
    const observeAsyncConfigOptions = (parsed: AcpConfigOptionEntry[]): void => {
      const verdict = classifyAsyncOptions(parsed)
      if (verdict === 'conflict') {
        conflictModelDuringSet = parsed.find((opt) => opt.id === 'model')?.currentValue ?? 'unknown'
        latestAttributedOptions = undefined
        latestAttributedMatched = false
      } else if (verdict === 'match') {
        conflictModelDuringSet = undefined
        latestAttributedOptions = parsed
        latestAttributedMatched = true
      } else if (verdict === 'other_attributed') {
        conflictModelDuringSet = undefined
        latestAttributedOptions = parsed
        latestAttributedMatched = false
      }
    }
    const observeReplyOptions = (resp: object): void => {
      const rErr = Reflect.get(resp, 'error')
      const rRes = Reflect.get(resp, 'result')
      if (rErr || !isPlainObject(rRes)) return
      if (!Array.isArray(Reflect.get(rRes, 'configOptions'))) return
      const parsedReply = parseConfigOptions(Reflect.get(rRes, 'configOptions'))
      replyHadOptions = true
      if (modelAttribution && modelAttribution.requestedModel !== null) {
        const replyModel = parsedReply.find((opt) => opt.id === 'model')?.currentValue
        if (
          replyModel !== undefined &&
          !modelAttribution.configFamilyMatchesRequested(replyModel)
        ) {
          replyError = new AgentExecutionError(
            'runtime_incompatible',
            `Antigravity silently substituted model="${replyModel}" for requested "${modelAttribution.requestedModel}".`,
            false,
          )
          return
        }
      }
      conflictModelDuringSet = undefined
      latestAttributedOptions = parsedReply
      latestAttributedMatched =
        parsedReply.find((opt) => opt.id === configId)?.currentValue === value
    }
    const response = sessionStream
      ? await this.runWithConcurrentReplayDrain(
          requestPromise,
          sessionStream,
          (note) => {
            onMetadataNotification(note)
            const parsed = this.extractConfigOptionsFromNotification(note, sessionId)
            if (parsed) observeAsyncConfigOptions(parsed)
          },
          observeReplyOptions,
          setOptionOp.requestId,
          onServerRequest,
        )
      : await requestPromise
    const error = Reflect.get(response, 'error')
    const result = Reflect.get(response, 'result')
    if (error || !isPlainObject(result)) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity rejected ${configId}="${value}".`,
        false,
      )
    }
    if (!sessionStream) {
      observeReplyOptions(response)
    }
    if (replyError) {
      throw replyError
    }
    if (conflictModelDuringSet !== undefined && modelAttribution?.requestedModel !== null) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity silently substituted model="${conflictModelDuringSet}" for requested "${modelAttribution?.requestedModel ?? 'unknown'}".`,
        false,
      )
    }
    if (sessionStream) {
      await Promise.resolve()
      while (true) {
        const buffered = sessionStream.shift()
        if (!buffered) break
        if (buffered.kind === 'server_request') {
          onServerRequest?.(buffered)
          continue
        }
        if (buffered.kind !== 'notification') continue
        onMetadataNotification(buffered.message)
        const parsed = this.extractConfigOptionsFromNotification(buffered.message, sessionId)
        if (parsed) observeAsyncConfigOptions(parsed)
      }
    }
    if (conflictModelDuringSet !== undefined && modelAttribution?.requestedModel !== null) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity silently substituted model="${conflictModelDuringSet}" for requested "${modelAttribution?.requestedModel ?? 'unknown'}".`,
        false,
      )
    }
    let updated: AcpConfigOptionEntry[]
    if (replyHadOptions) {
      updated = latestAttributedOptions ?? []
    } else {
      if (!latestAttributedMatched && sessionStream) {
        const deadlineAt = Date.now() + AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS
        while (true) {
          let sawEnd = false
          while (true) {
            const buffered = sessionStream.shift()
            if (!buffered) break
            if (buffered.kind === 'server_request') {
              onServerRequest?.(buffered)
              continue
            }
            if (buffered.kind === 'end') {
              sawEnd = true
              break
            }
            if (buffered.kind !== 'notification') continue
            onMetadataNotification(buffered.message)
            const parsed = this.extractConfigOptionsFromNotification(buffered.message, sessionId)
            if (parsed) observeAsyncConfigOptions(parsed)
          }
          if (sawEnd || conflictModelDuringSet !== undefined || latestAttributedMatched) break
          const remainingMs = deadlineAt - Date.now()
          if (remainingMs <= 0) break
          // oxlint-disable-next-line no-await-in-loop -- Bounded short wait for post-reply `config_option_update`.
          const nextItem = await sessionStream
            .nextIngress(remainingMs, signal)
            .catch(() => undefined)
          if (!nextItem) {
            signal.throwIfAborted()
            break
          }
          if (nextItem.kind === 'server_request') {
            onServerRequest?.(nextItem)
            continue
          }
          if (nextItem.kind === 'end') break
          if (nextItem.kind !== 'notification') continue
          onMetadataNotification(nextItem.message)
          const parsed = this.extractConfigOptionsFromNotification(nextItem.message, sessionId)
          if (parsed) observeAsyncConfigOptions(parsed)
        }
      }
      if (conflictModelDuringSet !== undefined && modelAttribution?.requestedModel !== null) {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity silently substituted model="${conflictModelDuringSet}" for requested "${modelAttribution?.requestedModel ?? 'unknown'}".`,
          false,
        )
      }
      updated = latestAttributedOptions ?? []
    }
    const confirmed = updated.find((opt) => opt.id === configId)
    if (confirmed && confirmed.currentValue !== undefined && confirmed.currentValue !== value) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity silently substituted ${configId}="${confirmed.currentValue}" for requested "${value}".`,
        false,
      )
    }
    if (configId === 'thought_level' && (!confirmed || confirmed.currentValue !== value)) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity did not confirm thought_level="${value}".`,
        false,
      )
    }
    return updated
  }

  private buildEffectiveExecutionSettings(
    model: string,
    effort: string | null,
    effortKnown: boolean,
    permissionMode: SessionPermissionMode,
  ): RunEffectiveExecutionSettings | undefined {
    if (!effortKnown) {
      return undefined
    }
    const configurationSha256 = createHash('sha256')
      .update(
        JSON.stringify({
          provider: 'agy',
          model,
          effort,
          speed: 'native',
          permissionMode,
        }),
      )
      .digest('hex')

    return {
      version: 1,
      provider: 'agy',
      model,
      effort: { known: true, value: effort },
      speed: 'native',
      permissionMode,
      configurationSha256,
      provenance: 'agy_applied_settings',
    }
  }

  private async handlePermissionRequest(context: {
    connection: AgyAcpConnection
    validated: ValidatedAgyFrame
    rpcId: string | number
    params: Record<string, unknown>
    paramsObjectValid: boolean
    unscopedDuringForeignTurn: boolean
    preBuiltCard: ReturnType<typeof buildAgyPermissionCard> | undefined
    cwd: string
    input: AgentRunInput
    activeRun: ActiveAgyRun | undefined
    getSessionId: () => string | undefined
    mcpServer: AgyRunMcpServer
    tools: Map<string, AgyToolState>
    approvedBrainPlanCalls: Map<
      string,
      { readonly toolName: string; readonly args: Record<string, unknown> }
    >
    onBrainPlanWriteApproved: (toolCallId: string) => void
    readOnlyStage: boolean
    planModeStage: boolean
    permissionMode: SessionPermissionMode
    permissionWait: NativePermissionWait
    getActiveCount: () => number
    adjustActiveCount: (delta: number) => void
    interactionControllers: Set<AbortController>
    pushEvent: (event: NormalizedAgentEvent) => void
    signal: AbortSignal
  }): Promise<void> {
    const {
      connection,
      validated,
      rpcId,
      params,
      paramsObjectValid,
      unscopedDuringForeignTurn,
      preBuiltCard,
      cwd,
      input,
      activeRun,
      getSessionId,
      mcpServer,
      tools,
      approvedBrainPlanCalls,
      onBrainPlanWriteApproved,
      readOnlyStage,
      planModeStage,
      permissionMode,
      permissionWait,
      getActiveCount,
      adjustActiveCount,
      interactionControllers,
      pushEvent,
      signal,
    } = context

    const mayRevokeCurrentSessionMcp = validated.sessionAttribution !== 'pure_foreign'
    const hasForeignOrInvalidMeta = validated.hasForeignOrInvalidSessionMeta
    const executionContradicted =
      validated.executionIdInvalid ||
      unscopedDuringForeignTurn ||
      (validated.executionId !== undefined &&
        activeRun?.providerExecutionId !== undefined &&
        validated.executionId !== activeRun.providerExecutionId) ||
      (validated.executionId !== undefined &&
        Boolean(activeRun?.knownForeignExecutionIds.has(validated.executionId)))
    const validTcId = validated.toolCallIdInvalid ? undefined : validated.toolCallId
    const inheritedName =
      validated.explicitToolName === undefined &&
      !validated.explicitToolNameInvalid &&
      validTcId !== undefined
        ? mcpServer.lookupVerifiedCallToolName(validTcId)
        : undefined
    const exactToolName = validated.explicitToolName ?? inheritedName ?? ''
    const isAuthorizedPactTool =
      !validated.explicitToolNameInvalid &&
      Boolean(mcpServer.isAuthorizedMcpToolCallName(exactToolName))
    const disputedTokens = validated.tokens.allCanonicalTokens
    const resolvedPt = validated.tokens.resolvedToken
    const hasTerminalOrInvalidPermStatus =
      validated.statusPresent &&
      (validated.statusInvalid ||
        validated.status === 'completed' ||
        validated.status === 'failed' ||
        validated.status === 'cancelled')
    const hasInvalidOrContradictedPermFrame =
      !paramsObjectValid ||
      hasForeignOrInvalidMeta ||
      executionContradicted ||
      validated.rootEvidenceContradicted ||
      validated.tokens.hasInvalidToken ||
      validated.tokens.hasConflictingTokens ||
      validated.toolCallIdInvalid ||
      hasTerminalOrInvalidPermStatus ||
      validated.argsEvidence.kind === 'invalid_or_conflict'

    const recordNegativeNonPactDecision = (): void => {
      if (!mayRevokeCurrentSessionMcp) return
      mcpServer.observeNonPactCall(validTcId, disputedTokens)
    }

    const denyPermission = async (): Promise<void> => {
      const rejectOnce = findRejectOnceOptionId(params.options)
      const payload = rejectOnce
        ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
        : { outcome: { outcome: 'cancelled' } }
      await connection.respond(rpcId, payload).catch(() => undefined)
    }

    // 1. Full access (`requirements.md:519`): explicitly deny ANY residual `session/request_permission`
    // BEFORE any Pact MCP tool-name auto-allow and without surfacing a user approval card!
    // Record refusal of both call ID and all supplied progressTokens BEFORE sending the negative reply.
    if (!readOnlyStage && permissionMode === 'full') {
      if (mayRevokeCurrentSessionMcp) {
        if (isAuthorizedPactTool) {
          mcpServer.revokeDisputedTokens(validTcId, disputedTokens)
        } else {
          recordNegativeNonPactDecision()
        }
      }
      await denyPermission()
      return
    }

    // 2. Record non-Pact call ID & token ownership before replying (independent of activeRun or prior admission).
    if (!isAuthorizedPactTool) {
      recordNegativeNonPactDecision()
    }

    // Reject contradictory, malformed, foreign-execution, terminal-status, or invalid-token
    // permission requests for BOTH Pact and non-Pact tools BEFORE auto-approval or approval cards!
    if (hasInvalidOrContradictedPermFrame) {
      if (mayRevokeCurrentSessionMcp && isAuthorizedPactTool) {
        mcpServer.revokeDisputedTokens(validTcId, disputedTokens)
      }
      await denyPermission()
      return
    }

    // Auto-allow ONLY verified current-root Pact MCP tools matching this Run's active allowed list.
    if (
      activeRun &&
      !activeRun.promptReplyReceived &&
      mcpServer.isRootActive() &&
      !signal.aborted &&
      !hasInvalidOrContradictedPermFrame &&
      isAuthorizedPactTool
    ) {
      const allowOnce = findAllowOnceOptionId(params.options)
      if (!allowOnce || validTcId === undefined) {
        mcpServer.revokeDisputedTokens(validTcId, disputedTokens)
        await denyPermission()
        return
      }
      const admission = mcpServer.observeAcpToolCall({
        toolCallId: validTcId,
        rawToolName: exactToolName,
        status: validated.status ?? 'pending',
        ...(validated.argsEvidence.kind === 'present'
          ? {
              args: validated.argsEvidence.args,
              argsFingerprint: validated.argsEvidence.fingerprint,
            }
          : {}),
        ...(resolvedPt !== undefined ? { progressToken: resolvedPt.canonical } : {}),
        ...(disputedTokens.length > 0 ? { disputedTokens } : {}),
        ...(validated.trajectoryId !== undefined ? { trajectoryId: validated.trajectoryId } : {}),
        ...(validated.stepIdx !== undefined ? { stepIdx: validated.stepIdx } : {}),
      })
      if (admission !== 'admitted') {
        mcpServer.revokeDisputedTokens(validTcId, disputedTokens)
        await denyPermission()
        return
      }
      // Pin root trajectory/step ONLY after full frame validation AND correlator admission succeeded!
      if (validated.trajectoryId !== undefined) {
        mcpServer.pinRootTrajectoryId(validated.trajectoryId)
      } else if (resolvedPt?.structured && !resolvedPt.structured.hasLeadingZeros) {
        mcpServer.pinRootTrajectoryId(resolvedPt.structured.trajectoryId)
      }
      await connection
        .respond(rpcId, { outcome: { outcome: 'selected', optionId: allowOnce } })
        .catch(() => undefined)
      return
    }
    if (mayRevokeCurrentSessionMcp && isAuthorizedPactTool) {
      mcpServer.revokeDisputedTokens(validTcId, disputedTokens)
    }

    // Phase-1 native planning authorizes bounded Markdown artifact writes strictly inside
    // `<appDataDir>/brain/<nativeSessionId>/*.md` with ArtifactMetadata, without surfacing a UI card.
    const isBrainPlanTool =
      !validated.explicitToolNameInvalid &&
      (validated.explicitToolName === 'write_file' || validated.explicitToolName === 'edit_file')
    if (
      planModeStage &&
      activeRun &&
      !activeRun.promptReplyReceived &&
      !activeRun.rootTerminal &&
      !activeRun.cancellationPending &&
      !activeRun.foreignTurnActiveUntilRootBound &&
      mcpServer.isRootActive() &&
      !signal.aborted &&
      !hasInvalidOrContradictedPermFrame &&
      validated.sessionAttribution === 'matching' &&
      validTcId !== undefined &&
      !approvedBrainPlanCalls.has(validTcId) &&
      approvedBrainPlanCalls.size < 64 &&
      isBrainPlanTool &&
      validated.argsEvidence.kind === 'present' &&
      hasValidArtifactMetadata(validated.argsEvidence.args) &&
      isPlainObject(params.toolCall)
    ) {
      const existingTool = tools.get(validTcId)
      const existingToolHealthy =
        !existingTool ||
        (!existingTool.toolIdentityConflicted &&
          !existingTool.argsConflicted &&
          !existingTool.invalidStatus &&
          !existingTool.completedEmitted &&
          (existingTool.explicitToolName === undefined ||
            existingTool.explicitToolName === validated.explicitToolName) &&
          (existingTool.mergedArgs === undefined ||
            mergePlainArgsRecords(existingTool.mergedArgs, validated.argsEvidence.args).kind ===
              'ok'))
      const stepMatches =
        validated.stepIdx === undefined ||
        mcpServer.minStepIdx === undefined ||
        validated.stepIdx >= mcpServer.minStepIdx
      const trajectoryMatches =
        validated.trajectoryId === undefined ||
        mcpServer.pinnedTrajectory === undefined ||
        validated.trajectoryId === mcpServer.pinnedTrajectory
      const argPath = asString(validated.argsEvidence.args.Path ?? validated.argsEvidence.args.path)
      const collected = collectAgyTargetPaths(params.toolCall)
      if (
        existingToolHealthy &&
        stepMatches &&
        trajectoryMatches &&
        argPath !== undefined &&
        isVerifiedDirectBrainPlanWriteTarget(
          argPath,
          cwd,
          this.appDataDirs,
          activeRun.nativeSessionId,
        ) &&
        collected.complete &&
        !collected.hasMoveTarget &&
        collected.paths.length > 0 &&
        collected.paths.every((target) =>
          isVerifiedDirectBrainPlanWriteTarget(
            target,
            cwd,
            this.appDataDirs,
            activeRun.nativeSessionId,
          ),
        )
      ) {
        const allowOnce = findAllowOnceOptionId(params.options)
        if (!allowOnce) {
          await denyPermission()
          return
        }
        approvedBrainPlanCalls.set(validTcId, {
          toolName: validated.explicitToolName,
          args: validated.argsEvidence.args,
        })
        onBrainPlanWriteApproved(validTcId)
        await connection
          .respond(rpcId, { outcome: { outcome: 'selected', optionId: allowOnce } })
          .catch(() => undefined)
        return
      }
    }

    // 3. Read-Only Ironclad Wall (`B4`): deterministically reject ALL workspace/read_file/command/other
    // permission requests using `reject_once` / `deny` (NEVER `options[0]`!).
    if (readOnlyStage) {
      await denyPermission()
      return
    }

    // 4. Interactive user approval (`native`, `ask`, or `auto` classifier escalation).
    if (!input.requestPermission || getActiveCount() >= NATIVE_PERMISSION_REQUESTS) {
      await denyPermission()
      return
    }

    const fenceEpoch = activeRun?.turnEpoch
    const fenceExecutor = activeRun?.executorId
    const fenceGen = activeRun?.bindingGeneration
    const isFenceCurrent = (): boolean =>
      !this.disposed &&
      !signal.aborted &&
      connection.isOpen &&
      (activeRun
        ? !activeRun.promptReplyReceived &&
          !activeRun.rootTerminal &&
          activeRun.turnEpoch === fenceEpoch &&
          activeRun.executorId === fenceExecutor &&
          activeRun.bindingGeneration === fenceGen &&
          !(
            validated.executionId !== undefined &&
            activeRun.providerExecutionId !== undefined &&
            activeRun.providerExecutionId !== validated.executionId
          )
        : true)

    let card: ReturnType<typeof buildAgyPermissionCard>
    try {
      card = preBuiltCard ?? buildAgyPermissionCard(params, cwd)
    } catch {
      await denyPermission()
      return
    }

    adjustActiveCount(1)
    const endConnectionWait = connection.beginPermissionWait()
    const endLocalWait = permissionWait.begin()
    const interactionAbort = new AbortController()
    interactionControllers.add(interactionAbort)

    try {
      if (!isFenceCurrent()) {
        if (connection.isOpen) {
          await connection
            .respond(rpcId, { outcome: { outcome: 'cancelled' } })
            .catch(() => undefined)
        }
        return
      }
      pushEvent({
        agentId: 'agy',
        type: 'interaction.requested',
        turnId: input.runId,
        requestId: String(rpcId),
        category: 'approval',
      })
      const combinedSignal = AbortSignal.any([signal, interactionAbort.signal])
      const permWork = input.requestPermission(card.request, combinedSignal)
      void permWork.catch(() => undefined)
      const decisionId = await NativePermissionWait.decision(permWork, combinedSignal)
      if (!isFenceCurrent()) {
        if (connection.isOpen) {
          await connection
            .respond(rpcId, { outcome: { outcome: 'cancelled' } })
            .catch(() => undefined)
        }
        return
      }
      const mappedResponse = card.responses.get(decisionId) ?? {
        outcome: { outcome: 'cancelled' },
      }
      await connection.respond(rpcId, mappedResponse)
      if (decisionId === 'agy-cancel') {
        const cancelSessionId = activeRun?.nativeSessionId ?? getSessionId()
        if (cancelSessionId) {
          await connection
            .notify('session/cancel', { sessionId: cancelSessionId }, {})
            .catch(() => undefined)
        }
      }
    } catch {
      if (connection.isOpen) {
        await connection
          .respond(rpcId, { outcome: { outcome: 'cancelled' } })
          .catch(() => undefined)
      }
    } finally {
      interactionControllers.delete(interactionAbort)
      endLocalWait()
      endConnectionWait()
      adjustActiveCount(-1)
    }
  }

  private async handleElicitationRequest(context: {
    connection: AgyAcpConnection
    validated: ValidatedAgyFrame
    rpcId: string | number
    params: Record<string, unknown>
    paramsObjectValid: boolean
    unscopedDuringForeignTurn: boolean
    preParsedRequest: NativeUserInputRequest | undefined
    input: AgentRunInput
    activeRun: ActiveAgyRun | undefined
    askOnlyStage: boolean
    readOnlyNonInteractive: boolean
    permissionWait: NativePermissionWait
    interactionControllers: Set<AbortController>
    pushEvent: (event: NormalizedAgentEvent) => void
    signal: AbortSignal
  }): Promise<void> {
    const {
      connection,
      validated,
      rpcId,
      params,
      paramsObjectValid,
      unscopedDuringForeignTurn,
      preParsedRequest,
      input,
      activeRun,
      askOnlyStage,
      readOnlyNonInteractive,
      permissionWait,
      interactionControllers,
      pushEvent,
      signal,
    } = context

    // Reject foreign, malformed, or root-contradicting elicitation requests before prompting the user.
    const executionContradicted =
      validated.executionIdInvalid ||
      unscopedDuringForeignTurn ||
      (validated.executionId !== undefined &&
        activeRun !== undefined &&
        (activeRun.knownForeignExecutionIds.has(validated.executionId) ||
          (activeRun.providerExecutionId !== undefined &&
            activeRun.providerExecutionId !== validated.executionId)))
    if (
      !paramsObjectValid ||
      executionContradicted ||
      validated.hasForeignOrInvalidSessionMeta ||
      validated.rootEvidenceContradicted ||
      validated.tokens.hasInvalidToken ||
      validated.tokens.hasConflictingTokens
    ) {
      await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
      return
    }

    if (!input.requestUserInput || askOnlyStage || readOnlyNonInteractive) {
      await connection.respond(rpcId, { action: 'decline' }).catch(() => undefined)
      return
    }

    let uiRequest: NativeUserInputRequest
    try {
      uiRequest = preParsedRequest ?? agyElicitationRequest(params)
    } catch (error) {
      await connection
        .respondError(
          rpcId,
          error instanceof Error ? error.message : 'Unsupported Antigravity elicitation schema.',
          -32_602,
        )
        .catch(() => undefined)
      return
    }

    const fenceEpoch = activeRun?.turnEpoch
    const fenceExecutor = activeRun?.executorId
    const fenceGen = activeRun?.bindingGeneration
    const isFenceCurrent = (): boolean =>
      !this.disposed &&
      !signal.aborted &&
      connection.isOpen &&
      (activeRun
        ? !activeRun.promptReplyReceived &&
          !activeRun.rootTerminal &&
          activeRun.turnEpoch === fenceEpoch &&
          activeRun.executorId === fenceExecutor &&
          activeRun.bindingGeneration === fenceGen &&
          !(
            validated.executionId !== undefined &&
            activeRun.providerExecutionId !== undefined &&
            activeRun.providerExecutionId !== validated.executionId
          )
        : true)

    const endConnectionWait = connection.beginPermissionWait()
    const endLocalWait = permissionWait.begin()
    const interactionAbort = new AbortController()
    interactionControllers.add(interactionAbort)

    try {
      if (!isFenceCurrent()) {
        if (connection.isOpen) {
          await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
        }
        return
      }
      pushEvent({
        agentId: 'agy',
        type: 'interaction.requested',
        turnId: input.runId,
        requestId: String(rpcId),
        category: 'question',
      })
      const combinedSignal = AbortSignal.any([signal, interactionAbort.signal])
      const userWork = input.requestUserInput(uiRequest, combinedSignal)
      void userWork.catch(() => undefined)
      const decision = await NativePermissionWait.decision(userWork, combinedSignal)
      // Never replay a late answer into a retired or replacement Turn (`B5`).
      if (!isFenceCurrent()) {
        if (connection.isOpen) {
          await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
        }
        return
      }
      if (decision.action === 'accept') {
        await connection.respond(
          rpcId,
          uiRequest.kind === 'url'
            ? { action: 'accept' }
            : { action: 'accept', content: decision.values ?? {} },
        )
      } else {
        await connection.respond(rpcId, { action: decision.action })
      }
    } catch {
      if (connection.isOpen) {
        await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
      }
    } finally {
      interactionControllers.delete(interactionAbort)
      endLocalWait()
      endConnectionWait()
    }
  }

  private *projectSessionNotification(context: {
    validated: ValidatedAgyFrame
    receivedAfterPromptReply: boolean
    input: AgentRunInput
    activeRun: ActiveAgyRun
    cwd: string
    mcpServer: AgyRunMcpServer
    roundTracker: AgyRoundEffectsTracker
    answer: AgentAnswerAssembler
    tools: Map<string, AgyToolState>
    approvedBrainPlanCalls: Map<
      string,
      { readonly toolName: string; readonly args: Record<string, unknown> }
    >
    resizeToolStateBytes: (state: AgyToolState, nextBytes: number) => void
    reasoningItems: Map<string, string>
    getReasoningBytes: () => number
    setReasoningBytes: (bytes: number) => void
    getMessageIndex: () => number
    bumpMessageIndex: () => void
    getThoughtIndex: () => number
    bumpThoughtIndex: () => void
    planModeStage: boolean
    onBrainPlanTouched: () => void
    onBrainPlanOpStarted: (callId: string) => void
    onBrainPlanDeferredReadback: (callId: string) => void
    onBrainPlanCaptured: (callId: string, plan: { nativeId: string; text: string }) => void
    onBrainPlanCaptureFailed: (callId?: string) => void
    onReviewAccepted: (obs: CollaborationReviewObservation) => void
    onInputResultAccepted: (obs: CollaborationInputObservation) => void
    onPlanRetainedAccepted: () => void
    onOpenPlanPublished: (plan: { nativeId: string; text: string }) => void
    onOpenPlanPublishFailed: () => void
    getSessionTitleEmitted: () => boolean
    markSessionTitleEmitted: () => void
    recordSeenForegroundMessageId: (msgIdentity: string, trustedStepIdx?: number) => void
    recordForegroundStepIdx: (stepIdx: number) => void
    onObservedBackgroundTask: () => void
    reportUnknown: (reason: string) => void
    observeFiles: (evidence: Parameters<typeof recordNativeChanges>[1]) => void
    signal: AbortSignal
  }): Generator<NormalizedAgentEvent> {
    const emitted: NormalizedAgentEvent[] = []
    const processFrame = (): void => {
      const { validated, input, activeRun } = context
      if (validated.method !== 'session/update') return
      if (validated.sessionAttribution === 'pure_foreign') return
      const update = validated.payload
      if (!update) return
      const sessionUpdate = validated.sessionUpdate
      if (!sessionUpdate) return

      const updateMeta = Reflect.get(update, '_meta')
      const steerId =
        sessionUpdate === 'user_message_chunk'
          ? (asString(update.pactSteerInputId) ??
            (isPlainObject(updateMeta) ? asString(updateMeta.pactSteerInputId) : undefined))
          : undefined

      const updateExecId = validated.executionId
      const updateStepIdx = update.stepIdx ?? update.step_idx
      const frameRootContradictsPinned =
        !validated.isAttributableToCurrentSession ||
        validated.hasForeignOrInvalidSessionMeta ||
        validated.executionIdInvalid ||
        validated.rootEvidenceContradicted ||
        (updateExecId !== undefined &&
          activeRun.providerExecutionId !== undefined &&
          updateExecId !== activeRun.providerExecutionId) ||
        (updateExecId !== undefined && activeRun.knownForeignExecutionIds.has(updateExecId))
      const frameCanPinRoot =
        !steerId &&
        !context.receivedAfterPromptReply &&
        !frameRootContradictsPinned &&
        !validated.tokens.hasInvalidToken &&
        !validated.tokens.hasConflictingTokens

      // Allow contradictory frames to revoke disputed MCP evidence ONLY; never project text,
      // record steer consumption, update session metadata/activity, or settle work!
      if (frameRootContradictsPinned) {
        if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
          const disputedTokens = validated.tokens.allCanonicalTokens
          const tcId = validated.toolCallIdInvalid ? undefined : validated.toolCallId
          if (tcId !== undefined || disputedTokens.length > 0) {
            context.mcpServer.revokeDisputedTokens(tcId, disputedTokens)
          }
        }
        return
      }

      const trustedStepIdx =
        frameCanPinRoot && validated.stepIdx !== undefined ? validated.stepIdx : undefined

      // Bind `rootStepIdx` and trusted root trajectory ID ONLY after full intra-frame validation passes!
      if (frameCanPinRoot) {
        if (validated.stepIdx !== undefined) {
          context.recordForegroundStepIdx(validated.stepIdx)
          if (activeRun.rootStepIdx === undefined) {
            activeRun.rootStepIdx = validated.stepIdx
            context.mcpServer.notifyRootProofUpdated()
          }
        }
        if (validated.trajectoryId !== undefined) {
          context.mcpServer.pinRootTrajectoryId(validated.trajectoryId)
        } else if (
          validated.tokens.resolvedToken?.structured &&
          !validated.tokens.resolvedToken.structured.hasLeadingZeros
        ) {
          context.mcpServer.pinRootTrajectoryId(
            validated.tokens.resolvedToken.structured.trajectoryId,
          )
        }
      }

      const msgIdentity = asString(update.messageId ?? update.stepId ?? update.toolCallId)
      if (msgIdentity) {
        context.recordSeenForegroundMessageId(msgIdentity, trustedStepIdx)
      }

      if (sessionUpdate === 'session_info_update') {
        const title = asString(update.title)?.trim()
        if (title && title.length <= 120) {
          input.observeNativeTitle?.(activeRun.nativeSessionId, title)
          if (
            !context.getSessionTitleEmitted() &&
            sessionTitleInputSchema.safeParse({ title }).success
          ) {
            context.markSessionTitleEmitted()
            emitted.push({ agentId: 'agy', type: 'session.title.updated', title })
          }
        }
        return
      }

      if (sessionUpdate === 'available_commands_update') {
        this.skillCatalogListener?.()
        return
      }

      if (sessionUpdate === 'current_mode_update') {
        const nextMode = asString(update.currentModeId ?? update.modeId)
        if (nextMode) {
          const modeState = this.sessionModes.get(activeRun.nativeSessionId)
          if (modeState) modeState.currentModeId = nextMode
        }
        return
      }

      if (sessionUpdate === 'user_message_chunk') {
        // Correlate in-Turn steer consumption receipt if echoed on the live stream!
        if (
          steerId &&
          typeof updateStepIdx === 'number' &&
          Number.isSafeInteger(updateStepIdx) &&
          updateStepIdx >= 0 &&
          updateExecId
        ) {
          const steerEntry = activeRun.steeredInputs.get(steerId)
          if (steerEntry && !steerEntry.consumed) {
            steerEntry.candidateStepIdx = updateStepIdx
            steerEntry.candidateExecutionId = updateExecId
            if (activeRun.providerExecutionId) {
              if (this.tryPromoteStagedSteerCandidate(activeRun, steerId, steerEntry)) {
                input.recordInputConsumption?.(steerId, {
                  nativeSessionId: activeRun.nativeSessionId,
                  nativeTurnId: activeRun.nativeTurnId,
                  executorId: activeRun.executorId,
                })
              }
            }
          }
        }
        return
      }

      if (sessionUpdate === 'background_task_completed') {
        const completedTaskId = asString(update.taskId ?? update.backgroundTaskId)
        const completedToolCallId = asString(update.toolCallId ?? update.id)
        this.settleBackgroundTaskByAlias(activeRun, input, [completedTaskId, completedToolCallId])
        return
      }

      if (sessionUpdate === 'usage_update' || sessionUpdate === 'config_option_update') {
        return
      }

      // First substantive model/tool activity confirms Turn acceptance.
      if (!activeRun.turnAccepted) {
        activeRun.turnAccepted = true
        input.recordDispatch?.('accepted', activeRun.nativeSessionId, activeRun.executorId)
        this.recordEvidence(
          input,
          activeRun.nativeSessionId,
          activeRun.executorId,
          {
            kind: 'running',
            source: 'live_runtime',
          },
          activeRun.nativeTurnId,
        )
        emitted.push({ agentId: 'agy', type: 'turn.started', turnId: input.runId })
      }

      if (sessionUpdate === 'agent_thought_chunk') {
        const content = isPlainObject(update.content) ? update.content : undefined
        const delta = content && content.type === 'text' ? asString(content.text) : undefined
        if (!delta) return
        const key = String(context.getThoughtIndex())
        const prev = context.reasoningItems.get(key) ?? ''
        const addedBytes = Buffer.byteLength(delta, 'utf8')
        if (
          (!context.reasoningItems.has(key) &&
            context.reasoningItems.size >= AGY_MAX_REASONING_ITEMS) ||
          context.getReasoningBytes() + addedBytes > AGY_MAX_REASONING_BYTES
        ) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity reasoning summary exceeded the 2 MiB / 64-item budget.',
            false,
          )
        }
        context.setReasoningBytes(context.getReasoningBytes() + addedBytes)
        context.reasoningItems.set(key, prev + delta)
        const activityId = `${input.runId}:thought:${key}`
        emitted.push({
          agentId: 'agy',
          type: 'reasoning.summary.delta',
          turnId: input.runId,
          activityId,
          text: delta,
        })
        return
      }

      if (sessionUpdate === 'agent_message_chunk') {
        if (context.receivedAfterPromptReply) return
        const content = isPlainObject(update.content) ? update.content : undefined
        const text = content && content.type === 'text' ? asString(content.text) : undefined
        if (!text) return
        const itemId = `msg:${context.getMessageIndex()}`
        const delta = context.answer.append(itemId, text)
        if (delta) {
          emitted.push({
            agentId: 'agy',
            type: 'text.delta',
            turnId: input.runId,
            outputId: context.answer.outputId,
            text: delta,
          })
        }
        return
      }

      if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
        // Bump message & thought item indices across tool boundaries so multi-segment answers separate cleanly.
        if (sessionUpdate === 'tool_call') {
          const currentMsgKey = `msg:${context.getMessageIndex()}`
          if (context.answer.text.length > 0 && currentMsgKey) {
            context.bumpMessageIndex()
          }
          const currentThoughtKey = String(context.getThoughtIndex())
          const priorThought = context.reasoningItems.get(currentThoughtKey)
          if (priorThought) {
            emitted.push({
              agentId: 'agy',
              type: 'reasoning.summary.completed',
              turnId: input.runId,
              activityId: `${input.runId}:thought:${currentThoughtKey}`,
              text: priorThought,
            })
            context.reasoningItems.delete(currentThoughtKey)
            context.bumpThoughtIndex()
          }
        }

        const disputedTokens = validated.tokens.allCanonicalTokens
        const resolvedPt = validated.tokens.resolvedToken
        const toolCallId = validated.toolCallIdInvalid ? undefined : validated.toolCallId
        if (!toolCallId) {
          if (disputedTokens.length > 0) {
            const rawToolName = validated.explicitToolName ?? ''
            if (
              validated.explicitToolNameInvalid ||
              !context.mcpServer.isAuthorizedMcpToolCallName(rawToolName)
            ) {
              context.mcpServer.observeNonPactCall(undefined, disputedTokens)
            } else {
              context.mcpServer.revokeDisputedTokens(undefined, disputedTokens)
            }
          }
          return
        }
        const hasExplicitStatus = validated.statusPresent
        const normalizedIncomingStatus = validated.status
        const incomingStatusInvalid = validated.statusInvalid

        let state = context.tools.get(toolCallId)
        if (!state) {
          if (context.tools.size >= AGY_MAX_TOOL_STATES) {
            // Evict oldest completed tool state to stay within <= 64 active items.
            for (const [k, existing] of context.tools) {
              if (existing.completedEmitted) {
                context.resizeToolStateBytes(existing, 0)
                context.tools.delete(k)
                break
              }
            }
          }
          if (context.tools.size >= AGY_MAX_TOOL_STATES) {
            throw new AgentExecutionError(
              'response_too_large',
              'Antigravity exceeded the 64-item concurrent tool call budget.',
              false,
            )
          }
          const inheritedExplicitName =
            validated.explicitToolName === undefined && !validated.explicitToolNameInvalid
              ? context.mcpServer.lookupVerifiedCallToolName(toolCallId)
              : undefined
          const priorApproved = context.approvedBrainPlanCalls.get(toolCallId)
          const initialExplicitName = validated.explicitToolName ?? inheritedExplicitName
          const approvedIdentityMismatch = Boolean(
            priorApproved &&
            initialExplicitName !== undefined &&
            initialExplicitName !== priorApproved.toolName,
          )
          state = {
            toolCallId,
            // Display name may fall back to `update.kind`; authorization STRICTLY uses `explicitToolName`!
            name: initialExplicitName ?? asString(update.kind)?.slice(0, 120) ?? 'tool',
            ...(initialExplicitName !== undefined ? { explicitToolName: initialExplicitName } : {}),
            ...(validated.explicitToolNameInvalid || approvedIdentityMismatch
              ? { toolIdentityConflicted: true }
              : {}),
            title: (asString(update.title) ?? initialExplicitName ?? 'Tool').slice(0, 160),
            status: normalizedIncomingStatus ?? 'pending',
            ...(incomingStatusInvalid ? { invalidStatus: true } : {}),
            reservedBytes: 0,
            startedEmitted: false,
            completedEmitted: false,
          }
          context.tools.set(toolCallId, state)
        } else {
          const priorApproved = context.approvedBrainPlanCalls.get(state.toolCallId)
          if (validated.explicitToolNameInvalid) {
            context.mcpServer.revokeDisputedTokens(
              state.toolCallId,
              state.progressToken ? [...disputedTokens, state.progressToken] : disputedTokens,
            )
            state.toolIdentityConflicted = true
          } else if (validated.explicitToolName !== undefined) {
            const incomingName = validated.explicitToolName
            if (
              (state.explicitToolName !== undefined && incomingName !== state.explicitToolName) ||
              (priorApproved && incomingName !== priorApproved.toolName)
            ) {
              context.mcpServer.revokeDisputedTokens(
                state.toolCallId,
                state.progressToken ? [...disputedTokens, state.progressToken] : disputedTokens,
              )
              state.toolIdentityConflicted = true
            } else if (state.explicitToolName === undefined) {
              state.explicitToolName = incomingName
            }
            state.name = incomingName
          }
          if (asString(update.title)) state.title = asString(update.title)!.slice(0, 160)
          if (hasExplicitStatus) {
            if (normalizedIncomingStatus !== undefined) {
              state.status = normalizedIncomingStatus
            } else {
              state.invalidStatus = true
            }
          }
        }

        const verifiedAuthToolName = state.explicitToolName ?? ''
        const isAuthorizedPactTool =
          !state.toolIdentityConflicted &&
          Boolean(context.mcpServer.isAuthorizedMcpToolCallName(verifiedAuthToolName))

        if (validated.tokens.suppliedCount > 0) {
          if (
            validated.tokens.hasInvalidToken ||
            validated.tokens.hasConflictingTokens ||
            !resolvedPt
          ) {
            state.invalidProgressToken = true
            state.progressToken = undefined
            if (!isAuthorizedPactTool && verifiedAuthToolName.length > 0) {
              context.mcpServer.observeNonPactCall(state.toolCallId, disputedTokens)
            } else {
              context.mcpServer.revokeDisputedTokens(state.toolCallId, disputedTokens)
            }
          } else {
            if (state.progressToken !== undefined && state.progressToken !== resolvedPt.canonical) {
              state.invalidProgressToken = true
              context.mcpServer.revokeDisputedTokens(state.toolCallId, [
                state.progressToken,
                resolvedPt.canonical,
              ])
              state.progressToken = undefined
            } else if (!state.invalidProgressToken) {
              state.progressToken = resolvedPt.canonical
            }
            if (!isAuthorizedPactTool && verifiedAuthToolName.length > 0) {
              context.mcpServer.observeNonPactCall(state.toolCallId, disputedTokens)
            }
          }
        } else if (!isAuthorizedPactTool && verifiedAuthToolName.length > 0) {
          // Explicit non-Pact call without progressToken MUST still register negative ownership on its call ID!
          context.mcpServer.observeNonPactCall(state.toolCallId, disputedTokens)
        }

        const computeCompactToolStateBytes = (): number =>
          64 +
          Buffer.byteLength(state.toolCallId, 'utf8') +
          Buffer.byteLength(state.name, 'utf8') +
          Buffer.byteLength(state.title, 'utf8') +
          Buffer.byteLength(state.status, 'utf8') +
          (state.detail ? Buffer.byteLength(state.detail, 'utf8') + 16 : 0) +
          (state.progressToken ? Buffer.byteLength(state.progressToken, 'utf8') + 16 : 0)

        const computeToolStateBytes = (extraBytes = 0): number =>
          computeCompactToolStateBytes() +
          extraBytes +
          (state.argsBytes ?? 0) +
          (state.rawInputBytes ?? 0) +
          (state.mergedArgsBytes ?? 0) +
          (state.rawOutputBytes ?? 0) +
          (state.contentBytes ?? 0) +
          (state.locationsBytes ?? 0)

        const frameArgs = validated.frameArgs
        const frameRawInput = validated.frameRawInput
        const frameArgsEvidence = validated.argsEvidence

        let acpAdmission: AcpToolCallAdmissionResult = 'already_retired'
        if (!state.completedEmitted) {
          const priorApproved = context.approvedBrainPlanCalls.get(state.toolCallId)
          if (frameArgsEvidence.kind === 'invalid_or_conflict') {
            state.argsConflicted = true
          } else if (frameArgsEvidence.kind === 'present') {
            const baselineArgs = state.mergedArgs ?? priorApproved?.args
            const merged = mergePlainArgsRecords(baselineArgs, frameArgsEvidence.args)
            if (merged.kind === 'conflict') {
              state.argsConflicted = true
            } else {
              state.mergedArgs = merged.args
              state.mergedArgsBytes = estimateJsonPayloadBytes(state.mergedArgs)
            }
          } else if (priorApproved && state.mergedArgs === undefined) {
            state.mergedArgs = { ...priorApproved.args }
            state.mergedArgsBytes = estimateJsonPayloadBytes(state.mergedArgs)
          }
          if (frameArgs) {
            state.args = frameArgs
            state.argsBytes = estimateJsonPayloadBytes(state.args)
          }
          if (frameRawInput) {
            state.rawInput = frameRawInput
            state.rawInputBytes = estimateJsonPayloadBytes(state.rawInput)
          }
          if ('rawOutput' in update) {
            state.rawOutput = update.rawOutput
            state.rawOutputBytes = estimateJsonPayloadBytes(state.rawOutput)
          }
          if (Array.isArray(update.content)) {
            state.content = update.content
            state.contentBytes = estimateJsonPayloadBytes(state.content)
          }
          if (Array.isArray(update.locations)) {
            state.locations = update.locations
            state.locationsBytes = estimateJsonPayloadBytes(state.locations)
          }
          const effectiveArgsForDetail =
            state.mergedArgs ?? frameArgs ?? frameRawInput ?? state.args ?? state.rawInput
          if (effectiveArgsForDetail) {
            const targetPath = asString(effectiveArgsForDetail.Path ?? effectiveArgsForDetail.path)
            const command = asString(
              effectiveArgsForDetail.CommandLine ?? effectiveArgsForDetail.command,
            )
            if (targetPath) state.detail = AgentActivityDetail.projectPath(targetPath, context.cwd)
            else if (command) state.detail = AgentActivityDetail.redact(command)
          }
          context.resizeToolStateBytes(state, computeToolStateBytes())
          if (state.toolIdentityConflicted) {
            context.mcpServer.revokeDisputedTokens(
              state.toolCallId,
              state.progressToken ? [...disputedTokens, state.progressToken] : disputedTokens,
            )
          } else if (!context.receivedAfterPromptReply) {
            if (verifiedAuthToolName.length > 0) {
              acpAdmission = context.mcpServer.observeAcpToolCall({
                toolCallId: state.toolCallId,
                rawToolName: verifiedAuthToolName,
                status: state.status,
                ...(state.invalidStatus || incomingStatusInvalid ? { invalidStatus: true } : {}),
                ...(frameArgsEvidence.kind === 'present'
                  ? {
                      args: frameArgsEvidence.args,
                      argsFingerprint: frameArgsEvidence.fingerprint,
                    }
                  : {}),
                ...(frameArgsEvidence.kind === 'invalid_or_conflict' || state.argsConflicted
                  ? { invalidArgs: true }
                  : {}),
                ...(resolvedPt !== undefined
                  ? { progressToken: resolvedPt.canonical }
                  : state.progressToken !== undefined
                    ? { progressToken: state.progressToken }
                    : {}),
                ...(disputedTokens.length > 0 ? { disputedTokens } : {}),
                ...(state.invalidProgressToken ||
                validated.tokens.hasInvalidToken ||
                validated.tokens.hasConflictingTokens
                  ? { invalidProgressToken: true }
                  : {}),
                ...(validated.trajectoryId !== undefined
                  ? { trajectoryId: validated.trajectoryId }
                  : {}),
                ...(validated.stepIdx !== undefined ? { stepIdx: validated.stepIdx } : {}),
                ...(frameRootContradictsPinned ? { rootEvidenceContradicted: true } : {}),
              })
            } else if (
              frameRootContradictsPinned ||
              state.invalidProgressToken ||
              state.argsConflicted ||
              incomingStatusInvalid
            ) {
              context.mcpServer.revokeDisputedTokens(state.toolCallId, disputedTokens)
            }
          }
        }

        const effectiveArgs = state.mergedArgs ?? state.args ?? state.rawInput

        // Detect and correlate background task launches (`toolCallId` <-> `rawOutput.taskId`).
        const spawnedTaskId = isPlainObject(state.rawOutput)
          ? asString(state.rawOutput.taskId ?? state.rawOutput.backgroundTaskId)
          : undefined
        if (
          (state.name === 'run_command' && effectiveArgs?.IsDaemon === true) ||
          state.name === 'schedule' ||
          Boolean(spawnedTaskId) ||
          activeRun.backgroundTaskAliases.has(state.toolCallId)
        ) {
          this.trackBackgroundTaskLaunch(
            activeRun,
            input,
            state.toolCallId,
            spawnedTaskId,
            state.status,
            context.onObservedBackgroundTask,
            context.reportUnknown,
          )
        }

        // Observe Phase-1 Brain Plan writes (`<appDataDir>/brain/<sessionId>/*.md` with `ArtifactMetadata`).
        // Consumes the SAME single-pass validated frame (pre-cutoff, current-root-attributed, exact
        // `write_file`/`edit_file`, monotonically merged args, matching diff path, completed terminal).
        const isExactBrainPlanTool =
          !state.toolIdentityConflicted &&
          (state.explicitToolName === 'write_file' || state.explicitToolName === 'edit_file')
        if (!state.completedEmitted && context.planModeStage && !isExactBrainPlanTool) {
          if (context.approvedBrainPlanCalls.has(state.toolCallId)) {
            context.onBrainPlanCaptureFailed(state.toolCallId)
          }
        } else if (!state.completedEmitted && context.planModeStage && isExactBrainPlanTool) {
          const argPath = effectiveArgs
            ? asString(effectiveArgs.Path ?? effectiveArgs.path)
            : undefined
          const diffBlocks = Array.isArray(state.content)
            ? state.content.filter(
                (c): c is Record<string, unknown> => isPlainObject(c) && c.type === 'diff',
              )
            : []
          const argIsBrainPlan =
            argPath !== undefined &&
            isMarkdownBrainPlanArtifact(
              argPath,
              context.cwd,
              this.appDataDirs,
              activeRun.nativeSessionId,
            )
          const anyDiffIsBrainPlan = diffBlocks.some((d) => {
            const dp = asString(d.path)
            return (
              dp !== undefined &&
              isMarkdownBrainPlanArtifact(
                dp,
                context.cwd,
                this.appDataDirs,
                activeRun.nativeSessionId,
              )
            )
          })

          if (argIsBrainPlan || anyDiffIsBrainPlan) {
            context.onBrainPlanTouched()
            const frameInvalidForPlan =
              context.receivedAfterPromptReply ||
              frameRootContradictsPinned ||
              state.argsConflicted === true ||
              frameArgsEvidence.kind === 'invalid_or_conflict' ||
              state.invalidStatus === true ||
              incomingStatusInvalid ||
              state.invalidProgressToken === true
            if (frameInvalidForPlan) {
              context.onBrainPlanCaptureFailed(state.toolCallId)
            } else if (
              state.status !== 'completed' &&
              state.status !== 'failed' &&
              state.status !== 'cancelled'
            ) {
              context.onBrainPlanOpStarted(state.toolCallId)
            } else if (state.status === 'failed' || state.status === 'cancelled') {
              context.onBrainPlanCaptureFailed(state.toolCallId)
            } else if (state.status === 'completed') {
              const anyAppDataExistsOnDisk = this.appDataDirs.some((dir) => {
                try {
                  return lstatSync(dir).isDirectory()
                } catch {
                  return false
                }
              })
              if (
                !argIsBrainPlan ||
                !argPath ||
                !effectiveArgs ||
                !hasValidArtifactMetadata(effectiveArgs) ||
                (anyAppDataExistsOnDisk &&
                  !isVerifiedDirectBrainPlanWriteTarget(
                    argPath,
                    context.cwd,
                    this.appDataDirs,
                    activeRun.nativeSessionId,
                  ))
              ) {
                context.onBrainPlanCaptureFailed(state.toolCallId)
              } else if (diffBlocks.length > 1) {
                context.onBrainPlanCaptureFailed(state.toolCallId)
              } else {
                const expectedPlanPath = resolvePath(context.cwd, argPath)
                let candidateText: string | undefined
                let pathMismatch = false
                if (diffBlocks.length === 1) {
                  const diffBlock = diffBlocks[0]!
                  const rawDiffPath = asString(diffBlock.path)
                  if (
                    !rawDiffPath ||
                    resolvePath(context.cwd, rawDiffPath) !== expectedPlanPath ||
                    typeof diffBlock.newText !== 'string'
                  ) {
                    pathMismatch = true
                  } else {
                    candidateText = diffBlock.newText
                  }
                } else if (
                  state.explicitToolName === 'write_file' &&
                  effectiveArgs.Append !== true &&
                  typeof effectiveArgs.Content === 'string'
                ) {
                  candidateText = effectiveArgs.Content
                }
                if (
                  !pathMismatch &&
                  candidateText &&
                  candidateText.trim().length > 0 &&
                  Buffer.byteLength(candidateText, 'utf8') <= COLLABORATION_PUBLISHED_PLAN_MAX_BYTES
                ) {
                  context.onBrainPlanCaptured(state.toolCallId, {
                    nativeId: buildBoundedNativePlanId(activeRun.nativeSessionId, state.toolCallId),
                    text: candidateText,
                  })
                } else if (state.explicitToolName === 'edit_file' && diffBlocks.length === 0) {
                  // `edit_file` without inline full `newText` diff block invalidates any earlier
                  // candidate so terminal cold `storageClient.inspectRun(..., { includePlan: true })`
                  // always reads back the updated post-edit body.
                  context.onBrainPlanDeferredReadback(state.toolCallId)
                } else {
                  context.onBrainPlanCaptureFailed(state.toolCallId)
                }
              }
            }
          }
        }

        if (!state.startedEmitted) {
          state.startedEmitted = true
          emitted.push({
            agentId: 'agy',
            type: 'tool.started',
            turnId: input.runId,
            toolCallId: state.toolCallId,
            toolName: state.name,
            title: state.title,
            ...(state.detail ? { detail: state.detail } : {}),
          })
        }

        const isTerminalToolStatus =
          state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled'
        if (!state.completedEmitted && isTerminalToolStatus) {
          state.completedEmitted = true

          // Promote staged Pact MCP tool outcomes strictly when this terminal transition was admitted.
          if (
            !context.receivedAfterPromptReply &&
            state.status === 'completed' &&
            !state.invalidStatus &&
            !incomingStatusInvalid &&
            !state.invalidProgressToken &&
            !state.toolIdentityConflicted &&
            !state.argsConflicted &&
            frameArgsEvidence.kind !== 'invalid_or_conflict' &&
            !frameRootContradictsPinned &&
            verifiedAuthToolName.length > 0 &&
            acpAdmission === 'admitted'
          ) {
            const promoted = context.mcpServer.promoteCompletedAcpToolCall({
              toolCallId: state.toolCallId,
              rawToolName: verifiedAuthToolName,
              ...(resolvedPt !== undefined
                ? { progressToken: resolvedPt.canonical }
                : state.progressToken !== undefined
                  ? { progressToken: state.progressToken }
                  : {}),
              ...(state.invalidProgressToken ? { invalidProgressToken: true } : {}),
              ...(frameArgsEvidence.kind === 'present'
                ? {
                    args: frameArgsEvidence.args,
                    argsFingerprint: frameArgsEvidence.fingerprint,
                  }
                : {}),
              ...(validated.trajectoryId !== undefined
                ? { trajectoryId: validated.trajectoryId }
                : {}),
              ...(validated.stepIdx !== undefined ? { stepIdx: validated.stepIdx } : {}),
              ...(frameRootContradictsPinned ? { rootEvidenceContradicted: true } : {}),
              receivedAfterPromptReply: context.receivedAfterPromptReply,
            })
            if (promoted) {
              if (promoted.type === 'title' && !context.getSessionTitleEmitted()) {
                context.markSessionTitleEmitted()
                emitted.push({
                  agentId: 'agy',
                  type: 'session.title.updated',
                  title: promoted.title,
                })
              } else if (promoted.type === 'peer') {
                emitted.push({
                  agentId: 'agy',
                  type: 'peer.assistance.requested',
                  turnId: input.runId,
                  proposalId: randomUUID(),
                  targetAgentId: promoted.targetAgentId,
                  kind: promoted.proposalKind,
                  ...(promoted.reason ? { reason: promoted.reason } : {}),
                })
              } else if (promoted.type === 'review') {
                context.onReviewAccepted(promoted.observation)
              } else if (promoted.type === 'input_result') {
                context.onInputResultAccepted(promoted.observation)
              } else if (promoted.type === 'retain_plan') {
                context.onPlanRetainedAccepted()
              } else if (promoted.type === 'publish_plan') {
                context.onOpenPlanPublished({
                  nativeId: buildBoundedNativePlanId(
                    activeRun.nativeSessionId,
                    promoted.finalToolCallId,
                  ),
                  text: promoted.markdown,
                })
              } else if (promoted.type === 'publish_plan_failed') {
                context.onOpenPlanPublishFailed()
              }
            }
          } else if (
            state.status !== 'completed' ||
            state.invalidProgressToken ||
            state.toolIdentityConflicted ||
            state.argsConflicted
          ) {
            context.mcpServer.failAcpToolCall({
              toolCallId: state.toolCallId,
              rawToolName: verifiedAuthToolName || state.name,
              ...(state.progressToken !== undefined ? { progressToken: state.progressToken } : {}),
            })
          }

          // File change & round command/tool uncertainty classification (`B9` / Module 6).
          const conflictedArgsSources = [state.mergedArgs, state.args, state.rawInput].filter(
            isPlainObject,
          )
          const hasToolConflict = Boolean(state.argsConflicted || state.toolIdentityConflicted)
          const mergedItem = {
            name: state.name,
            status: state.status,
            args: hasToolConflict ? undefined : (state.mergedArgs ?? state.args),
            rawInput: hasToolConflict ? undefined : state.rawInput,
            rawOutput: state.rawOutput,
            content: state.content,
            locations: state.locations,
            argsConflicted: Boolean(state.argsConflicted),
            toolIdentityConflicted: Boolean(state.toolIdentityConflicted),
            conflictedArgsSources,
          }
          const isFileTool =
            state.name === 'write_file' ||
            state.name === 'edit_file' ||
            state.name === 'delete_file' ||
            state.name === 'remove_file' ||
            state.name === 'move_file' ||
            state.name === 'rename_file'
          if (state.toolIdentityConflicted || isFileTool) {
            const fileEvidence = context.roundTracker.observeFileTool(mergedItem)
            fileEvidence.changes = fileEvidence.changes.map((change, index) => ({
              ...change,
              operationId: `${state.toolCallId}:${index}`,
            }))
            if (fileEvidence.changes.length > 0 || fileEvidence.uncertain) {
              context.observeFiles(fileEvidence)
            }
          }
          if (state.toolIdentityConflicted || !isFileTool) {
            const nonFile = context.roundTracker.observeNonFileTool(mergedItem)
            if (nonFile.uncertain && nonFile.reason) {
              nativeEffectsUncertain(input, nonFile.reason, nonFile.scope)
            }
          }

          // Immediately release heavy tool payload fields and progressToken on completion while
          // keeping retained compact dedup metadata accurately charged until eviction!
          state.args = undefined
          state.argsBytes = 0
          state.rawInput = undefined
          state.rawInputBytes = 0
          state.mergedArgs = undefined
          state.mergedArgsBytes = 0
          state.rawOutput = undefined
          state.rawOutputBytes = 0
          state.content = undefined
          state.contentBytes = 0
          state.locations = undefined
          state.locationsBytes = 0
          state.progressToken = undefined
          context.resizeToolStateBytes(state, computeCompactToolStateBytes())

          emitted.push({
            agentId: 'agy',
            type: 'tool.completed',
            turnId: input.runId,
            toolCallId: state.toolCallId,
            toolName: state.name,
            title: state.title,
            ...(state.detail ? { detail: state.detail } : {}),
            outcome: state.status === 'completed' ? 'completed' : 'failed',
          })
        }
        return
      }

      emitted.push({
        agentId: 'agy',
        type: 'unrecognized',
        nativeType: sessionUpdate.slice(0, 120),
        turnId: input.runId,
      })
    }

    context.mcpServer.beginWakeBatch()
    try {
      processFrame()
    } finally {
      context.mcpServer.endWakeBatch()
    }
    yield* emitted
  }

  private bindRootExecutionId(
    activeRun: ActiveAgyRun,
    input: AgentRunInput,
    executionId: string,
  ): void {
    if (!executionId || activeRun.providerExecutionId) return
    activeRun.providerExecutionId = executionId
    for (const [steerId, entry] of activeRun.steeredInputs) {
      if (!entry.consumed && this.tryPromoteStagedSteerCandidate(activeRun, steerId, entry)) {
        input.recordInputConsumption?.(steerId, {
          nativeSessionId: activeRun.nativeSessionId,
          nativeTurnId: activeRun.nativeTurnId,
          executorId: activeRun.executorId,
        })
      }
    }
    this.notifyRootExecutionWaiters(activeRun)
  }

  private notifyRootExecutionWaiters(activeRun: ActiveAgyRun): void {
    for (const notify of activeRun.rootExecutionWaiters) {
      notify()
    }
    activeRun.rootExecutionWaiters.clear()
  }

  private async waitForRootExecutionBinding(
    activeRun: ActiveAgyRun,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      activeRun.providerExecutionId ||
      activeRun.promptReplyReceived ||
      activeRun.rootReleasing ||
      activeRun.rootTerminal ||
      signal.aborted
    ) {
      return
    }
    await new Promise<void>((resolveWait) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        activeRun.rootExecutionWaiters.delete(finish)
        resolveWait()
      }
      const timer = setTimeout(finish, AGY_PROMPT_ACCEPT_TIMEOUT_MS)
      timer.unref?.()
      signal.addEventListener('abort', finish, { once: true })
      activeRun.rootExecutionWaiters.add(finish)
    })
  }

  private isValidSteerStepOrder(
    activeRun: ActiveAgyRun,
    steerInputId: string,
    candidateStepIdx: number,
  ): boolean {
    if (!Number.isSafeInteger(candidateStepIdx) || candidateStepIdx < 0) return false
    const minRootStep = activeRun.rootStepIdx ?? 0
    if (candidateStepIdx <= minRootStep) return false

    let sawCurrent = false
    for (const [id, existing] of activeRun.steeredInputs) {
      if (id === steerInputId) {
        sawCurrent = true
        continue
      }
      if (!existing.consumed || existing.stepIdx === undefined) continue
      if (!sawCurrent && candidateStepIdx <= existing.stepIdx) {
        return false
      }
      if (sawCurrent && candidateStepIdx >= existing.stepIdx) {
        return false
      }
    }
    return true
  }

  private tryPromoteStagedSteerCandidate(
    activeRun: ActiveAgyRun,
    steerInputId: string,
    entry: AgySteerEntry,
  ): boolean {
    if (entry.consumed) return true
    if (
      !activeRun.providerExecutionId ||
      entry.candidateExecutionId === undefined ||
      entry.candidateStepIdx === undefined
    ) {
      return false
    }
    if (entry.candidateExecutionId !== activeRun.providerExecutionId) {
      return false
    }
    if (!this.isValidSteerStepOrder(activeRun, steerInputId, entry.candidateStepIdx)) {
      return false
    }
    entry.stepIdx = entry.candidateStepIdx
    entry.executionId = entry.candidateExecutionId
    entry.consumed = true
    return true
  }

  private async verifySteerReceiptsBeforeRootRelease(
    activeRun: ActiveAgyRun,
    input: AgentRunInput,
    reportUnknown: (reason: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let previousStepIdx = activeRun.rootStepIdx ?? 0
    for (const [inputId, entry] of activeRun.steeredInputs) {
      if (!entry.dispatched) continue
      if (!entry.consumed && activeRun.providerExecutionId) {
        if (this.tryPromoteStagedSteerCandidate(activeRun, inputId, entry)) {
          input.recordInputConsumption?.(inputId, {
            nativeSessionId: activeRun.nativeSessionId,
            nativeTurnId: activeRun.nativeTurnId,
            executorId: activeRun.executorId,
          })
        }
      }
      if (!entry.consumed && this.options.storageClient?.verifySteerConsumption) {
        // oxlint-disable-next-line no-await-in-loop -- Bounded in-Turn steer verification before root release.
        const receipt = await this.options.storageClient
          .verifySteerConsumption(
            {
              appDataDir: this.primaryAppDataDir,
              cwd: activeRun.cwd,
              nativeSessionId: activeRun.nativeSessionId,
              nativeTurnId: activeRun.runId,
              executionId: activeRun.providerExecutionId,
              inputId,
              minStepIdx: previousStepIdx,
            },
            signal,
          )
          .catch((): AgySteerConsumptionReceipt => ({ consumed: false }))
        if (receipt.consumed && receipt.executionId !== undefined) {
          if (!activeRun.providerExecutionId) {
            this.bindRootExecutionId(activeRun, input, receipt.executionId)
          }
          if (
            receipt.executionId === activeRun.providerExecutionId &&
            (entry.candidateExecutionId === undefined ||
              entry.candidateExecutionId === activeRun.providerExecutionId) &&
            typeof receipt.stepIdx === 'number' &&
            receipt.stepIdx > previousStepIdx
          ) {
            entry.stepIdx = receipt.stepIdx
            entry.executionId = receipt.executionId
            entry.consumed = true
            input.recordInputConsumption?.(inputId, {
              nativeSessionId: activeRun.nativeSessionId,
              nativeTurnId: activeRun.nativeTurnId,
              executorId: activeRun.executorId,
            })
          }
        }
      }
      if (
        !entry.consumed ||
        !activeRun.providerExecutionId ||
        entry.executionId !== activeRun.providerExecutionId ||
        typeof entry.stepIdx !== 'number' ||
        entry.stepIdx <= previousStepIdx
      ) {
        reportUnknown(
          'A steered Antigravity message crossed the root Turn boundary without an in-Turn consumption receipt.',
        )
        throw new AgentExecutionError(
          'unknown_delivery',
          'Antigravity steer write crossed the Turn boundary without an in-Turn consumption receipt.',
          false,
        )
      }
      previousStepIdx = entry.stepIdx
    }
  }

  private trackBackgroundTaskLaunch(
    activeRun: ActiveAgyRun,
    input: Pick<AgentRunInput, 'backgroundWorkChanged'>,
    toolCallId: string,
    spawnedTaskId: string | undefined,
    status: string,
    onObservedBackgroundTask: () => void,
    reportUnknown?: (reason: string) => void,
  ): void {
    const existingCanonical =
      activeRun.backgroundTaskAliases.get(toolCallId) ??
      (spawnedTaskId ? activeRun.backgroundTaskAliases.get(spawnedTaskId) : undefined)

    if ((status === 'failed' || status === 'cancelled') && !spawnedTaskId) {
      if (existingCanonical) {
        this.settleBackgroundTaskByAlias(activeRun, input, [toolCallId])
      }
      return
    }

    onObservedBackgroundTask()
    const canonicalKey = existingCanonical ?? spawnedTaskId ?? toolCallId
    let changed = false
    if (!existingCanonical) {
      if (activeRun.activeBackgroundTasks.size >= 64) {
        if (!activeRun.backgroundUnconfirmed) {
          activeRun.backgroundUnconfirmed = true
          reportUnknown?.(
            'Antigravity exceeded the 64-task active background tracking budget; background effects remain unconfirmed.',
          )
          input.backgroundWorkChanged?.()
        }
        return
      }
      activeRun.activeBackgroundTasks.add(canonicalKey)
      changed = true
    }
    if (activeRun.backgroundTaskAliases.size < 256) {
      activeRun.backgroundTaskAliases.set(toolCallId, canonicalKey)
      if (spawnedTaskId) {
        activeRun.backgroundTaskAliases.set(spawnedTaskId, canonicalKey)
      }
    }
    if (changed) {
      input.backgroundWorkChanged?.()
    }
  }

  private settleBackgroundTaskByAlias(
    activeRun: ActiveAgyRun,
    input: Pick<AgentRunInput, 'backgroundWorkChanged'>,
    ids: readonly (string | undefined)[],
  ): boolean {
    let canonicalKey: string | undefined
    for (const id of ids) {
      if (!id) continue
      const mapped = activeRun.backgroundTaskAliases.get(id)
      if (mapped) {
        canonicalKey = mapped
        break
      }
      if (activeRun.activeBackgroundTasks.has(id)) {
        canonicalKey = id
        break
      }
    }
    if (!canonicalKey) return false
    const removed = activeRun.activeBackgroundTasks.delete(canonicalKey)
    for (const [alias, target] of activeRun.backgroundTaskAliases) {
      if (target === canonicalKey) {
        activeRun.backgroundTaskAliases.delete(alias)
      }
    }
    if (removed) {
      input.backgroundWorkChanged?.()
    }
    return removed
  }

  private async handlePostTurnBackgroundUpdate(context: {
    record: CompactPostCutoffBackgroundRecord
    input: AgentRunInput
    activeRun: ActiveAgyRun
    observedBackgroundTask: boolean
    canSettleEffects: () => boolean
    isRootTerminal: () => boolean
    seenForegroundMessageIds: Set<string>
    isForegroundDedupIncomplete: () => boolean
    hasOmittedForegroundIdWithoutStep: () => boolean
    getMaxForegroundStepIdx: () => number | undefined
    getPinnedTrajectory: () => string | undefined
    getMinStepIdx: () => number | undefined
    reportedBackgroundMessageIds: Set<string>
    reportUnknown: (reason: string) => void
  }): Promise<void> {
    const {
      record,
      input,
      activeRun,
      observedBackgroundTask,
      canSettleEffects,
      isRootTerminal,
      seenForegroundMessageIds,
      isForegroundDedupIncomplete,
      hasOmittedForegroundIdWithoutStep,
      getMaxForegroundStepIdx,
      getPinnedTrajectory,
      getMinStepIdx,
      reportedBackgroundMessageIds,
      reportUnknown,
    } = context

    // Re-check validated owner evidence against the run's latest execution, pinned trajectory,
    // and step lower bound BEFORE BOTH report persistence and task settlement!
    const pinnedTrajectory = getPinnedTrajectory()
    const minStepIdx = getMinStepIdx()
    const { ownership } = record
    if (
      ownership.executionId !== undefined &&
      (activeRun.knownForeignExecutionIds.has(ownership.executionId) ||
        (activeRun.providerExecutionId !== undefined &&
          ownership.executionId !== activeRun.providerExecutionId))
    ) {
      return
    }
    if (
      ownership.trajectoryId !== undefined &&
      pinnedTrajectory !== undefined &&
      ownership.trajectoryId !== pinnedTrajectory
    ) {
      return
    }
    if (
      ownership.stepIdx !== undefined &&
      minStepIdx !== undefined &&
      ownership.stepIdx < minStepIdx
    ) {
      return
    }

    const { sessionUpdate, status, outOfTurn, taskId, toolCallId, explicitMsgId, rawText } = record

    try {
      if (observedBackgroundTask && input.recordBackgroundReport) {
        // Never fabricate background reports from cancel ACKs, empty chunks, or foreground messages!
        const isOutOfTurnCompletion =
          (sessionUpdate === 'agent_message_chunk' && outOfTurn) ||
          sessionUpdate === 'background_task_completed' ||
          (sessionUpdate === 'tool_call_update' && status === 'completed' && outOfTurn)

        if (isOutOfTurnCompletion) {
          const fallbackId =
            sessionUpdate === 'background_task_completed' ? (taskId ?? toolCallId) : toolCallId
          const nativeMessageId =
            explicitMsgId ??
            (sessionUpdate === 'background_task_completed' && fallbackId
              ? `bg-task-completed:${fallbackId}`
              : fallbackId)

          const bgStepIdx = ownership.stepIdx
          const bgSameTrajectory =
            ownership.trajectoryId === undefined ||
            pinnedTrajectory === undefined ||
            ownership.trajectoryId === pinnedTrajectory
          const maxFgStepIdx = getMaxForegroundStepIdx()
          // Only when ALL omitted foreground dedup IDs had trusted same-trajectory stepIdx can
          // `bgStepIdx > maxFgStepIdx` prove novelty!
          const dedupCanProveNovelty =
            !isForegroundDedupIncomplete() ||
            (!hasOmittedForegroundIdWithoutStep() &&
              bgSameTrajectory &&
              bgStepIdx !== undefined &&
              maxFgStepIdx !== undefined &&
              bgStepIdx > maxFgStepIdx)

          if (
            isEligibleAgyBackgroundReportId(nativeMessageId) &&
            dedupCanProveNovelty &&
            !seenForegroundMessageIds.has(nativeMessageId) &&
            !reportedBackgroundMessageIds.has(nativeMessageId)
          ) {
            if (rawText && /\S/u.test(rawText)) {
              const frameId = deterministicUuid(
                `agy-bg:${input.runId}:${activeRun.nativeSessionId}:${activeRun.executorId}:${nativeMessageId}`,
              )
              const identity = nativeBackgroundReportIdentitySchema.parse({
                agentId: 'agy',
                runId: input.runId,
                nativeSessionId: activeRun.nativeSessionId,
                nativeTurnId: activeRun.nativeTurnId,
                bindingGeneration: activeRun.bindingGeneration,
                executorId: activeRun.executorId,
                frameId,
                nativeMessageId,
              })

              if (reportedBackgroundMessageIds.size >= 64) {
                activeRun.backgroundUnconfirmed = true
                input.recordBackgroundReportUnavailable?.(identity)
                reportUnknown(
                  'Antigravity background report tracking reached the 64-report per-run cap; coverage is incomplete.',
                )
              } else {
                reportedBackgroundMessageIds.add(nativeMessageId)
                let reservation: NativeMemoryReservation | undefined
                try {
                  const byteLength = Buffer.byteLength(rawText, 'utf8')
                  reservation = activeRun.connection.reserveWorkingMemory(
                    4096 + rawText.length * 10 + byteLength * 2,
                  )
                  await input.recordBackgroundReport({ ...identity, text: rawText })
                } catch (error) {
                  if (input.recordBackgroundReportUnavailable) {
                    input.recordBackgroundReportUnavailable(identity)
                  } else {
                    recordDiagnostic({
                      operation: 'native_check',
                      phase: 'failed',
                      level: 'warn',
                      scope: 'run',
                      sessionId: input.sessionId,
                      runId: input.runId,
                      agentId: 'agy',
                      runtimeBoundary: 'archive',
                      code: classifyAgentError(error).kind,
                    })
                  }
                } finally {
                  reservation?.release()
                }
              }
            }
          }
        }
      }
    } finally {
      // Settle tracked background task completion states and release observer/lease immediately when all settle!
      const isTerminalTaskUpdate =
        sessionUpdate === 'background_task_completed' ||
        (sessionUpdate === 'tool_call_update' &&
          (status === 'completed' || status === 'failed' || status === 'cancelled'))
      if (isTerminalTaskUpdate) {
        const settledAny = this.settleBackgroundTaskByAlias(activeRun, input, [taskId, toolCallId])
        if (settledAny && activeRun.activeBackgroundTasks.size === 0 && isRootTerminal()) {
          if (!activeRun.backgroundUnconfirmed && canSettleEffects()) {
            nativeFileChangesSettled(input, 'settled', 'native_work_drained')
          }
          activeRun.observation.abort()
        }
      }
    }
  }

  private extractConfigOptionsFromNotification(
    notification: object,
    expectedSessionId?: string,
  ): AcpConfigOptionEntry[] | undefined {
    if (!isPlainObject(notification)) return undefined
    const method = asString(Reflect.get(notification, 'method'))
    if (method !== 'session/update') return undefined
    const validated = validateAgyFrame(
      {
        kind: 'notification',
        seq: 0,
        message: notification,
      },
      expectedSessionId,
      undefined,
      undefined,
    )
    if (
      !validated.isAttributableToCurrentSession ||
      validated.hasForeignOrInvalidSessionMeta ||
      validated.executionIdInvalid ||
      validated.rootEvidenceContradicted ||
      validated.sessionUpdate !== 'config_option_update' ||
      !validated.payload
    ) {
      return undefined
    }
    const raw = validated.payload.configOptions ?? validated.payload.options
    if (!Array.isArray(raw)) return undefined
    return parseConfigOptions(raw)
  }

  private observeSessionTitleFromNotification(
    notification: object,
    sessionId: string,
    input: Pick<AgentRunInput, 'observeNativeTitle'>,
  ): void {
    if (!isPlainObject(notification)) return
    const method = asString(Reflect.get(notification, 'method'))
    if (method !== 'session/update') return
    const validated = validateAgyFrame(
      {
        kind: 'notification',
        seq: 0,
        message: notification,
      },
      sessionId,
      undefined,
      undefined,
    )
    if (
      !validated.isAttributableToCurrentSession ||
      validated.hasForeignOrInvalidSessionMeta ||
      validated.executionIdInvalid ||
      validated.rootEvidenceContradicted ||
      validated.sessionUpdate !== 'session_info_update' ||
      !validated.payload
    ) {
      return
    }
    const title = asString(validated.payload.title)?.trim()
    if (title && title.length <= 120) {
      input.observeNativeTitle?.(sessionId, title)
    }
  }

  private hasOtherActiveRunOnSession(activeRun: ActiveAgyRun): boolean {
    for (const other of this.activeRuns.values()) {
      if (
        other !== activeRun &&
        other.nativeSessionId === activeRun.nativeSessionId &&
        !other.rootTerminal
      ) {
        return true
      }
    }
    return false
  }

  private evidenceKey(runId: string, nativeSessionId: string): string {
    return `${runId}\0${nativeSessionId}`
  }

  private toEvidenceIdentity(
    input: Pick<
      NativeEvidenceIdentity,
      | 'sessionId'
      | 'agentId'
      | 'runId'
      | 'requestId'
      | 'nativeSessionId'
      | 'nativeTurnId'
      | 'bindingGeneration'
      | 'executorId'
    >,
  ): NativeEvidenceIdentity {
    return {
      sessionId: input.sessionId,
      agentId: input.agentId,
      ...(input.runId ? { runId: input.runId } : {}),
      requestId: input.requestId,
      nativeSessionId: input.nativeSessionId,
      ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
      bindingGeneration: input.bindingGeneration,
      ...(input.executorId ? { executorId: input.executorId } : {}),
    }
  }

  private invalidateNonTerminalEvidence(runId: string, nativeSessionId: string | undefined): void {
    if (!nativeSessionId) return
    const key = this.evidenceKey(runId, nativeSessionId)
    const existing = this.nativeEvidence.get(key)
    if (!existing || existing.kind === 'ended') return
    this.nativeEvidence.delete(key)
    this.resizeEvidenceCacheWork()
  }

  private resizeEvidenceCacheWork(): void {
    let totalBytes = 0
    for (const item of this.nativeEvidence.values()) {
      totalBytes += Buffer.byteLength(JSON.stringify(item), 'utf8') * 2 + 256
    }
    this.evidenceCacheWork.resize(totalBytes)
  }

  private recordEvidence(
    input: AgentRunInput,
    nativeSessionId: string,
    executorId: string,
    fact:
      | { kind: 'running' | 'waiting_user'; source: 'live_runtime' }
      | {
          kind: 'ended'
          source: 'live_terminal'
          outcome: 'completed' | 'failed' | 'interrupted'
          output?: Extract<NativeProbeResult, { kind: 'ended' }>['output']
        }
      | { kind: 'no_evidence'; reason: string },
    nativeTurnId = input.runId,
  ): void {
    const identity: NativeEvidenceIdentity = {
      sessionId: input.sessionId,
      agentId: 'agy',
      runId: input.runId,
      requestId: input.runId,
      nativeSessionId,
      nativeTurnId,
      bindingGeneration: input.bindingGeneration ?? 1,
      executorId,
    }
    const probeResult: NativeProbeResult =
      fact.kind === 'ended'
        ? {
            kind: 'ended',
            identity,
            source: fact.source,
            outcome: fact.outcome,
            ...(fact.output ? { output: fact.output } : {}),
          }
        : fact.kind === 'no_evidence'
          ? {
              kind: 'no_evidence',
              identity,
              reason: fact.reason,
            }
          : {
              kind: fact.kind,
              identity,
              source: fact.source,
            }

    const key = this.evidenceKey(input.runId, nativeSessionId)
    this.nativeEvidence.delete(key)
    if (this.nativeEvidence.size >= AGY_EVIDENCE_CACHE_LIMIT) {
      const oldest = this.nativeEvidence.keys().next().value
      if (oldest !== undefined) this.nativeEvidence.delete(oldest)
    }
    this.nativeEvidence.set(key, probeResult)
    this.resizeEvidenceCacheWork()
    input.recordNativeEvidence?.(probeResult)
  }

  private rememberRebuildReceipt(
    rebuildId: string,
    receipt: {
      nativeSessionId: string
      sourceHash?: string | undefined
      seedHash: string
      cwd: string
      executorId: string
      initializationWitness?: NativeInitializationWitness | undefined
    },
  ): void {
    this.nativeRebuildReceipts.delete(rebuildId)
    if (this.nativeRebuildReceipts.size >= AGY_REBUILD_RECEIPT_LIMIT) {
      const oldest = this.nativeRebuildReceipts.keys().next().value
      if (oldest !== undefined) this.nativeRebuildReceipts.delete(oldest)
    }
    this.nativeRebuildReceipts.set(rebuildId, receipt)
  }
}
