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
  AGY_MAX_STAGED_PRE_BIND_BYTES,
  AGY_MAX_STAGED_PRE_BIND_FRAMES,
  asString,
  estimateJsonPayloadBytes,
  extractUserChunkPactIdentity,
  isPlainObject,
  type ActiveAgyRun,
  type ValidatedAgyFrame,
} from './types'

export interface AgyTurnFrameAdmitterHost {
  readonly runtime: AgyAdapterRuntime
  readonly input: AgentRunInput
  readonly activeRun: ActiveAgyRun
  readonly mcpServer: AgyRunMcpServer
  readonly prePromptReplayedToolCallIds: ReadonlySet<string>
  readonly expectedFullPromptText: string
  readonly expectedPromptContent: string
  readonly getStagedPreBindReservation: () => NativeMemoryReservation | undefined
  readonly releaseStagedPreBindReservation: () => void
  readonly getForeignExecIdsReservation: () => NativeMemoryReservation | undefined
  readonly releaseForeignExecIdsReservation: () => void
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
   * empties staged queues and releases both working-memory reservations at most once.
   */
  close(): void {
    if (this.closedFlag) return
    this.closedFlag = true
    this.host.activeRun.stagedPreBindNotifications.length = 0
    this.stagedPreBindBytes = 0
    this.foreignExecIdsBytes = 0
    try {
      this.host.releaseStagedPreBindReservation()
    } finally {
      this.host.releaseForeignExecIdsReservation()
    }
  }

  *drainStagedPreBindNotes(): Generator<NormalizedAgentEvent> {
    if (this.closedFlag) return
    const { activeRun, mcpServer, projectValidatedFrame } = this.host
    const boundExecId = activeRun.providerExecutionId
    if (!boundExecId || activeRun.stagedPreBindNotifications.length === 0) return
    while (!this.closedFlag && activeRun.stagedPreBindNotifications.length > 0) {
      const staged = activeRun.stagedPreBindNotifications.shift()!
      this.stagedPreBindBytes = Math.max(0, this.stagedPreBindBytes - staged.bytes)
      this.host.getStagedPreBindReservation()?.resize(this.stagedPreBindBytes)
      // Retain arrival-time attribution: execution-less frames observed while a foreign turn
      // was active, or frames carrying a different execution_id, never replay into this root.
      if (staged.frame.executionId !== boundExecId) continue
      if (staged.arrivedDuringForeignTurn && staged.frame.executionId === undefined) continue
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
      const kind = staged.frame.sessionUpdate
      return (
        kind === 'agent_message_chunk' ||
        kind === 'agent_thought_chunk' ||
        kind === 'tool_call' ||
        kind === 'tool_call_update' ||
        kind === 'background_task_completed'
      )
    })
  }

  *admitAndProject(validated: ValidatedAgyFrame): Generator<NormalizedAgentEvent> {
    if (this.closedFlag) return
    const {
      runtime,
      input,
      activeRun,
      mcpServer,
      prePromptReplayedToolCallIds,
      expectedFullPromptText,
      expectedPromptContent,
      projectValidatedFrame,
    } = this.host

    if (activeRun.providerExecutionId && activeRun.stagedPreBindNotifications.length > 0) {
      yield* this.drainStagedPreBindNotes()
    }
    if (validated.method !== 'session/update') return
    const update = validated.payload
    const sessionUpdate = validated.sessionUpdate
    if (!update || !sessionUpdate) return

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
          yield* this.drainStagedPreBindNotes()
        }
        yield* projectValidatedFrame(validated)
        return
      }
      if (updateExecId) {
        this.addKnownForeignExecutionId(updateExecId)
      }
      activeRun.foreignTurnActiveUntilRootBound = true
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
      yield* this.drainStagedPreBindNotes()
      yield* projectValidatedFrame(validated)
      return
    }

    if (activeRun.foreignTurnActiveUntilRootBound && updateExecId === undefined) return

    if (updateExecId !== undefined) {
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
