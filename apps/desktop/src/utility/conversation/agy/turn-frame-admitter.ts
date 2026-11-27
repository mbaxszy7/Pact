import type { AgentRunInput } from '@pact/agent-runtime'
import type { NormalizedAgentEvent } from '@pact/contracts'

import type { NativeMemoryReservation } from '../native-working-memory'
import type { AgyAdapterRuntime } from './adapter-runtime'
import type { AgyRunMcpServer } from './peer-mcp-server'

import { AgentExecutionError } from '../agent-execution-error'
import { recheckValidatedFrameAgainstRootBoundary } from './frame-validator'
import {
  AGY_MAX_FOREIGN_EXECUTION_IDS,
  AGY_MAX_FOREIGN_EXECUTION_ID_BYTES,
  AGY_MAX_PENDING_EVENTS,
  AGY_MAX_PENDING_EVENT_BYTES,
  AGY_MAX_PRE_PROMPT_REPLAY_TOOL_IDS,
  AGY_MAX_STAGED_PRE_BIND_BYTES,
  AGY_MAX_STAGED_PRE_BIND_FRAMES,
  asString,
  estimateJsonPayloadBytes,
  estimateNormalizedEventBytes,
  extractUserChunkPactIdentity,
  isPlainObject,
  type ActiveAgyRun,
  type ValidatedAgyFrame,
} from './types'

const ORDER_SENSITIVE_UPDATES = new Set<string>([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'background_task_completed',
])

/** Bounded foreground event queue with backpressure & control-drain discard mode. */
export class AgyPendingEventQueue {
  private readonly entries: Array<{
    readonly event: NormalizedAgentEvent
    readonly bytes: number
  }> = []
  private bytes = 0
  private discardAllFlag = false
  wakeEventLoop: (() => void) | undefined
  wakePumpForBackpressure: (() => void) | undefined

  constructor(private readonly getReservation: () => NativeMemoryReservation | undefined) {}

  get length(): number {
    return this.entries.length
  }

  get discarding(): boolean {
    return this.discardAllFlag
  }

  enableDiscardMode(): void {
    this.discardAllFlag = true
    this.clear()
  }

  notifyEventLoop(): void {
    const wake = this.wakeEventLoop
    this.wakeEventLoop = undefined
    wake?.()
  }

  notifyPumpForBackpressure(): void {
    const wake = this.wakePumpForBackpressure
    this.wakePumpForBackpressure = undefined
    wake?.()
  }

  isAtSoftCap(): boolean {
    if (this.discardAllFlag) return false
    return (
      this.entries.length >= AGY_MAX_PENDING_EVENTS || this.bytes >= AGY_MAX_PENDING_EVENT_BYTES
    )
  }

  push(ev: NormalizedAgentEvent): void {
    if (this.discardAllFlag) return
    const evBytes = estimateNormalizedEventBytes(ev)
    const nextBytes = this.bytes + evBytes
    if (
      this.entries.length >= AGY_MAX_PENDING_EVENTS * 2 ||
      nextBytes > AGY_MAX_PENDING_EVENT_BYTES * 2
    ) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity pending event queue exceeded working-memory budget.',
        false,
      )
    }
    this.getReservation()?.resize(nextBytes)
    this.bytes = nextBytes
    this.entries.push({ event: ev, bytes: evBytes })
    this.notifyEventLoop()
  }

  shift(): NormalizedAgentEvent | undefined {
    const entry = this.entries.shift()
    if (!entry) return undefined
    this.bytes = Math.max(0, this.bytes - entry.bytes)
    this.getReservation()?.resize(this.bytes)
    if (!this.isAtSoftCap()) {
      this.notifyPumpForBackpressure()
    }
    return entry.event
  }

  clear(): void {
    this.entries.length = 0
    this.bytes = 0
    this.getReservation()?.resize(0)
    this.notifyPumpForBackpressure()
  }
}

/** Tracks pre-prompt `session/load` replayed tool IDs with fail-closed overflow latching (S2-F9). */
export class AgyPrePromptReplayTracker {
  private readonly replayedToolCallIds = new Set<string>()
  private coverageIncomplete = false

  get isIncomplete(): boolean {
    return this.coverageIncomplete
  }

  has(toolCallId: string): boolean {
    return this.replayedToolCallIds.has(toolCallId)
  }

  observeNotification(
    note: object,
    targetSessionId: string,
    observeTitle: (note: object, targetSessionId: string) => void,
  ): void {
    observeTitle(note, targetSessionId)
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
    if (!this.replayedToolCallIds.has(toolCallId)) {
      if (this.replayedToolCallIds.size >= AGY_MAX_PRE_PROMPT_REPLAY_TOOL_IDS) {
        this.coverageIncomplete = true
        const oldest = this.replayedToolCallIds.values().next().value
        if (oldest !== undefined) this.replayedToolCallIds.delete(oldest)
      }
      this.replayedToolCallIds.add(toolCallId)
    }
  }

  clear(): void {
    this.replayedToolCallIds.clear()
  }
}

export interface AgyTurnFrameAdmitterHost {
  readonly runtime: AgyAdapterRuntime
  readonly input: AgentRunInput
  readonly activeRun: ActiveAgyRun
  readonly mcpServer: AgyRunMcpServer
  readonly prePromptReplay: AgyPrePromptReplayTracker
  readonly hasCurrentRunTool: (toolCallId: string) => boolean
  readonly expectedFullPromptText: string
  readonly expectedPromptContent: string
  readonly getStagedPreBindReservation: () => NativeMemoryReservation | undefined
  readonly releaseStagedPreBindReservation: () => void
  readonly getForeignExecIdsReservation: () => NativeMemoryReservation | undefined
  readonly releaseForeignExecIdsReservation: () => void
  readonly onExecutionOwnershipChanged?: (() => void) | undefined
  readonly onOwnedOutOfTurnUpdate?:
    | ((params: Record<string, unknown>, update: Record<string, unknown>) => void)
    | undefined
  readonly projectValidatedFrame: (validated: ValidatedAgyFrame) => Generator<NormalizedAgentEvent>
}

/**
 * Deep module owning Antigravity pre-bind frame staging, root execution binding,
 * foreign-turn attribution quarantine, and MCP disputed-token revocation.
 */
export class AgyTurnFrameAdmitter {
  private stagedPreBindBytes = 0
  private foreignExecIdsBytes = 0
  private closedFlag = false

  constructor(private readonly host: AgyTurnFrameAdmitterHost) {}

  addKnownForeignExecutionId(execId: string): void {
    if (this.closedFlag) return
    const { activeRun } = this.host
    if (activeRun.knownForeignExecutionIds.has(execId)) return
    const entryBytes = Buffer.byteLength(execId, 'utf8') + 32
    const nextBytes = this.foreignExecIdsBytes + entryBytes
    if (
      activeRun.knownForeignExecutionIds.size >= AGY_MAX_FOREIGN_EXECUTION_IDS ||
      nextBytes > AGY_MAX_FOREIGN_EXECUTION_ID_BYTES
    ) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity foreign execution tracking exceeded working-memory budget.',
        false,
      )
    }
    this.host.getForeignExecIdsReservation()?.resize(nextBytes)
    this.foreignExecIdsBytes = nextBytes
    activeRun.knownForeignExecutionIds.add(execId)
    this.host.onExecutionOwnershipChanged?.()
  }

  clearStagedPreBindNotifications(): void {
    this.host.activeRun.stagedPreBindNotifications.length = 0
    this.stagedPreBindBytes = 0
    if (!this.closedFlag) {
      this.host.getStagedPreBindReservation()?.resize(0)
    }
  }

  /**
   * Idempotent teardown shared by normal iterator exit and emergency forceCleanup:
   * empties staged queues and releases staged reservation; optionally preserves
   * `foreignExecIdsMemoryReservation` while retained background observation still reads
   * `activeRun.knownForeignExecutionIds` (released in `cleanupRetained`).
   */
  close(options?: { readonly keepForeignExecReservation?: boolean | undefined }): void {
    if (this.closedFlag) return
    this.closedFlag = true
    this.host.activeRun.stagedPreBindNotifications.length = 0
    this.stagedPreBindBytes = 0
    try {
      this.host.releaseStagedPreBindReservation()
    } finally {
      if (!options?.keepForeignExecReservation) {
        this.foreignExecIdsBytes = 0
        this.host.releaseForeignExecIdsReservation()
      }
    }
  }

  private *drainResolvedPreBindPrefix(): Generator<NormalizedAgentEvent> {
    if (this.closedFlag) return
    const { activeRun, mcpServer, projectValidatedFrame } = this.host
    while (!this.closedFlag && activeRun.stagedPreBindNotifications.length > 0) {
      const head = activeRun.stagedPreBindNotifications[0]!
      const headExecId = head.frame.executionId
      if (headExecId !== undefined) {
        if (!activeRun.knownForeignExecutionIds.has(headExecId)) break
        activeRun.stagedPreBindNotifications.shift()
        this.stagedPreBindBytes = Math.max(0, this.stagedPreBindBytes - head.bytes)
        this.host.getStagedPreBindReservation()?.resize(this.stagedPreBindBytes)
        continue
      }
      activeRun.stagedPreBindNotifications.shift()
      this.stagedPreBindBytes = Math.max(0, this.stagedPreBindBytes - head.bytes)
      this.host.getStagedPreBindReservation()?.resize(this.stagedPreBindBytes)
      if (head.arrivedDuringForeignTurn) continue
      const rechecked = recheckValidatedFrameAgainstRootBoundary(
        head.frame,
        mcpServer.pinnedTrajectory,
        mcpServer.minStepIdx,
      )
      yield* projectValidatedFrame(rechecked)
    }
  }

  *drainStagedPreBindNotes(): Generator<NormalizedAgentEvent> {
    if (this.closedFlag) return
    const { activeRun, mcpServer, projectValidatedFrame } = this.host
    const boundExecId = activeRun.providerExecutionId
    if (!boundExecId) {
      yield* this.drainResolvedPreBindPrefix()
      return
    }
    if (activeRun.stagedPreBindNotifications.length === 0) return
    while (!this.closedFlag && activeRun.stagedPreBindNotifications.length > 0) {
      const staged = activeRun.stagedPreBindNotifications.shift()!
      this.stagedPreBindBytes = Math.max(0, this.stagedPreBindBytes - staged.bytes)
      this.host.getStagedPreBindReservation()?.resize(this.stagedPreBindBytes)
      // Retain arrival-time attribution while preserving ACP seq order across mixed IDs (S2-F8):
      // frames carrying a different execution_id or unattributed frames observed during a foreign
      // turn never replay into this root; matching execution_id and clean unattributed frames replay in seq order.
      if (staged.frame.executionId !== undefined && staged.frame.executionId !== boundExecId) {
        continue
      }
      if (staged.frame.executionId === undefined && staged.arrivedDuringForeignTurn) {
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

  hasUnresolvedSubstantivePreBind(): boolean {
    const { activeRun } = this.host
    if (activeRun.providerExecutionId || activeRun.stagedPreBindNotifications.length === 0) {
      return false
    }
    return activeRun.stagedPreBindNotifications.some((staged) => {
      const execId = staged.frame.executionId
      if (execId !== undefined && activeRun.knownForeignExecutionIds.has(execId)) return false
      if (staged.arrivedDuringForeignTurn) return false
      return (
        staged.frame.sessionUpdate !== undefined &&
        ORDER_SENSITIVE_UPDATES.has(staged.frame.sessionUpdate)
      )
    })
  }

  private handleOutOfTurnForegroundFrame(
    validated: ValidatedAgyFrame,
    update: Record<string, unknown>,
  ): void {
    const { activeRun, runtime } = this.host
    const rawParams = Reflect.get(validated.message, 'params')
    const rawOutput = isPlainObject(update.rawOutput) ? update.rawOutput : undefined
    const taskId =
      asString(update.taskId ?? update.backgroundTaskId) ??
      (rawOutput ? asString(rawOutput.taskId ?? rawOutput.backgroundTaskId) : undefined)
    const toolCallId = validated.toolCallIdInvalid ? undefined : validated.toolCallId
    const explicitlyOwnedByCurrentRun =
      (taskId !== undefined &&
        (activeRun.backgroundTaskAliases.has(taskId) ||
          activeRun.activeBackgroundTasks.has(taskId))) ||
      (toolCallId !== undefined &&
        (activeRun.backgroundTaskAliases.has(toolCallId) ||
          activeRun.activeBackgroundTasks.has(toolCallId))) ||
      (validated.executionId !== undefined &&
        activeRun.providerExecutionId !== undefined &&
        validated.executionId === activeRun.providerExecutionId)
    if (explicitlyOwnedByCurrentRun && isPlainObject(rawParams)) {
      this.host.onOwnedOutOfTurnUpdate?.(rawParams, update)
      return
    }
    // Unattributable outOfTurn frame cannot enter this foreground root answer; mark any
    // retained background runs on the same session unconfirmed because attribution was lost.
    for (const other of runtime.activeRuns.values()) {
      if (
        other !== activeRun &&
        other.nativeSessionId === activeRun.nativeSessionId &&
        other.activeBackgroundTasks.size > 0
      ) {
        other.backgroundUnconfirmed = true
        other.reportUnknown?.(
          'Antigravity received an unattributable out-of-turn background update while another Run was active on the same session.',
        )
      }
    }
  }

  *admitAndProject(validated: ValidatedAgyFrame): Generator<NormalizedAgentEvent> {
    if (this.closedFlag) return
    const {
      runtime,
      input,
      activeRun,
      mcpServer,
      prePromptReplay,
      hasCurrentRunTool,
      expectedFullPromptText,
      expectedPromptContent,
      projectValidatedFrame,
    } = this.host

    if (activeRun.stagedPreBindNotifications.length > 0) {
      yield* this.drainStagedPreBindNotes()
    }
    if (validated.method !== 'session/update') return
    const update = validated.payload
    const sessionUpdate = validated.sessionUpdate
    if (!update || !sessionUpdate) return

    // Explicit outOfTurn frames are background reports/task completions, NEVER foreground root answers (S2-F4).
    if (update.outOfTurn === true) {
      this.handleOutOfTurnForegroundFrame(validated, update)
      return
    }

    const updateExecId = validated.executionId
    // Run contradiction guard BEFORE any execution binding, foreign-ID insertion,
    // staged-frame drain, or projection. Retain ONLY negative MCP revocation for disputed frames.
    const frameRootContradictsPinned =
      validated.hasForeignOrInvalidSessionMeta ||
      validated.executionIdInvalid ||
      validated.rootEvidenceContradicted ||
      (updateExecId !== undefined &&
        activeRun.providerExecutionId !== undefined &&
        updateExecId !== activeRun.providerExecutionId) ||
      (updateExecId !== undefined && activeRun.knownForeignExecutionIds.has(updateExecId))
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
      activeRun.resumedExistingSession &&
      (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') &&
      !validated.toolCallIdInvalid &&
      validated.toolCallId !== undefined
    ) {
      if (prePromptReplay.has(validated.toolCallId)) {
        return
      }
      // S2-F9: When pre-prompt replay history exceeded 4,096 distinct tool IDs, evicted historical
      // split completions without verified current-Run identity cannot mutate current WorkspaceChanges.
      if (prePromptReplay.isIncomplete && sessionUpdate === 'tool_call_update') {
        const hasVerifiedCurrentIdentity =
          updateExecId !== undefined ||
          (validated.stepIdx !== undefined &&
            mcpServer.minStepIdx !== undefined &&
            validated.stepIdx >= mcpServer.minStepIdx) ||
          hasCurrentRunTool(validated.toolCallId)
        if (!hasVerifiedCurrentIdentity) {
          return
        }
      }
    }

    const updateMeta = Reflect.get(update, '_meta')
    const steerId =
      sessionUpdate === 'user_message_chunk'
        ? (asString(update.pactSteerInputId) ??
          (isPlainObject(updateMeta) ? asString(updateMeta.pactSteerInputId) : undefined))
        : undefined

    // Once root `providerExecutionId` is bound, strictly drop any update carrying a different `execution_id`.
    if (activeRun.providerExecutionId !== undefined) {
      if (updateExecId !== undefined && updateExecId !== activeRun.providerExecutionId) return
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
        activeRun.foreignTurnActiveUntilRootBound = false
        if (updateExecId && (hasExactHostRunReceipt || hasExactFullPromptProof)) {
          runtime.projector.bindRootExecutionId(activeRun, input, updateExecId)
          this.host.onExecutionOwnershipChanged?.()
          yield* this.drainStagedPreBindNotes()
        }
        yield* projectValidatedFrame(validated)
        return
      }
      if (updateExecId) {
        this.addKnownForeignExecutionId(updateExecId)
      }
      activeRun.foreignTurnActiveUntilRootBound = true
      this.host.onExecutionOwnershipChanged?.()
      if (activeRun.stagedPreBindNotifications.length > 0) {
        yield* this.drainResolvedPreBindPrefix()
      }
      return
    }

    const hasConcurrentRun = runtime.hasOtherActiveRunOnSession(activeRun)
    const canBindFromInitialUpdate =
      updateExecId !== undefined &&
      !activeRun.resumedExistingSession &&
      activeRun.steeredInputs.size === 0 &&
      !activeRun.foreignTurnActiveUntilRootBound &&
      !hasConcurrentRun

    if (canBindFromInitialUpdate) {
      runtime.projector.bindRootExecutionId(activeRun, input, updateExecId)
      this.host.onExecutionOwnershipChanged?.()
      yield* this.drainStagedPreBindNotes()
      yield* projectValidatedFrame(validated)
      return
    }

    if (activeRun.foreignTurnActiveUntilRootBound && updateExecId === undefined) return

    // S2-F8: Stage both candidate execution_id frames AND subsequent order-sensitive frames
    // behind any pending staged frame so mixed-ID chunks strictly preserve ACP seq order.
    const mustStageToPreserveOrder =
      activeRun.stagedPreBindNotifications.length > 0 && ORDER_SENSITIVE_UPDATES.has(sessionUpdate)
    if (updateExecId !== undefined || mustStageToPreserveOrder) {
      const frameBytes = estimateJsonPayloadBytes(validated.message, AGY_MAX_STAGED_PRE_BIND_BYTES)
      const nextStagedBytes = this.stagedPreBindBytes + frameBytes
      if (
        activeRun.stagedPreBindNotifications.length >= AGY_MAX_STAGED_PRE_BIND_FRAMES ||
        nextStagedBytes > AGY_MAX_STAGED_PRE_BIND_BYTES
      ) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity pre-bind staged updates exceeded working-memory budget.',
          false,
        )
      }
      this.host.getStagedPreBindReservation()?.resize(nextStagedBytes)
      this.stagedPreBindBytes = nextStagedBytes
      activeRun.stagedPreBindNotifications.push({
        frame: validated,
        bytes: frameBytes,
        arrivedDuringForeignTurn: activeRun.foreignTurnActiveUntilRootBound,
      })
      return
    }

    yield* projectValidatedFrame(validated)
  }
}
