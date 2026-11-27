import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

import type { AgentRunInput } from '@pact/agent-runtime'
import type {
  CollaborationInputObservation,
  CollaborationReviewObservation,
  NativeUserInputRequest,
  NormalizedAgentEvent,
  SessionPermissionMode,
} from '@pact/contracts'

import {
  COLLABORATION_PUBLISHED_PLAN_MAX_BYTES,
  NATIVE_PERMISSION_REQUESTS,
  buildBoundedNativePlanId,
  nativeBackgroundReportIdentitySchema,
  sessionTitleInputSchema,
} from '@pact/contracts'

import type { AgentAnswerAssembler } from '../agent-answer-assembler'
import type { AgyAcpConnection } from '../agy-acp-connection'
import type { NativeMemoryReservation } from '../native-working-memory'
import type { AgyAdapterRuntime } from './adapter-runtime'
import type { AgyRunMcpServer } from './peer-mcp-server'

import { recordDiagnostic } from '../../../diagnostics/utility-log'
import { AgentActivityDetail } from '../agent-activity-detail'
import { AgentExecutionError, classifyAgentError } from '../agent-execution-error'
import { AGY_PROMPT_ACCEPT_TIMEOUT_MS } from '../agy-acp-connection'
import {
  AgyRoundEffectsTracker,
  collectAgyTargetPaths,
  nativeEffectsUncertain,
  type NativeChanges,
} from '../native-file-changes'
import { NativePermissionWait } from '../native-permission-wait'
import {
  hasValidArtifactMetadata,
  isMarkdownBrainPlanArtifact,
  isVerifiedDirectBrainPlanWriteTarget,
  mergePlainArgsRecords,
  type AcpToolCallAdmissionResult,
  type CompactPostCutoffBackgroundRecord,
} from './frame-validator'
import {
  agyElicitationRequest,
  buildAgyPermissionCard,
  findAllowOnceOptionId,
  findRejectOnceOptionId,
} from './permission-and-elicitation'
import {
  AGY_MAX_REASONING_BYTES,
  AGY_MAX_REASONING_ITEMS,
  AGY_MAX_TOOL_STATES,
  asString,
  deterministicUuid,
  estimateJsonPayloadBytes,
  isEligibleAgyBackgroundReportId,
  isPlainObject,
  type ActiveAgyRun,
  type AgySteerConsumptionReceipt,
  type AgySteerEntry,
  type AgyToolState,
  type ValidatedAgyFrame,
} from './types'

/**
 * Deep notification, permission/elicitation, steer-receipt verification, and
 * post-cutoff background-update projector for Antigravity ACP Runs.
 */
export class AgyNotificationProjector {
  constructor(private readonly runtime: AgyAdapterRuntime) {}

  async handlePermissionRequest(context: {
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
          this.runtime.appDataDirs,
          activeRun.nativeSessionId,
        ) &&
        collected.complete &&
        !collected.hasMoveTarget &&
        collected.paths.length > 0 &&
        collected.paths.every((target) =>
          isVerifiedDirectBrainPlanWriteTarget(
            target,
            cwd,
            this.runtime.appDataDirs,
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
    if (
      !input.host?.interactions?.requestPermission ||
      getActiveCount() >= NATIVE_PERMISSION_REQUESTS
    ) {
      await denyPermission()
      return
    }

    const fenceEpoch = activeRun?.turnEpoch
    const fenceExecutor = activeRun?.executorId
    const fenceGen = activeRun?.bindingGeneration
    const isFenceCurrent = (): boolean =>
      !this.runtime.disposed &&
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
      const permWork = input.host?.interactions?.requestPermission?.(card.request, combinedSignal)
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

  async handleElicitationRequest(context: {
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

    if (!input.host?.interactions?.requestUserInput || askOnlyStage || readOnlyNonInteractive) {
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
      !this.runtime.disposed &&
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
      const userWork = input.host?.interactions?.requestUserInput?.(uiRequest, combinedSignal)
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

  *projectSessionNotification(context: {
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
    onAcceptTurn: () => void
    canAdmitForegroundDelta: () => boolean
    onForegroundDeltaDropped?: () => void
    reportUnknown: (reason: string) => void
    observeFiles: (evidence: NativeChanges) => void
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
          input.host?.lifecycle?.observeNativeTitle?.(activeRun.nativeSessionId, title)
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
        this.runtime.skillCatalogListener?.()
        return
      }

      if (sessionUpdate === 'current_mode_update') {
        const nextMode = asString(update.currentModeId ?? update.modeId)
        if (nextMode) {
          const modeState = this.runtime.sessionModes.get(activeRun.nativeSessionId)
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
                input.host?.lifecycle?.recordInputConsumption?.(steerId, {
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

      // First substantive model/tool activity confirms Turn acceptance via the session FSM.
      if (!activeRun.turnAccepted) {
        context.onAcceptTurn()
        this.runtime.recordEvidence(
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
        if (!context.canAdmitForegroundDelta()) return
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
        if (!context.canAdmitForegroundDelta()) {
          context.onForegroundDeltaDropped?.()
          return
        }
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
              this.runtime.appDataDirs,
              activeRun.nativeSessionId,
            )
          const anyDiffIsBrainPlan = diffBlocks.some((d) => {
            const dp = asString(d.path)
            return (
              dp !== undefined &&
              isMarkdownBrainPlanArtifact(
                dp,
                context.cwd,
                this.runtime.appDataDirs,
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
              const anyAppDataExistsOnDisk = this.runtime.appDataDirs.some((dir) => {
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
                    this.runtime.appDataDirs,
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

  bindRootExecutionId(activeRun: ActiveAgyRun, input: AgentRunInput, executionId: string): void {
    if (!executionId || activeRun.providerExecutionId) return
    activeRun.providerExecutionId = executionId
    for (const [steerId, entry] of activeRun.steeredInputs) {
      if (!entry.consumed && this.tryPromoteStagedSteerCandidate(activeRun, steerId, entry)) {
        input.host?.lifecycle?.recordInputConsumption?.(steerId, {
          nativeSessionId: activeRun.nativeSessionId,
          nativeTurnId: activeRun.nativeTurnId,
          executorId: activeRun.executorId,
        })
      }
    }
    this.notifyRootExecutionWaiters(activeRun)
  }

  notifyRootExecutionWaiters(activeRun: ActiveAgyRun): void {
    for (const notify of activeRun.rootExecutionWaiters) {
      notify()
    }
    activeRun.rootExecutionWaiters.clear()
  }

  async waitForRootExecutionBinding(activeRun: ActiveAgyRun, signal: AbortSignal): Promise<void> {
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

  isValidSteerStepOrder(
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

  tryPromoteStagedSteerCandidate(
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

  async verifySteerReceiptsBeforeRootRelease(
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
          input.host?.lifecycle?.recordInputConsumption?.(inputId, {
            nativeSessionId: activeRun.nativeSessionId,
            nativeTurnId: activeRun.nativeTurnId,
            executorId: activeRun.executorId,
          })
        }
      }
      if (!entry.consumed && this.runtime.options.storageClient?.verifySteerConsumption) {
        // oxlint-disable-next-line no-await-in-loop -- Bounded in-Turn steer verification before root release.
        const receipt = await this.runtime.options.storageClient
          .verifySteerConsumption(
            {
              appDataDir: this.runtime.primaryAppDataDir,
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
            input.host?.lifecycle?.recordInputConsumption?.(inputId, {
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

  trackBackgroundTaskLaunch(
    activeRun: ActiveAgyRun,
    input: Pick<AgentRunInput, 'host'>,
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
          input.host?.effects?.backgroundWorkChanged?.()
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
    if (status === 'completed' && activeRun.launchedCompletedToolCallIds.size < 256) {
      activeRun.launchedCompletedToolCallIds.add(toolCallId)
    }
    if (changed) {
      input.host?.effects?.backgroundWorkChanged?.()
    }
  }

  settleBackgroundTaskByAlias(
    activeRun: ActiveAgyRun,
    input: Pick<AgentRunInput, 'host'>,
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
      input.host?.effects?.backgroundWorkChanged?.()
    }
    return removed
  }

  async handlePostTurnBackgroundUpdate(context: {
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
      if (observedBackgroundTask && input.host?.effects?.recordBackgroundReport) {
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
                input.host?.effects?.recordBackgroundReportUnavailable?.(identity)
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
                  await input.host?.effects?.recordBackgroundReport?.({
                    ...identity,
                    text: rawText,
                  })
                } catch (error) {
                  if (input.host?.effects?.recordBackgroundReportUnavailable) {
                    input.host?.effects?.recordBackgroundReportUnavailable(identity)
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
      // Settle tracked background task completion states; AgyTurnBackgroundObserver drains
      // any queued reports before reporting settled and releasing observer ownership/lease.
      // Never let a non-out-of-turn replay of a completed background-task launch call settle
      // the still-running background task (e.g., when another Run runs session/load).
      const isReplayOfCompletedLaunchCall =
        sessionUpdate === 'tool_call_update' &&
        toolCallId !== undefined &&
        activeRun.launchedCompletedToolCallIds.has(toolCallId) &&
        !record.outOfTurn
      const isTerminalTaskUpdate =
        sessionUpdate === 'background_task_completed' ||
        (sessionUpdate === 'tool_call_update' &&
          !isReplayOfCompletedLaunchCall &&
          (status === 'completed' || status === 'failed' || status === 'cancelled'))
      if (isTerminalTaskUpdate) {
        this.settleBackgroundTaskByAlias(activeRun, input, [taskId, toolCallId])
      }
    }
  }
}
