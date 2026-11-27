import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'

import type {
  NativeContextRebuildChunk,
  NativeEvidenceIdentity,
  NativeProbeResult,
  NormalizedAgentEvent,
  SkillBinding,
} from '@pact/contracts'

import {
  agentPromptImageGroups,
  type AgentAdapter,
  type AgentNativeCheckContext,
  type AgentNativeCheckOperation,
  type AgentNativeContextRebuildInput,
  type AgentNativeContextRebuildResult,
  type AgentNativeForkBoundary,
  type AgentNativeForkInput,
  type AgentNativeForkInspection,
  type AgentNativeForkResult,
  type AgentNativeForkSourceInput,
  type AgentNativeInputProbeInput,
  type AgentNativeProbeInput,
  type AgentProbeResult,
  type AgentPromptImage,
  type AgentRunInput,
  type AgentShutdownSettlement,
  type AgentSteerInput,
  type AgentSteerResult,
} from '@pact/agent-runtime'

import type {
  AgyAdapterRuntime,
  AgyOwnedRunHandle,
  AgyRebuildReceipt,
  AgyRecordableEvidence,
} from './agy/adapter-runtime'

import { AgentExecutionError } from './agent-execution-error'
import { AGY_PROMPT_ACCEPT_TIMEOUT_MS, AgyAcpConnectionPool } from './agy-acp-connection'
import { resolveAgyAppDataDir } from './agy-native-storage'
import { AgyLifecycleCoordinator } from './agy/fork-and-rebuild'
import { AgyNotificationProjector } from './agy/notification-projector'
import { agyElicitationRequest } from './agy/permission-and-elicitation'
import { AgySessionBootstrapper } from './agy/session-bootstrap'
import { AgyTurnSession } from './agy/turn-session'
import {
  AGY_EVIDENCE_CACHE_LIMIT,
  AGY_EVIDENCE_CACHE_MAX_BYTES,
  AGY_MAX_STEERING_INPUTS,
  AGY_PHYSICAL_SETTLEMENT_GRACE_MS,
  asString,
  awaitPhysicalCompletionBounded,
  buildAgyPactMcpServerName,
  isPlainObject,
  type ActiveAgyRun,
  type AgyAgentAdapterOptions,
  type AgyCompletedPactPublishPlanCall,
  type AgyNativeStorageClient,
  type AgyRebuildSeedChunkRecord,
  type AgyRebuildSeedWriteResult,
  type AgySteerConsumptionReceipt,
  type AgySteerEntry,
  type OwnedAgyProbeProcess,
  type SessionModeState,
} from './agy/types'
import { NativeCheckOperation } from './native-check-operation'
import { NativeForkFiles } from './native-fork-files'
import { agyPromptInput, nativeImagePreparationBytes } from './native-image-content'
import {
  AgySkillProbeOwner,
  bindAgySkillSelections,
  discoverAgySkills,
} from './native-skill-catalog'
import { NativeWorkingMemory, type NativeMemoryReservation } from './native-working-memory'

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
  private readonly activeRuns = new Map<string, ActiveAgyRun>()
  private readonly runtime: AgyAdapterRuntime
  private readonly bootstrap: AgySessionBootstrapper
  private readonly lifecycle: AgyLifecycleCoordinator
  private readonly projector: AgyNotificationProjector
  private readonly unsubscribePoolPhysicalOps: () => void
  private readonly unsubscribeStoragePhysicalOps: (() => void) | undefined

  constructor(options: AgyAgentAdapterOptions = {}) {
    const executablePath = options.executablePath ?? 'agy'
    const primaryAppDataDir = options.appDataDir
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
    const appDataDirs =
      options.appDataDir || options.relativeAppDataDir || primaryAppDataDir === fallbackDir
        ? [primaryAppDataDir]
        : [primaryAppDataDir, fallbackDir]

    let disposed = false
    const nativeChecks = new NativeCheckOperation(() => !disposed)
    let pool: AgyAcpConnectionPool
    let ownsPool: boolean
    if (options.connectionPool) {
      pool = options.connectionPool
      ownsPool = false
    } else {
      pool = new AgyAcpConnectionPool({
        executablePath,
        clientInfo: options.clientInfo,
        relativeAppDataDir: options.relativeAppDataDir,
        idleTimeoutMs: options.idleTimeoutMs,
        processFactory: options.processFactory,
        ipcTraffic: options.ipcTraffic,
      })
      ownsPool = true
    }

    this.unsubscribePoolPhysicalOps = pool.subscribePhysicalOperations(
      (signal, physicalCompletion) => {
        nativeChecks.observeRequest(signal, physicalCompletion)
      },
    )
    this.unsubscribeStoragePhysicalOps = options.subscribeStoragePhysicalOperations?.(
      (signal, physicalCompletion) => {
        nativeChecks.observeRequest(signal, physicalCompletion)
      },
    )

    const evidenceCacheWork = new NativeWorkingMemory().reserve(0)
    const nativeEvidence = new Map<string, NativeProbeResult>()
    const sessionModes = new Map<string, SessionModeState>()
    const nativeRebuildReceipts = new Map<string, AgyRebuildReceipt>()
    const activeRuns = this.activeRuns
    const replayingSessions = new Map<string, number>()
    const ownedRunHandles = new Set<AgyOwnedRunHandle>()
    const skillProbeOwner = new AgySkillProbeOwner()
    const activeOwnedForkFiles = new Set<NativeForkFiles>()

    const runtime: AgyAdapterRuntime = {
      id: 'agy',
      executablePath,
      appDataDirs,
      primaryAppDataDir,
      pool,
      ownsPool,
      nativeChecks,
      evidenceCacheWork,
      nativeEvidence,
      sessionModes,
      nativeRebuildReceipts,
      activeRuns,
      replayingSessions,
      ownedRunHandles,
      skillProbeOwner,
      ownedForkFiles: undefined,
      activeOwnedForkFiles,
      disposalPromise: undefined,
      skillCatalogListener: undefined,
      nextTurnEpoch: 1,
      get disposed() {
        return disposed
      },
      set disposed(value: boolean) {
        disposed = value
      },
      options,
      get bootstrap(): AgySessionBootstrapper {
        return bootstrap
      },
      get lifecycle(): AgyLifecycleCoordinator {
        return lifecycle
      },
      get projector(): AgyNotificationProjector {
        return projector
      },
      getOwnedForkFiles: () => this.getOwnedForkFiles(),
      discoverSkills: (cwd, signal) => this.discoverSkills(cwd, signal),
      hasOtherActiveRunOnSession: (activeRun) => this.hasOtherActiveRunOnSession(activeRun),
      evidenceKey: (runId, nativeSessionId) => this.evidenceKey(runId, nativeSessionId),
      toEvidenceIdentity: (input) => this.toEvidenceIdentity(input),
      invalidateNonTerminalEvidence: (runId, nativeSessionId) =>
        this.invalidateNonTerminalEvidence(runId, nativeSessionId),
      resizeEvidenceCacheWork: () => this.resizeEvidenceCacheWork(),
      recordEvidence: (input, nativeSessionId, executorId, fact, nativeTurnId) =>
        this.recordEvidence(input, nativeSessionId, executorId, fact, nativeTurnId),
    }

    const bootstrap = new AgySessionBootstrapper(runtime)
    const lifecycle = new AgyLifecycleCoordinator(runtime)
    const projector = new AgyNotificationProjector(runtime)

    this.runtime = runtime
    this.bootstrap = bootstrap
    this.lifecycle = lifecycle
    this.projector = projector
  }

  private getOwnedForkFiles(): NativeForkFiles {
    if (this.runtime.disposed) {
      throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
    }
    if (!this.runtime.ownedForkFiles) {
      this.runtime.ownedForkFiles = new NativeForkFiles(this.runtime.options.ipcTraffic)
      this.runtime.activeOwnedForkFiles.add(this.runtime.ownedForkFiles)
    }
    return this.runtime.ownedForkFiles
  }

  get executorId(): string {
    return this.runtime.pool.executorId
  }

  hasExecutor(executorId: string): boolean {
    return this.runtime.pool.hasExecutor(executorId)
  }

  poolSnapshot() {
    return this.runtime.pool.poolSnapshot()
  }

  get unconfirmedClosedSessionCount(): number {
    return this.runtime.pool.unconfirmedClosedSessionCount
  }

  hasUnconfirmedClosedSession(sessionId: string): boolean {
    return this.runtime.pool.hasUnconfirmedClosedSession(sessionId)
  }

  retireFullAccess(options: { sessionId?: string; cwd?: string } = {}): Promise<void> {
    return this.runtime.pool.retireFullAccess(options)
  }

  setSkillCatalogListener(listener: (() => void) | undefined): void {
    this.runtime.skillCatalogListener = listener
  }

  async discoverSkills(cwd: string, signal: AbortSignal): Promise<SkillBinding[]> {
    return discoverAgySkills(cwd, this.runtime.executablePath, signal, {
      ...this.runtime.options.skillDiscoveryOptions,
      probeOwner:
        this.runtime.options.skillDiscoveryOptions?.probeOwner ?? this.runtime.skillProbeOwner,
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
    const active = this.runtime.activeRuns.get(owner.runId)
    if (active) active.retireSourceReader?.()
  }

  hasActiveBackgroundWork(runId?: string): boolean {
    if (runId !== undefined) {
      const run = this.runtime.activeRuns.get(runId)
      if (!run) return false
      return (
        run.backgroundUnconfirmed ||
        run.activeBackgroundTasks.size > 0 ||
        run.controlDrainActive === true
      )
    }
    for (const run of this.runtime.activeRuns.values()) {
      if (
        run.backgroundUnconfirmed ||
        run.activeBackgroundTasks.size > 0 ||
        run.controlDrainActive === true
      )
        return true
    }
    return false
  }

  backgroundWork(runId: string, executorId: string): 'working' | 'stoppable' | undefined {
    const run = this.runtime.activeRuns.get(runId)
    if (!run || run.executorId !== executorId) return undefined
    if (run.backgroundUnconfirmed || run.controlDrainActive === true) return 'working'
    if (run.activeBackgroundTasks.size > 0) return 'stoppable'
    return undefined
  }

  async stopBackgroundWork(runId: string, executorId: string, signal: AbortSignal): Promise<void> {
    const run = this.runtime.activeRuns.get(runId)
    if (!run || run.executorId !== executorId || !run.connection.isOpen) return
    await run.connection.notify('session/cancel', { sessionId: run.nativeSessionId }, { signal })
  }

  probe(signal?: AbortSignal): Promise<AgentProbeResult> {
    return this.lifecycle.probe(signal)
  }

  run(input: AgentRunInput, signal: AbortSignal): AsyncIterable<NormalizedAgentEvent> {
    return new AgyTurnSession(this.runtime, input, signal).run()
  }

  async steer(steerInput: AgentSteerInput, signal: AbortSignal): Promise<AgentSteerResult> {
    if (signal.aborted || this.runtime.disposed) {
      return { status: 'rejected', reason: 'Antigravity steer request was cancelled.' }
    }
    const activeRun = this.runtime.activeRuns.get(steerInput.runId)
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
          canDispatch: () =>
            !this.runtime.disposed && !signal.aborted && activeRun.isSteerLeaseOpen(),
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
        this.projector.tryPromoteStagedSteerCandidate(activeRun, steerInput.inputId, entry)
      }

      if (
        !entry.consumed &&
        this.runtime.options.storageClient?.verifySteerConsumption &&
        !activeRun.rootTerminal
      ) {
        const verified = await this.runtime.options.storageClient.verifySteerConsumption(
          {
            appDataDir: this.runtime.primaryAppDataDir,
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
            this.projector.notifyRootExecutionWaiters(activeRun)
          }
          if (
            verified.executionId === activeRun.providerExecutionId &&
            (entry.candidateExecutionId === undefined ||
              entry.candidateExecutionId === activeRun.providerExecutionId) &&
            typeof verified.stepIdx === 'number' &&
            this.projector.isValidSteerStepOrder(activeRun, steerInput.inputId, verified.stepIdx)
          ) {
            entry.stepIdx = verified.stepIdx
            entry.executionId = verified.executionId
            entry.consumed = true
          }
        }
      }

      if (
        !entry.consumed &&
        !activeRun.providerExecutionId &&
        entry.candidateExecutionId !== undefined &&
        !activeRun.rootReleasing &&
        !activeRun.rootTerminal
      ) {
        await this.projector.waitForRootExecutionBinding(activeRun, signal)
        if (!activeRun.rootTerminal && activeRun.providerExecutionId) {
          this.projector.tryPromoteStagedSteerCandidate(activeRun, steerInput.inputId, entry)
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
    return this.lifecycle.beginNativeStatusCheck(input, signal, context)
  }

  probeNativeStatus(input: AgentNativeProbeInput, signal: AbortSignal): Promise<NativeProbeResult> {
    return this.lifecycle.probeNativeStatus(input, signal)
  }

  beginNativeInputsCheck(
    input: AgentNativeInputProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<void> {
    return this.lifecycle.beginNativeInputsCheck(input, signal, context)
  }

  probeNativeInputs(input: AgentNativeInputProbeInput, signal: AbortSignal): Promise<void> {
    return this.lifecycle.probeNativeInputs(input, signal)
  }

  beginNativeRebuildCheck(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<AgentNativeContextRebuildResult | undefined> {
    return this.lifecycle.beginNativeRebuildCheck(input, source, signal, context)
  }

  inspectNativeRebuild(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult | undefined> {
    return this.lifecycle.inspectNativeRebuild(input, source, signal)
  }

  rebuildNativeContext(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult> {
    return this.lifecycle.rebuildNativeContext(input, source, signal)
  }

  prepareNativeFork(
    input: AgentNativeForkSourceInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkBoundary> {
    return this.lifecycle.prepareNativeFork(input, signal)
  }

  inspectNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkInspection> {
    return this.lifecycle.inspectNativeFork(input, signal)
  }

  forkNativeContext(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    return this.lifecycle.forkNativeContext(input, signal)
  }

  initializeNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    return this.lifecycle.initializeNativeFork(input, signal)
  }

  async closeZeroInputSessions(deadlineAt?: number): Promise<void> {
    const ownedRuns = [...this.runtime.ownedRunHandles]
    if (ownedRuns.length === 0) return
    await Promise.allSettled(ownedRuns.map((handle) => handle.closeZeroInputSession(deadlineAt)))
  }

  async dispose(shutdown?: AgentShutdownSettlement): Promise<void> {
    if (this.runtime.ownsPool && shutdown?.flushDeadlineAt !== undefined) {
      this.runtime.pool.capShutdownDeadline(shutdown.flushDeadlineAt)
    }
    if (this.runtime.disposalPromise) {
      return this.runtime.disposalPromise
    }
    const runDisposal = (async () => {
      if (shutdown?.foregroundSettlement) {
        const remaining = Math.max(0, shutdown.flushDeadlineAt - Date.now())
        await Promise.race([
          shutdown.foregroundSettlement,
          new Promise<void>((r) => setTimeout(r, remaining)),
        ]).catch(() => undefined)
      }
      this.runtime.disposed = true
      this.unsubscribePoolPhysicalOps()
      this.unsubscribeStoragePhysicalOps?.()
      this.runtime.nativeChecks.cancel()
      const ownedRuns = [...this.runtime.ownedRunHandles]
      for (const handle of ownedRuns) {
        handle.cancel()
      }
      if (ownedRuns.length > 0) {
        await Promise.allSettled(
          ownedRuns.map((handle) => handle.closeZeroInputSession(shutdown?.flushDeadlineAt)),
        )
      }
      for (const run of this.runtime.activeRuns.values()) {
        this.projector.notifyRootExecutionWaiters(run)
        run.observation.abort()
      }
      this.runtime.activeRuns.clear()
      this.runtime.sessionModes.clear()
      this.runtime.nativeRebuildReceipts.clear()
      const joinOwnedRuns = async (): Promise<void> => {
        try {
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
            const lingering = ownedRuns.filter((handle) => this.runtime.ownedRunHandles.has(handle))
            await Promise.allSettled(lingering.map((handle) => handle.forceCleanup()))
            if (lingering.length > 0 && shutdown?.flushDeadlineAt !== undefined) {
              throw new AgentExecutionError(
                'agent_process_crash',
                'Antigravity adapter disposal timed out waiting for active Run finalization.',
                false,
              )
            }
          }
        } finally {
          this.runtime.nativeEvidence.clear()
          if (!this.evidenceCacheReleased) {
            this.evidenceCacheReleased = true
            this.runtime.evidenceCacheWork.release()
          }
        }
      }
      const ownedForksToDispose = [...this.runtime.activeOwnedForkFiles]
      this.runtime.ownedForkFiles = undefined
      const results = await Promise.allSettled([
        joinOwnedRuns(),
        this.runtime.nativeChecks.join().catch(() => undefined),
        this.runtime.skillProbeOwner.dispose(shutdown?.flushDeadlineAt),
        ...ownedForksToDispose.map(async (forkFiles) => {
          await forkFiles.dispose(shutdown?.flushDeadlineAt)
          this.runtime.activeOwnedForkFiles.delete(forkFiles)
        }),
        ...(this.runtime.ownsPool ? [this.runtime.pool.dispose(shutdown?.flushDeadlineAt)] : []),
      ])
      const firstFailure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (firstFailure) throw firstFailure.reason
    })()
    const trackedDisposal = runDisposal.catch((error: unknown) => {
      if (this.runtime.disposalPromise === trackedDisposal) {
        this.runtime.disposalPromise = undefined
      }
      throw error
    })
    this.runtime.disposalPromise = trackedDisposal
    return trackedDisposal
  }

  private hasOtherActiveRunOnSession(activeRun: ActiveAgyRun): boolean {
    for (const other of this.runtime.activeRuns.values()) {
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

  private evidenceCacheReleased = false

  private invalidateNonTerminalEvidence(runId: string, nativeSessionId: string | undefined): void {
    if (!nativeSessionId) return
    const key = this.evidenceKey(runId, nativeSessionId)
    const existing = this.runtime.nativeEvidence.get(key)
    if (!existing || existing.kind === 'ended') return
    this.runtime.nativeEvidence.delete(key)
    this.resizeEvidenceCacheWork()
  }

  private static estimateEvidenceBytes(item: NativeProbeResult): number {
    return Buffer.byteLength(JSON.stringify(item), 'utf8') * 2 + 256
  }

  private resizeEvidenceCacheWork(): void {
    if (this.evidenceCacheReleased) return
    let totalBytes = 0
    for (const item of this.runtime.nativeEvidence.values()) {
      totalBytes += AgyAgentAdapter.estimateEvidenceBytes(item)
    }
    try {
      this.runtime.evidenceCacheWork.resize(totalBytes)
    } catch {
      // Best-effort shrink/resize on eviction; never block authoritative teardown.
    }
  }

  private recordEvidence(
    input: Pick<AgentRunInput, 'sessionId' | 'runId' | 'bindingGeneration' | 'host'>,
    nativeSessionId: string,
    executorId: string,
    fact: AgyRecordableEvidence,
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
          : fact.kind === 'missing'
            ? {
                kind: 'missing',
                identity,
                source: fact.source,
              }
            : {
                kind: fact.kind,
                identity,
                source: fact.source,
              }

    // B-F11: Pre-compute bytes and enforce BOTH 8-item count AND 16 MiB byte cap BEFORE inserting
    // into the evictable cache; if candidate exceeds budget or shared working memory refuses resize,
    // skip caching it so authoritative host persistence and final answer delivery are never blocked.
    if (!this.evidenceCacheReleased) {
      const key = this.evidenceKey(input.runId, nativeSessionId)
      this.runtime.nativeEvidence.delete(key)
      const candidateBytes = AgyAgentAdapter.estimateEvidenceBytes(probeResult)
      let currentBytes = 0
      for (const item of this.runtime.nativeEvidence.values()) {
        currentBytes += AgyAgentAdapter.estimateEvidenceBytes(item)
      }
      if (candidateBytes <= AGY_EVIDENCE_CACHE_MAX_BYTES) {
        while (
          this.runtime.nativeEvidence.size >= AGY_EVIDENCE_CACHE_LIMIT ||
          (this.runtime.nativeEvidence.size > 0 &&
            currentBytes + candidateBytes > AGY_EVIDENCE_CACHE_MAX_BYTES)
        ) {
          const oldest = this.runtime.nativeEvidence.keys().next().value
          if (oldest === undefined) break
          const removed = this.runtime.nativeEvidence.get(oldest)
          this.runtime.nativeEvidence.delete(oldest)
          if (removed) {
            currentBytes = Math.max(
              0,
              currentBytes - AgyAgentAdapter.estimateEvidenceBytes(removed),
            )
          }
        }
        try {
          this.runtime.evidenceCacheWork.resize(currentBytes + candidateBytes)
          this.runtime.nativeEvidence.set(key, probeResult)
        } catch {
          try {
            this.runtime.evidenceCacheWork.resize(currentBytes)
          } catch {
            // Leave cache clean without failing authoritative host evidence delivery.
          }
        }
      } else {
        this.resizeEvidenceCacheWork()
      }
    }
    input.host?.lifecycle?.recordNativeEvidence?.(probeResult)
  }
}
