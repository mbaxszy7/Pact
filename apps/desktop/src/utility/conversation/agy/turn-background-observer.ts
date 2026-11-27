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

export interface AgyTurnBackgroundObserverHost {
  readonly runtime: AgyAdapterRuntime
  readonly input: AgentRunInput
  readonly mcpServer: AgyRunMcpServer
  readonly getActiveRun: () => ActiveAgyRun | undefined
  readonly getResolvedSessionId: () => string | undefined
  readonly canSettleEffects: () => boolean
  readonly isRootTerminal: () => boolean
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
  private unsubscribeBackground: (() => void) | undefined

  constructor(private readonly host: AgyTurnBackgroundObserverHost) {}

  markObservedBackgroundTask(): void {
    this.observedBackgroundTaskFlag = true
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

  enqueuePostCutoffBackgroundUpdate(
    params: Record<string, unknown>,
    update: Record<string, unknown>,
    preValidatedOwnership?: ValidatedBackgroundOwnership,
  ): void {
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
    this.postCutoffBgQueuedCount += 1
    this.postCutoffBgQueuedBytes = nextBytes
    this.postCutoffBackgroundTail = this.postCutoffBackgroundTail
      .then(() =>
        this.host.runtime.projector.handlePostTurnBackgroundUpdate({
          record,
          input: this.host.input,
          activeRun,
          observedBackgroundTask: this.observedBackgroundTaskFlag,
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
        this.host.getPostCutoffBgReservation()?.resize(this.postCutoffBgQueuedBytes)
      })
  }

  /**
   * Zero-gap handoff from `orderedStream` to `subscribeBackground` when retaining background tasks:
   * 1. Arm `subscribeBackground` FIRST (so no subsequent stdout frame can slip through).
   * 2. Synchronously drain all buffered post-cutoff frames from `sessionStream.shift()`.
   * 3. Close `sessionStream`.
   */
  handoffOrderedStreamToBackground(params: {
    connection: AgyAcpConnection
    sessionStream: AgyOrderedSessionStream | undefined
    promptCutoffSeq: number | undefined
    routePostCutoffIngress: (item: AgyIngress) => void
    onStreamClosed: () => void
  }): void {
    const activeRun = this.host.getActiveRun()
    const resolvedSessionId = this.host.getResolvedSessionId()
    if (!activeRun || !resolvedSessionId || this.unsubscribeBackground) return
    const trackedRun = activeRun
    const trackedSessionId = resolvedSessionId
    this.unsubscribeBackground = params.connection.subscribeBackground((message) => {
      if (asString(Reflect.get(message, 'method')) !== 'session/update') return false
      const msgParams = Reflect.get(message, 'params')
      if (!isPlainObject(msgParams)) return false
      const sid = asString(msgParams.sessionId ?? msgParams.session_id)
      if (sid !== trackedSessionId) return false
      const update = msgParams.update
      if (!isPlainObject(update)) return false

      const ownership = validateBackgroundUpdateForRun(
        msgParams,
        update,
        trackedRun,
        this.host.mcpServer.pinnedTrajectory,
        this.host.mcpServer.minStepIdx,
      )
      if (!ownership.valid) return false

      let hasNewerActiveRun = false
      for (const other of this.host.runtime.activeRuns.values()) {
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
        if (!explicitlyOwnedByOldRun) return false
      }
      this.enqueuePostCutoffBackgroundUpdate(msgParams, update, ownership)
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
  }

  awaitTail(): Promise<void> {
    return this.postCutoffBackgroundTail
  }

  unsubscribe(): void {
    this.unsubscribeBackground?.()
    this.unsubscribeBackground = undefined
  }
}
