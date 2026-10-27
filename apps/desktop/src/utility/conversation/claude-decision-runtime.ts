/* oxlint-disable no-await-in-loop -- Native stages, controls and ancestor checks are strictly sequential. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DECISION_DEADLINE_MS,
  DECISION_CLEANUP_TARGET_MS,
  DECISION_OUTPUT_BYTES,
  parseDecisionRecommendation,
  validateDecisionInput,
  type DecisionInput,
  type DecisionOutcome,
  type DecisionPhysicalWitness,
  type SchedulingUsage,
} from '@pact/contracts'

import type {
  DecisionCapability,
  DecisionCapabilityReason,
  DecisionInputLoader,
  DecisionRuntime,
} from './decision-runtime'

import { OwnedProcessGroup } from '../owned-process-group'
import {
  claudeDecisionFingerprint as fingerprint,
  createClaudeDecisionResponseGuard,
  parseClaudeDecisionJson,
} from './claude-decision-response-guard'
import {
  assertDecisionEnvironment,
  decisionDarwinSandbox,
  resolveDecisionNativeExecutable,
} from './decision-native-isolation'
import { decisionRuntimePrompt } from './decision-runtime'
import {
  DecisionMemoryLease,
  type NativeMemoryAllocator,
  type NativeMemoryReservation,
} from './native-working-memory'

const MIB = 1024 * 1024
const FRAME_BYTES = 256 * 1024
const MODEL = /^claude-haiku-5-5(?:-\d{8})?$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const SETTINGS = {
  disableAllHooks: true,
  autoMemoryEnabled: false,
  disableWorkflows: true,
  disableRemoteControl: true,
  fallbackModel: [],
}
const ISOLATION_ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_MAX_RETRIES: '1',
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function isLoader(value: unknown): value is DecisionInputLoader {
  return typeof value === 'function'
}
const record = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw Error('unsupported_protocol')
  return value
}
const scalar = (value: unknown, limit = 4096): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > limit || value.includes('\0'))
    throw Error('unsupported_protocol')
  return value
}
type NativeStage = 'host_metadata' | 'project_metadata' | 'guarded_context' | 'project_verification'
type Guard = Awaited<ReturnType<typeof createClaudeDecisionResponseGuard>>
type Authority = { fingerprint: string; destination: string; account: string; effective: string }

/** The caller persists one invocation before its first stage. These callbacks cannot grant model authority. */
export interface ClaudeDecisionRuntimeContext {
  executable: string | ((signal: AbortSignal) => Promise<string | undefined>)
  modelId: string
  ownerId: string
  cwd?: string | undefined
  deadlineAt?: number | undefined
  current: () => boolean
  /** Optional additional host veto. Actual startup containment is always enforced internally. */
  startupPolicyAdmission?:
    | ((facts: {
        executable: string
        cwd: string
        deadlineAt: number
        signal: AbortSignal
      }) => boolean | Promise<boolean>)
    | undefined
  dispatch: () => void
  reserve?:
    | ((input: DecisionInput, facts: { deadlineAt: number }) => 'reserved' | 'duplicate' | 'busy')
    | undefined
  beginNativeStage: (facts: {
    expectedGeneration: number
    stage: NativeStage
    previousWitness: DecisionPhysicalWitness | null
    previousPhysicalReleased: boolean
  }) => number
  physicalPrepared: (facts: {
    nativeGeneration: number
    witness: DecisionPhysicalWitness
  }) => void | Promise<void>
  prepared: (facts: {
    nativeGeneration: number
    witness: DecisionPhysicalWitness
    configurationFingerprint: string
  }) => void
  /** Retire already-closed stages after their durable transition. False means
   * all helper work joined but capacity is still unavailable; rejection leaves
   * physical cleanup unknown and retains this invocation's admission. */
  retirePhysicalReceipts?:
    | ((facts: {
        memory: NativeMemoryAllocator
        deadlineAt: number
        signal?: AbortSignal | undefined
      }) => Promise<boolean>)
    | undefined
  /** Commit final physical release and join receipt retirement before releasing this lease. */
  physicalCompletion?:
    | ((facts: {
        memory: NativeMemoryAllocator
        deadlineAt: number
        nativeGeneration: number
        witness: DecisionPhysicalWitness | null
        outcome?: DecisionOutcome | undefined
        usage?: SchedulingUsage | undefined
      }) => Promise<void>)
    | undefined
  /** Owned native fixtures only. Production inherits the original native HOME and credential owner. */
  environment?: NodeJS.ProcessEnv | undefined
}

/** One fixed JSONL buffer and one waiter; no SDK/readline, event queue or shared parser worker. */
class ClaudeDecisionTransport {
  private readonly frame = Buffer.allocUnsafe(FRAME_BYTES)
  private length = 0
  private bytes = 0
  private frames = 0
  private stderrBytes = 0
  private pending:
    | { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined
  private result:
    | { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
    | undefined
  private failure: Error | undefined
  private sequence = 0
  private submitted = false
  private protocolRefusal = 'none'
  private nativeSystem = 'none'
  private nativeTypes = { assistant: 0, system: 0, result: 0, command_lifecycle: 0, other: 0 }
  diagnostics() {
    return {
      refusal: this.protocolRefusal,
      frames: { ...this.nativeTypes },
      system: this.nativeSystem,
      assistantFrames: this.assistantFrames,
    }
  }
  private rejectProtocol(reason: string): never {
    this.protocolRefusal = reason
    throw Error('unsupported_protocol')
  }
  private assistantSeen = false
  private assistantId: string | undefined
  private assistantFrames = 0
  private assistantBytes = 0
  private initSeen = false
  private resultSeen = false
  private commandId: string | undefined
  private lifecycle: 'none' | 'queued' | 'started' | 'completed' = 'none'
  private terminalResult: Record<string, unknown> | undefined
  private stopping = false
  private closed = false
  private readonly closePromise: Promise<void>
  private readonly aborted = () => this.fail()

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly signal: AbortSignal,
    private readonly sessionId: string,
    private readonly modelId: string,
  ) {
    child.stdout.on('data', this.read)
    child.stderr.on('data', this.stderr)
    child.stdin.on('error', this.aborted)
    child.on('error', this.aborted)
    child.stdout.on('error', this.aborted)
    child.stdout.on('end', this.eof)
    this.closePromise = new Promise<void>((resolve) =>
      child.once('close', () => {
        this.closed = true
        if (!this.stopping || this.length) this.fail()
        resolve()
      }),
    )
    signal.addEventListener('abort', this.aborted, { once: true })
    if (signal.aborted) this.fail()
  }
  private fail(): void {
    this.failure ??= Error('unsupported_protocol')
    this.pending?.reject(this.failure)
    this.pending = undefined
    this.result?.reject(this.failure)
    this.result = undefined
    // Stop consuming protocol data after a refusal; the physical owner must close the pipes.
    this.child.stdout.pause()
  }
  private readonly stderr = (chunk: Buffer): void => {
    this.stderrBytes += chunk.length
    if (this.stderrBytes > 16 * 1024) this.fail()
  }
  private readonly eof = (): void => {
    if (this.length || (!this.stopping && !this.resultSeen)) this.fail()
  }
  private readonly read = (chunk: Buffer): void => {
    if (this.failure) return
    this.bytes += chunk.length
    if (this.bytes > 2 * MIB) {
      this.fail()
      return
    }
    let offset = 0
    try {
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset),
          end = newline < 0 ? chunk.length : newline
        const count = end - offset
        if (this.length + count > this.frame.length) throw Error('unsupported_protocol')
        chunk.copy(this.frame, this.length, offset, end)
        this.length += count
        offset = end + 1
        if (newline < 0) break
        if (!this.length || ++this.frames > 256) throw Error('unsupported_protocol')
        const value = record(
          parseClaudeDecisionJson(
            new TextDecoder('utf-8', { fatal: true }).decode(this.frame.subarray(0, this.length)),
          ),
        )
        this.length = 0
        this.accept(value)
      }
    } catch {
      this.fail()
    }
  }
  private accept(value: Record<string, unknown>): void {
    if (value.type === 'control_response') {
      const response = record(value.response),
        pending = this.pending
      if (!pending || response.request_id !== pending.id) throw Error('unsupported_protocol')
      this.pending = undefined
      if (response.subtype !== 'success') pending.reject(Error('unsupported_protocol'))
      else pending.resolve(response.response)
      return
    }
    if (!this.submitted || value.session_id !== this.sessionId)
      this.rejectProtocol('unbound_session')
    if (value.type === 'system')
      this.nativeSystem = [
        'init',
        'status',
        'api_retry',
        'compact_boundary',
        'hook_started',
        'hook_response',
        'task_notification',
        'stop_hook_summary',
        'informational',
        'notification',
        'error_during_execution',
        'model_refusal_fallback',
        'model_refusal_no_fallback',
        'memory_recall',
        'permission_denied',
        'local_command_output',
        'mirror_error',
        'session_state_changed',
        'task_started',
        'task_progress',
        'thinking_tokens',
      ].includes(String(value.subtype))
        ? String(value.subtype)
        : 'other'
    if (
      value.type === 'assistant' ||
      value.type === 'system' ||
      value.type === 'result' ||
      value.type === 'command_lifecycle'
    )
      this.nativeTypes[value.type]++
    else this.nativeTypes.other++
    if (value.type === 'command_lifecycle') {
      if (
        value.command_uuid !== this.commandId ||
        typeof value.uuid !== 'string' ||
        !UUID.test(value.uuid)
      )
        throw Error('unsupported_protocol')
      if (value.state === 'queued' && this.lifecycle === 'none' && !this.resultSeen)
        this.lifecycle = 'queued'
      else if (value.state === 'started' && this.lifecycle === 'queued' && !this.resultSeen)
        this.lifecycle = 'started'
      else if (
        value.state === 'completed' &&
        this.lifecycle === 'started' &&
        this.resultSeen &&
        this.terminalResult &&
        this.result
      ) {
        this.lifecycle = 'completed'
        const waiting = this.result
        this.result = undefined
        waiting.resolve(this.terminalResult)
        this.terminalResult = undefined
      } else throw Error('unsupported_protocol')
      return
    }
    if (this.resultSeen || this.lifecycle !== 'started') throw Error('unsupported_protocol')
    if (value.type === 'system' && value.subtype === 'init') {
      if (
        this.initSeen ||
        value.model !== this.modelId ||
        !Array.isArray(value.tools) ||
        value.tools.length ||
        !Array.isArray(value.mcp_servers) ||
        value.mcp_servers.length
      )
        throw Error('unsupported_protocol')
      this.initSeen = true
    } else if (value.type === 'system' && value.subtype === 'thinking_tokens') {
      if (
        !this.initSeen ||
        value.user_message_uuid !== this.commandId ||
        typeof value.uuid !== 'string' ||
        !UUID.test(value.uuid) ||
        typeof value.estimated_tokens !== 'number' ||
        !Number.isSafeInteger(value.estimated_tokens) ||
        value.estimated_tokens < 0 ||
        typeof value.estimated_tokens_delta !== 'number' ||
        !Number.isSafeInteger(value.estimated_tokens_delta) ||
        value.estimated_tokens_delta < 0
      )
        this.rejectProtocol('thinking_progress')
    } else if (value.type === 'assistant') {
      const message = record(value.message)
      if (this.assistantSeen && (typeof message.id !== 'string' || message.id !== this.assistantId))
        this.rejectProtocol('assistant_identity')
      if (++this.assistantFrames > 64) this.rejectProtocol('assistant_capacity')
      if (!this.initSeen) this.rejectProtocol('assistant_before_init')
      if (message.model !== this.modelId) this.rejectProtocol('assistant_model')
      if (value.parent_tool_use_id !== null) this.rejectProtocol('assistant_parent')
      if (!Array.isArray(message.content)) this.rejectProtocol('assistant_content')
      const stamped =
        value.user_message_uuid !== undefined || value.user_message_uuids !== undefined
      if (
        (!this.assistantSeen || stamped) &&
        (value.user_message_uuid !== this.commandId ||
          !Array.isArray(value.user_message_uuids) ||
          value.user_message_uuids.length !== 1 ||
          value.user_message_uuids[0] !== this.commandId)
      )
        this.rejectProtocol('assistant_command')
      let bytes = this.assistantBytes
      for (const raw of message.content) {
        const part = record(raw)
        if (part.type !== 'text' && part.type !== 'thinking') throw Error('unsupported_protocol')
        bytes += Buffer.byteLength(
          scalar(part.type === 'text' ? part.text : part.thinking, DECISION_OUTPUT_BYTES) ?? '',
        )
        if (bytes > DECISION_OUTPUT_BYTES) throw Error('unsupported_protocol')
      }
      this.assistantId ??= scalar(message.id, 256) ?? undefined
      this.assistantBytes = bytes
      this.assistantSeen = true
    } else if (value.type === 'result') {
      const waiting = this.result
      if (!waiting || !this.initSeen) throw Error('unsupported_protocol')
      this.resultSeen = true
      if (
        value.subtype !== 'success' ||
        value.is_error !== false ||
        value.num_turns !== 1 ||
        value.queued_turn_count !== 0 ||
        value.result_index !== 0 ||
        value.user_message_uuid !== this.commandId ||
        !Array.isArray(value.user_message_uuids) ||
        value.user_message_uuids.length !== 1 ||
        value.user_message_uuids[0] !== this.commandId ||
        !this.assistantSeen ||
        typeof value.result !== 'string' ||
        Buffer.byteLength(value.result) > DECISION_OUTPUT_BYTES
      )
        waiting.reject(Error('unavailable'))
      else this.terminalResult = { result: value.result }
    } else this.rejectProtocol('unexpected_frame')
  }
  control(subtype: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (this.failure || this.closed || this.pending || this.submitted)
      return Promise.reject(this.failure ?? Error('unsupported_protocol'))
    return new Promise((resolve, reject) => {
      const id = `pact-decision-${++this.sequence}`
      this.pending = { id, resolve, reject }
      this.child.stdin.write(
        `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype, ...fields } })}\n`,
        (error) => {
          if (error) this.fail()
        },
      )
    })
  }
  prompt(prompt: string): Promise<Record<string, unknown>> {
    if (this.failure || this.closed || this.pending || this.submitted)
      return Promise.reject(this.failure ?? Error('unsupported_protocol'))
    this.submitted = true
    this.commandId = randomUUID()
    return new Promise((resolve, reject) => {
      this.result = { resolve, reject }
      const message = {
        type: 'user',
        uuid: this.commandId,
        session_id: this.sessionId,
        parent_tool_use_id: null,
        message: { role: 'user', content: prompt },
      }
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.fail()
      })
    })
  }
  stop(): void {
    this.stopping = true
    this.pending?.reject(Error('cancelled'))
    this.pending = undefined
    this.result?.reject(Error('cancelled'))
    this.result = undefined
    this.child.stdout.resume()
    this.child.stdin.end()
  }
  async release(): Promise<void> {
    await this.closePromise
    this.signal.removeEventListener('abort', this.aborted)
    this.child.stdout.off('data', this.read)
    this.child.stderr.off('data', this.stderr)
    this.child.stdout.off('end', this.eof)
    this.child.stdout.off('error', this.aborted)
    this.child.stdin.off('error', this.aborted)
    this.child.off('error', this.aborted)
    this.terminalResult = undefined
    this.length = 0
    this.frame.fill(0)
  }
}

/** One disposable native invocation; owns all native stages, I/O, guard and physical settlement. */
export class ClaudeDecisionRuntime implements DecisionRuntime {
  private readonly memory = new DecisionMemoryLease()
  private readonly controller = new AbortController()
  private readonly admittedAt = Date.now()
  private readonly environment: NodeJS.ProcessEnv
  private readonly environmentFingerprint: string
  private readonly deadlineAt: number
  private started = false
  private called = false
  private disposed = false
  private phase = 'admission'
  private failureReason: DecisionCapabilityReason | undefined
  private failureDetail: 'startup_policy_unverified' | undefined
  private hostWorkspace: NativeMemoryReservation | undefined
  private framingWorkspace: NativeMemoryReservation | undefined
  private ownerWorkspace: NativeMemoryReservation | undefined
  private physical: Promise<boolean> | undefined
  private cleanupTask: Promise<boolean> | undefined
  private cancelLogical: (() => void) | undefined
  private directory: { path: string; dev: number; ino: number } | undefined
  private executable: { path: string; identity: string } | undefined
  private group: OwnedProcessGroup | undefined
  private transport: ClaudeDecisionTransport | undefined
  private guard: Guard | undefined
  private guardFacts: Guard['facts'] | undefined
  private observedUsage: SchedulingUsage | undefined
  private observedTransport: ReturnType<ClaudeDecisionTransport['diagnostics']> | undefined
  private generation = 0
  private witness: DecisionPhysicalWitness | null = null
  private previousPhysicalReleased = true
  private evaluating = false
  private completionOutcome: DecisionOutcome | undefined
  private completionCancelled = false
  private receiptRetirementFailed = false

  constructor(private readonly context: ClaudeDecisionRuntimeContext) {
    // Darwin's bounded process-table decoding shares this 2 MiB partition.
    // Windows takes its other 1 MiB directly from this lease in OwnedProcessGroup.
    this.ownerWorkspace = this.memory.reserve(process.platform === 'win32' ? MIB : 2 * MIB)
    this.deadlineAt = Math.min(
      context.deadlineAt ?? this.admittedAt + DECISION_DEADLINE_MS,
      this.admittedAt + DECISION_DEADLINE_MS,
    )
    const source = context.environment ?? process.env
    let bytes = 0,
      entries = 0
    for (const key in source) {
      bytes += Buffer.byteLength(key) + Buffer.byteLength(source[key] ?? '')
      if (++entries > 256 || bytes > 128 * 1024) {
        this.ownerWorkspace.release()
        this.memory.release()
        throw Error('unsupported_protocol')
      }
    }
    this.environment = { ...source }
    this.environmentFingerprint = fingerprint(this.environment)
  }
  get invoked() {
    return this.called
  }
  get usage() {
    return this.guard?.usage ?? (this.observedUsage ? { ...this.observedUsage } : undefined)
  }
  diagnostics() {
    return {
      phase: this.phase,
      native: this.guard
        ? this.transport?.diagnostics()
        : (this.observedTransport ?? this.transport?.diagnostics()),
      failure: this.failureReason,
      failureReason: this.failureReason,
      failureDetail: this.failureDetail,
      refusalCode: undefined,
      working: this.memory.diagnostics(),
      guard: this.guard?.facts ?? this.guardFacts,
      nativeGeneration: this.generation,
    }
  }
  private check(): void {
    if (Date.now() >= this.deadlineAt) throw Error('timeout')
    if (this.controller.signal.aborted || this.disposed) throw Error('cancelled')
    if (!this.context.current()) throw Error('stale')
    if (fingerprint(this.context.environment ?? process.env) !== this.environmentFingerprint)
      throw Error('stale')
  }
  private reason(error: unknown): DecisionCapabilityReason {
    if (Date.now() >= this.deadlineAt) return 'timeout'
    if (this.controller.signal.aborted || this.disposed) return 'cancelled'
    const allowed: DecisionCapabilityReason[] = [
      'stale',
      'unsupported_platform',
      'unsupported_provider',
      'unsupported_network',
      'unsupported_authentication',
      'unsupported_protocol',
      'project_authentication_differs',
      'executable_unavailable',
      'model_unavailable',
      'model_metadata_invalid',
      'catalog_limit',
      'cleanup_unconfirmed',
      'unavailable',
    ]
    return error instanceof Error
      ? (allowed.find((reason) => reason === error.message) ?? 'unavailable')
      : 'unavailable'
  }
  private async run<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
    cancelled: (reason: 'cancelled' | 'timeout') => T,
    completion?: {
      result: (value: T) => DecisionOutcome
      error: (error: unknown) => DecisionOutcome
    },
  ): Promise<T> {
    this.started = true
    this.evaluating = completion !== undefined
    this.hostWorkspace = this.memory.reserve(4 * MIB)
    let settled = false,
      cancelling = false
    return new Promise<T>((resolve, reject) => {
      const finish = (value: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        this.cancelLogical = undefined
        resolve(value)
      }
      const failed = (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        this.cancelLogical = undefined
        reject(error)
      }
      const cancelWith = (reason: 'cancelled' | 'timeout') => {
        if (settled || cancelling) return
        cancelling = true
        const value = cancelled(reason)
        if (completion) {
          this.completionOutcome = completion.result(value)
          this.completionCancelled = true
        }
        this.controller.abort()
        finish(value)
      }
      const cancel = () => cancelWith('cancelled')
      const timer = setTimeout(
        () => cancelWith('timeout'),
        Math.max(0, this.deadlineAt - Date.now()),
      )
      this.cancelLogical = cancel
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      // Loader, executable resolver and cleanup remain joined after logical cancellation.
      this.physical = Promise.resolve()
        .then(operation)
        .then(
          async (value) => {
            if (completion && !this.completionCancelled)
              this.completionOutcome = completion.result(value)
            const released = await this.cleanup()
            if (released) finish(value)
            else failed(Error('cleanup_unconfirmed'))
            return released
          },
          async (error: unknown) => {
            if (completion && !this.completionCancelled)
              this.completionOutcome = completion.error(error)
            const released = await this.cleanup()
            failed(error)
            return released
          },
        )
    })
  }
  async probeAdmission(signal?: AbortSignal): Promise<DecisionCapability> {
    const capability = (
      reason: DecisionCapabilityReason,
      configurationFingerprint: string | null = null,
    ): DecisionCapability => ({
      provider: 'claude',
      modelId: this.context.modelId,
      status: reason === 'supported' ? 'supported' : 'unavailable',
      supported: reason === 'supported',
      reason,
      configurationFingerprint,
      checkedAt: new Date().toISOString(),
      physicalReleased: this.memory.diagnostics().released,
    })
    if (this.started || this.disposed) return capability('busy')
    try {
      const inspected = await this.run(
        signal,
        async () => {
          const authority = await this.prepare()
          return authority.fingerprint
        },
        (reason) => {
          this.failureReason = reason
          return ''
        },
      )
      const released = this.memory.diagnostics().released
      if (!inspected) return capability(this.failureReason ?? 'unavailable')
      return capability(released ? 'supported' : 'cleanup_unconfirmed', inspected)
    } catch (error) {
      this.failureReason =
        this.phase === 'cleanup_unconfirmed' ? 'cleanup_unconfirmed' : this.reason(error)
      return capability(
        this.memory.diagnostics().released ? this.failureReason : 'cleanup_unconfirmed',
      )
    }
  }
  async evaluateDecision(value: unknown, signal: AbortSignal): Promise<DecisionOutcome> {
    if (this.started || this.disposed) return { kind: 'unavailable', reason: 'busy' }
    try {
      return await this.run<DecisionOutcome>(
        signal,
        async () => {
          this.check()
          const inputValue = isLoader(value)
            ? await value({
                signal: this.controller.signal,
                deadlineAt: this.deadlineAt,
              })
            : value
          this.check()
          let validation: ReturnType<typeof validateDecisionInput>
          try {
            validation = validateDecisionInput(inputValue)
          } catch {
            return { kind: 'unavailable', reason: 'invalid_input' } as const
          }
          if (!validation.success) return { kind: 'unavailable', reason: 'invalid_input' } as const
          const input = validation.input
          if (!this.context.cwd || !this.context.reserve) throw Error('unavailable')
          const admission = this.context.reserve(input, { deadlineAt: this.deadlineAt })
          if (admission !== 'reserved') return { kind: 'unavailable', reason: admission } as const
          const authority = await this.prepare()
          this.check()
          const prompt = decisionRuntimePrompt(input) + JSON.stringify(input)
          this.guard!.bind({
            modelId: this.context.modelId,
            prompt,
            current: async () => {
              this.check()
              await this.verifyExecutable()
              this.check()
              return true
            },
            dispatch: () => {
              this.check()
              if (this.called) throw Error('unavailable')
              this.context.dispatch()
              this.called = true
            },
          })
          this.phase = 'inference'
          const result = await this.transport!.prompt(prompt)
          this.check()
          if (
            !this.called ||
            this.guard!.facts.acceptedResponses !== 1 ||
            result.result !== this.guard!.answer
          )
            throw Error('unavailable')
          const recommendation = parseDecisionRecommendation(
            scalar(result.result, DECISION_OUTPUT_BYTES)!,
            input,
          )
          if (!recommendation.success)
            return { kind: 'unavailable', reason: 'invalid_output' } as const
          await this.closeStage()
          const verified = await this.stage('project_verification', this.context.cwd, false)
          if (verified.fingerprint !== authority.fingerprint) throw Error('stale')
          await this.verifyExecutable()
          this.check()
          return { kind: 'recommendation', recommendation: recommendation.recommendation } as const
        },
        (reason) => {
          this.failureReason = reason
          return { kind: 'unavailable', reason }
        },
        { result: (outcome) => outcome, error: (error) => this.evaluationFailure(error) },
      )
    } catch (error) {
      return this.evaluationFailure(error)
    }
  }
  private evaluationFailure(error: unknown): DecisionOutcome {
    this.failureReason =
      this.phase === 'cleanup_unconfirmed' ? 'cleanup_unconfirmed' : this.reason(error)
    if (
      this.invoked &&
      this.guardFacts?.rejectedResponses &&
      this.failureReason === 'unsupported_protocol'
    )
      this.failureReason = 'unavailable'
    return {
      kind: 'unavailable',
      reason:
        this.failureReason === 'stale' ||
        this.failureReason === 'timeout' ||
        this.failureReason === 'cancelled'
          ? this.failureReason
          : 'runtime_unavailable',
    }
  }
  private async prepare(): Promise<Authority> {
    this.check()
    if (process.platform !== 'darwin') throw Error('unsupported_platform')
    if (!MODEL.test(this.context.modelId)) throw Error('model_unavailable')
    if (
      !UUID.test(this.context.ownerId) ||
      typeof this.context.beginNativeStage !== 'function' ||
      typeof this.context.physicalPrepared !== 'function' ||
      typeof this.context.prepared !== 'function'
    )
      throw Error('unsupported_protocol')
    this.framingWorkspace = this.memory.reserve(4 * MIB)
    const path = await realpath(await mkdtemp(join(tmpdir(), 'pact-claude-decision-'))),
      identity = await lstat(path)
    this.directory = { path, dev: identity.dev, ino: identity.ino }
    for (let ancestor = path; ; ancestor = dirname(ancestor)) {
      try {
        await lstat(join(ancestor, '.git'))
        throw Error('unsupported_protocol')
      } catch (error) {
        if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'ENOENT')
          throw error
      }
      if (dirname(ancestor) === ancestor) break
    }
    await this.verifyExecutable()
    const host = await this.stage('host_metadata', path, false)
    await this.closeStage()
    if (this.context.cwd) {
      const project = await this.stage('project_metadata', this.context.cwd, false)
      if (project.fingerprint !== host.fingerprint) throw Error('project_authentication_differs')
      await this.closeStage()
    }
    const guarded = await this.stage('guarded_context', path, true, host.destination)
    if (guarded.fingerprint !== host.fingerprint) throw Error('stale')
    this.context.prepared({
      nativeGeneration: this.generation,
      witness: this.witness!,
      configurationFingerprint: host.fingerprint,
    })
    return host
  }
  private nativeExecutable: Awaited<ReturnType<typeof resolveDecisionNativeExecutable>> | undefined
  private async verifyExecutable(): Promise<void> {
    this.check()
    const selected =
      typeof this.context.executable === 'string'
        ? this.context.executable
        : await this.context.executable(this.controller.signal)
    this.check()
    if (!selected) throw Error('executable_unavailable')
    const path = await realpath(selected),
      value = await stat(path)
    if (!value.isFile()) throw Error('executable_unavailable')
    const identity = fingerprint([
      path,
      value.dev,
      value.ino,
      value.size,
      value.mtimeMs,
      value.ctimeMs,
    ])
    if (this.executable && this.executable.identity !== identity) throw Error('stale')
    this.executable ??= { path, identity }
    if (this.nativeExecutable && !(await this.nativeExecutable.current())) throw Error('stale')
    this.nativeExecutable ??= await resolveDecisionNativeExecutable(path, 'claude')
  }
  private async stage(
    stage: NativeStage,
    cwd: string,
    guarded: boolean,
    originalDestination?: string,
  ): Promise<Authority> {
    this.check()
    if (this.group || this.transport || !this.previousPhysicalReleased || this.generation >= 4)
      throw Error('cleanup_unconfirmed')
    await this.verifyExecutable()
    try {
      if (
        this.context.startupPolicyAdmission &&
        !(await this.context.startupPolicyAdmission({
          executable: this.executable!.path,
          cwd,
          deadlineAt: this.deadlineAt,
          signal: this.controller.signal,
        }))
      )
        throw Error('unsupported_protocol')
    } catch {
      this.failureDetail = 'startup_policy_unverified'
      throw Error('unsupported_protocol')
    }
    this.check()
    assertDecisionEnvironment(this.environment)
    const generation = this.context.beginNativeStage({
      expectedGeneration: this.generation,
      stage,
      previousWitness: this.witness,
      previousPhysicalReleased: this.previousPhysicalReleased,
    })
    if (generation !== this.generation + 1) throw Error('unsupported_protocol')
    this.generation = generation
    this.phase = stage
    this.witness = null
    this.previousPhysicalReleased = false
    let receiptCapacity = true
    try {
      if (this.context.retirePhysicalReceipts)
        receiptCapacity = await this.context.retirePhysicalReceipts({
          memory: this.memory,
          deadlineAt: Math.min(this.deadlineAt, Date.now() + DECISION_CLEANUP_TARGET_MS),
          signal: this.controller.signal,
        })
    } catch {
      this.receiptRetirementFailed = true
      this.failureReason = 'cleanup_unconfirmed'
      throw Error('cleanup_unconfirmed')
    }
    if (!receiptCapacity) throw Error('unavailable')
    this.check()
    // Receipt helpers finish before the next transport allocates its workspace.
    // All allocations remain inside the original invocation's fixed lease.
    if (guarded) {
      if (!originalDestination) throw Error('unsupported_network')
      this.guard = await createClaudeDecisionResponseGuard(
        originalDestination,
        this.memory,
        this.deadlineAt,
      )
      this.guardFacts = this.guard.facts
      this.check()
    }
    const sessionId = randomUUID()
    const localEnv = {
      ...ISOLATION_ENV,
      ...(guarded ? { ANTHROPIC_BASE_URL: this.guard!.baseUrl } : {}),
    }
    const env = {
      ...this.environment,
      ...localEnv,
      TMPDIR: this.directory!.path,
      TMP: this.directory!.path,
      TEMP: this.directory!.path,
    }
    const args = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--session-id',
      sessionId,
      '--model',
      this.context.modelId,
      '--max-turns',
      '1',
      '--tools',
      '',
      '--disallowedTools',
      '*',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      stage === 'project_metadata' || stage === 'project_verification'
        ? 'user,project,local'
        : 'user',
      '--settings',
      JSON.stringify({ ...SETTINGS, env: localEnv }),
    ]
    this.group = new OwnedProcessGroup({
      signal: this.controller.signal,
      deadlineAt: this.deadlineAt,
      ownerId: this.context.ownerId,
      memory: this.memory,
      startupObservationMs: Math.min(2000, Math.max(0, this.deadlineAt - Date.now())),
      onCloseInput: () => this.transport?.stop(),
      physicalPrepared: async (witness) => {
        if (witness.ownerId !== this.context.ownerId || generation !== this.generation)
          throw Error('unsupported_protocol')
        this.witness = witness
        await this.context.physicalPrepared({ nativeGeneration: generation, witness })
      },
    })
    const sandbox = decisionDarwinSandbox(
      this.nativeExecutable!.path,
      this.directory!.path,
      this.guard?.port,
    )
    const child = this.group.spawn(sandbox.command, [...sandbox.args, ...args], {
      cwd,
      env,
      windowsHide: true,
    })
    this.transport = new ClaudeDecisionTransport(
      child,
      this.controller.signal,
      sessionId,
      this.context.modelId,
    )
    const witness = await this.group.physicalWitness(this.context.ownerId)
    this.witness = witness
    await this.context.physicalPrepared({ nativeGeneration: generation, witness })
    this.check()
    const account = this.initialization(
      await this.transport.control('initialize', {
        title: 'Pact Relay',
        skills: [],
        promptSuggestions: false,
        agentProgressSummaries: false,
      }),
    )
    const settings = this.settings(
      await this.transport.control('get_settings'),
      account,
      guarded,
      originalDestination,
    )
    this.hooks(await this.transport.control('get_hooks_listing'))
    this.check()
    return settings
  }
  private initialization(value: unknown): { hash: string; helper: boolean; identity: boolean } {
    const init = record(value)
    if (!Array.isArray(init.models) || init.models.length > 200) throw Error('catalog_limit')
    let available = false,
      productEntries = 0,
      exactEntries = 0
    for (const row of init.models) {
      const model = record(row)
      const resolved = scalar(model.resolvedModel, 256)
      if (!resolved || !scalar(model.value, 256)) throw Error('model_metadata_invalid')
      if (model.value === this.context.modelId && resolved === this.context.modelId) {
        if (++exactEntries > 1) throw Error('model_metadata_invalid')
        available = true
      }
      if (model.value === 'haiku') {
        if (++productEntries > 1) throw Error('model_metadata_invalid')
        if (resolved === this.context.modelId) available = true
      }
    }
    if (!available) throw Error('model_unavailable')
    const account = record(init.account)
    if (account.apiProvider !== 'firstParty') throw Error('unsupported_provider')
    const projected = Object.fromEntries(
      [
        'apiProvider',
        'email',
        'organization',
        'subscriptionType',
        'tokenSource',
        'apiKeySource',
      ].map((key) => [key, scalar(account[key], 1024)]),
    )
    const helper =
      projected.tokenSource === 'apiKeyHelper' || projected.apiKeySource === 'apiKeyHelper'
    const identity = Boolean(projected.email && projected.organization)
    // 2.1.272 reports a stored account summary, not an identity bound to the
    // credential produced by an arbitrary CWD-sensitive helper. Equal commands
    // and equal stored OAuth account fields cannot establish that equivalence.
    if (helper) throw Error('unsupported_authentication')
    if (
      projected.apiKeySource !== 'ANTHROPIC_API_KEY' &&
      projected.tokenSource !== 'ANTHROPIC_AUTH_TOKEN' &&
      !identity &&
      !helper
    )
      throw Error('unsupported_authentication')
    return { hash: fingerprint(projected), helper, identity }
  }
  private settings(
    value: unknown,
    account: { hash: string; helper: boolean; identity: boolean },
    guarded: boolean,
    originalDestination?: string,
  ): Authority {
    const metadata = record(value),
      effective = record(metadata.effective),
      applied = record(metadata.applied)
    if (
      metadata.errors !== undefined &&
      (!Array.isArray(metadata.errors) || metadata.errors.length)
    )
      throw Error('unsupported_protocol')
    if (applied.model !== this.context.modelId) throw Error('model_metadata_invalid')
    if (
      effective.disableAllHooks !== true ||
      effective.autoMemoryEnabled !== false ||
      effective.disableWorkflows !== true ||
      effective.disableRemoteControl !== true ||
      !Array.isArray(effective.fallbackModel) ||
      effective.fallbackModel.length
    )
      throw Error('unsupported_protocol')
    const settingsEnv = effective.env === undefined ? {} : record(effective.env)
    const mergedEnv = { ...this.environment, ...settingsEnv }
    // The fixed literal model, its native catalog receipt and the wire guard
    // determine this invocation. Unselected native picker aliases remain intact.
    if (effective.modelPicker !== undefined) throw Error('model_unavailable')
    if (
      [
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_FOUNDRY',
        'CLAUDE_CODE_USE_ANTHROPIC_AWS',
        'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
      ].some((key) => mergedEnv[key] && mergedEnv[key] !== '0')
    )
      throw Error('unsupported_provider')
    if (
      [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
        'NODE_EXTRA_CA_CERTS',
        'NODE_TLS_REJECT_UNAUTHORIZED',
        'CLAUDE_CODE_CLIENT_CERT',
        'CLAUDE_CODE_CLIENT_KEY',
        'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
      ].some((key) => mergedEnv[key])
    )
      throw Error('unsupported_network')
    if (effective.apiKeyHelper && !account.identity) throw Error('unsupported_authentication')
    const route = scalar(mergedEnv.ANTHROPIC_BASE_URL) ?? 'https://api.anthropic.com'
    if (guarded && route !== this.guard!.baseUrl) throw Error('unsupported_network')
    const destination = guarded ? originalDestination! : route
    const url = new URL(destination)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(this.context.environment && url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    )
      throw Error('unsupported_network')
    // Normalize only the intentional private transport destination; every other inherited JSON value is frozen.
    settingsEnv.ANTHROPIC_BASE_URL = destination
    effective.env = settingsEnv
    const effectiveHash = fingerprint({
      effective,
      applied,
      policy: metadata.remote_control_policy_lock_reason ?? null,
    })
    return {
      fingerprint: fingerprint([
        account.hash,
        effectiveHash,
        destination,
        this.executable!.identity,
      ]),
      destination,
      account: account.hash,
      effective: effectiveHash,
    }
  }
  private hooks(value: unknown): void {
    const listing = record(value),
      policy = record(listing.policy)
    if (
      policy.policyUnreadable ||
      policy.policyHookCount !== 0 ||
      policy.allDisabled !== true ||
      !Array.isArray(listing.hooks) ||
      listing.hooks.length > 128 ||
      listing.hooks.some((hook) => record(hook).disabled !== true) ||
      (listing.errors !== undefined && (!Array.isArray(listing.errors) || listing.errors.length))
    )
      throw Error('unsupported_protocol')
  }
  private async closeStage(): Promise<void> {
    this.phase = 'closing_stage'
    this.observedUsage = this.guard?.usage ?? this.observedUsage
    this.guard?.stopForwarding()
    const results = await Promise.allSettled([this.group?.close()])
    // Closing joins decoders too; retain counters observed while cancellation was settling.
    this.observedUsage = this.guard?.usage ?? this.observedUsage
    if (
      results.some((result) => result.status === 'rejected') ||
      (this.group && !this.group.released)
    )
      throw Error('cleanup_unconfirmed')
    if (this.guard) this.observedTransport = this.transport?.diagnostics() ?? this.observedTransport
    await this.transport?.release()
    await this.guard?.close()
    this.transport = undefined
    this.group = undefined
    this.guard = undefined
    this.previousPhysicalReleased = true
  }
  private cleanup(): Promise<boolean> {
    this.cleanupTask ??= (async () => {
      const deadlineAt = Date.now() + DECISION_CLEANUP_TARGET_MS
      try {
        await this.closeStage()
        if (this.directory) {
          const identity = await lstat(this.directory.path)
          if (
            identity.isSymbolicLink() ||
            identity.dev !== this.directory.dev ||
            identity.ino !== this.directory.ino
          )
            throw Error('cleanup_unconfirmed')
          await rm(this.directory.path, { recursive: true, force: true })
          this.directory = undefined
        }
        if (this.receiptRetirementFailed) throw Error('cleanup_unconfirmed')
        const facts: Parameters<
          NonNullable<ClaudeDecisionRuntimeContext['physicalCompletion']>
        >[0] = {
          memory: this.memory,
          deadlineAt,
          nativeGeneration: this.generation,
          witness: this.witness,
          ...(this.usage ? { usage: this.usage } : {}),
        }
        if (this.evaluating) {
          // A host that waits before committing sees the first logical cancellation,
          // even if native work finished before its receipt I/O did. No late work
          // may replace that terminal outcome.
          Object.defineProperty(facts, 'outcome', {
            enumerable: true,
            get: () => this.completionOutcome,
          })
        }
        await this.context.physicalCompletion?.(facts)
        this.hostWorkspace?.release()
        this.framingWorkspace?.release()
        this.ownerWorkspace?.release()
        for (const key of Object.keys(this.environment)) delete this.environment[key]
        this.memory.release()
        this.phase = 'released'
        return true
      } catch {
        this.failureReason = 'cleanup_unconfirmed'
        this.phase = 'cleanup_unconfirmed'
        return false
      }
    })()
    return this.cleanupTask
  }
  settlement(): Promise<boolean> {
    return this.physical ?? this.cleanup()
  }
  dispose(): Promise<boolean> {
    this.disposed = true
    this.cancelLogical?.()
    this.controller.abort()
    return this.settlement()
  }
}
