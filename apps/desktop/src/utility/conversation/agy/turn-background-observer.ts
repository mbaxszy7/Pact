import type { AgentRunInput } from '@pact/agent-runtime'

import type { AgyAcpConnection, AgyIngress, AgyOrderedSessionStream } from '../agy-acp-connection'
import type { NativeMemoryReservation } from '../native-working-memory'
import type { AgyAdapterRuntime } from './adapter-runtime'
import type { AgyRunMcpServer } from './peer-mcp-server'

import {
  buildCompactPostCutoffBackgroundRecord,
  estimateCompactBackgroundRecordBytes,
  validateBackgroundUpdateForRun,
  type ValidatedBackgroundOwnership,
} from './frame-validator'
import {
  AGY_MAX_FOREGROUND_DEDUP_BYTES,
  AGY_MAX_FOREGROUND_DEDUP_ID_COUNT,
  AGY_MAX_POST_CUTOFF_BG_BYTES,
  AGY_MAX_POST_CUTOFF_BG_PENDING,
  asString,
  isEligibleAgyBackgroundReportId,
  isPlainObject,
  type ActiveAgyRun,
} from './types'

/**
 * Only these `session/update` kinds represent background task settlement or post-turn
 * background reports. Session control/config/replay metadata must NEVER be monopolized
 * by a retained background observer.
 */
const AGY_BACKGROUND_OBSERVER_UPDATES = new Set<string>([
  'agent_message_chunk',
  'tool_call',
  'tool_call_update',
  'background_task_completed',
])

export interface AgyTurnBackgroundObserverHost {
  readonly runtime: AgyAdapterRuntime
  readonly input: AgentRunInput
  readonly mcpServer: AgyRunMcpServer
  readonly getActiveRun: () => ActiveAgyRun | undefined
  readonly getResolvedSessionId: () => string | undefined
  readonly canSettleEffects: () => boolean
  readonly isRootTerminal: () => boolean
  readonly hasVerifiedRootOutcome?: (() => boolean) | undefined
  readonly ensureCompactEndedCommitted?: (() => boolean) | undefined
  readonly awaitRecordings?: (() => Promise<void>) | undefined
  readonly hasPendingRecordings?: (() => boolean) | undefined
  readonly reportSettled: () => void
  readonly reportUnknown: (reason: string) => void
  readonly getForegroundDedupReservation: () => NativeMemoryReservation | undefined
  readonly getPostCutoffBgReservation: () => NativeMemoryReservation | undefined
}

/**
 * Deep module owning Antigravity foreground-message deduplication (512 KiB / 4096-ID bound),
 * serialized post-cutoff background report queuing, and zero-gap ordered-stream-to-background
 * subscription handoff.
 */
export class AgyTurnBackgroundObserver {
  private readonly seenForegroundMessageIds = new Set<string>()
  private seenForegroundMessageIdBytes = 0
  private foregroundDedupIncomplete = false
  private omittedForegroundIdLacksTrustedStep = false
  private maxForegroundStepIdx: number | undefined
  private readonly reportedBackgroundMessageIds = new Set<string>()
  private observedBackgroundTaskFlag = false
  private postCutoffBackgroundTail = Promise.resolve()
  private postCutoffBgQueuedCount = 0
  private postCutoffBgQueuedBytes = 0
  private readonly pendingPreTerminalEntries: Array<{
    params: Record<string, unknown>
    update: Record<string, unknown>
    ownership: ValidatedBackgroundOwnership
    arrivedDuringOtherRunReplay: boolean
    bytes: number
  }> = []
  private admittingBackground = true
  private unsubscribeBackground: (() => void) | undefined
  private unsubscribeConnectionClose: (() => void) | undefined
  private retainedCleanup: (() => void) | undefined
  private retainedSettling = false
  private retainedCleaned = false

  constructor(private readonly host: AgyTurnBackgroundObserverHost) {}

  markObservedBackgroundTask(): void {
    this.observedBackgroundTaskFlag = true
  }

  hasObservedBackgroundTask(): boolean {
    return this.observedBackgroundTaskFlag
  }

  recordSeenForegroundMessageId(msgIdentity: string, trustedStepIdx?: number): void {
    if (!isEligibleAgyBackgroundReportId(msgIdentity)) return
    if (this.seenForegroundMessageIds.has(msgIdentity)) return
    const markOmitted = (): void => {
      this.foregroundDedupIncomplete = true
      if (trustedStepIdx === undefined) {
        this.omittedForegroundIdLacksTrustedStep = true
      }
    }
    if (this.seenForegroundMessageIds.size >= AGY_MAX_FOREGROUND_DEDUP_ID_COUNT) {
      markOmitted()
      return
    }
    const entryBytes = msgIdentity.length * 2 + 32
    if (this.seenForegroundMessageIdBytes + entryBytes > AGY_MAX_FOREGROUND_DEDUP_BYTES) {
      markOmitted()
      return
    }
    const foregroundDedupReservation = this.host.getForegroundDedupReservation()
    if (foregroundDedupReservation) {
      try {
        foregroundDedupReservation.resize(this.seenForegroundMessageIdBytes + entryBytes)
      } catch {
        markOmitted()
        return
      }
    }
    this.seenForegroundMessageIds.add(msgIdentity)
    this.seenForegroundMessageIdBytes += entryBytes
  }

  recordForegroundStepIdx(stepIdx: number): void {
    if (this.maxForegroundStepIdx === undefined || stepIdx > this.maxForegroundStepIdx) {
      this.maxForegroundStepIdx = stepIdx
    }
  }

  hasPendingWork(): boolean {
    return (
      this.postCutoffBgQueuedCount > 0 ||
      this.pendingPreTerminalEntries.length > 0 ||
      Boolean(this.host.hasPendingRecordings?.())
    )
  }

  onRecordingsSettled(): void {
    const activeRun = this.host.getActiveRun()
    if (activeRun) this.maybeFinishRetainedBackground(activeRun)
  }

  flushPreTerminalEntries(): void {
    if (!this.pendingPreTerminalEntries.length) return
    const items = this.pendingPreTerminalEntries.splice(0)
    for (const entry of items) {
      this.postCutoffBgQueuedCount = Math.max(0, this.postCutoffBgQueuedCount - 1)
      this.postCutoffBgQueuedBytes = Math.max(0, this.postCutoffBgQueuedBytes - entry.bytes)
      if (!this.retainedCleaned) {
        this.host.getPostCutoffBgReservation()?.resize(this.postCutoffBgQueuedBytes)
      }
      this.enqueuePostCutoffBackgroundUpdate(
        entry.params,
        entry.update,
        entry.ownership,
        entry.arrivedDuringOtherRunReplay,
      )
    }
  }

  enqueuePostCutoffBackgroundUpdate(
    params: Record<string, unknown>,
    update: Record<string, unknown>,
    preValidatedOwnership?: ValidatedBackgroundOwnership,
    arrivedDuringOtherRunReplayOverride?: boolean,
  ): void {
    if (!this.admittingBackground) return
    const activeRun = this.host.getActiveRun()
    if (!activeRun) return
    const ownership =
      preValidatedOwnership ??
      validateBackgroundUpdateForRun(
        params,
        update,
        activeRun,
        this.host.mcpServer.pinnedTrajectory,
        this.host.mcpServer.minStepIdx,
      )
    if (!ownership.valid) return
    const record = buildCompactPostCutoffBackgroundRecord(update, ownership)
    if (!record) return
    const recordBytes = estimateCompactBackgroundRecordBytes(record)
    const nextBytes = this.postCutoffBgQueuedBytes + recordBytes
    if (
      this.postCutoffBgQueuedCount >= AGY_MAX_POST_CUTOFF_BG_PENDING ||
      nextBytes > AGY_MAX_POST_CUTOFF_BG_BYTES
    ) {
      activeRun.backgroundUnconfirmed = true
      this.host.reportUnknown(
        'Antigravity post-cutoff background update queue exceeded working-memory budget; coverage is incomplete.',
      )
      return
    }
    try {
      this.host.getPostCutoffBgReservation()?.resize(nextBytes)
    } catch {
      activeRun.backgroundUnconfirmed = true
      this.host.reportUnknown(
        'Antigravity post-cutoff background update queue exceeded shared working-memory budget; coverage is incomplete.',
      )
      return
    }
    // B-F9: Capture replay state at exact frame arrival boundary instead of asynchronously reading later state.
    const arrivedDuringOtherRunReplay =
      arrivedDuringOtherRunReplayOverride ??
      (this.host.runtime.replayingSessions.get(activeRun.nativeSessionId) ?? 0) > 0
    // B-F8: Buffer owned out-of-turn background reports arriving before root reaches a verified
    // terminal outcome, then flush them in order once compact `ended(completed)` can be committed.
    const rootOutcomeReady = this.host.hasVerifiedRootOutcome?.() ?? this.host.isRootTerminal()
    if (
      !rootOutcomeReady &&
      record.rawText &&
      ((record.sessionUpdate === 'agent_message_chunk' && record.outOfTurn) ||
        record.sessionUpdate === 'background_task_completed' ||
        (record.sessionUpdate === 'tool_call_update' &&
          record.status === 'completed' &&
          record.outOfTurn))
    ) {
      if (this.pendingPreTerminalEntries.length >= 16) {
        if (!this.retainedCleaned) {
          this.host.getPostCutoffBgReservation()?.resize(this.postCutoffBgQueuedBytes)
        }
        activeRun.backgroundUnconfirmed = true
        this.host.reportUnknown(
          'Antigravity pre-terminal background report buffer exceeded capacity; coverage is incomplete.',
        )
        return
      }
      this.postCutoffBgQueuedCount += 1
      this.postCutoffBgQueuedBytes = nextBytes
      this.pendingPreTerminalEntries.push({
        params,
        update,
        ownership,
        arrivedDuringOtherRunReplay,
        bytes: recordBytes,
      })
      return
    }
    this.postCutoffBgQueuedCount += 1
    this.postCutoffBgQueuedBytes = nextBytes
    this.postCutoffBackgroundTail = this.postCutoffBackgroundTail
      .then(() =>
        this.host.runtime.projector.handlePostTurnBackgroundUpdate({
          record,
          input: this.host.input,
          activeRun,
          observedBackgroundTask: this.observedBackgroundTaskFlag,
          onObservedBackgroundTask: () => this.markObservedBackgroundTask(),
          arrivedDuringOtherRunReplay,
          ensureCompactEndedCommitted: this.host.ensureCompactEndedCommitted,
          isOtherRunReplayingHistory: () =>
            arrivedDuringOtherRunReplay ||
            (this.host.runtime.replayingSessions.get(activeRun.nativeSessionId) ?? 0) > 0,
          canSettleEffects: () => this.host.canSettleEffects(),
          isRootTerminal: () => this.host.isRootTerminal(),
          seenForegroundMessageIds: this.seenForegroundMessageIds,
          isForegroundDedupIncomplete: () => this.foregroundDedupIncomplete,
          hasOmittedForegroundIdWithoutStep: () => this.omittedForegroundIdLacksTrustedStep,
          getMaxForegroundStepIdx: () => this.maxForegroundStepIdx,
          getPinnedTrajectory: () => this.host.mcpServer.pinnedTrajectory,
          getMinStepIdx: () => this.host.mcpServer.minStepIdx,
          reportedBackgroundMessageIds: this.reportedBackgroundMessageIds,
          reportUnknown: this.host.reportUnknown,
        }),
      )
      .catch(() => undefined)
      .finally(() => {
        this.postCutoffBgQueuedCount = Math.max(0, this.postCutoffBgQueuedCount - 1)
        this.postCutoffBgQueuedBytes = Math.max(0, this.postCutoffBgQueuedBytes - recordBytes)
        if (!this.retainedCleaned) {
          this.host.getPostCutoffBgReservation()?.resize(this.postCutoffBgQueuedBytes)
        }
        this.maybeFinishRetainedBackground(activeRun)
      })
  }

  private maybeFinishRetainedBackground(activeRun: ActiveAgyRun): void {
    if (!this.retainedCleanup || this.retainedSettling || this.retainedCleaned) return
    if (!this.host.isRootTerminal() || activeRun.activeBackgroundTasks.size > 0) return
    // Wait until EVERY already-admitted background report AND file recording has drained before revoking
    // ownership, reporting settled, or releasing postCutoffBgMemoryReservation!
    if (this.hasPendingWork()) return
    this.closeRetainedBackground({ reason: 'tasks_drained' })
  }

  closeRetainedBackground(options: {
    readonly reason: 'tasks_drained' | 'transport_closed' | 'disposed'
    readonly emergency?: boolean | undefined
  }): void {
    if (this.retainedSettling || this.retainedCleaned) return
    this.retainedSettling = true
    this.admittingBackground = false
    this.unsubscribe()
    const activeRun = this.host.getActiveRun()

    const finalize = (): void => {
      if (this.retainedCleaned) return
      this.retainedCleaned = true
      if (this.pendingPreTerminalEntries.length > 0) {
        this.pendingPreTerminalEntries.length = 0
        this.postCutoffBgQueuedCount = 0
        this.postCutoffBgQueuedBytes = 0
      }
      if (activeRun && this.host.isRootTerminal()) {
        // B-F7: Settle strictly from final facts AFTER both background reports AND file recordings
        // have drained, regardless of whether tasks_drained, transport_closed, or disposal triggered teardown.
        if (
          activeRun.activeBackgroundTasks.size === 0 &&
          !activeRun.backgroundUnconfirmed &&
          !this.host.hasPendingRecordings?.() &&
          this.host.canSettleEffects()
        ) {
          this.host.reportSettled()
        } else if (
          activeRun.activeBackgroundTasks.size > 0 ||
          activeRun.backgroundUnconfirmed ||
          this.host.hasPendingRecordings?.()
        ) {
          this.host.reportUnknown(
            options.reason === 'transport_closed'
              ? 'Antigravity ACP connection closed before background tasks settled.'
              : 'Antigravity background observation ended before tasks could be confirmed.',
          )
        }
      }
      const cleanup = this.retainedCleanup
      this.retainedCleanup = undefined
      cleanup?.()
    }

    if (options.emergency) {
      finalize()
      return
    }
    const waitTasks: Promise<unknown>[] = [this.postCutoffBackgroundTail]
    if (this.host.awaitRecordings) {
      waitTasks.push(this.host.awaitRecordings().catch(() => undefined))
    }
    void Promise.allSettled(waitTasks).finally(finalize)
  }

  /**
   * Zero-gap handoff from `orderedStream` to `subscribeBackground` when retaining background tasks:
   * 1. Arm `subscribeBackground` and connection close observer FIRST.
   * 2. Synchronously drain all buffered post-cutoff frames from `sessionStream.shift()`.
   * 3. Close `sessionStream`.
   */
  handoffOrderedStreamToBackground(params: {
    connection: AgyAcpConnection
    sessionStream: AgyOrderedSessionStream | undefined
    promptCutoffSeq: number | undefined
    routePostCutoffIngress: (item: AgyIngress) => void
    onStreamClosed: () => void
    onRetainedCleanup?: (() => void) | undefined
  }): void {
    const activeRun = this.host.getActiveRun()
    const resolvedSessionId = this.host.getResolvedSessionId()
    if (!activeRun || !resolvedSessionId || this.unsubscribeBackground) return
    const trackedRun = activeRun
    const trackedSessionId = resolvedSessionId
    if (params.onRetainedCleanup) {
      this.retainedCleanup = params.onRetainedCleanup
    }
    this.unsubscribeBackground = params.connection.subscribeBackground((message) => {
      if (!this.admittingBackground) return false
      if (asString(Reflect.get(message, 'method')) !== 'session/update') return false
      const msgParams = Reflect.get(message, 'params')
      if (!isPlainObject(msgParams)) return false
      const sid = asString(msgParams.sessionId ?? msgParams.session_id)
      if (sid !== trackedSessionId) return false
      const update = msgParams.update
      if (!isPlainObject(update)) return false
      const sessionUpdate = asString(update.sessionUpdate)
      if (!sessionUpdate || !AGY_BACKGROUND_OBSERVER_UPDATES.has(sessionUpdate)) return false

      const ownership = validateBackgroundUpdateForRun(
        msgParams,
        update,
        trackedRun,
        this.host.mcpServer.pinnedTrajectory,
        this.host.mcpServer.minStepIdx,
      )
      if (!ownership.valid) return false

      let hasCompetingSessionOwner = params.connection.hasActiveSessionConsumer(trackedSessionId)
      const otherRunReplayingHistory =
        (this.host.runtime.replayingSessions.get(trackedSessionId) ?? 0) > 0
      for (const other of this.host.runtime.activeRuns.values()) {
        if (other === trackedRun || other.nativeSessionId !== trackedSessionId) continue
        if (
          !other.rootTerminal ||
          other.activeBackgroundTasks.size > 0 ||
          other.backgroundUnconfirmed
        ) {
          hasCompetingSessionOwner = true
        }
      }
      if (hasCompetingSessionOwner) {
        const rawOutput = isPlainObject(update.rawOutput) ? update.rawOutput : undefined
        const rawArgs = isPlainObject(update.args)
          ? update.args
          : isPlainObject(update.rawInput)
            ? update.rawInput
            : undefined
        const toolName = asString(update.name ?? update.toolName)
        const eventTaskId = asString(update.taskId ?? update.backgroundTaskId)
        const launchTaskId = rawOutput
          ? asString(rawOutput.taskId ?? rawOutput.backgroundTaskId)
          : undefined
        const taskId = eventTaskId ?? launchTaskId
        const isDaemonLaunchMetadata =
          launchTaskId !== undefined ||
          (toolName === 'run_command' && rawArgs?.IsDaemon === true) ||
          toolName === 'schedule'
        const toolCallId = asString(update.toolCallId ?? update.id)
        // Do not intercept another Run's session/load replay of this Run's already-completed launch call,
        // UNLESS it carries a delayed new rawOutput.taskId alias for an active task (B-F9).
        if (
          sessionUpdate === 'tool_call_update' &&
          update.outOfTurn !== true &&
          toolCallId !== undefined &&
          trackedRun.launchedCompletedToolCallIds.has(toolCallId) &&
          (otherRunReplayingHistory ||
            (isDaemonLaunchMetadata &&
              !(
                launchTaskId !== undefined &&
                trackedRun.backgroundTaskAliases.has(toolCallId) &&
                !trackedRun.backgroundTaskAliases.has(launchTaskId)
              )))
        ) {
          return false
        }
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
        if (!explicitlyOwnedByOldRun) return false
      }
      this.enqueuePostCutoffBackgroundUpdate(msgParams, update, ownership, otherRunReplayingHistory)
      return true
    })

    if (params.sessionStream) {
      while (true) {
        const buffered = params.sessionStream.shift()
        if (!buffered) break
        if (params.promptCutoffSeq !== undefined && buffered.seq <= params.promptCutoffSeq) {
          continue
        }
        params.routePostCutoffIngress(buffered)
      }
      params.sessionStream.close()
      params.onStreamClosed()
    }

    this.unsubscribeConnectionClose = params.connection.onClose(() => {
      this.closeRetainedBackground({ reason: 'transport_closed' })
    })
    this.maybeFinishRetainedBackground(trackedRun)
  }

  awaitTail(): Promise<void> {
    return this.postCutoffBackgroundTail
  }

  unsubscribe(): void {
    this.unsubscribeBackground?.()
    this.unsubscribeBackground = undefined
    this.unsubscribeConnectionClose?.()
    this.unsubscribeConnectionClose = undefined
  }
}
