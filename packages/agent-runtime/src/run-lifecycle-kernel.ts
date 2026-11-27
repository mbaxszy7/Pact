import type { ConfirmedUnsentBoundary } from '@pact/contracts'

import type { BoundedWorkLedgerOptions } from './bounded-work-ledger.js'
import type { AgentId } from './types.js'

import { BoundedWorkLedger } from './bounded-work-ledger.js'

/**
 * Explicit 8-phase finite state machine for a single native Run execution:
 *   PreLease -> BootstrappingSession -> ReadyToDispatch -> DispatchedStreaming
 *     -> TerminalObserved | AbortRequested -> DrainingEffects -> Settled
 */
export type RunLifecyclePhase =
  | 'PreLease'
  | 'BootstrappingSession'
  | 'ReadyToDispatch'
  | 'DispatchedStreaming'
  | 'TerminalObserved'
  | 'AbortRequested'
  | 'DrainingEffects'
  | 'Settled'

const ALLOWED_TRANSITIONS: Readonly<Record<RunLifecyclePhase, readonly RunLifecyclePhase[]>> = {
  PreLease: ['BootstrappingSession', 'AbortRequested', 'DrainingEffects'],
  BootstrappingSession: [
    'ReadyToDispatch',
    'TerminalObserved',
    'AbortRequested',
    'DrainingEffects',
  ],
  ReadyToDispatch: ['DispatchedStreaming', 'TerminalObserved', 'AbortRequested', 'DrainingEffects'],
  DispatchedStreaming: ['TerminalObserved', 'AbortRequested', 'DrainingEffects'],
  TerminalObserved: ['DrainingEffects'],
  AbortRequested: ['TerminalObserved', 'DrainingEffects'],
  DrainingEffects: ['Settled'],
  Settled: [],
}

export type RunDispatchPhase = 'none' | 'possibly_sent' | 'accepted' | 'rejected'
export type RunTerminalOutcome = 'completed' | 'failed' | 'interrupted'
export type NativeEffectsState = 'pending' | 'settled' | 'unknown'

/**
 * Exhaustive classification of runtime side effects.
 * - `PROCESS_BOUND`: tied to a live foreground native process/turn; must never be admitted
 *   once foreground output freezes or abort/drain begins.
 * - `REPLAY_SAFE`: idempotent observation/settlement facts safe to admit through drain.
 */
export type RunEffectDisposition = 'PROCESS_BOUND' | 'REPLAY_SAFE'

export type RunEffectKind =
  | 'permission_request'
  | 'user_input_request'
  | 'in_turn_steer'
  | 'open_plan_publish'
  | 'peer_assistance_request'
  | 'mcp_tool_call'
  | 'session_title_sync'
  | 'stream_delta'
  | 'native_evidence'
  | 'input_consumption'
  | 'background_report'
  | 'archived_event'
  | 'file_change_record'
  | 'native_effects_settlement'
  | 'native_title_observation'
  | 'effective_settings_receipt'

export const RUN_EFFECT_DISPOSITION = {
  permission_request: 'PROCESS_BOUND',
  user_input_request: 'PROCESS_BOUND',
  in_turn_steer: 'PROCESS_BOUND',
  open_plan_publish: 'PROCESS_BOUND',
  peer_assistance_request: 'PROCESS_BOUND',
  mcp_tool_call: 'PROCESS_BOUND',
  session_title_sync: 'PROCESS_BOUND',
  stream_delta: 'PROCESS_BOUND',
  native_evidence: 'REPLAY_SAFE',
  input_consumption: 'REPLAY_SAFE',
  background_report: 'REPLAY_SAFE',
  archived_event: 'REPLAY_SAFE',
  file_change_record: 'REPLAY_SAFE',
  native_effects_settlement: 'REPLAY_SAFE',
  native_title_observation: 'REPLAY_SAFE',
  effective_settings_receipt: 'REPLAY_SAFE',
} as const satisfies Record<RunEffectKind, RunEffectDisposition>

export type BindingRejectionKind =
  | 'occupied'
  | 'archived'
  | 'confirmed_missing'
  | 'identity_mismatch'
  | 'rpc_protocol_error'

export class RunLifecycleInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunLifecycleInvariantError'
  }
}

export class NativeBindingRejectionError extends Error {
  constructor(
    readonly rejectionKind: BindingRejectionKind,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'NativeBindingRejectionError'
  }
}

export function classifyBindingRejection(input: {
  readonly code?: string | number | undefined
  readonly message: string
  readonly occupied?: boolean | undefined
  readonly archived?: boolean | undefined
  readonly confirmedMissing?: boolean | undefined
  readonly identityMismatch?: boolean | undefined
}): BindingRejectionKind {
  if (input.occupied) return 'occupied'
  if (input.archived) return 'archived'
  if (input.confirmedMissing) return 'confirmed_missing'
  if (input.identityMismatch) return 'identity_mismatch'
  const lower = input.message.toLowerCase()
  if (lower.includes('archived')) return 'archived'
  if (
    lower.includes('no rollout found for thread id') ||
    lower.includes('session not found') ||
    lower.includes('trajectory not found')
  ) {
    return 'confirmed_missing'
  }
  if (lower.includes('already active') || lower.includes('occupied') || lower.includes('busy')) {
    return 'occupied'
  }
  if (lower.includes('identity') || lower.includes('mismatch') || lower.includes('foreign')) {
    return 'identity_mismatch'
  }
  return 'rpc_protocol_error'
}

export const NATIVE_TERMINAL_FAILURE_MAX_CHARS = 240

const REDACT_SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  /\bsk-[A-Za-z0-9_-]{12,}/gu,
  /\b(?:api[_-]?key|token|secret|authorization)\s*[:=]\s*["']?[^\s"',;]{6,}["']?/giu,
]

/**
 * Single authoritative sanitizer for provider terminal failure detail (Rule A5):
 * strips ASCII control characters, collapses whitespace, redacts obvious credentials,
 * and caps the output at 240 characters.
 */
export function sanitizeNativeTerminalFailure(
  raw: unknown,
  maxChars = NATIVE_TERMINAL_FAILURE_MAX_CHARS,
): string {
  const rawMessage =
    raw !== null && raw !== undefined && typeof raw === 'object' && 'message' in raw
      ? Reflect.get(raw, 'message')
      : undefined
  const source =
    raw instanceof Error
      ? raw.message
      : typeof raw === 'string'
        ? raw
        : typeof rawMessage === 'string'
          ? rawMessage
          : typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint'
            ? String(raw)
            : ''
  let cleaned = ''
  for (const ch of source) {
    const code = ch.charCodeAt(0)
    cleaned += code < 32 || code === 127 ? ' ' : ch
  }
  cleaned = cleaned.replaceAll(/\s+/gu, ' ').trim()
  for (const pattern of REDACT_SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[redacted]')
  }
  const bound = Math.max(1, maxChars)
  if (cleaned.length <= bound) return cleaned
  if (bound <= 1) return cleaned.slice(0, bound)
  return `${cleaned.slice(0, bound - 1).trimEnd()}…`
}

/**
 * LIFO resource cleanup container. Every registered cleanup runs at most once,
 * in strict reverse registration order, isolating individual failures so later
 * cleanups always run.
 */
export class DisposableScope {
  private readonly cleanups: Array<() => void | Promise<void>> = []
  private disposedFlag = false

  get disposed(): boolean {
    return this.disposedFlag
  }

  get size(): number {
    return this.cleanups.length
  }

  register(cleanup: () => void | Promise<void>): () => void {
    if (this.disposedFlag) {
      void Promise.resolve()
        .then(() => cleanup())
        .catch(() => undefined)
      return () => undefined
    }
    this.cleanups.push(cleanup)
    let active = true
    return () => {
      if (!active) return
      active = false
      const idx = this.cleanups.lastIndexOf(cleanup)
      if (idx !== -1) this.cleanups.splice(idx, 1)
    }
  }

  async disposeAll(): Promise<readonly unknown[]> {
    if (this.disposedFlag) return []
    this.disposedFlag = true
    const errors: unknown[] = []
    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop()!
      try {
        // oxlint-disable-next-line no-await-in-loop -- Strict LIFO teardown order is a lifecycle invariant.
        await cleanup()
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    return errors
  }
}

export interface GenerationSnapshot {
  readonly sessionGen: number
  readonly connectionGen: number
  readonly ownerGen: number
}

export interface RunLifecycleKernelCallbacks {
  readonly onExecutorBound?: ((executorId: string) => void) | undefined
  readonly onDispatchPhase?:
    | ((
        phase: Exclude<RunDispatchPhase, 'none'>,
        nativeSessionId?: string,
        executorId?: string,
      ) => void)
    | undefined
  readonly onTerminalFrozen?: ((outcome: RunTerminalOutcome, detail?: string) => void) | undefined
  readonly onConfirmedUnsent?:
    | ((
        boundary: ConfirmedUnsentBoundary,
        identity: { executorId: string; nativeSessionId: string },
      ) => void)
    | undefined
  readonly onReportNativeEffects?:
    | ((report: {
        runId: string
        generation: string
        state: NativeEffectsState
        reason?: string
      }) => void)
    | undefined
}

export interface RunLifecycleKernelOptions {
  readonly agentId: AgentId
  readonly runId: string
  readonly sessionId: string
  readonly nativeGeneration: string
  readonly initialSessionGen?: number | undefined
  readonly initialConnectionGen?: number | undefined
  readonly initialOwnerGen?: number | undefined
  readonly ledger?: BoundedWorkLedgerOptions | undefined
  readonly callbacks?: RunLifecycleKernelCallbacks | undefined
}

export interface RunLifecycleSnapshot {
  readonly phase: RunLifecyclePhase
  readonly dispatchPhase: RunDispatchPhase
  readonly executorId: string | undefined
  readonly nativeSessionId: string | undefined
  readonly terminalOutcome: RunTerminalOutcome | undefined
  readonly terminalDetail: string | undefined
  readonly foregroundOutputFrozen: boolean
  readonly abortRequested: boolean
  readonly effectsState: NativeEffectsState | undefined
  readonly confirmedUnsentBoundary: ConfirmedUnsentBoundary | undefined
  readonly fences: GenerationSnapshot
}

/**
 * Shared explicit-FSM execution kernel for Claude, Codex, and Agy TurnSessions.
 *
 * Centralizes:
 * 1. Explicit 8-phase lifecycle FSM with illegal-transition rejection.
 * 2. Three orthogonal generation fences (`sessionGen`, `connectionGen`, `ownerGen`).
 * 3. Exhaustive `PROCESS_BOUND` vs `REPLAY_SAFE` effect admission gating.
 * 4. Monotonic dispatch phase & confirmed-unsent proof guard.
 * 5. Terminal-first foreground output freeze & irreversible `unknown` effects lock.
 * 6. LIFO `DisposableScope` & `BoundedWorkLedger` (8 concurrency / 64 FIFO).
 */
export class RunLifecycleKernel<TMeta = undefined> {
  readonly agentId: AgentId
  readonly runId: string
  readonly sessionId: string
  readonly nativeGeneration: string
  readonly disposables = new DisposableScope()
  readonly ledger: BoundedWorkLedger<TMeta>

  private readonly callbacks: RunLifecycleKernelCallbacks
  private phaseValue: RunLifecyclePhase = 'PreLease'
  private dispatchPhaseValue: RunDispatchPhase = 'none'
  private executorIdValue: string | undefined
  private nativeSessionIdValue: string | undefined
  private terminalOutcomeValue: RunTerminalOutcome | undefined
  private terminalDetailValue: string | undefined
  private foregroundOutputFrozenFlag = false
  private abortRequestedFlag = false
  private effectsStateValue: NativeEffectsState | undefined
  private confirmedUnsentBoundaryValue: ConfirmedUnsentBoundary | undefined

  private sessionGenValue: number
  private connectionGenValue: number
  private ownerGenValue: number

  constructor(options: RunLifecycleKernelOptions) {
    this.agentId = options.agentId
    this.runId = options.runId
    this.sessionId = options.sessionId
    this.nativeGeneration = options.nativeGeneration
    this.sessionGenValue = options.initialSessionGen ?? 1
    this.connectionGenValue = options.initialConnectionGen ?? 1
    this.ownerGenValue = options.initialOwnerGen ?? 1
    this.callbacks = options.callbacks ?? {}
    this.ledger = new BoundedWorkLedger<TMeta>(options.ledger)
  }

  get phase(): RunLifecyclePhase {
    return this.phaseValue
  }

  get dispatchPhase(): RunDispatchPhase {
    return this.dispatchPhaseValue
  }

  get executorId(): string | undefined {
    return this.executorIdValue
  }

  get nativeSessionId(): string | undefined {
    return this.nativeSessionIdValue
  }

  get terminalOutcome(): RunTerminalOutcome | undefined {
    return this.terminalOutcomeValue
  }

  get terminalDetail(): string | undefined {
    return this.terminalDetailValue
  }

  get isForegroundOutputFrozen(): boolean {
    return this.foregroundOutputFrozenFlag
  }

  get isAbortRequested(): boolean {
    return this.abortRequestedFlag
  }

  get effectsState(): NativeEffectsState | undefined {
    return this.effectsStateValue
  }

  snapshotFences(): GenerationSnapshot {
    return {
      sessionGen: this.sessionGenValue,
      connectionGen: this.connectionGenValue,
      ownerGen: this.ownerGenValue,
    }
  }

  isFenceCurrent(snapshot: GenerationSnapshot): boolean {
    return (
      snapshot.sessionGen === this.sessionGenValue &&
      snapshot.connectionGen === this.connectionGenValue &&
      snapshot.ownerGen === this.ownerGenValue
    )
  }

  bumpSessionGen(): number {
    this.sessionGenValue += 1
    return this.sessionGenValue
  }

  bumpConnectionGen(): number {
    this.connectionGenValue += 1
    return this.connectionGenValue
  }

  bumpOwnerGen(): number {
    this.ownerGenValue += 1
    return this.ownerGenValue
  }

  transition(next: RunLifecyclePhase): void {
    if (this.phaseValue === next) return
    const allowed = ALLOWED_TRANSITIONS[this.phaseValue]
    if (!allowed.includes(next)) {
      throw new RunLifecycleInvariantError(
        `Illegal RunLifecycleKernel transition ${this.phaseValue} -> ${next} for run ${this.runId}.`,
      )
    }
    this.phaseValue = next
    if (
      next === 'TerminalObserved' ||
      next === 'AbortRequested' ||
      next === 'DrainingEffects' ||
      next === 'Settled'
    ) {
      this.foregroundOutputFrozenFlag = true
    }
  }

  bindExecutor(executorId: string): void {
    if (!executorId) {
      throw new RunLifecycleInvariantError('Executor ID must be non-empty.')
    }
    if (this.executorIdValue !== undefined) {
      if (this.executorIdValue === executorId) return
      throw new RunLifecycleInvariantError(
        `Run ${this.runId} already bound to executor ${this.executorIdValue}; cannot rebind to ${executorId}.`,
      )
    }
    this.executorIdValue = executorId
    if (this.phaseValue === 'PreLease') {
      this.transition('BootstrappingSession')
    }
    this.callbacks.onExecutorBound?.(executorId)
  }

  bindNativeSession(nativeSessionId: string): void {
    if (!nativeSessionId) return
    this.nativeSessionIdValue = nativeSessionId
  }

  markReadyToDispatch(nativeSessionId?: string): void {
    if (nativeSessionId) this.nativeSessionIdValue = nativeSessionId
    if (this.phaseValue === 'PreLease') {
      this.transition('BootstrappingSession')
    }
    if (this.phaseValue === 'BootstrappingSession') {
      this.transition('ReadyToDispatch')
    }
  }

  recordDispatch(
    phase: Exclude<RunDispatchPhase, 'none'>,
    nativeSessionId?: string,
    executorId?: string,
  ): boolean {
    if (nativeSessionId) this.nativeSessionIdValue = nativeSessionId
    if (executorId && !this.executorIdValue) this.executorIdValue = executorId

    if (this.phaseValue === 'Settled') return false

    if (phase === 'possibly_sent') {
      if (this.dispatchPhaseValue !== 'none') return false
      if (this.phaseValue === 'BootstrappingSession') this.transition('ReadyToDispatch')
      if (this.phaseValue === 'ReadyToDispatch') this.transition('DispatchedStreaming')
      this.dispatchPhaseValue = 'possibly_sent'
      this.callbacks.onDispatchPhase?.(
        'possibly_sent',
        this.nativeSessionIdValue,
        this.executorIdValue,
      )
      return true
    }

    if (phase === 'accepted') {
      if (this.dispatchPhaseValue === 'accepted' || this.dispatchPhaseValue === 'rejected') {
        return false
      }
      if (this.phaseValue === 'BootstrappingSession') this.transition('ReadyToDispatch')
      if (this.phaseValue === 'ReadyToDispatch') this.transition('DispatchedStreaming')
      this.dispatchPhaseValue = 'accepted'
      this.callbacks.onDispatchPhase?.('accepted', this.nativeSessionIdValue, this.executorIdValue)
      return true
    }

    // phase === 'rejected'
    if (this.dispatchPhaseValue === 'accepted' || this.dispatchPhaseValue === 'rejected') {
      return false
    }
    this.dispatchPhaseValue = 'rejected'
    this.callbacks.onDispatchPhase?.('rejected', this.nativeSessionIdValue, this.executorIdValue)
    return true
  }

  recordConfirmedUnsent(
    boundary: ConfirmedUnsentBoundary,
    identity: { executorId: string; nativeSessionId: string },
  ): boolean {
    if (
      this.confirmedUnsentBoundaryValue !== undefined ||
      this.dispatchPhaseValue === 'accepted' ||
      this.terminalOutcomeValue !== undefined ||
      this.phaseValue === 'Settled'
    ) {
      return false
    }
    this.confirmedUnsentBoundaryValue = boundary
    this.callbacks.onConfirmedUnsent?.(boundary, identity)
    return true
  }

  requestAbort(): boolean {
    if (this.phaseValue === 'Settled' || this.phaseValue === 'DrainingEffects') {
      return false
    }
    this.abortRequestedFlag = true
    this.foregroundOutputFrozenFlag = true
    if (this.phaseValue !== 'TerminalObserved' && this.phaseValue !== 'AbortRequested') {
      this.transition('AbortRequested')
    }
    return true
  }

  /**
   * Irreversible terminal-first gate: records the first terminal outcome, freezes
   * foreground output synchronously, and ignores subsequent contradictory terminals.
   */
  recordTerminal(outcome: RunTerminalOutcome, rawDetail?: unknown): boolean {
    if (this.terminalOutcomeValue !== undefined) {
      return false
    }
    if (this.phaseValue === 'Settled') {
      return false
    }
    const detail =
      rawDetail !== undefined ? sanitizeNativeTerminalFailure(rawDetail) || undefined : undefined
    this.terminalOutcomeValue = outcome
    this.terminalDetailValue = detail
    this.foregroundOutputFrozenFlag = true
    if (
      this.phaseValue === 'BootstrappingSession' ||
      this.phaseValue === 'ReadyToDispatch' ||
      this.phaseValue === 'DispatchedStreaming' ||
      this.phaseValue === 'AbortRequested'
    ) {
      this.transition('TerminalObserved')
    }
    this.callbacks.onTerminalFrozen?.(outcome, detail)
    return true
  }

  /**
   * Authoritative effect gate driven by the exhaustive `RUN_EFFECT_DISPOSITION` table
   * and optional generation fence snapshot.
   */
  canAdmitEffect(kind: RunEffectKind, fenceSnapshot?: GenerationSnapshot): boolean {
    if (fenceSnapshot && !this.isFenceCurrent(fenceSnapshot)) {
      return false
    }
    const disposition = RUN_EFFECT_DISPOSITION[kind]
    if (disposition === 'PROCESS_BOUND') {
      if (this.foregroundOutputFrozenFlag) return false
      return (
        this.phaseValue === 'BootstrappingSession' ||
        this.phaseValue === 'ReadyToDispatch' ||
        this.phaseValue === 'DispatchedStreaming'
      )
    }
    // REPLAY_SAFE: admissible up through DrainingEffects (never after Settled).
    return this.phaseValue !== 'Settled'
  }

  /**
   * Enforces monotonic native effects reporting:
   * - `pending` can move to `settled` or `unknown`.
   * - Once `unknown` is latched (timeout, overflow, crash without proof), it NEVER downgrades to `settled` (L3).
   * - Once `settled` is latched, duplicate `settled` emissions are suppressed.
   */
  reportNativeEffects(state: NativeEffectsState, reason?: string): boolean {
    if (state === 'pending') {
      if (this.effectsStateValue !== undefined) return false
      this.effectsStateValue = 'pending'
      this.callbacks.onReportNativeEffects?.({
        runId: this.runId,
        generation: this.nativeGeneration,
        state: 'pending',
        ...(reason ? { reason } : {}),
      })
      return true
    }
    if (state === 'settled') {
      if (this.effectsStateValue === 'settled' || this.effectsStateValue === 'unknown') {
        return false
      }
      if (this.ledger.hasUncertainOverflow) {
        return this.reportNativeEffects('unknown', 'native_work_overflow')
      }
      this.effectsStateValue = 'settled'
      this.callbacks.onReportNativeEffects?.({
        runId: this.runId,
        generation: this.nativeGeneration,
        state: 'settled',
        ...(reason ? { reason } : {}),
      })
      return true
    }
    // state === 'unknown'
    if (this.effectsStateValue === 'unknown') return false
    this.effectsStateValue = 'unknown'
    this.callbacks.onReportNativeEffects?.({
      runId: this.runId,
      generation: this.nativeGeneration,
      state: 'unknown',
      ...(reason ? { reason } : {}),
    })
    return true
  }

  /**
   * Transitions into `DrainingEffects`, drains the bounded recording queue, runs LIFO
   * disposables, finalizes native effects reporting, and enters `Settled`.
   */
  async settle(
    options: {
      readonly drainSignal?: AbortSignal | undefined
      readonly beforeDispose?: (() => Promise<void> | void) | undefined
      readonly retainBackgroundObservation?: boolean | undefined
    } = {},
  ): Promise<{
    readonly cleanupErrors: readonly unknown[]
    readonly recordingsDrained: boolean
  }> {
    if (this.phaseValue === 'Settled') {
      return { cleanupErrors: [], recordingsDrained: true }
    }
    this.foregroundOutputFrozenFlag = true
    if (this.phaseValue !== 'DrainingEffects') {
      this.transition('DrainingEffects')
    }

    const drainResult = await this.ledger.recordings.drain(options.drainSignal)
    if (!drainResult.drained || drainResult.overflowed) {
      this.reportNativeEffects('unknown', 'native_recording_drain_incomplete')
    }

    const cleanupErrors: unknown[] = []
    if (options.beforeDispose) {
      try {
        await options.beforeDispose()
      } catch (error: unknown) {
        cleanupErrors.push(error)
      }
    }

    const scopeErrors = await this.disposables.disposeAll()
    cleanupErrors.push(...scopeErrors)

    if (!options.retainBackgroundObservation) {
      if (this.ledger.hasPendingWork || this.ledger.hasUncertainOverflow) {
        this.reportNativeEffects('unknown', 'native_work_unconfirmed')
      } else if (this.effectsStateValue === 'pending') {
        this.reportNativeEffects('settled')
      }
      this.ledger.dispose()
    } else if (this.ledger.hasPendingWork) {
      this.reportNativeEffects('pending')
    } else if (this.ledger.hasUncertainOverflow) {
      this.reportNativeEffects('unknown', 'native_work_overflow')
    } else if (this.effectsStateValue === 'pending') {
      this.reportNativeEffects('settled')
    }

    this.transition('Settled')
    return {
      cleanupErrors,
      recordingsDrained: drainResult.drained,
    }
  }

  snapshot(): RunLifecycleSnapshot {
    return {
      phase: this.phaseValue,
      dispatchPhase: this.dispatchPhaseValue,
      executorId: this.executorIdValue,
      nativeSessionId: this.nativeSessionIdValue,
      terminalOutcome: this.terminalOutcomeValue,
      terminalDetail: this.terminalDetailValue,
      foregroundOutputFrozen: this.foregroundOutputFrozenFlag,
      abortRequested: this.abortRequestedFlag,
      effectsState: this.effectsStateValue,
      confirmedUnsentBoundary: this.confirmedUnsentBoundaryValue,
      fences: this.snapshotFences(),
    }
  }
}
