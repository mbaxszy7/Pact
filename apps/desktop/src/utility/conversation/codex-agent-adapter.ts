import type { ChildProcessWithoutNullStreams } from 'node:child_process'

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
  AgentNativeInputProbeInput,
  AgentNativeProbeInput,
  AgentNativeTitleInput,
  AgentRunInput,
  AgentShutdownSettlement,
  AgentSteerInput,
  AgentSteerResult,
  AgentTitleEnrichmentInput,
} from '@pact/agent-runtime'
import type {
  CollaborationInputObservation,
  CollaborationReviewObservation,
  NativeContextRebuildChunk,
  NativeEvidenceIdentity,
  NativeProbeResult,
  NormalizedAgentEvent,
  RuntimeAgentId,
  SkillBinding,
} from '@pact/contracts'

import { nativeCodexSkillListSchema } from '@pact/contracts'

import type { LogicalIpcWorkerTraffic } from '../../shared/logical-ipc-traffic'
import type {
  CodexAppServerConnection,
  CodexConnectionDiagnostics,
} from './codex-app-server-connection'

import { AgentExecutionError } from './agent-execution-error'
import { CodexConnectionManager } from './codex/connection-and-settings'
import { CodexLifecycleCoordinator } from './codex/fork-and-rebuild'
import { CodexTurnSession } from './codex/turn-session'
import {
  CODEX_INITIALIZATION_TIMEOUT_MS,
  CODEX_THREAD_RPC_TIMEOUT_MS,
  CODEX_TITLE_TIMEOUT_MS,
  CODEX_TURN_ACCEPT_TIMEOUT_MS,
  acceptsCodexReroute,
  resolveCodexThreadConfiguration,
  resolveLoadedCodexConfiguration,
  type CodexAdapterRuntime,
  type CodexNativeForkOwner,
  type CodexProcessFactory,
  type CodexRunConfiguration,
  type CodexSettingsBarrier,
  type NativeBackground,
  type NativeRebuildReceipt,
} from './codex/types'
import {
  collaborationInstructions,
  collaborationPlanMode,
  frozenSourceInstructions,
} from './collaboration-prompt'
import { cutoffSourceNavigator } from './frozen-source-reader'
import { NativeCheckOperation } from './native-check-operation'
import { nativeFileChangesSettled } from './native-file-changes'
import { NativeForkFiles } from './native-fork-files'
import { codexPromptInput } from './native-image-content'
import { freezeNativeJsonFrame } from './native-json-encoder'
import { nativeSkillCatalog } from './native-skill-catalog'
import { NATIVE_OWNER_WORKING_BYTES, NativeWorkingMemory } from './native-working-memory'
import { PactPeerToolServer } from './pact-peer-tool-server'

export {
  CODEX_INITIALIZATION_TIMEOUT_MS,
  CODEX_THREAD_RPC_TIMEOUT_MS,
  CODEX_TITLE_TIMEOUT_MS,
  CODEX_TURN_ACCEPT_TIMEOUT_MS,
  acceptsCodexReroute,
  resolveCodexThreadConfiguration,
  resolveLoadedCodexConfiguration,
  type CodexRunConfiguration,
}

export class CodexAgentAdapter implements AgentAdapter {
  readonly id = 'codex' as const
  private readonly runtime: CodexAdapterRuntime
  private readonly connections: CodexConnectionManager
  private readonly lifecycle: CodexLifecycleCoordinator

  get executorId(): string {
    return this.runtime.connection?.executorId ?? this.runtime.latestExecutorId
  }

  constructor(
    executablePath: string,
    processFactory?: CodexProcessFactory,
    nativeReadOptions: { storageRoot?: string } = {},
    ipcTraffic?: LogicalIpcWorkerTraffic,
    resolvePeerTarget?: (sessionId: string) => RuntimeAgentId | undefined,
  ) {
    const evidenceCacheWork = new NativeWorkingMemory().reserve(0)
    const terminalEvidence = new Map<string, Extract<NativeProbeResult, { kind: 'ended' }>>()
    const nativeRebuildReceipts = new Map<string, NativeRebuildReceipt>()
    const loadedThreadIds = new Set<string>()
    const loadedThreadConfigurations = new Map<string, CodexRunConfiguration>()
    const peerToolServer = new PactPeerToolServer()
    const nativeBackground = new Set<NativeBackground>()
    const pendingSettingsBarriers = new Map<string, CodexSettingsBarrier>()
    const retiredNativeTurns = new Set<string>()
    const retiredNativeChildren = new Set<string>()
    const nativeForkOwners = new Map<string, CodexNativeForkOwner>()

    let disposed = false
    const nativeCheck = new NativeCheckOperation(() => !disposed)
    const nativeForkFiles = new NativeForkFiles(ipcTraffic, (signal, physicalCompletion) =>
      nativeCheck.observeRequest(signal, physicalCompletion),
    )

    const runtime: CodexAdapterRuntime = {
      id: 'codex',
      executablePath,
      processFactory,
      nativeReadOptions,
      ipcTraffic,
      resolvePeerTarget,
      latestExecutorId: randomUUID(),
      evidenceCacheWork,
      terminalEvidence,
      nativeRebuildReceipts,
      connection: undefined as CodexAppServerConnection | undefined,
      connectionStarting: undefined,
      featureProbe: undefined,
      closingConnection: undefined,
      processCwd: undefined,
      processStorageRoot: undefined,
      processEnvironmentKey: undefined,
      connectionProcess: undefined as ChildProcessWithoutNullStreams | undefined,
      nativeInspection: undefined,
      initialized: false,
      turnSpeedOverrideSupported: false,
      nativeSourceContextSupported: false,
      running: false,
      get disposed() {
        return disposed
      },
      set disposed(value: boolean) {
        disposed = value
      },
      disposal: undefined,
      shutdownDeadlineAt: undefined,
      loadedThreadIds,
      loadedThreadConfigurations,
      connectionPeerTarget: undefined,
      currentPeerTarget: 'claude',
      skillCatalogChanged: undefined,
      peerToolServer,
      peerServerName: `pact_peer_${randomUUID().replaceAll('-', '')}`,
      nativeBackground,
      pendingSettingsBarriers,
      retiredNativeTurns,
      retiredNativeChildren,
      idleTimer: undefined,
      uncertainTitleExecutor: undefined,
      nativeForkFiles,
      nativeCheck,
      nativeForkOwners,
      get executorId() {
        return runtime.connection?.executorId ?? runtime.latestExecutorId
      },
      withSourceCallable: (instructions: string) => {
        const name = `mcp__${runtime.peerServerName}__read_collaboration_source`
        return `${instructions}\nFor permitted Source reads in this current native Root, the exact CodeMode callable is tools[${JSON.stringify(name)}]. Bind that exact function before using it; do not guess an unqualified name or reuse a callable from another Root. This binding does not require a tool call when the current task forbids tools.`
      },
      beginNativeCheck: (signal, operation, context) =>
        this.beginNativeCheck(signal, operation, context),
      hasActiveBackgroundWork: (runId) => this.hasActiveBackgroundWork(runId),
      describeBackgroundWork: (owner) => this.describeBackgroundWork(owner),
      trackNativeBackground: (background, item, ownerThreadId, ownerTurnId) =>
        this.trackNativeBackground(background, item, ownerThreadId, ownerTurnId),
      settleNativeBackground: (background) => this.settleNativeBackground(background),
      preflightPrompt: (input) => this.preflightPrompt(input),
      discoverSkills: (cwd, signal) => this.discoverSkills(cwd, signal),
      runIdentity: (input, nativeSessionId, nativeTurnId) =>
        this.runIdentity(input, nativeSessionId, nativeTurnId),
      admitEvidenceCache: () => this.admitEvidenceCache(),
      recordTerminal: (input, nativeSessionId, nativeTurnId, outcome, answer, workflow) =>
        this.recordTerminal(input, nativeSessionId, nativeTurnId, outcome, answer, workflow),
      get connections(): CodexConnectionManager {
        return connections
      },
      get lifecycle(): CodexLifecycleCoordinator {
        return lifecycle
      },
    }

    const connections = new CodexConnectionManager(runtime)
    const lifecycle = new CodexLifecycleCoordinator(runtime)

    this.runtime = runtime
    this.connections = connections
    this.lifecycle = lifecycle
  }

  setSkillCatalogListener(listener: (() => void) | undefined): void {
    this.runtime.skillCatalogChanged = listener
  }

  retireSourceGrant(owner: { runId: string; grant: string }): void {
    this.runtime.peerToolServer.retireSourceReader(owner)
  }

  async probe(): Promise<{ id: 'codex'; available: true }> {
    return { id: 'codex', available: true }
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

  probeNativeInputs(input: AgentNativeInputProbeInput, signal: AbortSignal): Promise<void> {
    return this.lifecycle.probeNativeInputs(input, signal)
  }

  beginNativeInputsCheck(
    input: AgentNativeInputProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<void> {
    return this.lifecycle.beginNativeInputsCheck(input, signal, context)
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

  preflightPrompt(input: AgentRunInput): void {
    const workflow = input.promptEnvelope.collaboration
    const authorization = input.promptEnvelope.collaborationAuthorization
    if (
      workflow &&
      (!authorization ||
        authorization.runId !== input.runId ||
        authorization.taskId !== workflow.id ||
        authorization.taskRevision !== workflow.revision ||
        authorization.stage !== workflow.stage ||
        authorization.inputSequence !== workflow.inputSequence ||
        workflow.sessionId !== input.sessionId ||
        input.promptEnvelope.sessionId !== input.sessionId ||
        authorization.actor !== this.id ||
        workflow.actor !== this.id)
    )
      throw new AgentExecutionError(
        'protocol_error',
        'The frozen Pact duty authorization is missing or inconsistent. Nothing was sent.',
        false,
      )
    const request = {
      id: Number.MAX_SAFE_INTEGER,
      method: 'turn/start',
      params: {
        threadId: input.nativeSessionId ?? 'x'.repeat(256),
        clientUserMessageId: input.runId,
        input: [
          ...(input.promptEnvelope.collaboration || input.host?.workflow?.sourceReader
            ? [
                {
                  type: 'text',
                  text: this.runtime.withSourceCallable(
                    input.promptEnvelope.collaboration
                      ? collaborationInstructions(
                          input.promptEnvelope.collaboration,
                          input.promptEnvelope.collaborationAuthorization,
                        )
                      : frozenSourceInstructions,
                  ),
                },
              ]
            : []),
          ...codexPromptInput(input.promptEnvelope),
        ],
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        collaborationMode: {
          mode: collaborationPlanMode(workflow, authorization) ? 'plan' : 'default',
          settings: {
            model: input.model ?? 'x'.repeat(256),
            reasoning_effort: input.effort,
            developer_instructions: null,
          },
        },
      },
    }
    if (freezeNativeJsonFrame(request) + 256 * 1024 > NATIVE_OWNER_WORKING_BYTES)
      throw new AgentExecutionError(
        'response_too_large',
        'Native request preparation capacity is full. Nothing was sent.',
        false,
      )
  }

  async steer(input: AgentSteerInput, signal: AbortSignal): Promise<AgentSteerResult> {
    const owner = [...this.runtime.nativeBackground].find(
      (entry) => entry.input.runId === input.runId,
    )
    const current = (): boolean =>
      Boolean(
        owner &&
        this.runtime.running &&
        !this.runtime.disposed &&
        !signal.aborted &&
        !owner.closed &&
        !owner.foregroundReleased &&
        !owner.rootTerminal &&
        !owner.rootNotStarted &&
        !owner.cancellationPending &&
        !owner.observation.signal.aborted &&
        owner.input.nativeGeneration === input.nativeGeneration &&
        (owner.input.bindingGeneration ?? 1) === input.bindingGeneration &&
        owner.primaryThreadId === input.nativeSessionId &&
        owner.primaryTurnId === input.nativeTurnId &&
        owner.connection === this.runtime.connection &&
        owner.connection?.isOpen,
      )
    if (!owner || !current())
      return {
        status: 'rejected',
        reason: 'The target execution is no longer available for steering.',
      }
    if (owner.steering)
      return { status: 'rejected', reason: 'Another steering request is still being delivered.' }
    owner.steering = true
    const receipt = { id: input.inputId, consumed: false }
    owner.steeringInput = receipt
    const done = Promise.withResolvers<void>()
    owner.steeringDone = done.promise
    let sent = false
    const deadline = Date.now() + 10_000
    try {
      this.preflightPrompt({ ...owner.input, promptEnvelope: input.promptEnvelope })
      const workflow = input.promptEnvelope.collaboration
      if (input.promptEnvelope.skillInvocation) {
        const listed = await owner.connection!.request(
          'skills/list',
          { cwds: [owner.input.cwd], forceReload: true },
          { timeoutMs: Math.max(1, deadline - Date.now()), signal, canDispatch: current },
        )
        if (Reflect.get(listed, 'error')) throw new Error('Native Skills are unavailable.')
        const catalog = nativeCodexSkillListSchema.parse(Reflect.get(listed, 'result'))
        const directory = catalog.data.find((entry) => entry.cwd === owner.input.cwd)
        if (!directory || directory.errors.length) throw new Error('Native Skills are incomplete.')
        const bindings = nativeSkillCatalog(
          'codex',
          owner.input.cwd,
          this.runtime.executablePath,
          directory.skills,
        )
        const selected = input.promptEnvelope.skillInvocation.bindings.filter(
          (binding) => binding.agentId === 'codex',
        )
        if (selected.some((binding) => !bindings.some((candidate) => candidate.id === binding.id)))
          throw new Error('The steering Skill binding no longer matches the native catalog.')
      }
      if (owner.steerInputIds.size >= 64)
        throw new AgentExecutionError(
          'runtime_incompatible',
          'Native input observation capacity is occupied.',
          false,
        )
      owner.steerInputIds.add(input.inputId)
      const ownerSourceReader = owner.input.host?.workflow?.sourceReader
      const response = await owner.connection!.request(
        'turn/steer',
        {
          threadId: input.nativeSessionId,
          expectedTurnId: input.nativeTurnId,
          clientUserMessageId: input.inputId,
          input: [
            ...(workflow || ownerSourceReader
              ? [
                  {
                    type: 'text',
                    text: this.runtime.withSourceCallable(
                      workflow
                        ? collaborationInstructions(
                            workflow,
                            input.promptEnvelope.collaborationAuthorization,
                          )
                        : frozenSourceInstructions,
                    ),
                  },
                ]
              : []),
            ...codexPromptInput(
              input.promptEnvelope,
              ownerSourceReader
                ? (target) => ownerSourceReader.navigation(target, owner.sourceReadForm ?? 'legacy')
                : undefined,
              cutoffSourceNavigator(ownerSourceReader, owner.sourceReadForm ?? 'legacy'),
            ),
          ],
        },
        {
          timeoutMs: Math.max(1, deadline - Date.now()),
          signal,
          canDispatch: current,
          onDispatch: () => {
            sent = true
            input.recordDispatch('possibly_sent')
          },
        },
      )
      const error = Reflect.get(response, 'error')
      if (receipt.consumed) return { status: 'accepted' }
      if (error) {
        owner.steerInputIds.delete(input.inputId)
        input.recordDispatch('rejected')
        return {
          status:
            typeof error === 'object' && Reflect.get(error, 'code') === -32601
              ? 'unsupported'
              : 'rejected',
          reason:
            typeof error === 'object' && Reflect.get(error, 'code') === -32601
              ? 'This Codex version does not support steering an active turn.'
              : 'Codex rejected steering for this exact active turn. The message was kept.',
        }
      }
      const result = Reflect.get(response, 'result')
      if (
        !result ||
        typeof result !== 'object' ||
        Reflect.get(result, 'turnId') !== input.nativeTurnId
      )
        throw new AgentExecutionError(
          'unknown_delivery',
          'Codex did not confirm the steering request for its exact turn. Do not resend it automatically.',
          false,
        )
      input.recordDispatch('accepted')
      return { status: 'accepted' }
    } catch (error) {
      if (receipt.consumed) return { status: 'accepted' }
      if (sent)
        throw new AgentExecutionError(
          'unknown_delivery',
          'Codex may have received this steering message. Do not resend it automatically.',
          false,
        )
      owner.steerInputIds.delete(input.inputId)
      input.recordDispatch('rejected')
      if (signal.aborted) throw error
      return { status: 'rejected', reason: 'The steering message was not delivered to Codex.' }
    } finally {
      owner.steering = false
      if (owner.steeringInput === receipt) owner.steeringInput = undefined
      done.resolve()
    }
  }

  run(input: AgentRunInput, signal: AbortSignal): AsyncIterable<NormalizedAgentEvent> {
    return new CodexTurnSession(this.runtime, input, signal).run()
  }

  enrichTitle(input: AgentTitleEnrichmentInput, signal: AbortSignal): Promise<string | undefined> {
    return this.lifecycle.enrichTitle(input, signal)
  }

  setNativeTitle(
    input: AgentNativeTitleInput,
    signal: AbortSignal,
  ): Promise<'synchronized' | 'unavailable' | 'unknown_delivery'> {
    return this.lifecycle.setNativeTitle(input, signal)
  }

  diagnostics(): CodexConnectionDiagnostics {
    return this.connections.diagnostics()
  }

  dispose(shutdown?: AgentShutdownSettlement): Promise<void> {
    if (this.runtime.disposal) return this.runtime.disposal
    const connection = this.runtime.connection
    if (shutdown) {
      this.runtime.shutdownDeadlineAt = Math.min(
        this.runtime.shutdownDeadlineAt ?? Infinity,
        shutdown.flushDeadlineAt,
      )
      connection?.capShutdownDeadline(this.runtime.shutdownDeadlineAt)
      this.runtime.nativeInspection?.connection?.capShutdownDeadline(
        this.runtime.shutdownDeadlineAt,
      )
    }
    const foreground = shutdown?.foregroundSettlement && connection?.isOpen ? shutdown : undefined
    if (!foreground) this.runtime.disposed = true
    // Publish the single close owner before callbacks or the abort path can reenter.
    const disposal = Promise.resolve().then(() =>
      this.connections.closeAdapter(
        shutdown
          ? { ...shutdown, foregroundSettlement: foreground?.foregroundSettlement }
          : undefined,
      ),
    )
    this.runtime.disposal = disposal
    void disposal.catch(() => {
      // A later explicit disposal can join a late physical release. The native
      // close owners keep their original promises and are never restarted here.
      this.runtime.disposed = true
      if (this.runtime.disposal === disposal) this.runtime.disposal = undefined
    })
    return disposal
  }

  hasActiveBackgroundWork(runId?: string): boolean {
    return (
      (!runId &&
        (this.runtime.nativeCheck.active ||
          this.runtime.nativeInspection !== undefined ||
          this.runtime.nativeForkFiles.active ||
          this.runtime.pendingSettingsBarriers.size > 0)) ||
      [...this.runtime.nativeForkOwners].some(([id]) => !runId || id === runId) ||
      [...this.runtime.nativeBackground].some(
        (background) => !runId || background.input.runId === runId,
      ) ||
      [...this.runtime.nativeRebuildReceipts].some(
        ([id, receipt]) => receipt.pending && (!runId || runId === id),
      )
    )
  }

  backgroundWork(runId: string, executorId: string): 'working' | 'stoppable' | undefined {
    const owner = [...this.runtime.nativeBackground].find(
      (item) => item.input.runId === runId && item.connection?.executorId === executorId,
    )
    return owner ? this.describeBackgroundWork(owner) : undefined
  }

  private describeBackgroundWork(owner: NativeBackground): 'working' | 'stoppable' | undefined {
    if (
      !owner.rootTerminal ||
      owner.closed ||
      !owner.connection?.isOpen ||
      (!owner.threads.size && !owner.operations.size && !owner.spawns.size)
    )
      return undefined
    if (
      owner.unknown ||
      owner.untrackedWork ||
      owner.spawns.size ||
      owner.early.length ||
      [...owner.threads].some((thread) => !owner.turns.has(thread)) ||
      [...owner.operations].some((key) => {
        const operation: unknown = JSON.parse(key)
        if (!Array.isArray(operation)) return true
        const [thread, turn, id] = operation
        if (typeof thread !== 'string' || typeof turn !== 'string' || typeof id !== 'string')
          return true
        return thread === owner.primaryThreadId
          ? turn !== owner.primaryTurnId || !owner.foregroundCommands.has(id)
          : !owner.threads.has(thread) || owner.turns.get(thread) !== turn
      })
    )
      return 'working'
    return 'stoppable'
  }

  async stopBackgroundWork(runId: string, executorId: string, signal: AbortSignal): Promise<void> {
    const owner = [...this.runtime.nativeBackground].find(
      (item) => item.input.runId === runId && item.connection?.executorId === executorId,
    )
    const connection = owner?.connection
    if (!owner || !connection || this.describeBackgroundWork(owner) !== 'stoppable')
      throw new Error('The original Codex background work is no longer available to stop.')
    const commands = new Map(owner.foregroundCommands)
    const children = [...owner.threads].map((thread) => [thread, owner.turns.get(thread)!] as const)
    if (commands.size && owner.primaryThreadId && owner.primaryTurnId)
      await this.connections.interruptForegroundCommands(
        owner,
        connection,
        owner.primaryThreadId,
        owner.primaryTurnId,
        commands,
        signal,
        true,
      )
    for (const [thread, turn] of children) {
      if (
        signal.aborted ||
        this.runtime.disposed ||
        this.runtime.connection !== connection ||
        owner.connection !== connection ||
        !connection.isOpen
      )
        throw new Error('Native interruption ownership is no longer current.')
      if (owner.closed) return
      if (!owner.threads.has(thread) || owner.turns.get(thread) !== turn) continue
      // oxlint-disable-next-line no-await-in-loop -- Exact owned child Turns share one Stop deadline.
      await this.connections.interruptForegroundCommands(
        owner,
        connection,
        thread,
        turn,
        new Map(),
        signal,
      )
    }
  }

  private beginNativeCheck<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<T> {
    const check = this.runtime.nativeCheck.begin(signal, operation, context)
    void check.physicalCompletion.then(
      () => this.connections.scheduleIdleDisconnect(),
      () => undefined,
    )
    return check
  }

  private trackNativeBackground(
    background: NativeBackground,
    item: object,
    ownerThreadId?: string,
    ownerTurnId?: string,
  ): void {
    const type = Reflect.get(item, 'type')
    if (
      ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(String(type))
    ) {
      const id = Reflect.get(item, 'id')
      if (typeof id !== 'string' || !ownerThreadId || !ownerTurnId) {
        background.unknown = true
        background.untrackedWork = true
        return
      }
      background.operations.delete(JSON.stringify([ownerThreadId, ownerTurnId, id]))
      if (
        ownerThreadId === background.primaryThreadId &&
        ownerTurnId === background.primaryTurnId &&
        background.foregroundCommands.has(id)
      ) {
        const handle = background.foregroundCommands.get(id)
        background.foregroundCommands.delete(id)
        background.foregroundCommandBytes -= Buffer.byteLength(JSON.stringify([id, handle ?? null]))
      }
    } else if (type === 'collabAgentToolCall' || type === 'collabToolCall') {
      const itemId = Reflect.get(item, 'id')
      if (typeof itemId === 'string' && ownerThreadId && ownerTurnId)
        background.spawns.delete(JSON.stringify([ownerThreadId, ownerTurnId, itemId]))
      const sender = Reflect.get(item, 'senderThreadId')
      if (sender !== ownerThreadId || typeof ownerThreadId !== 'string') {
        background.unknown = true
        background.untrackedWork = true
        return
      }
      const receivers = Reflect.get(item, 'receiverThreadIds')
      const states = Reflect.get(item, 'agentsStates')
      if (!Array.isArray(receivers) || receivers.length > 64) {
        background.unknown = true
        background.untrackedWork = true
        return
      }
      for (const id of receivers) {
        if (typeof id !== 'string' || id.length > 1024) {
          background.unknown = true
          background.untrackedWork = true
          continue
        }
        const state = states && typeof states === 'object' ? Reflect.get(states, id) : undefined
        const status = state && typeof state === 'object' ? Reflect.get(state, 'status') : undefined
        if (!background.parents.has(id)) {
          if (Reflect.get(item, 'tool') !== 'spawnAgent' || background.parents.size >= 64) {
            background.unknown = true
            background.untrackedWork = true
            continue
          }
          background.parents.set(id, ownerThreadId)
        }
        if (['completed', 'errored', 'shutdown', 'notFound'].includes(String(status)))
          background.threads.delete(id)
        else background.threads.add(id)
      }
    }
  }

  private settleNativeBackground(background: NativeBackground): void {
    if (background.closed) return
    background.closed = true
    if (background.sourceGrant)
      this.runtime.peerToolServer.retireSourceReader(background.sourceGrant)
    background.foregroundCommands.clear()
    background.steerInputIds.clear()
    background.foregroundCommandBytes = 0
    background.release?.()
    clearTimeout(background.earlyTimer)
    for (const entry of background.early) entry.reservation.release()
    background.early = []
    background.earlyBytes = 0
    background.observation.abort()
    for (const [thread, turn] of background.turns)
      this.runtime.retiredNativeTurns.add(JSON.stringify([thread, turn]))
    if (background.primaryThreadId && background.primaryTurnId)
      this.runtime.retiredNativeTurns.add(
        JSON.stringify([background.primaryThreadId, background.primaryTurnId]),
      )
    for (const child of background.parents.keys()) this.runtime.retiredNativeChildren.add(child)
    for (const retired of [this.runtime.retiredNativeTurns, this.runtime.retiredNativeChildren]) {
      let bytes = [...retired].reduce((sum, identity) => sum + Buffer.byteLength(identity), 0)
      while (retired.size > 256 || bytes > 512 * 1024) {
        const oldest = retired.values().next().value
        if (!oldest) break
        retired.delete(oldest)
        bytes -= Buffer.byteLength(oldest)
      }
    }
    this.runtime.nativeBackground.delete(background)
    nativeFileChangesSettled(
      background.input,
      background.unknown ? 'unknown' : 'settled',
      background.rootInputWithheld
        ? 'workflow_input_withheld'
        : background.rootNotStarted
          ? 'native_turn_not_started'
          : background.unknown
            ? 'native_observation_released'
            : 'native_work_drained',
    )
    this.connections.scheduleIdleDisconnect()
  }

  private runIdentity(
    input: Pick<AgentRunInput, 'sessionId' | 'runId' | 'bindingGeneration'>,
    nativeSessionId: string,
    nativeTurnId?: string,
  ): NativeEvidenceIdentity {
    return {
      sessionId: input.sessionId,
      agentId: this.id,
      runId: input.runId,
      requestId: input.runId,
      nativeSessionId,
      bindingGeneration: input.bindingGeneration ?? 1,
      executorId: this.executorId,
      ...(nativeTurnId ? { nativeTurnId } : {}),
    }
  }

  private admitEvidenceCache(): void {
    const bytes = (): number =>
      [...this.runtime.terminalEvidence.values()].reduce(
        (sum, entry) => sum + freezeNativeJsonFrame(entry),
        0,
      )
    while (this.runtime.terminalEvidence.size > 8 || bytes() > 16 * 1024 * 1024)
      this.runtime.terminalEvidence.delete(this.runtime.terminalEvidence.keys().next().value!)
    for (;;) {
      try {
        this.runtime.evidenceCacheWork.resize(bytes())
        return
      } catch (error) {
        if (!(error instanceof AgentExecutionError) || !this.runtime.terminalEvidence.size)
          throw error
        this.runtime.terminalEvidence.delete(this.runtime.terminalEvidence.keys().next().value!)
      }
    }
  }

  private recordTerminal(
    input: AgentRunInput,
    nativeSessionId: string,
    nativeTurnId: string,
    outcome: 'completed' | 'failed' | 'interrupted',
    answer: { outputId: string; text: string },
    workflow?: {
      plan?: { nativeId: string; text: string } | undefined
      reviewResult?: CollaborationReviewObservation | undefined
      inputResult?: CollaborationInputObservation | undefined
    },
  ): void {
    const evidence: Extract<NativeProbeResult, { kind: 'ended' }> = {
      kind: 'ended',
      source: 'live_terminal',
      outcome,
      ...(answer.text || (outcome === 'completed' && (workflow?.plan || workflow?.reviewResult))
        ? {
            output: {
              outputId: answer.outputId,
              text: answer.text,
              completeness: outcome === 'completed' ? 'complete' : 'partial',
              ...(outcome === 'completed' && workflow?.plan ? { plan: workflow.plan } : {}),
              ...(outcome === 'completed' && workflow?.reviewResult
                ? { reviewResult: workflow.reviewResult }
                : {}),
              ...(outcome === 'completed' && workflow?.inputResult
                ? { inputResult: workflow.inputResult }
                : {}),
            },
          }
        : {}),
      identity: this.runIdentity(input, nativeSessionId, nativeTurnId),
    }
    if (!this.runtime.disposed) {
      this.runtime.terminalEvidence.delete(input.runId)
      this.runtime.terminalEvidence.set(input.runId, evidence)
      this.admitEvidenceCache()
    }
    input.host?.lifecycle?.recordNativeEvidence?.(evidence)
  }
}
