import type { query } from '@anthropic-ai/claude-agent-sdk'

import { randomUUID } from 'node:crypto'

import type {
  AgentAdapter,
  AgentNativeCheckContext,
  AgentNativeCheckOperation,
  AgentNativeContextRebuildInput,
  AgentNativeContextRebuildResult,
  AgentNativeForkBoundary,
  AgentNativeForkInput,
  AgentNativeForkInspection,
  AgentNativeForkResult,
  AgentNativeForkSourceInput,
  AgentNativeProbeInput,
  AgentRunInput,
  AgentSteerInput,
  AgentSteerResult,
  AgentTitleEnrichmentInput,
} from '@pact/agent-runtime'
import type {
  NativeContextRebuildChunk,
  NativeProbeResult,
  NormalizedAgentEvent,
  RuntimeAgentId,
  SkillBinding,
} from '@pact/contracts'

import type { LogicalIpcWorkerTraffic } from '../../shared/logical-ipc-traffic'

import { AgentExecutionError } from './agent-execution-error'
import { ClaudeLifecycleCoordinator } from './claude/fork-and-rebuild'
import { withDeadline } from './claude/permissions-and-settings'
import { ClaudeTurnSession } from './claude/turn-session'
import {
  CLAUDE_TITLE_TIMEOUT_MS,
  defaultClaudeAgentDependencies,
  type ClaudeAdapterRuntime,
  type ClaudeAgentDependencies,
  type ClaudeBackgroundRunOwner,
  type ClaudeRebuildReceipt,
  type ClaudeRecordableEvidence,
} from './claude/types'
import { NativeCheckOperation } from './native-check-operation'
import { NativeForkFiles } from './native-fork-files'
import { freezeNativeJsonFrame } from './native-json-encoder'
import { NativeWorkingMemory } from './native-working-memory'

export { CLAUDE_TITLE_TIMEOUT_MS }

export class ClaudeAgentAdapter implements AgentAdapter {
  readonly id = 'claude' as const
  private readonly runtime: ClaudeAdapterRuntime
  private readonly lifecycle: ClaudeLifecycleCoordinator

  get executorId(): string {
    return this.runtime.latestExecutorId
  }

  constructor(
    executablePath: string,
    dependencies: ClaudeAgentDependencies = defaultClaudeAgentDependencies,
    ipcTraffic?: LogicalIpcWorkerTraffic,
    resolvePeerTarget?: (sessionId: string) => RuntimeAgentId | undefined,
  ) {
    const evidenceCacheWork = new NativeWorkingMemory().reserve(0)
    const nativeEvidence = new Map<string, NativeProbeResult>()
    const nativeRebuildReceipts = new Map<string, ClaudeRebuildReceipt>()
    const activeControllers = new Set<AbortController>()
    const activeSessions = new Set<ReturnType<typeof query>>()
    const backgroundDrains = new Set<Promise<void>>()
    const backgroundRuns = new Map<string, ClaudeBackgroundRunOwner>()
    const forkInitializing = new Set<string>()
    const peerServerName = `pact_peer_${randomUUID().replaceAll('-', '')}`

    let disposed = false
    const nativeCheck = new NativeCheckOperation(() => !disposed)
    const nativeForkFiles = new NativeForkFiles(ipcTraffic, (signal, physicalCompletion) =>
      nativeCheck.observeRequest(signal, physicalCompletion),
    )

    const runtime: ClaudeAdapterRuntime = {
      id: 'claude',
      executablePath,
      dependencies,
      resolvePeerTarget,
      peerServerName,
      evidenceCacheWork,
      nativeEvidence,
      nativeRebuildReceipts,
      activeControllers,
      activeSessions,
      backgroundDrains,
      backgroundRuns,
      nativeForkFiles,
      nativeCheck,
      forkInitializing,
      latestExecutorId: randomUUID(),
      get disposed() {
        return disposed
      },
      set disposed(value: boolean) {
        disposed = value
      },
      skillCatalogChanged: undefined,
      hasActiveBackgroundWork: (runId?: string) => this.hasActiveBackgroundWork(runId),
      admitEvidenceCache: () => this.admitEvidenceCache(),
      recordEvidence: (input, nativeSessionId, fact) =>
        this.recordEvidence(input, nativeSessionId, fact),
    }

    this.runtime = runtime
    this.lifecycle = new ClaudeLifecycleCoordinator(runtime)
  }

  setSkillCatalogListener(listener: (() => void) | undefined): void {
    this.runtime.skillCatalogChanged = listener
  }

  retireSourceGrant(owner: { runId: string; grant: string }): void {
    const source = this.runtime.backgroundRuns.get(owner.runId)?.sourceGrant
    if (source?.runId === owner.runId && source.grant === owner.grant) {
      source.active = false
      this.runtime.backgroundRuns.get(owner.runId)?.sourceReader?.retire()
    }
  }

  async probe(): Promise<{ id: 'claude'; available: true }> {
    return { id: 'claude', available: true }
  }

  prepareNativeFork(
    input: AgentNativeForkSourceInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkBoundary> {
    return this.lifecycle.prepareNativeFork(input, signal)
  }

  forkNativeContext(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    return this.lifecycle.forkNativeContext(input, signal)
  }

  inspectNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkInspection> {
    return this.lifecycle.inspectNativeFork(input, signal)
  }

  initializeNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    return this.lifecycle.initializeNativeFork(input, signal)
  }

  probeNativeStatus(input: AgentNativeProbeInput, signal: AbortSignal): Promise<NativeProbeResult> {
    return this.lifecycle.probeNativeStatus(input, signal)
  }

  beginNativeStatusCheck(
    input: AgentNativeProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<NativeProbeResult> {
    return this.lifecycle.beginNativeStatusCheck(input, signal, context)
  }

  rebuildNativeContext(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult> {
    return this.lifecycle.rebuildNativeContext(input, source, signal)
  }

  inspectNativeRebuild(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult | undefined> {
    return this.lifecycle.inspectNativeRebuild(input, source, signal)
  }

  beginNativeRebuildCheck(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<AgentNativeContextRebuildResult | undefined> {
    return this.lifecycle.beginNativeRebuildCheck(input, source, signal, context)
  }

  discoverSkills(cwd: string, signal: AbortSignal): Promise<SkillBinding[]> {
    return this.lifecycle.discoverSkills(cwd, signal)
  }

  async steer(input: AgentSteerInput, signal: AbortSignal): Promise<AgentSteerResult> {
    const owner = this.runtime.backgroundRuns.get(input.runId)
    return owner?.steer
      ? owner.steer(input, signal)
      : { status: 'rejected', reason: 'The target execution is no longer available for steering.' }
  }

  backgroundWork(runId: string, executorId: string): 'working' | 'stoppable' | undefined {
    const owner = this.runtime.backgroundRuns.get(runId)
    return owner?.executorId === executorId ? owner.work?.() : undefined
  }

  async stopBackgroundWork(runId: string, executorId: string, signal: AbortSignal): Promise<void> {
    const owner = this.runtime.backgroundRuns.get(runId)
    if (owner?.executorId !== executorId || owner.work?.() !== 'stoppable' || !owner.stopWork)
      throw new Error('The original Claude background work is no longer available to stop.')
    await owner.stopWork(signal)
  }

  run(input: AgentRunInput, signal: AbortSignal): AsyncIterable<NormalizedAgentEvent> {
    return new ClaudeTurnSession(this.runtime, input, signal).run()
  }

  async enrichTitle(
    input: AgentTitleEnrichmentInput,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (this.runtime.disposed || signal.aborted) return undefined
    return withDeadline(
      this.lifecycle.sessionTitle(input.nativeSessionId, input.cwd),
      CLAUDE_TITLE_TIMEOUT_MS,
      signal,
    ).catch(() => undefined)
  }

  async dispose(): Promise<void> {
    this.runtime.skillCatalogChanged = undefined
    this.runtime.disposed = true
    this.runtime.nativeCheck.cancel()
    this.runtime.nativeEvidence.clear()
    this.runtime.evidenceCacheWork.release()
    this.runtime.nativeRebuildReceipts.clear()
    await this.runtime.nativeForkFiles.dispose()
    for (const controller of this.runtime.activeControllers) controller.abort()
    const sessions = [...this.runtime.activeSessions]
    for (const session of sessions) session.close()
    await Promise.allSettled([
      ...sessions.map((session) => session.return(undefined)),
      ...this.runtime.backgroundDrains,
    ])
    // Drain acknowledged file facts before releasing the native observation signal.
    await Promise.allSettled(
      [...this.runtime.backgroundRuns.values()].map(async (owner) => {
        await Promise.allSettled(owner.recordings)
        owner.observation.abort()
      }),
    )
    this.runtime.activeControllers.clear()
    this.runtime.forkInitializing.clear()
    this.runtime.activeSessions.clear()
    this.runtime.backgroundRuns.clear()
    await this.runtime.nativeCheck.join()
  }

  hasActiveBackgroundWork(runId?: string): boolean {
    return runId
      ? this.runtime.backgroundRuns.has(runId)
      : this.runtime.nativeCheck.active ||
          this.runtime.nativeForkFiles.active ||
          this.runtime.activeSessions.size > 0 ||
          this.runtime.backgroundRuns.size > 0
  }

  diagnostics(): { activeQueries: number; activeSessions: number } {
    return {
      activeQueries: this.runtime.activeControllers.size,
      activeSessions: this.runtime.activeSessions.size,
    }
  }

  private admitEvidenceCache(): void {
    const bytes = (): number =>
      [...this.runtime.nativeEvidence.values()].reduce(
        (sum, entry) => sum + freezeNativeJsonFrame(entry),
        0,
      )
    while (this.runtime.nativeEvidence.size > 8 || bytes() > 16 * 1024 * 1024)
      this.runtime.nativeEvidence.delete(this.runtime.nativeEvidence.keys().next().value!)
    for (;;) {
      try {
        this.runtime.evidenceCacheWork.resize(bytes())
        return
      } catch (error) {
        if (!(error instanceof AgentExecutionError) || !this.runtime.nativeEvidence.size)
          throw error
        // Cache pressure never discards the live durable Native evidence callback.
        this.runtime.nativeEvidence.delete(this.runtime.nativeEvidence.keys().next().value!)
      }
    }
  }

  private recordEvidence(
    input: AgentRunInput,
    nativeSessionId: string,
    fact: ClaudeRecordableEvidence,
  ): void {
    const evidence: NativeProbeResult = {
      ...fact,
      identity: {
        sessionId: input.sessionId,
        agentId: this.id,
        runId: input.runId,
        requestId: input.runId,
        nativeSessionId,
        bindingGeneration: input.bindingGeneration ?? 1,
        executorId: this.runtime.backgroundRuns.get(input.runId)?.executorId ?? this.executorId,
        nativeTurnId: input.runId,
      },
    }
    if (!this.runtime.disposed) {
      this.runtime.nativeEvidence.delete(input.runId)
      this.runtime.nativeEvidence.set(input.runId, evidence)
      this.admitEvidenceCache()
    }
    input.host?.lifecycle?.recordNativeEvidence?.(evidence)
  }
}
