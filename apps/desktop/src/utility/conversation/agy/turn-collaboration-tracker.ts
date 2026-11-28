import type { AgentRunInput } from '@pact/agent-runtime'
import type {
  CollaborationInputObservation,
  CollaborationReviewObservation,
  NormalizedAgentEvent,
} from '@pact/contracts'

import { buildBoundedNativePlanId } from '@pact/contracts'

import type { NativeMemoryReservation } from '../native-working-memory'
import type { AgyAdapterRuntime } from './adapter-runtime'
import type { AgyRunMcpServer } from './peer-mcp-server'
import type { ActiveAgyRun } from './types'

import { mergeWorkflowInput, mergeWorkflowReview } from '../collaboration-answer'
import { computeRetainedPlanTextBytes } from './frame-validator'

export interface AgyTurnCollaborationTrackerOptions {
  readonly input: AgentRunInput
  readonly planModeStage: boolean
  readonly authorization: AgentRunInput['promptEnvelope']['collaborationAuthorization']
}

/**
 * Owns Antigravity per-Turn collaboration state: Phase-1 brain plan capture &
 * overlap readback latch, open-plan publish memory tracking, review/input
 * verdicts, negative plan unavailability recording, and post-settlement
 * artifact promotion (`B6`).
 */
export class AgyTurnCollaborationTracker {
  readonly approvedBrainPlanCalls = new Map<
    string,
    { readonly toolName: string; readonly args: Record<string, unknown> }
  >()

  private brainPlanTouched = false
  private readonly activeBrainPlanOpCallIds = new Set<string>()
  private latestBrainPlanCandidate: { nativeId: string; text: string } | undefined
  private brainPlanReadbackRequired = false
  private brainPlanCaptureFailed = false
  private reviewResult: CollaborationReviewObservation | undefined
  private inputResult: CollaborationInputObservation | undefined
  private planRetained = false
  private publishedOpenPlan: { nativeId: string; text: string } | undefined
  private openPlanPublishFailed = false
  private openPlanUnavailableRecorded = false

  constructor(private readonly options: AgyTurnCollaborationTrackerOptions) {}

  hasUnresolvedBrainPlanWrite(): boolean {
    return this.activeBrainPlanOpCallIds.size > 0
  }

  isPlanRetentionCurrent(): boolean {
    return !this.brainPlanTouched && !this.hasUnresolvedBrainPlanWrite()
  }

  onBrainPlanWriteApproved(toolCallId: string): void {
    this.brainPlanTouched = true
    if (this.activeBrainPlanOpCallIds.size < 64) {
      this.activeBrainPlanOpCallIds.add(toolCallId)
    }
  }

  clearApprovedCalls(): void {
    this.approvedBrainPlanCalls.clear()
  }

  projectorCallbacks(params: {
    readonly mcpServer: AgyRunMcpServer
    readonly getPublishedPlanReservation: () => NativeMemoryReservation | undefined
  }) {
    const { input } = this.options
    return {
      onBrainPlanTouched: () => {
        this.brainPlanTouched = true
      },
      onBrainPlanOpStarted: (callId: string) => {
        // Invalidate any prior Plan candidate as soon as a subsequent Plan mutation begins so
        // deferred readback or the newer body is always obtained before publication.
        this.latestBrainPlanCandidate = undefined
        const hasOtherActivePlanOp =
          this.activeBrainPlanOpCallIds.size > (this.activeBrainPlanOpCallIds.has(callId) ? 1 : 0)
        if (hasOtherActivePlanOp) {
          // Overlapping Phase-1 Plan ops MUST verify final disk body via storage readback.
          this.brainPlanReadbackRequired = true
        }
        this.activeBrainPlanOpCallIds.add(callId)
      },
      onBrainPlanDeferredReadback: (callId: string) => {
        this.activeBrainPlanOpCallIds.delete(callId)
        this.latestBrainPlanCandidate = undefined
        this.brainPlanReadbackRequired = true
      },
      onBrainPlanCaptured: (callId: string, candidate: { nativeId: string; text: string }) => {
        this.activeBrainPlanOpCallIds.delete(callId)
        if (this.activeBrainPlanOpCallIds.size === 0 && !this.brainPlanReadbackRequired) {
          this.latestBrainPlanCandidate = candidate
          this.brainPlanCaptureFailed = false
          input.host?.workflow?.recordPlan?.(candidate)
        } else {
          // Another concurrent Plan op was in flight or readback was already latched; defer to verified storage readback.
          this.brainPlanReadbackRequired = true
          this.latestBrainPlanCandidate = undefined
        }
      },
      onBrainPlanCaptureFailed: (callId?: string) => {
        if (callId !== undefined) this.activeBrainPlanOpCallIds.delete(callId)
        this.brainPlanCaptureFailed = true
        this.latestBrainPlanCandidate = undefined
        input.host?.workflow?.recordPlanUnavailable?.()
      },
      onReviewAccepted: (obs: CollaborationReviewObservation) => {
        this.reviewResult = mergeWorkflowReview(this.reviewResult, obs)
        input.host?.workflow?.recordReview?.(this.reviewResult)
      },
      onInputResultAccepted: (obs: CollaborationInputObservation) => {
        this.inputResult = mergeWorkflowInput(this.inputResult, obs)
        input.host?.workflow?.recordInputResult?.(this.inputResult)
      },
      onPlanRetainedAccepted: () => {
        if (this.isPlanRetentionCurrent()) {
          this.planRetained = true
        }
      },
      onOpenPlanPublished: (plan: { nativeId: string; text: string }) => {
        try {
          params
            .getPublishedPlanReservation()
            ?.resize(computeRetainedPlanTextBytes(plan.text) + plan.nativeId.length * 2)
          this.publishedOpenPlan = plan
          this.openPlanPublishFailed = false
          this.openPlanUnavailableRecorded = false
          input.host?.workflow?.recordPlan?.(plan)
        } catch {
          this.openPlanPublishFailed = true
          this.publishedOpenPlan = undefined
          if (!this.openPlanUnavailableRecorded) {
            this.openPlanUnavailableRecorded = true
            input.host?.workflow?.recordPlanUnavailable?.()
          }
        } finally {
          params.mcpServer.clearPendingTransferredPlanBytes()
        }
      },
      onOpenPlanPublishFailed: () => {
        this.openPlanPublishFailed = true
        this.publishedOpenPlan = undefined
        if (!this.openPlanUnavailableRecorded) {
          this.openPlanUnavailableRecorded = true
          input.host?.workflow?.recordPlanUnavailable?.()
        }
      },
    }
  }

  /**
   * If a brain plan write was touched and did not capture inline (or readback was latched due to
   * overlapping ops / deferred edit readback), inspect through the isolated storage client
   * (NEVER direct Utility `fs.open`!) for the SAME execution.
   */
  async readbackBrainPlanIfNeeded(params: {
    readonly runtime: AgyAdapterRuntime
    readonly canonicalCwd: string
    readonly resolvedSessionId: string
    readonly activeRun: ActiveAgyRun
    readonly signal: AbortSignal
  }): Promise<void> {
    if (
      !this.options.planModeStage ||
      (this.latestBrainPlanCandidate !== undefined && !this.brainPlanReadbackRequired) ||
      this.brainPlanCaptureFailed ||
      !this.brainPlanTouched ||
      this.hasUnresolvedBrainPlanWrite()
    ) {
      return
    }
    const { runtime, canonicalCwd, resolvedSessionId, activeRun, signal } = params
    const inspected = runtime.options.storageClient?.inspectRun
      ? await runtime.options.storageClient
          .inspectRun(
            {
              appDataDir: runtime.primaryAppDataDir,
              cwd: canonicalCwd,
              nativeSessionId: resolvedSessionId,
              nativeTurnId: activeRun.providerExecutionId ?? activeRun.nativeTurnId,
              includePlan: true,
            },
            signal,
          )
          .catch(() => undefined)
      : await runtime
          .getOwnedForkFiles()
          .inspectAgyRun(
            {
              cwd: canonicalCwd,
              storageRoot: runtime.primaryAppDataDir,
              nativeSessionId: resolvedSessionId,
              nativeTurnId: activeRun.providerExecutionId ?? activeRun.nativeTurnId,
              includePlan: true,
            },
            signal,
          )
          .catch(() => undefined)
    const terminal = inspected?.exists ? inspected.terminalState : undefined
    const matchesExecution =
      terminal !== undefined &&
      !terminal.planUnavailable &&
      (activeRun.providerExecutionId === undefined ||
        terminal.executionId === activeRun.providerExecutionId)
    if (matchesExecution && terminal.plan?.text.trim()) {
      this.latestBrainPlanCandidate = {
        nativeId:
          terminal.plan.nativeId ||
          buildBoundedNativePlanId(resolvedSessionId, 'implementation_plan'),
        text: terminal.plan.text,
      }
      this.brainPlanReadbackRequired = false
      this.options.input.host?.workflow?.recordPlan?.(this.latestBrainPlanCandidate)
    } else {
      this.brainPlanCaptureFailed = true
      this.latestBrainPlanCandidate = undefined
      this.options.input.host?.workflow?.recordPlanUnavailable?.()
    }
  }

  getTerminalOutputArtifacts(): {
    readonly settledPlan: { nativeId: string; text: string } | undefined
    readonly reviewResult: CollaborationReviewObservation | undefined
    readonly inputResult: CollaborationInputObservation | undefined
  } {
    return {
      settledPlan: this.latestBrainPlanCandidate ?? this.publishedOpenPlan,
      reviewResult: this.reviewResult,
      inputResult: this.inputResult,
    }
  }

  /**
   * Record negative plan unavailability OUTSIDE `!unknownEffectsReported` so recovery is never
   * suppressed when an open-mode final `publish_plan` was acknowledged without confirmed ACP promotion
   * or when a Phase-1 brain plan write failed.
   */
  recordPlanUnavailabilityIfNeeded(params: {
    readonly outcome: 'completed' | 'interrupted' | 'failed'
    readonly mcpServer: AgyRunMcpServer
  }): void {
    if (params.outcome !== 'completed') return
    const { input, planModeStage } = this.options
    if (planModeStage) {
      if (
        this.hasUnresolvedBrainPlanWrite() ||
        this.brainPlanCaptureFailed ||
        this.brainPlanReadbackRequired
      ) {
        input.host?.workflow?.recordPlanUnavailable?.()
      }
    } else if (
      this.openPlanPublishFailed ||
      (params.mcpServer.hasAcknowledgedFinalOpenPlan && !this.publishedOpenPlan)
    ) {
      if (!this.openPlanUnavailableRecorded) {
        this.openPlanUnavailableRecorded = true
        input.host?.workflow?.recordPlanUnavailable?.()
      }
    }
  }

  /**
   * Promote collaboration artifacts ONLY after normal root completion & settlement (`B6`).
   */
  promoteArtifactsIfEligible(params: {
    readonly outcome: 'completed' | 'interrupted' | 'failed'
    readonly unknownReported: boolean
    readonly incompleteVisiblePrefix: boolean
    readonly resolvedSessionId: string
    readonly mcpServer: AgyRunMcpServer
  }): NormalizedAgentEvent[] {
    if (
      params.outcome !== 'completed' ||
      params.unknownReported ||
      params.incompleteVisiblePrefix
    ) {
      return []
    }
    const { authorization, input, planModeStage } = this.options
    const events: NormalizedAgentEvent[] = []
    if (planModeStage) {
      if (
        !this.hasUnresolvedBrainPlanWrite() &&
        !this.brainPlanCaptureFailed &&
        !this.brainPlanReadbackRequired
      ) {
        if (this.latestBrainPlanCandidate) {
          events.push({
            agentId: 'agy',
            type: 'collaboration.plan',
            turnId: input.runId,
            nativeId: this.latestBrainPlanCandidate.nativeId,
            text: this.latestBrainPlanCandidate.text,
          })
        } else if (this.planRetained && authorization?.planReference) {
          const planDoc = authorization.planReference.document
          input.host?.workflow?.recordPlanRetained?.({
            nativeId: buildBoundedNativePlanId(params.resolvedSessionId, 'retained'),
            sha256: planDoc.sha256,
            bytes: planDoc.bytes,
            chars: planDoc.chars,
            confirmation: 'native_root_settled_v1',
          })
        }
      }
    } else if (
      !this.openPlanPublishFailed &&
      !(params.mcpServer.hasAcknowledgedFinalOpenPlan && !this.publishedOpenPlan) &&
      this.publishedOpenPlan
    ) {
      events.push({
        agentId: 'agy',
        type: 'collaboration.plan',
        turnId: input.runId,
        nativeId: this.publishedOpenPlan.nativeId,
        text: this.publishedOpenPlan.text,
      })
    }
    if (this.reviewResult) {
      events.push({
        agentId: 'agy',
        type: 'collaboration.review',
        turnId: input.runId,
        verdict: this.reviewResult.verdict,
        ...(this.reviewResult.questions ? { questions: this.reviewResult.questions } : {}),
      })
    }
    return events
  }
}
