import type { spawn } from 'node:child_process'

import {
  getSessionInfo,
  getSessionMessages,
  query,
  type SDKMessage,
  type startup,
} from '@anthropic-ai/claude-agent-sdk'

import type {
  AgentCollaborationSourceReader,
  AgentRunInput,
  AgentSteerInput,
  AgentSteerResult,
} from '@pact/agent-runtime'
import type { NativeProbeResult, RuntimeAgentId } from '@pact/contracts'
import type { DiagnosticEvent } from '@pact/contracts/diagnostics'

import type { NativeCheckOperation } from '../native-check-operation'
import type { NativeForkFiles } from '../native-fork-files'
import type { NativeMemoryReservation } from '../native-working-memory'

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const CLAUDE_TITLE_TIMEOUT_MS = 2_000
export const MAX_NATIVE_CLAUDE_QUERIES = 8
export const PERMISSION_MODE_TIMEOUT_MS = 15_000
export const NATIVE_INTERRUPT_TIMEOUT_MS = 2_000
export const FAST_MODE_CHECK_TIMEOUT_MS = 10_000
export const RUN_STARTUP_TIMEOUT_MS = 30_000
// The native consumption list has 64 UUID slots, including the initial input.
export const MAX_STEERING_INPUTS = 63

export interface ClaudeAgentDependencies {
  query: typeof query
  getSessionInfo: typeof getSessionInfo
  startup?: typeof startup
  getSessionMessages?: typeof getSessionMessages
  spawn?: typeof spawn
}

export const defaultClaudeAgentDependencies: ClaudeAgentDependencies = {
  query,
  getSessionInfo,
  getSessionMessages,
}

export interface ClaudeSteeringInput {
  request: AgentSteerInput
  signal: AbortSignal
  result: PromiseWithResolvers<AgentSteerResult>
  started: boolean
  yielded: boolean
  consumed: boolean
  finished: boolean
  cancelled: boolean
  reservation?: NativeMemoryReservation
}

export type PlanCaptureFailureCode = NonNullable<DiagnosticEvent['planCapture']>['code']
export type PlanCaptureFailure = NonNullable<DiagnosticEvent['planCapture']> & {
  operationId?: string
}
export type PlanSubmissionRejection = {
  reason:
    | PlanCaptureFailureCode
    | 'submission_hook_unverified'
    | 'plan_pending'
    | 'plan_unavailable'
    | 'plan_missing'
    | 'retained_basis_mismatch'
  latestCapture?: Pick<PlanCaptureFailure, 'code' | 'tool' | 'phase'>
}

export interface ClaudeBackgroundRunOwner {
  observation: AbortController
  recordings: Set<Promise<void>>
  executorId: string
  sourceGrant?: { runId: string; grant: string; active: boolean } | undefined
  sourceReader?: AgentCollaborationSourceReader | undefined
  steer?: (input: AgentSteerInput, signal: AbortSignal) => Promise<AgentSteerResult>
  work?: () => 'working' | 'stoppable' | undefined
  stopWork?: (signal: AbortSignal) => Promise<void>
}

export interface ClaudeRebuildReceipt {
  nativeSessionId: string
  sourceHash?: string
  seedHash: string
  cwd: string
  executorId: string
}

export type ClaudeRecordableEvidence =
  | Omit<Extract<NativeProbeResult, { kind: 'ended' }>, 'identity'>
  | Omit<Extract<NativeProbeResult, { kind: 'running' | 'waiting_user' }>, 'identity'>
  | Omit<Extract<NativeProbeResult, { kind: 'no_evidence' }>, 'identity'>
  | Omit<Extract<NativeProbeResult, { kind: 'missing' }>, 'identity'>

/**
 * Adapter-owned runtime state shared strictly with `ClaudeTurnSession` and
 * `ClaudeLifecycleCoordinator`. Keeps adapter-level capacity, evidence cache,
 * and background drain registries under one authoritative owner.
 */
export interface ClaudeAdapterRuntime {
  readonly id: 'claude'
  readonly executablePath: string
  readonly dependencies: ClaudeAgentDependencies
  readonly resolvePeerTarget?: ((sessionId: string) => RuntimeAgentId | undefined) | undefined
  readonly peerServerName: string
  readonly evidenceCacheWork: NativeMemoryReservation
  readonly nativeEvidence: Map<string, NativeProbeResult>
  readonly nativeRebuildReceipts: Map<string, ClaudeRebuildReceipt>
  readonly activeControllers: Set<AbortController>
  readonly activeSessions: Set<ReturnType<typeof query>>
  readonly backgroundDrains: Set<Promise<void>>
  readonly backgroundRuns: Map<string, ClaudeBackgroundRunOwner>
  readonly nativeForkFiles: NativeForkFiles
  readonly nativeCheck: NativeCheckOperation
  readonly forkInitializing: Set<string>
  latestExecutorId: string
  disposed: boolean
  skillCatalogChanged: (() => void) | undefined
  hasActiveBackgroundWork(runId?: string): boolean
  admitEvidenceCache(): void
  recordEvidence(
    input: AgentRunInput,
    nativeSessionId: string,
    fact: ClaudeRecordableEvidence,
  ): void
}

/**
 * Per creating Query: bounded observed work, released with that native owner.
 * The SDK background level replaces task edges once available; Hooks remain paired.
 * Excludes ambient tasks from root settlement gating (L4).
 */
export class ClaudeNativeWork {
  private readonly hooks = new Set<string>()
  private readonly tasks = new Set<string>()
  private readonly ambientTasks = new Set<string>()
  private hasBackgroundLevel = false
  private unconfirmed = false

  get pending(): boolean {
    return this.unconfirmed || this.active || this.ambientTasks.size > 0
  }

  get active(): boolean {
    return this.hooks.size > 0 || this.tasks.size > 0
  }

  get stoppable(): boolean {
    return this.active && !this.unconfirmed
  }

  get taskIds(): readonly string[] {
    return [...this.tasks]
  }

  get hooksRunning(): boolean {
    return this.hooks.size > 0
  }

  hasTask(id: string): boolean {
    return this.tasks.has(id)
  }

  observe(message: SDKMessage): void {
    if (message.type !== 'system') return
    const add = (set: Set<string>, id: string): void => {
      let bytes = 0
      for (const value of this.hooks) bytes += Buffer.byteLength(value)
      for (const value of this.tasks) bytes += Buffer.byteLength(value)
      for (const value of this.ambientTasks) bytes += Buffer.byteLength(value)
      if (
        !id ||
        id.length > 1024 ||
        (!set.has(id) &&
          (this.hooks.size + this.tasks.size + this.ambientTasks.size >= 64 ||
            bytes + Buffer.byteLength(id) > 64 * 1024))
      )
        this.unconfirmed = true
      else set.add(id)
    }
    if (message.subtype === 'hook_started') add(this.hooks, message.hook_id)
    else if (message.subtype === 'hook_response') this.hooks.delete(message.hook_id)
    else if (message.subtype === 'background_tasks_changed') {
      // Level and edge ordering is unspecified. Once present, only the level
      // owns task activity; a trailing task_started must not resurrect it.
      this.hasBackgroundLevel = true
      if (message.tasks.length > 64) {
        this.unconfirmed = true
        return
      }
      let count = this.hooks.size,
        bytes = 0
      for (const id of this.hooks) bytes += Buffer.byteLength(id)
      // Validate the replacement without retaining a second task set or losing
      // previously observed identities when the new level cannot be admitted.
      for (let index = 0; index < message.tasks.length; index++) {
        const task = message.tasks[index]!
        if (!task.task_id || task.task_id.length > 1024) {
          this.unconfirmed = true
          return
        }
        const duplicate = message.tasks.findIndex((other) => other.task_id === task.task_id)
        if (duplicate < index) {
          if ((message.tasks[duplicate]!.ambient === true) !== (task.ambient === true)) {
            this.unconfirmed = true
            return
          }
          continue
        }
        const taskBytes = Buffer.byteLength(task.task_id)
        count++
        bytes += taskBytes
        if (count > 64 || bytes > 64 * 1024) {
          this.unconfirmed = true
          return
        }
      }
      this.tasks.clear()
      this.ambientTasks.clear()
      for (const task of message.tasks)
        (task.ambient === true ? this.ambientTasks : this.tasks).add(task.task_id)
    } else if (!this.hasBackgroundLevel) {
      if (message.subtype === 'task_started') {
        const set = message.ambient === true ? this.ambientTasks : this.tasks
        const other = message.ambient === true ? this.tasks : this.ambientTasks
        if (other.has(message.task_id)) this.unconfirmed = true
        else add(set, message.task_id)
      } else if (
        message.subtype === 'task_notification' ||
        (message.subtype === 'task_updated' &&
          ['completed', 'failed', 'killed'].includes(String(message.patch.status)))
      ) {
        this.tasks.delete(message.task_id)
        this.ambientTasks.delete(message.task_id)
      }
    }
  }
}
