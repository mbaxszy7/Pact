import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk'

import type { AgentRunInput } from '@pact/agent-runtime'
import type {
  CollaborationRetainedPlan,
  CollaborationTask,
  CollaborationTurnAuthorization,
} from '@pact/contracts'
import type { DiagnosticEvent } from '@pact/contracts/diagnostics'

import {
  collaborationInputOutcomeAllowed,
  collaborationPlanRetentionInputSchema,
} from '@pact/contracts'

import type { NativePermissionWait } from '../native-permission-wait'
import type { NativeWorkingMemory, NativeMemoryReservation } from '../native-working-memory'
import type {
  ClaudeAdapterRuntime,
  PlanCaptureFailure,
  PlanCaptureFailureCode,
  PlanSubmissionRejection,
} from './types'

import { recordDiagnostic } from '../../../diagnostics/utility-log'
import {
  classifyAgentError,
  NativeCapacityError,
  AgentExecutionError,
} from '../agent-execution-error'
import {
  ClaudeNativePlan,
  ClaudePlanPublication,
  claudePlanInputFingerprint,
  claudePlanSubmissionFingerprint,
} from '../claude-native-plan'
import { mergeWorkflowInput, mergeWorkflowReview } from '../collaboration-answer'
import { collaborationToolAllowed } from '../collaboration-prompt'
import {
  anchorNativeFileBeforeEdit,
  claudeFileChanges,
  nativeEffectsUncertain,
  type NativeChanges,
} from '../native-file-changes'
import { isRequestUuid } from './permissions-and-settings'

export interface ClaudePlanCaptureHost {
  readonly runtime: ClaudeAdapterRuntime
  readonly input: AgentRunInput
  readonly resolvedSessionId: string
  readonly workflow: CollaborationTask | undefined
  readonly authorization: CollaborationTurnAuthorization | undefined
  readonly nativePlanning: boolean
  readonly nativeRetention: boolean
  readonly nativeOpenPlanPublish: boolean
  readonly nativeReview: boolean
  readonly nativeInputResult: boolean
  readonly readOnlyStage: boolean
  readonly peerServerName: string
  readonly titleToolName: string
  readonly peerToolName: string
  readonly reviewToolName: string
  readonly inputResultToolName: string
  readonly retentionToolName: string
  readonly publishPlanToolName: string
  readonly queryMemory: NativeWorkingMemory
  readonly permissionWait: NativePermissionWait
  readonly signal: AbortSignal
  readonly observationSignal: AbortSignal
  readonly isTerminalOrReleased: () => boolean
  readonly getProjectionFailure: () => AgentExecutionError | undefined
  readonly setProjectionFailure: (failure: AgentExecutionError) => void
  readonly failProjection: (error: unknown, deferForegroundFailure?: boolean) => void
  readonly observeFiles: (evidence: NativeChanges) => Promise<void>
}

export interface ClaudeRetentionCallState {
  promptId?: string
  observed: boolean
  succeeded: boolean
  invalid: boolean
  preObserved: boolean
  postObserved: boolean
}

export type ClaudeWorkflowCallEntry =
  | { kind: 'review'; value: import('@pact/contracts').CollaborationReviewObservation }
  | { kind: 'input'; value: import('@pact/contracts').CollaborationInputObservation }

/**
 * Deep module owning Claude native plan capture, plan retention authentication,
 * workflow review/input-result correlation, SDK PreToolUse/PostToolUse/PostToolUseFailure hooks,
 * and terminal full-root plan verification on query exit.
 */
export class ClaudePlanCaptureCoordinator {
  readonly planPublication = new ClaudePlanPublication()
  readonly openPlanPublish: {
    chunks: Buffer[]
    byteLength: number
    completedMarkdown?: string
  } = { chunks: [], byteLength: 0 }
  readonly planExitIds = new Set<string>()
  readonly retentionCalls = new Map<string, ClaudeRetentionCallState>()
  readonly workflowCalls = new Map<string, ClaudeWorkflowCallEntry>()
  readonly planCalls = new Set<string>()

  private readonly planMemory: NativeMemoryReservation
  private readonly metadataMemory: NativeMemoryReservation
  private readonly planProofMemory: NativeMemoryReservation
  private readonly planDiagnosticKeys = new Set<string>()

  workflowProjectionFailed = false
  nativePlan: ClaudeNativePlan | undefined
  private planBindingTask: Promise<ClaudeNativePlan | undefined> | undefined
  private planBindingReads = 0
  retentionBlocked = false
  terminalPlanIntent:
    | {
        id: string
        promptId: string
        inputFingerprint: string
        permissionMatched: boolean
        invalid: boolean
      }
    | undefined
  planCaptureFailure: PlanCaptureFailure | undefined
  reviewResult: import('@pact/contracts').CollaborationReviewObservation | undefined
  inputResult: import('@pact/contracts').CollaborationInputObservation | undefined

  constructor(private readonly host: ClaudePlanCaptureHost) {
    this.planMemory = host.queryMemory.reserve(0)
    this.metadataMemory = host.queryMemory.reserve(0)
    this.planProofMemory = host.queryMemory.reserve(0)
  }

  initializeMetadataBudget(): void {
    this.metadataMemory.resize(
      this.host.nativePlanning ||
        this.host.nativeReview ||
        this.host.nativeInputResult ||
        this.host.nativeOpenPlanPublish
        ? 256 * 1024
        : 0,
    )
  }

  invalidateTerminalPlanIntent(): void {
    if (this.terminalPlanIntent) this.terminalPlanIntent.invalid = true
  }

  private retentionMetadataBytes(): number {
    return [...this.retentionCalls].reduce((total, [key, value]) => {
      const encoded = JSON.stringify(value)
      return (
        total +
        Buffer.byteLength(key) +
        key.length * 2 +
        Buffer.byteLength(encoded) +
        encoded.length * 2
      )
    }, 0)
  }

  retentionCall(id: string): ClaudeRetentionCallState {
    if (!id || id.length > 1024) {
      this.workflowProjectionFailed = true
      throw new Error('The native plan retention identity exceeds its bound.')
    }
    const existing = this.retentionCalls.get(id)
    if (existing) return existing
    if (
      this.retentionCalls.size >= 64 ||
      this.retentionMetadataBytes() + Buffer.byteLength(id) + id.length * 2 + 1024 > 64 * 1024
    ) {
      this.workflowProjectionFailed = true
      throw new AgentExecutionError(
        'response_too_large',
        'Native plan retention activity exceeded its bounded owner.',
        false,
      )
    }
    const entry: ClaudeRetentionCallState = {
      observed: false,
      succeeded: false,
      invalid: false,
      preObserved: false,
      postObserved: false,
    }
    this.retentionCalls.set(id, entry)
    return entry
  }

  logPlan(
    planStage: NonNullable<DiagnosticEvent['planStage']>,
    planReason: NonNullable<DiagnosticEvent['planReason']>,
    planCapture?: DiagnosticEvent['planCapture'],
  ): void {
    const key =
      planStage === 'capture'
        ? `${planStage}/${planReason}/${planCapture?.tool ?? ''}/${planCapture?.phase ?? ''}`
        : `${planStage}/${planReason}`
    if (this.planDiagnosticKeys.has(key) || this.planDiagnosticKeys.size >= 64) return
    this.planDiagnosticKeys.add(key)
    recordDiagnostic({
      operation: 'claude_plan',
      scope: 'run',
      phase: ['captured', 'submitted', 'retained'].includes(planReason) ? 'completed' : 'blocked',
      level: ['captured', 'submitted', 'retained'].includes(planReason) ? 'info' : 'warn',
      sessionId: this.host.input.sessionId,
      runId: this.host.input.runId,
      agentId: 'claude',
      planStage,
      planReason,
      ...(planCapture ? { planCapture } : {}),
    })
  }

  private rememberPlanFailure(
    code: PlanCaptureFailureCode,
    hook: { tool_use_id: string; tool_name: string },
    phase: PlanCaptureFailure['phase'],
  ): void {
    this.planCaptureFailure = {
      code,
      ...(typeof hook.tool_use_id === 'string' &&
      hook.tool_use_id.length > 0 &&
      hook.tool_use_id.length <= 1024
        ? { operationId: hook.tool_use_id }
        : {}),
      tool:
        hook.tool_name === 'Write' ? 'Write' : hook.tool_name === 'Edit' ? 'Edit' : 'ExitPlanMode',
      phase,
    }
    this.logPlan('capture', code, { code, tool: this.planCaptureFailure.tool, phase })
  }

  rejectPlanSubmission(reason: PlanSubmissionRejection['reason']): PlanSubmissionRejection {
    const latestCapture = this.planCaptureFailure
      ? {
          code: this.planCaptureFailure.code,
          tool: this.planCaptureFailure.tool,
          phase: this.planCaptureFailure.phase,
        }
      : undefined
    this.logPlan('submission', reason, latestCapture)
    return { reason, ...(latestCapture ? { latestCapture } : {}) }
  }

  rememberWorkflowCall(id: string, entry: ClaudeWorkflowCallEntry): void {
    let bytes = 0
    for (const [key, value] of this.workflowCalls) {
      if (key === id) continue
      const encoded = JSON.stringify(value)
      bytes += Buffer.byteLength(encoded) + encoded.length * 2 + key.length * 2
    }
    const encoded = JSON.stringify(entry)
    bytes += Buffer.byteLength(encoded) + encoded.length * 2 + id.length * 2
    if (bytes > 64 * 1024) {
      this.workflowProjectionFailed = true
      throw new AgentExecutionError(
        'response_too_large',
        'Pending question metadata exceeded its bounded owner.',
        false,
      )
    }
    this.workflowCalls.set(id, entry)
  }

  refreshCachedPlan(): void {
    const known = this.host.runtime.nativeEvidence.get(this.host.input.runId)
    if (known?.kind !== 'ended') return
    const { planUnavailable: _unavailable, ...terminal } = known
    this.host.runtime.nativeEvidence.set(this.host.input.runId, {
      ...terminal,
      ...(this.planPublication.unavailable ? { planUnavailable: true as const } : {}),
      ...(known.output ? { output: this.planPublication.project(known.output) } : {}),
    })
  }

  capturePlan(plan: { nativeId: string; text: string }): void {
    try {
      this.retentionBlocked = true
      this.planMemory.resize(4096 + Buffer.byteLength(plan.text) * 4 + plan.text.length * 2)
      this.host.input.host?.workflow?.recordPlan?.(plan)
      this.planPublication.publish(plan)
      this.refreshCachedPlan()
      this.logPlan('capture', 'captured')
      this.planCaptureFailure = undefined
    } catch (error) {
      this.planPublication.invalidate()
      this.refreshCachedPlan()
      this.workflowProjectionFailed = true
      this.host.failProjection(error)
    }
  }

  captureUnavailable(retentionOnly = false, pending = false): void {
    const invalidatesSubmittedPlan = Boolean(this.planPublication.plan)
    const notify = !this.planPublication.unavailable
    this.planPublication.invalidate(pending)
    this.refreshCachedPlan()
    if (notify) {
      try {
        this.host.input.host?.workflow?.recordPlanUnavailable?.()
      } catch (error) {
        if (!retentionOnly || invalidatesSubmittedPlan) {
          this.workflowProjectionFailed = true
          this.host.failProjection(error)
        }
      }
    }
  }

  blockRetention(): void {
    this.retentionBlocked = true
    for (const call of this.retentionCalls.values()) call.invalid = true
    if (this.retentionCalls.size || this.planPublication.retained) this.captureUnavailable(true)
  }

  invalidateRetentionForQuestion(): void {
    this.retentionBlocked = true
    for (const call of this.retentionCalls.values()) call.invalid = true
    if (this.retentionCalls.size || this.planPublication.retained) this.captureUnavailable(true)
  }

  captureReview(verdict: import('@pact/contracts').CollaborationReviewObservation): void {
    try {
      this.reviewResult = mergeWorkflowReview(this.reviewResult, verdict)
      this.host.input.host?.workflow?.recordReview?.(this.reviewResult)
    } catch (error) {
      this.workflowProjectionFailed = true
      this.host.failProjection(error)
    }
  }

  captureInputResult(outcome: import('@pact/contracts').CollaborationInputObservation): void {
    if (
      !this.host.workflow ||
      !collaborationInputOutcomeAllowed(
        this.host.workflow,
        this.host.authorization,
        outcome.outcome,
      )
    )
      return
    try {
      this.inputResult = mergeWorkflowInput(this.inputResult, outcome)
      this.host.input.host?.workflow?.recordInputResult?.(outcome)
    } catch (error) {
      this.workflowProjectionFailed = true
      this.host.failProjection(error)
    }
  }

  private async nativePlanForHook(
    hook: {
      session_id: string
      prompt_id?: string
      agent_id?: string
      tool_use_id: string
      tool_name: string
      tool_input: unknown
    },
    failed: (code: PlanCaptureFailureCode) => void,
  ): Promise<ClaudeNativePlan | undefined> {
    if (
      this.host.signal.aborted ||
      hook.agent_id ||
      hook.session_id !== this.host.resolvedSessionId
    )
      return undefined
    if (!this.planBindingTask) {
      if (this.planBindingReads >= 64)
        throw new Error('Native plan binding reads exceeded the root budget.')
      this.planBindingReads++
      this.planBindingTask = (async () => {
        const source = await this.host.runtime.nativeForkFiles
          .readAnswer(
            {
              cwd: this.host.input.cwd,
              nativeSessionId: hook.session_id,
              nativeTurnId: this.host.input.runId,
              planHook: {
                id: hook.tool_use_id,
                inputFingerprint: claudePlanInputFingerprint(hook.tool_name, hook.tool_input),
              },
              planCheckpoint: this.host.input.host?.workflow?.getPlanCheckpoint?.(hook.session_id),
            },
            this.host.signal,
          )
          .catch((error: unknown) => {
            const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
            failed(
              code === 'CLAUDE_PLAN_OPERATION_MISSING'
                ? 'history_operation_missing'
                : code === 'CLAUDE_PLAN_OPERATION_DUPLICATE'
                  ? 'history_operation_duplicate'
                  : 'history_lookup_failed',
            )
            throw error
          })
        if (!source.planBinding || !source.planState) {
          failed('history_binding_missing')
          throw new Error('The current native root has no authenticated plan attachment.')
        }
        this.planProofMemory.resize(256 * 1024)
        this.host.signal.throwIfAborted()
        this.nativePlan = ClaudeNativePlan.restore(source.planBinding, source.planState, (bytes) =>
          this.planMemory.resize(bytes),
        )
        return this.nativePlan
      })()
    }
    const reading = this.planBindingTask
    try {
      const artifact = await reading
      if (artifact && artifact.binding.promptId !== hook.prompt_id) failed('hook_prompt_mismatch')
      return artifact?.binding.promptId === hook.prompt_id ? artifact : undefined
    } catch (error) {
      if (this.planBindingTask === reading) this.planBindingTask = undefined
      throw error
    }
  }

  observeRetentionIntent(hook: {
    session_id: string
    prompt_id?: string
    agent_id?: string
    tool_use_id: string
    tool_input: unknown
  }): boolean {
    if (
      !this.host.nativeRetention ||
      this.host.isTerminalOrReleased() ||
      this.host.signal.aborted ||
      this.host.permissionWait.waiting ||
      hook.agent_id ||
      hook.session_id !== this.host.resolvedSessionId ||
      !hook.prompt_id ||
      !isRequestUuid(hook.prompt_id) ||
      !collaborationPlanRetentionInputSchema.safeParse(hook.tool_input).success
    )
      return false
    const call = this.retentionCall(hook.tool_use_id)
    if (call.promptId && call.promptId !== hook.prompt_id) call.invalid = true
    call.promptId ??= hook.prompt_id
    if (call.preObserved) call.invalid = true
    call.preObserved = true
    return !call.invalid && !this.retentionBlocked
  }

  authenticateRetention(hook: {
    session_id: string
    prompt_id?: string
    agent_id?: string
    tool_use_id: string
    tool_name: string
    tool_input: unknown
  }): void {
    const call = this.retentionCalls.get(hook.tool_use_id)
    if (!call) return
    if (
      hook.agent_id ||
      hook.session_id !== this.host.resolvedSessionId ||
      hook.tool_name !== this.host.retentionToolName ||
      !call.preObserved ||
      call.postObserved ||
      !call.promptId ||
      call.promptId !== hook.prompt_id ||
      !collaborationPlanRetentionInputSchema.safeParse(hook.tool_input).success
    ) {
      call.invalid = true
      return
    }
    // Hooks are observations only. The terminal Worker authenticates the persisted whole root.
    call.postObserved = true
  }

  async observePlanHook(
    hook: {
      session_id: string
      prompt_id?: string
      agent_id?: string
      tool_use_id: string
      tool_name: string
      tool_input: unknown
      tool_response?: unknown
    },
    phase: 'begin' | 'success' | 'failure',
  ): Promise<void> {
    let failureRecorded = false
    const failed = (code: PlanCaptureFailureCode): void => {
      failureRecorded = true
      this.rememberPlanFailure(code, hook, phase)
    }
    try {
      if (
        !hook.agent_id &&
        hook.session_id === this.host.resolvedSessionId &&
        ['Write', 'Edit'].includes(hook.tool_name) &&
        (!this.nativePlan ||
          (hook.tool_input &&
            typeof hook.tool_input === 'object' &&
            Reflect.get(hook.tool_input, 'file_path') === this.nativePlan.binding.path))
      )
        this.blockRetention()
      if (this.host.signal.aborted) {
        if (
          !hook.agent_id &&
          hook.session_id === this.host.resolvedSessionId &&
          this.nativePlan &&
          this.nativePlan.binding.promptId === hook.prompt_id &&
          hook.tool_input &&
          typeof hook.tool_input === 'object' &&
          Reflect.get(hook.tool_input, 'file_path') === this.nativePlan.binding.path
        ) {
          this.nativePlan.fail()
          this.captureUnavailable()
        }
        return
      }
      if (
        !hook.prompt_id &&
        !hook.agent_id &&
        hook.session_id === this.host.resolvedSessionId &&
        !this.host.signal.aborted
      ) {
        this.nativePlan?.fail()
        this.captureUnavailable()
        failed('hook_prompt_missing')
        return
      }
      if (phase === 'begin' && !hook.agent_id && hook.session_id === this.host.resolvedSessionId) {
        if (
          hook.tool_name === 'ExitPlanMode' &&
          hook.prompt_id &&
          isRequestUuid(hook.prompt_id) &&
          hook.tool_use_id &&
          hook.tool_use_id.length <= 1024
        ) {
          const inputFingerprint = claudePlanSubmissionFingerprint(hook.tool_input)
          if (!this.terminalPlanIntent) {
            this.planProofMemory.resize(256 * 1024)
            this.terminalPlanIntent = {
              id: hook.tool_use_id,
              promptId: hook.prompt_id,
              inputFingerprint,
              permissionMatched: false,
              invalid: false,
            }
          } else if (
            this.terminalPlanIntent.id !== hook.tool_use_id ||
            this.terminalPlanIntent.promptId !== hook.prompt_id ||
            this.terminalPlanIntent.inputFingerprint !== inputFingerprint
          )
            this.invalidateTerminalPlanIntent()
        } else this.invalidateTerminalPlanIntent()
      }
      const artifact = await this.nativePlanForHook(hook, failed)
      if (!artifact || this.host.signal.aborted) return
      if (hook.tool_name === 'ExitPlanMode') {
        if (
          phase === 'begin' &&
          hook.tool_use_id &&
          hook.tool_use_id.length <= 1024 &&
          this.planExitIds.size < 64
        ) {
          artifact.noteSubmission(hook.tool_use_id, hook.tool_input)
          this.planExitIds.add(hook.tool_use_id)
        }
        if (artifact.unavailable) this.captureUnavailable()
        return
      }
      if (!artifact.begin(hook.tool_name, hook.tool_use_id, hook.tool_input)) {
        if (artifact.unavailable) this.captureUnavailable()
        return
      }
      if (phase === 'begin' && !artifact.isPending(hook.tool_use_id)) {
        if (artifact.unavailable) this.captureUnavailable()
        return
      }
      if (phase === 'begin') this.captureUnavailable(false, true)
      if (phase === 'failure') artifact.reject(hook.tool_use_id)
      else if (phase === 'success')
        artifact.acknowledge(hook.tool_name, hook.tool_use_id, hook.tool_input, hook.tool_response)
      if (this.host.signal.aborted) return
      if (artifact.unavailable) this.captureUnavailable()
      else if (phase === 'success' && artifact.plan) {
        this.capturePlan(artifact.plan)
      }
    } catch (error) {
      if (this.host.signal.aborted) return
      this.captureUnavailable()
      if (!failureRecorded) failed('plan_capture_failed')
      if (error instanceof NativeCapacityError) {
        this.workflowProjectionFailed = true
        this.host.failProjection(error)
      }
    }
  }

  async handlePlanSubmissionPermission(
    id: string,
    toolInput: unknown,
  ): Promise<'submitted' | 'retained' | PlanSubmissionRejection> {
    const intent = this.terminalPlanIntent
    if (intent) {
      try {
        if (
          intent.id !== id ||
          intent.inputFingerprint !== claudePlanSubmissionFingerprint(toolInput)
        )
          this.invalidateTerminalPlanIntent()
        else if (!this.host.signal.aborted && !intent.invalid) intent.permissionMatched = true
      } catch {
        this.invalidateTerminalPlanIntent()
      }
    }
    if (this.host.signal.aborted || intent?.invalid || !this.planExitIds.has(id)) {
      this.captureUnavailable()
      return this.rejectPlanSubmission(
        this.planCaptureFailure?.operationId === id &&
          this.planCaptureFailure.tool === 'ExitPlanMode'
          ? this.planCaptureFailure.code
          : 'submission_hook_unverified',
      )
    }
    const pending = this.nativePlan?.hasPendingOperations
    this.nativePlan?.finish()
    if (this.nativePlan?.plan) {
      this.capturePlan(this.nativePlan.plan)
      this.logPlan('submission', 'submitted')
      return 'submitted'
    }
    const retained = this.nativePlan?.retained(id),
      basis = this.host.authorization?.planReference?.document
    if (
      retained &&
      basis &&
      retained.sha256 === basis.sha256 &&
      retained.bytes === basis.bytes &&
      retained.chars === basis.chars
    ) {
      // Permission denial may acknowledge intent, but only root drain persists it.
      return 'retained'
    }
    this.captureUnavailable()
    return this.rejectPlanSubmission(
      pending
        ? 'plan_pending'
        : this.nativePlan?.unavailable
          ? 'plan_unavailable'
          : retained
            ? 'retained_basis_mismatch'
            : 'plan_missing',
    )
  }

  buildSdkHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const {
      input,
      workflow,
      nativePlanning,
      nativeRetention,
      readOnlyStage,
      peerServerName,
      peerToolName,
      titleToolName,
      reviewToolName,
      inputResultToolName,
      retentionToolName,
      publishPlanToolName,
      resolvedSessionId,
      observationSignal,
    } = this.host

    return {
      PreToolUse: [
        {
          hooks: [
            async (hook) => {
              if (hook.hook_event_name !== 'PreToolUse') return {}
              const anchorWriteOrEdit = async (): Promise<void> => {
                if (hook.tool_name !== 'Write' && hook.tool_name !== 'Edit') return
                const rawPath =
                  hook.tool_input && typeof hook.tool_input === 'object'
                    ? (Reflect.get(hook.tool_input, 'file_path') ??
                      Reflect.get(hook.tool_input, 'path'))
                    : undefined
                if (typeof rawPath === 'string' && rawPath && rawPath.length <= 4096)
                  await anchorNativeFileBeforeEdit(input, rawPath, observationSignal)
              }
              if (!workflow) {
                await anchorWriteOrEdit()
                return {}
              }
              if (nativePlanning && hook.tool_name === 'AskUserQuestion') {
                this.invalidateTerminalPlanIntent()
                if (!hook.agent_id && hook.session_id === resolvedSessionId)
                  this.invalidateRetentionForQuestion()
              }
              if (hook.tool_name === retentionToolName) {
                const allowed = this.observeRetentionIntent(hook)
                return allowed
                  ? {}
                  : {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        permissionDecision: 'deny' as const,
                        permissionDecisionReason:
                          'This root cannot retain an unchanged frozen plan.',
                      },
                    }
              }
              if (nativePlanning && ['Write', 'Edit', 'ExitPlanMode'].includes(hook.tool_name))
                await this.observePlanHook(hook, 'begin')
              if (nativePlanning && hook.tool_name === 'ExitPlanMode')
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: 'ask' as const,
                  },
                }
              const allowed =
                !['Agent', 'Task', 'EnterPlanMode', 'ExitPlanMode'].includes(hook.tool_name) &&
                (!readOnlyStage ||
                  nativePlanning ||
                  collaborationToolAllowed(hook.tool_name, peerServerName))
              if (allowed) {
                if (!nativePlanning) await anchorWriteOrEdit()
                return {}
              }
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason:
                    'Stay within this root responsibility. Use native questions for user decisions; Pact schedules independent review and implementation.',
                },
              }
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            async (hook) => {
              if (hook.hook_event_name !== 'PostToolUse') return {}
              if (hook.tool_name === retentionToolName && nativeRetention) {
                this.authenticateRetention(hook)
                return {}
              }
              if (nativePlanning && ['Write', 'Edit', 'ExitPlanMode'].includes(hook.tool_name)) {
                await this.observePlanHook(hook, 'success')
                return {}
              }
              if (nativePlanning && ['AskUserQuestion', 'TodoWrite'].includes(hook.tool_name))
                return {}
              if (hook.tool_name === 'Write' || hook.tool_name === 'Edit') {
                const evidence = claudeFileChanges(hook.tool_name, hook.tool_response, input.cwd)
                evidence.changes = evidence.changes.map((change, index) => ({
                  ...change,
                  operationId: `${hook.tool_use_id}:${index}`,
                }))
                await this.host.observeFiles(evidence)
              } else if (
                hook.tool_name !== peerToolName &&
                hook.tool_name !== titleToolName &&
                hook.tool_name !== `mcp__${peerServerName}__read_collaboration_source` &&
                hook.tool_name !== reviewToolName &&
                hook.tool_name !== inputResultToolName &&
                hook.tool_name !== retentionToolName &&
                hook.tool_name !== publishPlanToolName &&
                ![
                  'Read',
                  'Grep',
                  'Glob',
                  'WebSearch',
                  'WebFetch',
                  'AskUserQuestion',
                  'TodoWrite',
                ].includes(hook.tool_name)
              ) {
                nativeEffectsUncertain(
                  input,
                  'Native shell, MCP, skill or child-tool effects are not fully represented by file operation results.',
                )
              }
              return {}
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          hooks: [
            async (hook) => {
              if (
                hook.hook_event_name === 'PostToolUseFailure' &&
                hook.tool_name === retentionToolName &&
                !hook.agent_id &&
                hook.session_id === resolvedSessionId
              ) {
                const call = this.retentionCalls.get(hook.tool_use_id)
                if (call) call.invalid = true
                if (this.planPublication.retained?.nativeId === hook.tool_use_id)
                  this.captureUnavailable()
                return {}
              }
              if (
                hook.hook_event_name === 'PostToolUseFailure' &&
                nativePlanning &&
                ['Write', 'Edit'].includes(hook.tool_name)
              ) {
                await this.observePlanHook(hook, 'failure')
                return {}
              }
              if (
                hook.hook_event_name !== 'PostToolUseFailure' ||
                nativePlanning ||
                !['Write', 'Edit'].includes(hook.tool_name)
              )
                return {}
              const path =
                hook.tool_input && typeof hook.tool_input === 'object'
                  ? Reflect.get(hook.tool_input, 'file_path')
                  : undefined
              const knownPath = typeof path === 'string' && path.length > 0 && path.length <= 4096
              const reason = 'A failed native file operation may have left a partial final version.'
              await this.host.observeFiles({
                changes: knownPath
                  ? [
                      {
                        path,
                        kind: 'modified',
                        invalidateOnly: true,
                        unavailableReason: reason,
                      },
                    ]
                  : [],
                uncertain: reason,
                ...(!knownPath ? { invalidatesPriorEvidence: true } : {}),
              })
              return {}
            },
          ],
        },
      ],
    }
  }

  /**
   * Verifies terminal full-root plan retention or submission proof after query exit.
   * Returns whether terminal plan projection failed.
   */
  async verifyTerminalPlanOnExit(
    settledRoot: () => boolean,
    initialRecordingFailed: boolean,
  ): Promise<boolean> {
    const intent = this.terminalPlanIntent
    const eligible = (): boolean =>
      Boolean(
        this.host.nativePlanning &&
        !this.planPublication.plan &&
        intent &&
        !intent.invalid &&
        intent.permissionMatched &&
        (!this.inputResult || this.inputResult.outcome === 'explanation_only') &&
        settledRoot(),
      )
    let terminalPlanProjectionFailed = initialRecordingFailed
    const commitRetained = (candidate: CollaborationRetainedPlan): void => {
      const confirmed: CollaborationRetainedPlan = {
        ...candidate,
        confirmation: 'native_root_settled_v1',
      }
      const recordRetained = this.host.input.host?.workflow?.recordPlanRetained
      if (!recordRetained) throw new Error('The retained plan has no durable recorder.')
      recordRetained(confirmed)
      this.planPublication.retain(confirmed)
      this.planCaptureFailure = undefined
      this.logPlan('submission', 'retained')
      this.refreshCachedPlan()
      const known = this.host.runtime.nativeEvidence.get(this.host.input.runId)
      if (known?.kind === 'ended' && known.outcome === 'completed') {
        this.host.runtime.recordEvidence(this.host.input, this.host.resolvedSessionId, {
          ...known,
          output: this.planPublication.project(
            known.output ?? {
              outputId: this.host.input.runId,
              text: '',
              completeness: 'complete' as const,
            },
          ),
        })
      }
    }
    const calls = [...this.retentionCalls]
    const retention = calls.length === 1 ? calls[0] : undefined
    const eligibleRetention = (): boolean =>
      Boolean(
        this.host.nativeRetention &&
        retention &&
        !this.retentionBlocked &&
        !this.planPublication.plan &&
        !retention[1].invalid &&
        retention[1].preObserved &&
        retention[1].postObserved &&
        retention[1].observed &&
        retention[1].succeeded &&
        retention[1].promptId &&
        this.host.authorization?.planReference &&
        (!this.inputResult || this.inputResult.outcome === 'explanation_only') &&
        settledRoot(),
      )
    if (retention && eligibleRetention()) {
      try {
        const [id, call] = retention
        await this.host.runtime.nativeForkFiles.readAnswer(
          {
            cwd: this.host.input.cwd,
            nativeSessionId: this.host.resolvedSessionId,
            nativeTurnId: this.host.input.runId,
            terminalPlanRetention: {
              id,
              promptId: call.promptId!,
              toolName: this.host.retentionToolName,
              inputFingerprint: claudePlanInputFingerprint(this.host.retentionToolName, {}),
            },
          },
          this.host.signal,
        )
        if (eligibleRetention()) {
          const basis = this.host.authorization!.planReference!.document
          commitRetained({
            nativeId: id,
            sha256: basis.sha256,
            bytes: basis.bytes,
            chars: basis.chars,
          })
        }
      } catch {
        this.captureUnavailable(true)
      }
    } else if (this.retentionCalls.size && !this.planPublication.plan) {
      this.captureUnavailable(true)
    }
    if (intent && eligible() && this.planBindingReads < 64) {
      this.planBindingReads++
      let projectingTerminalPlan = false
      let retainingTerminalPlan = false
      try {
        const proof = await this.host.runtime.nativeForkFiles.readAnswer(
          {
            cwd: this.host.input.cwd,
            nativeSessionId: this.host.resolvedSessionId,
            nativeTurnId: this.host.input.runId,
            terminalPlanSubmission: {
              id: intent.id,
              promptId: intent.promptId,
              inputFingerprint: intent.inputFingerprint,
            },
            planCheckpoint: this.host.input.host?.workflow?.getPlanCheckpoint?.(
              this.host.resolvedSessionId,
            ),
          },
          this.host.signal,
        )
        if (eligible()) {
          const retained = proof.retainedPlan,
            basis = this.host.authorization?.planReference?.document
          if (proof.plan) {
            projectingTerminalPlan = true
            this.capturePlan(proof.plan)
            this.logPlan('submission', 'submitted')
          } else if (
            retained &&
            basis &&
            retained.sha256 === basis.sha256 &&
            retained.bytes === basis.bytes &&
            retained.chars === basis.chars
          ) {
            retainingTerminalPlan = true
            commitRetained(retained)
          }
          if (this.host.getProjectionFailure()) {
            terminalPlanProjectionFailed = true
            this.captureUnavailable()
          }
        }
      } catch (error) {
        // A terminal proof is never retried and never upgrades the native outcome.
        if (projectingTerminalPlan) {
          terminalPlanProjectionFailed = true
          try {
            this.host.failProjection(error)
          } catch {
            if (!this.host.getProjectionFailure()) {
              this.host.setProjectionFailure(classifyAgentError(error))
            }
          }
        }
        try {
          this.captureUnavailable(retainingTerminalPlan)
        } catch (storageError) {
          this.planPublication.invalidate()
          this.refreshCachedPlan()
          terminalPlanProjectionFailed = true
          this.host.setProjectionFailure(classifyAgentError(storageError))
        }
      }
    }
    return terminalPlanProjectionFailed
  }

  dispose(): void {
    this.planMemory.release()
    this.metadataMemory.release()
    this.planProofMemory.release()
    this.terminalPlanIntent = undefined
    this.planExitIds.clear()
    this.retentionCalls.clear()
    this.planDiagnosticKeys.clear()
    this.planCaptureFailure = undefined
    this.workflowCalls.clear()
    this.planCalls.clear()
  }
}
