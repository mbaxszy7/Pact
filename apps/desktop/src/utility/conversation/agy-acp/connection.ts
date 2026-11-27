import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { randomUUID } from 'node:crypto'

import {
  diagnosticNativeMethodSchema,
  type DiagnosticFailureSource,
} from '@pact/contracts/diagnostics'

import type { LogicalIpcWorkerTraffic } from '../../../shared/logical-ipc-traffic'
import type {
  AgyConnectionDiagnostics,
  AgyIngress,
  AgyLegacyRequestPhysicalCompletion,
  AgyOrderedSessionStream,
  AgyPermissionScope,
  AgyRequestOperation,
  AgyRequestPhysicalCompletion,
  AgyServerRequestOwnerHandle,
  AgySessionCloseResult,
  AgySessionNotificationStream,
  PendingRequest,
  RegisteredServerRequestOwner,
  RequestFailureReason,
} from './protocol'

import { recordDiagnostic } from '../../../diagnostics/utility-log'
import { AgentExecutionError, NativeCapacityError } from '../agent-execution-error'
import { freezeNativeJsonFrame } from '../native-json-encoder'
import { parseNativeJsonFrame } from '../native-json-parser'
import { NativePermissionWait, safeNativePermissionText } from '../native-permission-wait'
import { NativeWorkingMemory, type NativeMemoryReservation } from '../native-working-memory'
import { AgyOutboundFrameQueue } from './outbound-frame-queue'
import {
  AGY_CONTROL_RPC_TIMEOUT_MS,
  AGY_EXIT_INBOUND_DRAIN_TIMEOUT_MS,
  AGY_FORCE_EXIT_TIMEOUT_MS,
  AGY_FRAME_WORKSPACE_BYTES,
  AGY_INLINE_ENCODING_MEMORY_BYTES,
  AGY_MAX_CONTEXTS,
  AGY_MAX_FRAME_BYTES,
  AGY_PARSE_WORKSPACE_MULTIPLIER,
  AGY_PENDING_REQUEST_LIMIT,
  AGY_SHUTDOWN_TIMEOUT_MS,
  AGY_STDERR_LIMIT_BYTES,
  classifyAgySessionCloseResponse,
  createUnconfirmedProcessError,
  extractCloseSessionId,
  extractNotificationSessionId,
  extractServerRequestSessionId,
  formatCloseErrorDetail,
  isPlainObject,
  requestFailureReasons,
  tagRequestFailure,
  validateJsonRpcResponse,
} from './protocol'
import { AgySessionStreamRouter } from './session-stream-router'

export class AgyAcpConnection {
  readonly executorId = randomUUID()
  private readonly memory: NativeWorkingMemory
  private readonly inboundController = new AbortController()
  private frameReservation: NativeMemoryReservation | undefined
  private inboundProcessing = false
  private activeInboundReservation: NativeMemoryReservation | undefined
  private frameDeadline: ReturnType<typeof setTimeout> | undefined
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly unconfirmedCloseRequestIds = new Set<number>()
  private readonly backgroundListeners = new Set<(message: object) => boolean>()
  private readonly closeListeners = new Set<() => void>()
  private readonly serverRequestListeners = new Set<(message: object) => boolean>()
  private readonly serverRequestOwners = new Map<string, RegisteredServerRequestOwner>()
  private readonly permissionWait = new NativePermissionWait()
  private readonly outbound: AgyOutboundFrameQueue
  private readonly streams: AgySessionStreamRouter
  private frameChunks: Buffer[] = []
  private receiveTask: Promise<void> | undefined
  private parserCompletion: Promise<void> | undefined
  private readonly processClosed: Promise<void>
  private readonly physicalReleaseDeferred = Promise.withResolvers<void>()
  private physicalFinalizationPromise: Promise<void> | undefined
  private shutdownTask: Promise<void> | undefined
  private readonly shutdownDeadlineListeners = new Set<(deadlineAt: number) => void>()
  private shutdownSucceeded = false
  private groupCloseSucceeded = false
  private shutdownStarted = false
  private shutdownAttemptSettled = false
  private closeInFlight = false
  private physicalReleaseObserved = false
  private physicalReleaseFinalized = false
  private ownerReleaseListenerStarted = false
  private ownerReleaseNotified = false
  private lateReleaseWatchStarted = false
  private frameBytes = 0
  private nextRequestId = 0
  private stdoutPaused = false
  private closed = false
  private tainted = false
  private taintError: Error | undefined
  private shutdownPromise: Promise<void> | undefined
  private shutdownDeadlineAt: number | undefined
  private closeError: Error | undefined
  private exitRecorded = false
  private processHasClosed = false
  private stdoutEnded = false
  private exitDrainPending = false
  private exitDrainDeadlineAt: number | undefined
  private exitDrainTimer: ReturnType<typeof setTimeout> | undefined
  private exitDrainDeferred: PromiseWithResolvers<void> | undefined
  private rawStderr = ''
  private stderrBytes = 0

  private readonly receive = (chunk: Buffer): void => {
    this.inboundProcessing = true
    this.updateStdoutPause()
    const task = this.receiveChunk(chunk)
      .catch((error: unknown) => {
        const frameError =
          error instanceof Error ? error : new Error('Native ACP frame read failed.')
        this.fail(frameError, 'transport_failure', {
          cause: 'transport',
          incomplete: true,
          detail: formatCloseErrorDetail(frameError),
        })
        void this.close(frameError).catch(() => undefined)
      })
      .finally(() => {
        this.inboundProcessing = false
        this.updateStdoutPause()
        if (this.exitDrainPending) {
          this.maybeCompleteExitDrain()
        }
      })
    this.receiveTask = task
  }

  private readonly onStdoutEnded = (): void => {
    this.stdoutEnded = true
    if (this.closed) return
    if (this.exitDrainPending) {
      this.maybeCompleteExitDrain()
    } else {
      this.beginExitInboundDrain()
    }
  }

  private readonly onStdoutError = (rawFailure: unknown): void => {
    const streamError =
      rawFailure instanceof Error ? rawFailure : new Error('Native ACP stdout read failed.')
    this.fail(streamError, 'transport_failure', {
      cause: 'transport',
      incomplete: true,
      detail: formatCloseErrorDetail(streamError),
    })
    void this.close(streamError).catch(() => undefined)
  }

  private readonly receiveError = (chunk: Buffer): void => {
    const remaining = AGY_STDERR_LIMIT_BYTES - this.stderrBytes
    if (remaining <= 0) return
    const bounded = chunk.subarray(0, remaining)
    this.stderrBytes += bounded.length
    this.rawStderr = safeNativePermissionText(
      this.rawStderr + bounded.toString('utf8'),
      AGY_STDERR_LIMIT_BYTES,
    )
  }

  private readonly exited = (code: number | null): void => {
    this.processHasClosed = true
    this.recordExit(code)
    if (this.closed) return
    if (!this.exitDrainPending) {
      this.beginExitInboundDrain()
    } else {
      this.maybeCompleteExitDrain()
    }
  }

  private readonly processExited = (code: number | null): void => {
    this.recordExit(code)
    if (!this.closed) {
      this.beginExitInboundDrain()
    }
  }

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly canonicalCwd: string,
    readonly permissionScope: AgyPermissionScope,
    private readonly onClosed?: () => void,
    private readonly closeOwnedProcess?: (deadlineAt?: number) => Promise<void>,
    private readonly ipcTraffic?: LogicalIpcWorkerTraffic,
    private readonly isLifetimeCurrent?: () => boolean,
    private readonly observePhysicalOperation?: (
      signal: AbortSignal | undefined,
      physicalCompletion: Promise<unknown>,
    ) => void,
    private readonly onPhysicalWorkIdle?: () => void,
    private readonly isProcessOwnerReleased?: () => boolean,
    private readonly whenProcessOwnerReleased?: () => Promise<void>,
    private readonly ownsProcessGroup = false,
    private readonly onTainted?: (error: Error) => void,
    private readonly needsOwnerReleaseProbe = Boolean(
      isProcessOwnerReleased && !whenProcessOwnerReleased,
    ),
  ) {
    this.processClosed = new Promise((resolve) =>
      child.once('close', () => {
        this.processHasClosed = true
        resolve()
      }),
    )
    this.memory = new NativeWorkingMemory()
    this.outbound = new AgyOutboundFrameQueue({
      stdin: child.stdin,
      memory: this.memory,
      isOpen: () => this.isOpen,
      isClosed: () => this.closed,
      isLifetimeCurrent: () => this.isLifetimeCurrent?.() ?? true,
      getUnavailableError: () =>
        this.taintError ?? this.closeError ?? new Error('Antigravity ACP server is unavailable.'),
      isRequestActiveForWrite: (requestId) =>
        this.pendingRequests.has(requestId) && !this.pendingRequests.get(requestId)?.logicalSettled,
      getRequestSignal: (requestId) => this.pendingRequests.get(requestId)?.signal,
      onFinishRequestWrite: (requestId) => this.finishRequestWrite(requestId),
      ...(this.observePhysicalOperation
        ? {
            onObservePhysicalOperation: (
              signal: AbortSignal | undefined,
              physicalCompletion: Promise<unknown>,
            ) => this.observePhysicalOperation!(signal, physicalCompletion),
          }
        : {}),
      onPossiblyWrittenWriteFailure: (failure) => {
        void this.close(failure).catch(() => undefined)
      },
      onIdleCheck: () => this.notifyPhysicalWorkIdleIfSettled(),
    })
    this.streams = new AgySessionStreamRouter({
      permissionWait: this.permissionWait,
      isOpen: () => this.isOpen,
      isClosed: () => this.closed,
      isExitDrainPending: () => this.exitDrainPending,
      getCloseError: () => this.taintError ?? this.closeError,
      getUnavailableError: () =>
        this.taintError ?? this.closeError ?? new Error('Antigravity ACP server is unavailable.'),
      sendUnconsumedServerRequestCancel: (rpcId, method) => {
        if (method === 'session/request_permission') {
          return this.respond(rpcId, { outcome: { outcome: 'cancelled' } })
        }
        if (method === 'elicitation/create') {
          return this.respond(rpcId, { action: 'cancel' })
        }
        return this.respondError(
          rpcId,
          'Antigravity session stream closed before handling request.',
          -32_000,
        )
      },
      onTaintAndClose: (cancelError) => {
        this.taint(cancelError)
        if (!this.closed) {
          void this.close(cancelError).catch(() => undefined)
        }
      },
      onCloseIfNotClosed: (closeReason) => {
        if (!this.closed) {
          void this.close(closeReason).catch(() => undefined)
        }
      },
      onBackpressureChanged: () => this.updateStdoutPause(),
      onIdleCheck: () => this.notifyPhysicalWorkIdleIfSettled(),
    })

    this.ensureOwnerReleaseListener()
    recordDiagnostic({
      operation: 'process',
      scope: 'process',
      phase: 'started',
      executorId: this.executorId,
      agentId: 'agy',
      ...(child.pid ? { pid: child.pid } : {}),
    })
    child.stdout.on('data', this.receive)
    child.stdout.once('end', this.onStdoutEnded)
    child.stdout.once('error', this.onStdoutError)
    child.stderr.on('data', this.receiveError)
    child.once('exit', this.processExited)
    child.once('close', this.exited)
  }

  get isOpen(): boolean {
    return (
      !this.closed &&
      !this.tainted &&
      !this.exitRecorded &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    )
  }

  get isTainted(): boolean {
    return this.tainted
  }

  get taintReason(): Error | undefined {
    return this.taintError
  }

  get closeReason(): Error | undefined {
    return this.taintError ?? this.closeError
  }

  get workingMemoryBytes(): number {
    return this.memory.bytes
  }

  get isProcessAlive(): boolean {
    return !this.exitRecorded && this.child.exitCode === null && this.child.signalCode === null
  }

  get hasProcessClosed(): boolean {
    return this.processHasClosed
  }

  get isPhysicallyReleased(): boolean {
    return this.physicalReleaseFinalized
  }

  hasObservedPhysicalRelease(): boolean {
    return this.physicalReleaseObserved
  }

  isCloseInFlight(): boolean {
    return this.closeInFlight
  }

  whenProcessExited(): Promise<void> {
    return this.processClosed
  }

  whenPhysicallyReleased(): Promise<void> {
    return this.physicalReleaseDeferred.promise
  }

  existingClosePromise(): Promise<void> | undefined {
    return this.shutdownPromise
  }

  supportsReleaseProbe(): boolean {
    return this.needsOwnerReleaseProbe
  }

  private isOwnerReleaseConfirmed(): boolean {
    if (this.isProcessOwnerReleased && !this.isProcessOwnerReleased()) return false
    if (this.whenProcessOwnerReleased && !this.ownerReleaseNotified) return false
    if (this.ownsProcessGroup) {
      const hasExplicitWitness = Boolean(
        this.isProcessOwnerReleased || this.whenProcessOwnerReleased,
      )
      if (!this.groupCloseSucceeded && !hasExplicitWitness) {
        return false
      }
    }
    return true
  }

  recheckPhysicalRelease(): boolean {
    if (this.physicalReleaseObserved) return true
    if (!this.shutdownAttemptSettled || !this.processHasClosed) return false
    if (!this.isOwnerReleaseConfirmed()) return false
    this.markPhysicalReleaseVerified()
    return true
  }

  markUnconfirmedCloseRequests(sessionId: string): void {
    let added = false
    for (const [id, pending] of this.pendingRequests) {
      if (
        pending.method === 'session/close' &&
        pending.logicalSettled &&
        pending.replyTerminal !== 'reply' &&
        pending.closeSessionId === sessionId
      ) {
        if (!this.unconfirmedCloseRequestIds.has(id)) {
          this.unconfirmedCloseRequestIds.add(id)
          added = true
        }
      }
    }
    if (added) {
      this.notifyPhysicalWorkIdleIfSettled()
    }
  }

  get totalActiveOrInitializingOwners(): number {
    return this.serverRequestOwners.size
  }

  hasActiveSessionOwners(): boolean {
    return (
      this.serverRequestOwners.size > 0 ||
      this.serverRequestListeners.size > 0 ||
      this.backgroundListeners.size > 0 ||
      this.streams.hasGlobalWaiter
    )
  }

  get stderrText(): string {
    return safeNativePermissionText(this.rawStderr.trim(), AGY_STDERR_LIMIT_BYTES)
  }

  hasPendingPhysicalWork(): boolean {
    return (
      this.pendingRequests.size > 0 || this.outbound.hasPendingWork || this.streams.hasPendingWork
    )
  }

  hasActiveWorkExcludingUnconfirmedCloses(): boolean {
    if (this.outbound.hasPendingWork || this.streams.hasPendingWork) {
      return true
    }
    for (const id of this.pendingRequests.keys()) {
      if (!this.unconfirmedCloseRequestIds.has(id)) return true
    }
    return false
  }

  async closeSession(
    sessionId: string,
    options: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<AgySessionCloseResult> {
    if (options.signal?.aborted) {
      return {
        confirmed: false,
        reason: 'cancelled',
        detail: 'Antigravity was interrupted.',
      }
    }
    if (!this.isOpen) {
      const detail = formatCloseErrorDetail(
        this.taintError ?? this.closeError ?? 'Antigravity ACP connection is closed.',
      )
      return {
        confirmed: false,
        reason: 'transport_closed',
        ...(detail !== undefined ? { detail } : {}),
      }
    }
    const timeoutMs = options.timeoutMs ?? AGY_CONTROL_RPC_TIMEOUT_MS
    const op = this.requestOwned(
      'session/close',
      { sessionId },
      { timeoutMs, signal: options.signal, exemptFromPermissionWait: true },
    )
    try {
      const response = await op.result
      return classifyAgySessionCloseResponse(response)
    } catch (error) {
      if (this.pendingRequests.has(op.requestId)) {
        this.unconfirmedCloseRequestIds.add(op.requestId)
        this.notifyPhysicalWorkIdleIfSettled()
      }
      const detail = formatCloseErrorDetail(error)
      const tagged = error instanceof Error ? requestFailureReasons.get(error) : undefined
      const reason: RequestFailureReason =
        tagged ??
        (error instanceof NativeCapacityError
          ? 'capacity'
          : error instanceof AgentExecutionError && error.kind === 'protocol_error'
            ? 'protocol_error'
            : 'transport_closed')
      return {
        confirmed: false,
        reason,
        ...(detail !== undefined ? { detail } : {}),
      }
    }
  }

  reserveWorkingMemory(bytes: number): NativeMemoryReservation {
    return this.memory.reserve(bytes)
  }

  diagnostics(): AgyConnectionDiagnostics {
    return {
      pendingRequests: [...this.pendingRequests.values()].filter(
        (request) => !request.logicalSettled,
      ).length,
      pendingPhysicalRequests: this.pendingRequests.size,
      queuedMessages: this.streams.queuedInboundCount,
      queuedInboundBytes: this.streams.queuedInboundBytes,
      queuedOutboundFrames: this.outbound.queuedFrameCount,
      queuedOutboundBytes: this.outbound.queuedOutboundBytes,
      waitingForNotification: this.streams.hasWaitingConsumer,
      stdoutPaused: this.stdoutPaused,
      open: this.isOpen,
    }
  }

  request(
    method: string,
    params: object,
    options: {
      timeoutMs: number | undefined
      signal?: AbortSignal | undefined
      onDispatch?: (() => void) | undefined
      canDispatch?: (() => boolean) | undefined
      exemptFromPermissionWait?: boolean | undefined
      replyTo?: AgyOrderedSessionStream | AgySessionNotificationStream | undefined
    },
  ): Promise<object> {
    return this.requestOwned(method, params, options).result
  }

  requestOwned(
    method: string,
    params: object,
    options: {
      timeoutMs: number | undefined
      signal?: AbortSignal | undefined
      onDispatch?: (() => void) | undefined
      canDispatch?: (() => boolean) | undefined
      exemptFromPermissionWait?: boolean | undefined
      replyTo?: AgyOrderedSessionStream | AgySessionNotificationStream | undefined
    },
  ): AgyRequestOperation {
    const id = this.nextRequestId
    this.nextRequestId += 1

    if (options.signal?.aborted) {
      return {
        requestId: id,
        result: Promise.reject(
          tagRequestFailure(
            new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
            'cancelled',
          ),
        ),
        physicalCompletion: Promise.resolve('not_sent'),
        physicalOutcome: Promise.resolve('not_sent'),
      }
    }
    const replyConsumer =
      options.replyTo !== undefined
        ? this.streams.lookupConsumerForStream(options.replyTo)
        : undefined
    if (options.replyTo !== undefined && !replyConsumer) {
      return {
        requestId: id,
        result: Promise.reject(
          tagRequestFailure(
            new AgentExecutionError(
              'protocol_error',
              'Antigravity replyTo stream does not belong to this ACP connection.',
              false,
            ),
            'protocol_error',
          ),
        ),
        physicalCompletion: Promise.resolve('not_sent'),
        physicalOutcome: Promise.resolve('not_sent'),
      }
    }
    if (this.pendingRequests.size >= AGY_PENDING_REQUEST_LIMIT) {
      return {
        requestId: id,
        result: Promise.reject(
          tagRequestFailure(
            new AgentExecutionError(
              'protocol_error',
              'Antigravity exceeded Pact’s pending request budget.',
              false,
            ),
            'capacity',
          ),
        ),
        physicalCompletion: Promise.resolve('not_sent'),
        physicalOutcome: Promise.resolve('not_sent'),
      }
    }

    let physicalResolve!: PendingRequest['physicalResolve']
    const physicalOutcome = new Promise<AgyRequestPhysicalCompletion>((resolve) => {
      physicalResolve = resolve
    })
    const physicalCompletion: Promise<AgyLegacyRequestPhysicalCompletion> = physicalOutcome.then(
      (outcome) => (outcome === 'invalid_reply' ? 'connection_closed' : outcome),
    )
    this.observePhysicalOperation?.(options.signal, physicalOutcome)

    const exemptFromPermissionWait = options.exemptFromPermissionWait ?? method === 'session/close'
    const closeSessionId = extractCloseSessionId(method, params)

    const response = new Promise<object>((resolve, reject) => {
      const expired = (): void => {
        this.settleRequest(
          id,
          tagRequestFailure(
            new AgentExecutionError(
              'transient_transport',
              `Antigravity did not answer ${method} before its deadline.`,
              true,
            ),
            'timeout',
          ),
          undefined,
          'timeout',
        )
      }
      const methodName = diagnosticNativeMethodSchema.safeParse(method)
      const pending: PendingRequest = {
        method,
        closeSessionId,
        replyConsumer,
        startedAt: Date.now(),
        diagnostic: {
          operation: 'process',
          scope: 'request',
          phase: 'started',
          level: 'debug',
          agentId: 'agy',
          operationId: randomUUID(),
          executorId: this.executorId,
          nativeMethod: methodName.success ? methodName.data : 'unrecognized',
        },
        resolve,
        reject,
        timeout: undefined,
        signal: options.signal,
        logicalSettled: false,
        dispatched: false,
        writeJoined: false,
        replyTerminal: undefined,
        physicalResolve,
      }
      if (exemptFromPermissionWait) {
        if (options.timeoutMs !== undefined) {
          pending.timeout = setTimeout(expired, options.timeoutMs)
        }
      } else {
        const arm = (): void => {
          clearTimeout(pending.timeout)
          pending.timeout =
            this.permissionWait.waiting || options.timeoutMs === undefined
              ? undefined
              : setTimeout(expired, options.timeoutMs)
        }
        pending.pauseCleanup = this.permissionWait.subscribe(arm)
        arm()
      }
      if (options.signal) {
        pending.abort = (): void => {
          this.settleRequest(
            id,
            tagRequestFailure(
              new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
              'cancelled',
            ),
            undefined,
            'cancelled',
          )
        }
        options.signal.addEventListener('abort', pending.abort, { once: true })
      }
      this.pendingRequests.set(id, pending)
      this.updateStdoutPause()
      recordDiagnostic(pending.diagnostic)
    })

    const writing = this.outbound.enqueue(
      { jsonrpc: '2.0', method, id, params },
      {
        requestId: id,
        onDispatch: () => {
          const pending = this.pendingRequests.get(id)
          options.onDispatch?.()
          if (pending) pending.dispatched = true
        },
        canDispatch: options.canDispatch,
      },
    )
    void writing.catch((error: unknown) => {
      this.settleRequest(id, error instanceof Error ? error : new Error(String(error)))
    })
    return { requestId: id, result: response, physicalCompletion, physicalOutcome }
  }

  async notify(
    method: string,
    params: object,
    options: { signal?: AbortSignal | undefined; canDispatch?: (() => boolean) | undefined } = {},
  ): Promise<void> {
    await this.outbound.enqueue(
      { jsonrpc: '2.0', method, params },
      { canDispatch: options.canDispatch, cancelBeforeWriteSignal: options.signal },
    )
  }

  async respond(id: string | number, result: object): Promise<void> {
    if (
      (typeof id === 'string' && id.length > 1024) ||
      (typeof id === 'number' && !Number.isSafeInteger(id))
    ) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity returned an invalid request identity.',
        false,
      )
    }
    await this.outbound.enqueue({ jsonrpc: '2.0', id, result }, {})
  }

  async respondError(id: string | number, message: string, code = -32_601): Promise<void> {
    if (
      (typeof id === 'string' && id.length > 1024) ||
      (typeof id === 'number' && !Number.isSafeInteger(id))
    ) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity returned an invalid request identity.',
        false,
      )
    }
    await this.outbound.enqueue(
      {
        jsonrpc: '2.0',
        id,
        error: { code, message: safeNativePermissionText(message, 1024) },
      },
      {},
    )
  }

  subscribeBackground(listener: (message: object) => boolean): () => void {
    if (this.backgroundListeners.size >= 9) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Too many owned Antigravity background observers.',
        false,
      )
    }
    this.backgroundListeners.add(listener)
    return () => {
      if (this.backgroundListeners.delete(listener)) {
        this.notifyPhysicalWorkIdleIfSettled()
      }
    }
  }

  onClose(listener: () => void): () => void {
    if (!this.isOpen) {
      try {
        listener()
      } catch {
        // Ignore close observer failures.
      }
      return () => undefined
    }
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  hasActiveSessionConsumer(sessionId: string): boolean {
    return Boolean(this.streams.getActiveConsumer(sessionId))
  }

  subscribeServerRequests(listener: (message: object) => boolean): () => void {
    if (this.serverRequestListeners.size >= 8) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Too many owned Antigravity server request handlers.',
        false,
      )
    }
    this.serverRequestListeners.add(listener)
    this.updateStdoutPause()
    return () => {
      if (this.serverRequestListeners.delete(listener)) {
        this.updateStdoutPause()
        this.notifyPhysicalWorkIdleIfSettled()
      }
    }
  }

  registerServerRequestOwner(input: {
    ownerId: string
    knownSessionId?: string | undefined
    handler: (message: object, seq?: number) => boolean
  }): AgyServerRequestOwnerHandle {
    if (!input.ownerId || input.ownerId.length > 1024) {
      throw new AgentExecutionError(
        'protocol_error',
        'Invalid Antigravity server request owner identity.',
        false,
      )
    }
    if (
      !this.serverRequestOwners.has(input.ownerId) &&
      this.serverRequestOwners.size >= AGY_MAX_CONTEXTS * 2
    ) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Too many owned Antigravity server request owners.',
        false,
      )
    }
    const entry: RegisteredServerRequestOwner = {
      ownerId: input.ownerId,
      knownSessionId: input.knownSessionId,
      handler: input.handler,
    }
    this.serverRequestOwners.set(input.ownerId, entry)
    this.updateStdoutPause()
    return {
      updateSessionId: (sessionId: string | undefined) => {
        entry.knownSessionId = sessionId
        this.updateStdoutPause()
      },
      dispose: () => {
        if (this.serverRequestOwners.get(input.ownerId) === entry) {
          this.serverRequestOwners.delete(input.ownerId)
          this.updateStdoutPause()
          this.notifyPhysicalWorkIdleIfSettled()
        }
      },
    }
  }

  beginPermissionWait(): () => void {
    return this.permissionWait.begin()
  }

  openSessionStream(sessionId: string): AgySessionNotificationStream
  openSessionStream(sessionId: string, options: { readonly ordered: true }): AgyOrderedSessionStream
  openSessionStream(
    sessionId: string,
    options?: { readonly ordered?: false | undefined },
  ): AgySessionNotificationStream
  openSessionStream(
    sessionId: string,
    options?: { readonly ordered?: boolean | undefined },
  ): AgySessionNotificationStream | AgyOrderedSessionStream {
    return options?.ordered === true
      ? this.streams.openSessionStream(sessionId, { ordered: true })
      : this.streams.openSessionStream(sessionId)
  }

  nextNotification(timeoutMs: number | undefined, signal?: AbortSignal): Promise<object> {
    return this.streams.nextNotification(timeoutMs, signal)
  }

  capShutdownDeadline(deadlineAt: number): void {
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) {
      throw new Error('Invalid Antigravity shutdown deadline.')
    }
    const next = Math.min(this.shutdownDeadlineAt ?? deadlineAt, deadlineAt)
    if (this.shutdownDeadlineAt !== undefined && next >= this.shutdownDeadlineAt) return
    this.shutdownDeadlineAt = next
    if (this.exitDrainPending) {
      this.tightenExitDrainDeadline(next)
    }
    for (const listener of Array.from(this.shutdownDeadlineListeners)) {
      listener(next)
    }
  }

  private raceWithShutdownDeadline<T>(
    work: Promise<T>,
    fallbackDeadlineAt: number | undefined,
    timeoutMessage: string,
  ): Promise<T> {
    const effectiveDeadline = (): number | undefined => {
      if (fallbackDeadlineAt === undefined) return this.shutdownDeadlineAt
      if (this.shutdownDeadlineAt === undefined) return fallbackDeadlineAt
      return Math.min(fallbackDeadlineAt, this.shutdownDeadlineAt)
    }
    const initial = effectiveDeadline()
    if (initial !== undefined && initial <= Date.now()) {
      return Promise.reject(createUnconfirmedProcessError(timeoutMessage))
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        clearTimeout(timer)
        timer = undefined
        this.shutdownDeadlineListeners.delete(rearm)
      }
      const finishResolve = (value: T): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const finishReject = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const rearm = (): void => {
        if (settled) return
        clearTimeout(timer)
        timer = undefined
        const deadline = effectiveDeadline()
        if (deadline === undefined) return
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          finishReject(createUnconfirmedProcessError(timeoutMessage))
          return
        }
        timer = setTimeout(() => {
          finishReject(createUnconfirmedProcessError(timeoutMessage))
        }, remainingMs)
      }
      this.shutdownDeadlineListeners.add(rearm)
      rearm()
      void work.then(finishResolve, finishReject)
    })
  }

  private hasBufferedStdout(): boolean {
    if (this.stdoutEnded) return false
    const stdout = this.child.stdout as NodeJS.ReadableStream & {
      readableLength?: number
      writableLength?: number
      writableEnded?: boolean
    }
    if ((stdout.readableLength ?? 0) > 0) return true
    if ((stdout.writableLength ?? 0) > 0) return true
    if (stdout.writableEnded === true) return true
    return false
  }

  private beginExitInboundDrain(): void {
    if (this.closed || this.exitDrainPending) return
    this.exitDrainPending = true
    this.exitDrainDeferred ??= Promise.withResolvers<void>()
    const boundedDeadline = Math.min(
      this.shutdownDeadlineAt ?? Infinity,
      Date.now() + AGY_EXIT_INBOUND_DRAIN_TIMEOUT_MS,
    )
    this.exitDrainDeadlineAt = boundedDeadline
    this.updateStdoutPause()
    this.armExitDrainTimer()
    this.maybeCompleteExitDrain()
  }

  private tightenExitDrainDeadline(deadlineAt: number): void {
    if (!this.exitDrainPending) return
    const nextDeadline = Math.min(this.exitDrainDeadlineAt ?? deadlineAt, deadlineAt)
    if (this.exitDrainDeadlineAt !== undefined && nextDeadline >= this.exitDrainDeadlineAt) return
    this.exitDrainDeadlineAt = nextDeadline
    this.armExitDrainTimer()
  }

  private armExitDrainTimer(): void {
    clearTimeout(this.exitDrainTimer)
    this.exitDrainTimer = undefined
    if (!this.exitDrainPending || this.exitDrainDeadlineAt === undefined) return
    const remainingMs = this.exitDrainDeadlineAt - Date.now()
    if (remainingMs <= 0) {
      this.completeExitDrain('deadline')
      return
    }
    this.exitDrainTimer = setTimeout(() => {
      this.exitDrainTimer = undefined
      this.completeExitDrain('deadline')
    }, remainingMs)
  }

  private maybeCompleteExitDrain(): void {
    if (!this.exitDrainPending || this.closed) return
    if (this.inboundProcessing) return
    if (this.hasBufferedStdout()) {
      this.updateStdoutPause()
      return
    }
    if (this.stdoutEnded || this.processHasClosed) {
      this.completeExitDrain('eof')
    }
  }

  private completeExitDrain(cause: 'eof' | 'deadline' | 'transport'): void {
    if (!this.exitDrainPending) return
    const incomplete =
      cause === 'deadline'
        ? this.frameBytes > 0 ||
          this.hasBufferedStdout() ||
          this.inboundProcessing ||
          !this.stdoutEnded
        : cause === 'eof'
          ? this.frameBytes > 0
          : true
    const detail =
      cause === 'deadline'
        ? 'Antigravity ACP exit inbound drain deadline expired.'
        : cause === 'eof' && incomplete
          ? 'Antigravity ACP stdout ended with an incomplete frame.'
          : this.stderrText || undefined
    this.exitDrainPending = false
    this.exitDrainDeadlineAt = undefined
    clearTimeout(this.exitDrainTimer)
    this.exitDrainTimer = undefined
    const deferred = this.exitDrainDeferred
    this.exitDrainDeferred = undefined
    const error = new AgentExecutionError(
      'agent_process_crash',
      this.stderrText || 'Antigravity ACP server exited.',
      true,
    )
    if (!this.closed) {
      this.fail(error, 'process_exit', {
        cause,
        incomplete,
        ...(detail !== undefined ? { detail } : {}),
      })
    }
    deferred?.resolve()
    if (!this.shutdownPromise) {
      void this.close(error).catch(() => undefined)
    }
  }

  async close(error = new Error('Antigravity ACP connection closed.')): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    // oxlint-disable-next-line promise/no-promise-in-callback -- Publish completion before onClosed can reenter.
    const completion = Promise.withResolvers<void>()
    this.shutdownPromise = completion.promise
    if (!this.closed) {
      if (this.exitDrainPending) {
        this.maybeCompleteExitDrain()
        if (this.exitDrainPending && this.exitDrainDeferred) {
          // oxlint-disable-next-line promise/no-promise-in-callback -- close accepts an Error, not a callback.
          void this.exitDrainDeferred.promise
            .then(() => {
              if (!this.closed) {
                this.fail(error, 'process_exit', {
                  cause: 'transport',
                  incomplete:
                    this.frameBytes > 0 ||
                    this.hasBufferedStdout() ||
                    this.inboundProcessing ||
                    !this.stdoutEnded,
                  detail: formatCloseErrorDetail(error),
                })
              }
              return this.performClose()
            })
            .then(completion.resolve, completion.reject)
          return completion.promise
        }
      }
      if (!this.closed) {
        this.fail(error, 'transport_failure', {
          cause: 'transport',
          incomplete:
            this.frameBytes > 0 ||
            this.hasBufferedStdout() ||
            this.inboundProcessing ||
            !this.stdoutEnded,
          detail: formatCloseErrorDetail(error),
        })
      }
    }
    // oxlint-disable-next-line promise/no-promise-in-callback -- close accepts an Error, not a callback.
    void this.performClose().then(completion.resolve, completion.reject)
    return completion.promise
  }

  private async performClose(): Promise<void> {
    this.shutdownStarted = true
    this.closeInFlight = true
    const closeDeadlineAt =
      this.shutdownDeadlineAt ??
      Date.now() +
        (this.closeOwnedProcess ? 4_000 : AGY_SHUTDOWN_TIMEOUT_MS + AGY_FORCE_EXIT_TIMEOUT_MS)
    try {
      this.shutdownTask ??= this.shutdown().then(
        () => {
          this.shutdownSucceeded = true
          this.shutdownAttemptSettled = true
          this.recheckPhysicalRelease()
          return undefined
        },
        (shutdownError: unknown) => {
          this.shutdownAttemptSettled = true
          this.startWatchingLatePhysicalRelease()
          this.recheckPhysicalRelease()
          throw shutdownError
        },
      )
      void this.shutdownTask.catch(() => undefined)
      try {
        await this.raceWithShutdownDeadline(
          this.shutdownTask,
          this.closeOwnedProcess ? undefined : closeDeadlineAt,
          'Antigravity shutdown exceeded its existing deadline.',
        )
      } catch (shutdownError) {
        this.startWatchingLatePhysicalRelease()
        throw shutdownError
      }
      try {
        await this.waitForProcessClosed(closeDeadlineAt)
      } catch (closeWaitError) {
        this.startWatchingLatePhysicalRelease()
        throw closeWaitError
      }
      this.ensureOwnerReleaseListener()
      if (this.whenProcessOwnerReleased && !this.ownerReleaseNotified) {
        await Promise.resolve()
      }
      if (!this.isOwnerReleaseConfirmed()) {
        this.startWatchingLatePhysicalRelease()
        throw createUnconfirmedProcessError(
          'Antigravity owned process scope did not confirm release.',
        )
      }
      this.markPhysicalReleaseVerified()
      await this.raceWithShutdownDeadline(
        this.finalizePhysicalRequestsOnVerifiedClose(),
        undefined,
        'Antigravity physical close finalization did not finish before its deadline.',
      )
    } finally {
      this.closeInFlight = false
    }
  }

  private async waitForProcessClosed(deadlineAt: number): Promise<void> {
    if (this.processHasClosed) return
    await this.raceWithShutdownDeadline(
      this.processClosed,
      deadlineAt,
      'Antigravity process stdio did not close before its deadline.',
    )
  }

  private ensureOwnerReleaseListener(): void {
    if (this.ownerReleaseListenerStarted || !this.whenProcessOwnerReleased) return
    this.ownerReleaseListenerStarted = true
    let notification: Promise<void>
    try {
      notification = Promise.resolve(this.whenProcessOwnerReleased())
    } catch {
      return
    }
    void notification.then(
      () => {
        this.ownerReleaseNotified = true
        this.recheckPhysicalRelease()
        return undefined
      },
      () => undefined,
    )
  }

  private startWatchingLatePhysicalRelease(): void {
    if (this.lateReleaseWatchStarted || this.physicalReleaseObserved) return
    this.lateReleaseWatchStarted = true
    void this.processClosed.then(() => {
      this.recheckPhysicalRelease()
      return undefined
    })
    this.ensureOwnerReleaseListener()
    this.recheckPhysicalRelease()
  }

  private markPhysicalReleaseVerified(): void {
    if (this.physicalReleaseObserved) return
    this.physicalReleaseObserved = true
    void this.finalizePhysicalRequestsOnVerifiedClose()
  }

  private finalizePhysicalRequestsOnVerifiedClose(): Promise<void> {
    this.physicalFinalizationPromise ??= (async () => {
      await this.processClosed
      await Promise.allSettled([
        this.outbound.currentWriteTask,
        this.receiveTask,
        this.parserCompletion,
      ])
      for (const [id, pending] of this.pendingRequests) {
        this.pendingRequests.delete(id)
        this.unconfirmedCloseRequestIds.delete(id)
        pending.physicalResolve(pending.replyTerminal ?? 'connection_closed')
      }
      this.unconfirmedCloseRequestIds.clear()
      this.physicalReleaseFinalized = true
      this.physicalReleaseDeferred.resolve()
    })()
    return this.physicalFinalizationPromise
  }

  private async receiveChunk(chunk: Buffer): Promise<void> {
    if (this.closed) return
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline === -1 ? chunk.length : newline
      const fragment = chunk.subarray(offset, end)
      if (fragment.length > 0) {
        if (!this.frameDeadline) {
          this.frameDeadline = setTimeout(() => {
            void this.close(
              new AgentExecutionError(
                'protocol_error',
                'Native ACP JSONL framing exceeded its ten-second deadline.',
                false,
              ),
            ).catch(() => undefined)
          }, 10_000)
        }
        this.frameBytes += fragment.length
        if (this.frameBytes > AGY_MAX_FRAME_BYTES) {
          throw new AgentExecutionError(
            'runtime_incompatible',
            'Antigravity ACP frame exceeded the 16 MiB single-frame bound.',
            false,
          )
        }
        this.frameReservation ??= this.memory.reserve(AGY_FRAME_WORKSPACE_BYTES)
        this.frameReservation.resize(
          AGY_FRAME_WORKSPACE_BYTES + this.frameBytes * AGY_PARSE_WORKSPACE_MULTIPLIER,
        )
        this.frameChunks.push(fragment)
      }
      if (newline === -1) return
      const frame = Buffer.concat(this.frameChunks, this.frameBytes)
      this.frameChunks = []
      this.frameBytes = 0
      const reservation = this.frameReservation ?? this.memory.reserve(AGY_FRAME_WORKSPACE_BYTES)
      this.frameReservation = undefined
      this.activeInboundReservation = reservation
      try {
        // oxlint-disable-next-line no-await-in-loop -- One logical JSONL frame at a time with stdout backpressure.
        await this.receiveFrame(frame, reservation)
      } finally {
        if (this.activeInboundReservation === reservation) this.activeInboundReservation = undefined
        clearTimeout(this.frameDeadline)
        this.frameDeadline = undefined
      }
      if (this.closed) return
      offset = newline + 1
    }
  }

  private async receiveFrame(
    rawFrame: Buffer,
    reservation: NativeMemoryReservation,
  ): Promise<void> {
    let retained = false
    let parserPhysical: Promise<void> | undefined
    try {
      const wireBytes = rawFrame.length + 1
      const frame = rawFrame.at(-1) === 0x0d ? rawFrame.subarray(0, -1) : rawFrame
      if (frame.length === 0) return
      let message: unknown
      let heldBytes: number
      if (frame.length <= AGY_INLINE_ENCODING_MEMORY_BYTES) {
        message = JSON.parse(this.decoder.decode(frame))
        heldBytes = freezeNativeJsonFrame(message)
      } else {
        const parsed = await parseNativeJsonFrame(
          frame,
          this.inboundController.signal,
          this.ipcTraffic,
          (completion) => {
            parserPhysical = completion
            this.parserCompletion = completion
          },
        )
        message = parsed.message
        heldBytes = parsed.heldBytes
      }
      if (this.closed || !isPlainObject(message)) return
      reservation.resize(Math.max(reservation.bytes, heldBytes))
      const seq = this.streams.nextSeq()
      const recordMessage = message

      const id = Reflect.get(message, 'id')
      const method = Reflect.get(message, 'method')
      if (typeof method !== 'string' && typeof id === 'number' && this.pendingRequests.has(id)) {
        const pending = this.pendingRequests.get(id)!
        if (pending.replyTerminal !== undefined) return
        if (!pending.dispatched) {
          const protocolError = tagRequestFailure(
            new AgentExecutionError(
              'protocol_error',
              'Antigravity returned a response for an undispatched ACP request.',
              false,
            ),
            'protocol_error',
          )
          this.settleRequest(id, protocolError, undefined, 'transport_failure')
          this.outbound.dropQueuedRequestFrame(id, protocolError)
          return
        }
        const malformedReason = validateJsonRpcResponse(message)
        if (malformedReason !== undefined) {
          pending.replyTerminal = 'invalid_reply'
          const protocolError = tagRequestFailure(
            new AgentExecutionError('protocol_error', malformedReason, false),
            'protocol_error',
          )
          if (!pending.logicalSettled) {
            this.settleRequest(id, protocolError, undefined, 'transport_failure')
          } else {
            this.completePhysicalRequest(id, pending)
          }
          this.taint(protocolError)
          return
        }
        pending.replyTerminal = 'reply'
        if (
          pending.replyConsumer &&
          pending.replyConsumer.ordered &&
          !pending.replyConsumer.abandoned &&
          !pending.replyConsumer.producerSealed
        ) {
          const replyIngress: Exclude<AgyIngress, { kind: 'end' }> = {
            kind: 'reply',
            seq,
            requestId: id,
            message: recordMessage,
          }
          retained = this.streams.enqueueSessionIngress(
            pending.replyConsumer,
            replyIngress,
            wireBytes,
            heldBytes,
            reservation,
          )
        }
        this.settleRequest(id, undefined, message)
        return
      }
      if (Object.hasOwn(message, 'id') && typeof method !== 'string') return

      if (Object.hasOwn(message, 'id') && typeof method === 'string') {
        const rpcId = typeof id === 'string' || typeof id === 'number' ? id : undefined
        const reqSessionId = extractServerRequestSessionId(message)
        const enqueueOrderedServerRequest = (
          consumer: NonNullable<ReturnType<AgySessionStreamRouter['getActiveOrderedConsumer']>>,
        ): boolean => {
          if (rpcId === undefined) return false
          const serverReqIngress: Exclude<AgyIngress, { kind: 'end' }> = {
            kind: 'server_request',
            seq,
            rpcId,
            method,
            message: recordMessage,
          }
          retained = this.streams.enqueueSessionIngress(
            consumer,
            serverReqIngress,
            wireBytes,
            heldBytes,
            reservation,
          )
          return true
        }

        if (reqSessionId !== undefined) {
          let matchedOwner: RegisteredServerRequestOwner | undefined
          let matchedCount = 0
          for (const owner of this.serverRequestOwners.values()) {
            if (owner.knownSessionId !== undefined && owner.knownSessionId === reqSessionId) {
              matchedOwner = owner
              matchedCount += 1
            }
          }
          if (matchedCount > 1) {
            if (rpcId !== undefined) {
              await this.respondServerRequestErrorIfOpen(
                rpcId,
                'Ambiguous active session owners for this ACP request.',
              )
            }
            return
          }
          const orderedConsumer = this.streams.getActiveOrderedConsumer(reqSessionId)
          if (orderedConsumer && enqueueOrderedServerRequest(orderedConsumer)) return
          if (matchedCount === 1 && matchedOwner?.handler(message, seq)) return
          if (this.serverRequestOwners.size > 0) {
            if (rpcId !== undefined) {
              await this.respondServerRequestErrorIfOpen(
                rpcId,
                'No active session handler accepted this ACP request.',
              )
            }
            return
          }
        } else {
          if (this.serverRequestOwners.size > 1) {
            if (rpcId !== undefined) {
              await this.respondServerRequestErrorIfOpen(
                rpcId,
                'No active session handler accepted this ACP request.',
              )
            }
            return
          }
          if (this.serverRequestOwners.size === 1) {
            const soleOwner = this.serverRequestOwners.values().next().value!
            const activeOrdered = this.streams.listActiveOrderedConsumers()
            const otherOrderedExists = activeOrdered.some(
              (c) => c.sessionId !== soleOwner.knownSessionId,
            )
            if (otherOrderedExists) {
              if (rpcId !== undefined) {
                await this.respondServerRequestErrorIfOpen(
                  rpcId,
                  'No active session handler accepted this ACP request.',
                )
              }
              return
            }
            const soleOrdered = this.streams.getActiveOrderedConsumer(soleOwner.knownSessionId)
            if (soleOrdered && enqueueOrderedServerRequest(soleOrdered)) return
            if (soleOwner.handler(message, seq)) return
            if (rpcId !== undefined) {
              await this.respondServerRequestErrorIfOpen(
                rpcId,
                'No active session handler accepted this ACP request.',
              )
            }
            return
          }
          if (this.serverRequestListeners.size === 0) {
            const activeOrdered = this.streams.listActiveOrderedConsumers()
            if (activeOrdered.length === 1 && enqueueOrderedServerRequest(activeOrdered[0]!)) {
              return
            }
          }
        }

        for (const listener of this.serverRequestListeners) {
          if (listener(message)) return
        }
        if (rpcId !== undefined) {
          await this.respondServerRequestErrorIfOpen(
            rpcId,
            'No active session handler accepted this ACP request.',
          )
        }
        return
      }

      for (const listener of this.backgroundListeners) {
        if (listener(message)) return
      }

      const notificationIngress: Exclude<AgyIngress, { kind: 'end' }> = {
        kind: 'notification',
        seq,
        message: recordMessage,
      }
      const sessionId = extractNotificationSessionId(message)
      const sessionConsumer = sessionId ? this.streams.getActiveConsumer(sessionId) : undefined
      if (sessionConsumer) {
        retained = this.streams.enqueueSessionIngress(
          sessionConsumer,
          notificationIngress,
          wireBytes,
          heldBytes,
          reservation,
        )
        return
      }
      retained = this.streams.deliverGlobalNotification(
        sessionId,
        notificationIngress,
        wireBytes,
        heldBytes,
        reservation,
      )
    } finally {
      if (parserPhysical) {
        const completion = parserPhysical
        void completion.then(() => {
          if (!retained) reservation.release()
          if (this.parserCompletion === completion) this.parserCompletion = undefined
          return undefined
        })
      } else if (!retained) {
        reservation.release()
      }
    }
  }

  private async respondServerRequestErrorIfOpen(
    rpcId: string | number,
    message: string,
    code = -32_601,
  ): Promise<void> {
    if (this.exitRecorded && !this.isOpen) return
    await this.respondError(rpcId, message, code)
  }

  private settleRequest(
    id: number,
    error?: Error,
    message?: object,
    failureSource: DiagnosticFailureSource = 'transport_failure',
  ): void {
    const pending = this.pendingRequests.get(id)
    if (!pending) return
    if (pending.logicalSettled) {
      this.completePhysicalRequest(id, pending)
      return
    }
    pending.logicalSettled = true
    const rpcError = message && Reflect.get(message, 'error')
    const candidate =
      rpcError && typeof rpcError === 'object' ? Reflect.get(rpcError, 'code') : undefined
    const nativeErrorCode =
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= -0x80000000 &&
      candidate <= 0x7fffffff
        ? candidate
        : undefined
    recordDiagnostic({
      ...pending.diagnostic,
      phase: rpcError
        ? 'blocked'
        : error
          ? failureSource === 'timeout'
            ? 'timeout'
            : failureSource === 'cancelled'
              ? 'interrupted'
              : 'failed'
          : 'completed',
      level: rpcError || error ? 'warn' : 'debug',
      durationMs: Date.now() - pending.startedAt,
      ...(rpcError
        ? { failureSource: 'native_rpc_rejection', code: 'native_rpc_rejected' }
        : error
          ? {
              failureSource,
              code:
                failureSource === 'timeout'
                  ? 'TIMEOUT'
                  : failureSource === 'cancelled'
                    ? 'request_cancelled'
                    : failureSource === 'process_exit'
                      ? 'agent_process_crash'
                      : 'transport_failure',
            }
          : {}),
      ...(nativeErrorCode === undefined ? {} : { nativeErrorCode }),
    })
    clearTimeout(pending.timeout)
    pending.pauseCleanup?.()
    if (pending.signal && pending.abort) pending.signal.removeEventListener('abort', pending.abort)
    this.updateStdoutPause()
    if (error) pending.reject?.(error)
    else if (message) pending.resolve?.(message)
    pending.resolve = undefined
    pending.reject = undefined
    pending.signal = undefined
    pending.abort = undefined
    pending.pauseCleanup = undefined
    pending.timeout = undefined
    this.completePhysicalRequest(id, pending)
    if (error && pending.method === 'session/close' && this.pendingRequests.get(id) === pending) {
      if (!this.unconfirmedCloseRequestIds.has(id)) {
        this.unconfirmedCloseRequestIds.add(id)
        this.notifyPhysicalWorkIdleIfSettled()
      }
    }
  }

  private finishRequestWrite(id: number | undefined): void {
    if (id === undefined) return
    const pending = this.pendingRequests.get(id)
    if (!pending) return
    pending.writeJoined = true
    if (pending.logicalSettled) this.completePhysicalRequest(id, pending)
  }

  private taint(reason: Error): void {
    if (this.tainted) return
    this.tainted = true
    this.taintError = reason
    this.onTainted?.(reason)
    if (!this.closed) {
      void this.close(reason).catch(() => undefined)
    }
  }

  private completePhysicalRequest(id: number, pending: PendingRequest): void {
    if (
      !pending.logicalSettled ||
      !pending.writeJoined ||
      (pending.replyTerminal === undefined && pending.dispatched)
    )
      return
    if (this.pendingRequests.get(id) !== pending) return
    this.pendingRequests.delete(id)
    this.unconfirmedCloseRequestIds.delete(id)
    const outcome: AgyRequestPhysicalCompletion = pending.replyTerminal ?? 'not_sent'
    pending.physicalResolve(outcome)
    this.updateStdoutPause()
    this.notifyPhysicalWorkIdleIfSettled()
  }

  private notifyPhysicalWorkIdleIfSettled(): void {
    if (!this.closed && !this.hasActiveWorkExcludingUnconfirmedCloses()) {
      this.onPhysicalWorkIdle?.()
    }
  }

  private hasDirectServerRequestOwner(): boolean {
    for (const owner of this.serverRequestOwners.values()) {
      const routedViaOrderedStream = Boolean(
        this.streams.getActiveOrderedConsumer(owner.knownSessionId),
      )
      if (!routedViaOrderedStream) return true
    }
    return false
  }

  private updateStdoutPause(): void {
    const canWaitForConsumer =
      this.pendingRequests.size === 0 &&
      this.serverRequestListeners.size === 0 &&
      !this.hasDirectServerRequestOwner()
    const queuePaused = this.streams.evaluateQueuePause(this.closed)
    const shouldPause =
      !this.closed &&
      (this.inboundProcessing || (!this.exitDrainPending && canWaitForConsumer && queuePaused))
    if (shouldPause === this.stdoutPaused) return
    this.stdoutPaused = shouldPause
    if (shouldPause) this.child.stdout.pause()
    else this.child.stdout.resume()
  }

  private recordExit(code: number | null): void {
    if (this.exitRecorded) return
    this.exitRecorded = true
    recordDiagnostic({
      operation: 'process',
      scope: 'process',
      phase: 'closed',
      level: this.closed ? 'info' : 'error',
      agentId: 'agy',
      executorId: this.executorId,
      failureSource: 'process_exit',
      ...(this.child.pid ? { pid: this.child.pid } : {}),
      ...(code === null ? {} : { exitCode: code }),
      ...(this.closed ? {} : { code: 'agent_process_crash' }),
    })
  }

  private fail(
    error: Error,
    failureSource: DiagnosticFailureSource = 'transport_failure',
    endMeta?: {
      readonly cause: 'eof' | 'transport' | 'deadline'
      readonly incomplete: boolean
      readonly detail?: string | undefined
    },
  ): void {
    if (this.closed) return
    const effectiveEndCause = endMeta?.cause ?? 'transport'
    const effectiveIncomplete =
      endMeta?.incomplete ??
      (this.frameBytes > 0 ||
        this.hasBufferedStdout() ||
        this.inboundProcessing ||
        !this.stdoutEnded)
    const effectiveDetail = endMeta?.detail ?? formatCloseErrorDetail(error)
    this.closed = true
    this.closeError = error
    this.exitDrainPending = false
    this.exitDrainDeadlineAt = undefined
    clearTimeout(this.exitDrainTimer)
    this.exitDrainTimer = undefined
    const exitDrainDeferred = this.exitDrainDeferred
    this.exitDrainDeferred = undefined
    this.child.stdout.removeListener('data', this.receive)
    this.child.stdout.removeListener('end', this.onStdoutEnded)
    this.child.stdout.removeListener('error', this.onStdoutError)
    this.child.stderr.removeListener('data', this.receiveError)
    this.child.removeListener('exit', this.processExited)
    this.child.removeListener('close', this.exited)
    this.outbound.abortActive()
    this.inboundController.abort()
    this.frameReservation?.release()
    this.frameReservation = undefined
    clearTimeout(this.frameDeadline)
    this.frameDeadline = undefined
    for (const id of this.pendingRequests.keys()) {
      this.settleRequest(id, error, undefined, failureSource)
    }
    this.streams.sealAllOnClose(effectiveEndCause, effectiveIncomplete, effectiveDetail, error)
    this.outbound.failAll(error)
    this.backgroundListeners.clear()
    this.serverRequestListeners.clear()
    this.serverRequestOwners.clear()
    const closeObservers = [...this.closeListeners]
    this.closeListeners.clear()
    this.frameChunks = []
    this.frameBytes = 0
    if (this.stdoutPaused) this.child.stdout.resume()
    this.stdoutPaused = false
    exitDrainDeferred?.resolve()
    for (const notifyClose of closeObservers) {
      try {
        notifyClose()
      } catch {
        // Isolate close listener errors from connection teardown.
      }
    }
    this.onClosed?.()
  }

  private async shutdown(): Promise<void> {
    if (this.closeOwnedProcess) {
      await this.closeOwnedProcess(this.shutdownDeadlineAt)
      this.groupCloseSucceeded = true
      this.recordExit(this.child.exitCode)
      return
    }
    if (this.child.exitCode !== null || this.child.signalCode != null) {
      this.recordExit(this.child.exitCode)
      return
    }
    const remaining = (): number =>
      this.shutdownDeadlineAt === undefined ? Infinity : this.shutdownDeadlineAt - Date.now()
    if (remaining() <= 0) {
      throw createUnconfirmedProcessError('Antigravity shutdown exceeded its existing deadline.')
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let forceTimeout: ReturnType<typeof setTimeout> | undefined
      let escalated = false
      const cleanup = (): boolean => {
        if (settled) return false
        settled = true
        clearTimeout(timeout)
        clearTimeout(forceTimeout)
        this.shutdownDeadlineListeners.delete(onDeadlineTightened)
        this.child.removeListener('exit', finish)
        return true
      }
      const finish = (code: number | null): void => {
        this.recordExit(code)
        if (cleanup()) resolve()
      }
      const fail = (error: unknown): void => {
        if (cleanup()) reject(error instanceof Error ? error : new Error(String(error)))
      }
      const escalate = (): void => {
        if (settled || escalated) return
        escalated = true
        clearTimeout(timeout)
        if (remaining() <= 0) {
          fail(
            createUnconfirmedProcessError('Antigravity shutdown exceeded its existing deadline.'),
          )
          return
        }
        try {
          this.child.kill('SIGKILL')
        } catch (error) {
          fail(error)
          return
        }
        forceTimeout = setTimeout(
          () => {
            fail(createUnconfirmedProcessError('Antigravity process did not exit after SIGKILL.'))
          },
          Math.min(AGY_FORCE_EXIT_TIMEOUT_MS, Math.max(1, remaining())),
        )
      }
      let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(
        escalate,
        Math.min(AGY_SHUTDOWN_TIMEOUT_MS, Math.max(1, remaining())),
      )
      const onDeadlineTightened = (): void => {
        if (settled) return
        if (!escalated) {
          clearTimeout(timeout)
          const rem = remaining()
          if (rem <= 0) {
            escalate()
          } else {
            timeout = setTimeout(escalate, Math.min(AGY_SHUTDOWN_TIMEOUT_MS, rem))
          }
        } else {
          clearTimeout(forceTimeout)
          const rem = remaining()
          if (rem <= 0) {
            fail(
              createUnconfirmedProcessError('Antigravity shutdown exceeded its existing deadline.'),
            )
          } else {
            forceTimeout = setTimeout(
              () => {
                fail(
                  createUnconfirmedProcessError('Antigravity process did not exit after SIGKILL.'),
                )
              },
              Math.min(AGY_FORCE_EXIT_TIMEOUT_MS, rem),
            )
          }
        }
      }
      this.shutdownDeadlineListeners.add(onDeadlineTightened)
      this.child.once('exit', finish)
      try {
        this.child.stdin.end()
        this.child.kill()
      } catch (error) {
        fail(error)
      }
    })
  }
}
