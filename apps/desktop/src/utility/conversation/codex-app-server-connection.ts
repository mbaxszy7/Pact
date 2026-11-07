import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { randomUUID } from 'node:crypto'

import {
  diagnosticNativeMethodSchema,
  type DiagnosticEvent,
  type DiagnosticFailureSource,
} from '@pact/contracts/diagnostics'

import type { LogicalIpcWorkerTraffic } from '../../shared/logical-ipc-traffic'

import { recordDiagnostic } from '../../diagnostics/utility-log'
import { AgentExecutionError } from './agent-execution-error'
import {
  NATIVE_FRAME_WRITE_CHUNK_BYTES,
  NativeFrameWriteError,
  writeNativeFrame,
} from './native-frame-writer'
import { encodeNativeJsonFrame, freezeNativeJsonFrame } from './native-json-encoder'
import { parseNativeJsonFrame } from './native-json-parser'
import { NativePermissionWait } from './native-permission-wait'
import {
  NativeWorkingMemory,
  NATIVE_OWNER_WORKING_BYTES,
  type NativeMemoryReservation,
  type NativeMemoryAllocator,
} from './native-working-memory'

// Compatibility for bounded cold-read callers; actual framing uses shared working admission.
export const CODEX_MAX_FRAME_BYTES = NATIVE_OWNER_WORKING_BYTES / 8
export const CODEX_QUEUE_HIGH_WATER_BYTES = 4 * 1024 * 1024
export const CODEX_QUEUE_LOW_WATER_BYTES = 2 * 1024 * 1024
export const CODEX_QUEUE_HARD_LIMIT_BYTES = 8 * 1024 * 1024
export const CODEX_QUEUE_MESSAGE_LIMIT = 4_096
export const CODEX_PENDING_REQUEST_LIMIT = 64
export const CODEX_OUTBOUND_DRAIN_TIMEOUT_MS = 10_000
export const CODEX_SHUTDOWN_TIMEOUT_MS = 2_000
const CODEX_FORCE_EXIT_TIMEOUT_MS = 1_000
const CODEX_STDERR_LIMIT_BYTES = 16 * 1024
const CODEX_INLINE_ENCODING_MEMORY_BYTES = 256 * 1024
// Raw fragments, concatenation, decode, Worker DTO and receiving structured clone.
const CODEX_PARSE_WORKSPACE_MULTIPLIER = 8
const CODEX_FRAME_WORKSPACE_BYTES = 4 * NATIVE_FRAME_WRITE_CHUNK_BYTES
const DECISION_PARSE_WORKSPACE_BYTES = 3 * 1024 * 1024
const DECISION_NATIVE_DTO_BYTES = 1024 * 1024

/** Count structural allocation before JSON.parse; no shared parser Worker for auxiliary frames. */
function decisionParseWorkspace(bytes: Buffer): number {
  let quoted = false,
    escaped = false
  let held = CODEX_FRAME_WORKSPACE_BYTES + bytes.length * CODEX_PARSE_WORKSPACE_MULTIPLIER
  for (const byte of bytes) {
    if (quoted) {
      if (escaped) escaped = false
      else if (byte === 92) escaped = true
      else if (byte === 34) quoted = false
    } else if (byte === 34) {
      quoted = true
      held += 96
    } else if (byte === 123 || byte === 91) held += 512
    // Include array-index properties, descriptor/own-key counting workspace,
    // slots and primitives as well as the parsed containers and strings.
    else if (byte === 58 || byte === 44) held += 384
  }
  return held
}

interface PendingRequest {
  diagnostic: DiagnosticEvent
  startedAt: number
  resolve: ((message: object) => void) | undefined
  reject: ((error: Error) => void) | undefined
  timeout: ReturnType<typeof setTimeout> | undefined
  pauseCleanup?: (() => void) | undefined
  signal?: AbortSignal | undefined
  abort?: (() => void) | undefined
  logicalSettled: boolean
  dispatched: boolean
  writeJoined: boolean
  replied: boolean
  physicalResolve: (result: CodexRequestPhysicalCompletion) => void
}

export type CodexRequestPhysicalCompletion = 'reply' | 'not_sent' | 'connection_closed'
export interface CodexRequestOperation {
  readonly requestId: number | null
  result: Promise<object>
  /** A logical timeout/abort cannot settle an already dispatched RPC's physical ownership. */
  physicalCompletion: Promise<CodexRequestPhysicalCompletion>
}

interface QueuedNotification {
  message: object
  bytes: number
  reservation: NativeMemoryReservation
}

interface NotificationWaiter {
  resolve: (message: object) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | undefined
  pauseCleanup?: (() => void) | undefined
  signal?: AbortSignal | undefined
  abort?: (() => void) | undefined
}

interface OutboundFrame {
  message: object
  expiresAt: number
  bytes?: Buffer | undefined
  heldBytes: number
  released: boolean
  reservation: NativeMemoryReservation
  controller: AbortController
  requestId?: number | undefined
  resolve: () => void
  reject: (error: Error) => void
  onDispatch?: (() => void) | undefined
  canDispatch?: (() => boolean) | undefined
  cancelBeforeWriteSignal?: AbortSignal | undefined
  physicalResolve?: (() => void) | undefined
}

export interface CodexConnectionDiagnostics {
  pendingRequests: number
  pendingPhysicalRequests: number
  queuedMessages: number
  queuedInboundBytes: number
  queuedOutboundFrames: number
  queuedOutboundBytes: number
  waitingForNotification: boolean
  stdoutPaused: boolean
  open: boolean
}

export class CodexAppServerConnection {
  readonly executorId = randomUUID()
  private readonly memory: NativeMemoryAllocator
  private readonly inboundController = new AbortController()
  private frameReservation: NativeMemoryReservation | undefined
  private inboundProcessing = false
  private activeInboundReservation: NativeMemoryReservation | undefined
  private frameDeadline: ReturnType<typeof setTimeout> | undefined
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private skillChangeListener: (() => void) | undefined
  setSkillChangeListener(listener: (() => void) | undefined): void {
    this.skillChangeListener = listener
  }
  private readonly backgroundListeners = new Set<(message: object) => boolean>()
  private readonly serverRequestListeners = new Set<(message: object) => boolean>()
  private readonly permissionWait = new NativePermissionWait()
  private readonly notificationQueue: Array<QueuedNotification | undefined> = []
  private readonly outboundQueue: Array<OutboundFrame | undefined> = []
  private notificationHead = 0
  private outboundHead = 0
  private notificationWaiter: NotificationWaiter | undefined
  private frameChunks: Buffer[] = []
  private decisionFrame: Buffer | undefined
  private decisionFrameReservation: NativeMemoryReservation | undefined
  private receiveTask: Promise<void> | undefined
  private parserCompletion: Promise<void> | undefined
  private outboundWriteTask: Promise<void> | undefined
  private readonly processClosed: Promise<void>
  private frameBytes = 0
  private queuedInboundBytes = 0
  private queuedOutboundBytes = 0
  private nextRequestId = 0
  private writing = false
  private activeOutboundFrame: OutboundFrame | undefined
  private stdoutPaused = false
  private notificationQueuePaused = false
  private closed = false
  private shutdownPromise: Promise<void> | undefined
  private closeError: Error | undefined
  private exitRecorded = false
  private observedCloseError: Error | undefined
  private stderr = ''
  private stderrBytes = 0
  private readonly receive = (chunk: Buffer): void => {
    this.inboundProcessing = true
    this.updateStdoutPause()
    const task = this.receiveChunk(chunk)
      .catch((error: unknown) => {
        void this.close(
          error instanceof Error ? error : new Error('Native frame read failed.'),
        ).catch(() => undefined)
      })
      .finally(() => {
        this.inboundProcessing = false
        if (this.observedCloseError) {
          this.fail(this.observedCloseError, 'process_exit')
          void this.close(this.observedCloseError).catch(() => undefined)
        }
        this.updateStdoutPause()
      })
    this.receiveTask = task
  }
  private readonly receiveError = (chunk: Buffer): void => {
    const remaining = CODEX_STDERR_LIMIT_BYTES - this.stderrBytes
    if (remaining <= 0) return
    const bounded = chunk.subarray(0, remaining)
    this.stderr += bounded.toString('utf8')
    this.stderrBytes += bounded.length
  }
  private readonly exited = (code: number | null): void => {
    this.recordExit(code)
    const error = new AgentExecutionError(
      'agent_process_crash',
      this.stderr.trim() || 'Codex app-server exited.',
      true,
    )
    if (this.inboundProcessing) this.observedCloseError = error
    else {
      this.fail(error, 'process_exit')
      void this.close(error).catch(() => undefined)
    }
  }
  private readonly processExited = (code: number | null): void => this.recordExit(code)

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onClosed?: () => void,
    private readonly closeOwnedProcess?: () => Promise<void>,
    private readonly ipcTraffic?: LogicalIpcWorkerTraffic,
    private readonly isLifetimeCurrent?: () => boolean,
    private readonly decisionMemory?: NativeMemoryAllocator,
    private readonly observePhysicalOperation?: (
      signal: AbortSignal | undefined,
      physicalCompletion: Promise<unknown>,
    ) => void,
  ) {
    this.processClosed = new Promise((resolve) => child.once('close', () => resolve()))
    this.memory = decisionMemory ?? new NativeWorkingMemory()
    recordDiagnostic({
      operation: 'process',
      scope: 'process',
      phase: 'started',
      executorId: this.executorId,
      agentId: 'codex',
      ...(child.pid ? { pid: child.pid } : {}),
    })
    child.stdout.on('data', this.receive)
    child.stderr.on('data', this.receiveError)
    // Native may exit after writing a final large receipt while our Worker is parsing it.
    // `close` follows stdout drainage; `exit` alone must not discard those final bytes.
    child.once('exit', this.processExited)
    child.once('close', this.exited)
  }

  get isOpen(): boolean {
    return !this.closed && this.child.exitCode === null
  }

  /** Adapter-retained facts remain charged to their physical Connection owner. */
  reserveWorkingMemory(bytes: number): NativeMemoryReservation {
    return this.memory.reserve(bytes)
  }

  get stderrText(): string {
    return this.stderr.trim()
  }

  diagnostics(): CodexConnectionDiagnostics {
    return {
      pendingRequests: [...this.pendingRequests.values()].filter(
        (request) => !request.logicalSettled,
      ).length,
      pendingPhysicalRequests: this.pendingRequests.size,
      queuedMessages: this.notificationQueue.length - this.notificationHead,
      queuedInboundBytes: this.queuedInboundBytes,
      queuedOutboundFrames: this.outboundQueue.length - this.outboundHead,
      queuedOutboundBytes: this.queuedOutboundBytes,
      waitingForNotification: Boolean(this.notificationWaiter),
      stdoutPaused: this.stdoutPaused,
      open: this.isOpen,
    }
  }

  request(
    method: string,
    params: object,
    options: {
      timeoutMs: number
      signal?: AbortSignal | undefined
      onDispatch?: (() => void) | undefined
      canDispatch?: (() => boolean) | undefined
    },
  ): Promise<object> {
    return this.requestOwned(method, params, options).result
  }

  requestOwned(
    method: string,
    params: object,
    options: {
      timeoutMs: number
      signal?: AbortSignal | undefined
      onDispatch?: (() => void) | undefined
      canDispatch?: (() => boolean) | undefined
    },
  ): CodexRequestOperation {
    if (options.signal?.aborted) {
      return {
        requestId: null,
        result: Promise.reject(
          new AgentExecutionError('agent_process_crash', 'Codex was interrupted.', false),
        ),
        physicalCompletion: Promise.resolve('not_sent'),
      }
    }
    if (this.pendingRequests.size >= (this.decisionMemory ? 8 : CODEX_PENDING_REQUEST_LIMIT)) {
      return {
        requestId: null,
        result: Promise.reject(
          new AgentExecutionError(
            'protocol_error',
            'Codex exceeded Pact’s pending request budget.',
            false,
          ),
        ),
        physicalCompletion: Promise.resolve('not_sent'),
      }
    }
    const id = this.nextRequestId
    this.nextRequestId += 1
    let physicalResolve!: PendingRequest['physicalResolve']
    const physicalCompletion = new Promise<CodexRequestPhysicalCompletion>((resolve) => {
      physicalResolve = resolve
    })
    this.observePhysicalOperation?.(options.signal, physicalCompletion)
    const response = new Promise<object>((resolve, reject) => {
      const expired = (): void => {
        this.settleRequest(
          id,
          new AgentExecutionError(
            'transient_transport',
            `Codex did not answer ${method} before its deadline.`,
            true,
          ),
          undefined,
          'timeout',
        )
      }
      const methodName = diagnosticNativeMethodSchema.safeParse(method)
      const pending: PendingRequest = {
        startedAt: Date.now(),
        diagnostic: {
          operation: 'process',
          scope: 'request',
          phase: 'started',
          level: 'debug',
          agentId: 'codex',
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
        replied: false,
        physicalResolve,
      }
      const arm = (): void => {
        clearTimeout(pending.timeout)
        pending.timeout = this.permissionWait.waiting
          ? undefined
          : setTimeout(expired, options.timeoutMs)
      }
      pending.pauseCleanup = this.permissionWait.subscribe(arm)
      arm()
      if (options.signal) {
        pending.abort = (): void => {
          this.settleRequest(
            id,
            new AgentExecutionError('agent_process_crash', 'Codex was interrupted.', false),
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
    const writing = this.enqueue(
      { method, id, params },
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
    return { requestId: id, result: response, physicalCompletion }
  }

  async notify(
    method: string,
    params: object,
    options: { signal?: AbortSignal | undefined; canDispatch?: (() => boolean) | undefined } = {},
  ): Promise<void> {
    await this.enqueue(
      { method, params },
      { canDispatch: options.canDispatch, cancelBeforeWriteSignal: options.signal },
    )
  }

  /** A native server request is independent of our outbound request ID space. */
  async respond(id: string | number, result: object): Promise<void> {
    if (
      (typeof id === 'string' && id.length > 1024) ||
      (typeof id === 'number' && !Number.isSafeInteger(id))
    )
      throw new AgentExecutionError(
        'protocol_error',
        'Codex returned an invalid request identity.',
        false,
      )
    await this.enqueue({ id, result }, {})
  }

  async respondError(id: string | number, message: string): Promise<void> {
    await this.enqueue({ id, error: { code: -32_601, message: message.slice(0, 1024) } }, {})
  }

  subscribeBackground(listener: (message: object) => boolean): () => void {
    if (this.backgroundListeners.size >= 9)
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Too many owned native background observers.',
        false,
      )
    this.backgroundListeners.add(listener)
    return () => this.backgroundListeners.delete(listener)
  }

  /** Recheck bounded queued facts after a read-only probe proves a lost-ACK Turn identity. */
  replayBackgroundNotifications(): void {
    for (let index = this.notificationHead; index < this.notificationQueue.length; index += 1) {
      const queued = this.notificationQueue[index]
      if (!queued) continue
      for (const listener of this.backgroundListeners) {
        if (!listener(queued.message)) continue
        this.notificationQueue[index] = undefined
        this.queuedInboundBytes -= queued.bytes
        queued.reservation.release()
        break
      }
    }
    // The queue may contain holes after attribution; nextNotification consumes
    // a compact ordered remainder, without discarding unclaimed native facts.
    const remaining = this.notificationQueue
      .slice(this.notificationHead)
      .filter((entry): entry is QueuedNotification => entry !== undefined)
    this.notificationQueue.splice(0, this.notificationQueue.length, ...remaining)
    this.notificationHead = 0
    this.resumeStdoutIfNeeded()
  }

  subscribeServerRequests(listener: (message: object) => boolean): () => void {
    if (this.serverRequestListeners.size >= 8)
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Too many owned native request handlers.',
        false,
      )
    this.serverRequestListeners.add(listener)
    this.updateStdoutPause()
    return () => {
      this.serverRequestListeners.delete(listener)
      this.updateStdoutPause()
    }
  }

  beginPermissionWait(): () => void {
    return this.permissionWait.begin()
  }

  nextNotification(timeoutMs: number | undefined, signal?: AbortSignal): Promise<object> {
    if (signal?.aborted) {
      return Promise.reject(
        new AgentExecutionError('agent_process_crash', 'Codex was interrupted.', false),
      )
    }
    const queued = this.notificationQueue[this.notificationHead]
    if (queued) {
      this.notificationQueue[this.notificationHead] = undefined
      this.notificationHead += 1
      this.queuedInboundBytes -= queued.bytes
      queued.reservation.release()
      this.compactNotificationQueue()
      this.resumeStdoutIfNeeded()
      return Promise.resolve(queued.message)
    }
    if (!this.isOpen) {
      return Promise.reject(this.closeError ?? new Error('Codex app-server is unavailable.'))
    }
    if (this.notificationWaiter) {
      return Promise.reject(
        new AgentExecutionError(
          'protocol_error',
          'Codex has more than one notification consumer.',
          false,
        ),
      )
    }
    return new Promise((resolve, reject) => {
      const expired = (): void => {
        this.settleNotificationWaiter(
          new AgentExecutionError(
            'transient_transport',
            'Codex produced no progress before the inactivity deadline.',
            true,
          ),
        )
      }
      const waiter: NotificationWaiter = { resolve, reject, timeout: undefined, signal }
      const arm = (): void => {
        clearTimeout(waiter.timeout)
        waiter.timeout =
          this.permissionWait.waiting || timeoutMs === undefined
            ? undefined
            : setTimeout(expired, timeoutMs)
      }
      waiter.pauseCleanup = this.permissionWait.subscribe(arm)
      arm()
      if (signal) {
        waiter.abort = (): void => {
          this.settleNotificationWaiter(
            new AgentExecutionError('agent_process_crash', 'Codex was interrupted.', false),
          )
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.notificationWaiter = waiter
    })
  }

  async close(error = new Error('Codex connection closed.')): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    // oxlint-disable-next-line promise/no-promise-in-callback -- Publish completion before onClosed can reenter this method.
    const completion = Promise.withResolvers<void>()
    this.shutdownPromise = completion.promise
    if (!this.closed) this.fail(error)
    // oxlint-disable-next-line promise/no-promise-in-callback -- This method accepts an Error, not a callback.
    void (async () => {
      await this.shutdown()
      await this.processClosed
      await this.outboundWriteTask
      await this.receiveTask
      await this.parserCompletion
      if (this.decisionMemory) {
        // Native exit is not a decoder join. The fixed buffer remains charged
        // until the last physical reader has stopped referring to it.
        this.decisionFrame = undefined
        this.decisionFrameReservation?.release()
        this.decisionFrameReservation = undefined
      }
      for (const [id, pending] of this.pendingRequests) {
        this.pendingRequests.delete(id)
        pending.physicalResolve('connection_closed')
      }
    })().then(completion.resolve, completion.reject)
    return completion.promise
  }

  private async receiveChunk(chunk: Buffer): Promise<void> {
    if (this.closed) return
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline === -1 ? chunk.length : newline
      const fragment = chunk.subarray(offset, end)
      if (fragment.length > 0) {
        if (!this.frameDeadline)
          this.frameDeadline = setTimeout(() => {
            void this.close(
              new AgentExecutionError(
                'protocol_error',
                'Native JSONL framing exceeded its ten-second deadline.',
                false,
              ),
            ).catch(() => undefined)
          }, 10_000)
        this.frameBytes += fragment.length
        if (this.decisionMemory && this.frameBytes > 256 * 1024)
          throw new AgentExecutionError(
            'protocol_error',
            'Decision native frame capacity is full.',
            false,
          )
        this.frameReservation ??= this.memory.reserve(CODEX_FRAME_WORKSPACE_BYTES)
        this.frameReservation.resize(
          CODEX_FRAME_WORKSPACE_BYTES + this.frameBytes * CODEX_PARSE_WORKSPACE_MULTIPLIER,
        )
        if (this.decisionMemory) {
          if (!this.decisionFrame) {
            this.decisionFrameReservation = this.memory.reserve(256 * 1024)
            this.decisionFrame = Buffer.allocUnsafe(256 * 1024)
          }
          fragment.copy(this.decisionFrame, this.frameBytes - fragment.length)
        } else this.frameChunks.push(fragment)
      }
      if (newline === -1) return
      const frame = this.decisionMemory
        ? (this.decisionFrame?.subarray(0, this.frameBytes) ?? Buffer.alloc(0))
        : Buffer.concat(this.frameChunks, this.frameBytes)
      this.frameChunks = []
      this.frameBytes = 0
      const reservation = this.frameReservation ?? this.memory.reserve(CODEX_FRAME_WORKSPACE_BYTES)
      this.frameReservation = undefined
      this.activeInboundReservation = reservation
      try {
        // oxlint-disable-next-line no-await-in-loop -- One logical JSONL frame at a time, with stdout backpressure.
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
      if (frame.length <= CODEX_INLINE_ENCODING_MEMORY_BYTES) {
        if (this.decisionMemory) {
          const workspace = decisionParseWorkspace(frame)
          if (workspace > DECISION_PARSE_WORKSPACE_BYTES)
            throw new AgentExecutionError(
              'protocol_error',
              'Decision native structure capacity is full.',
              false,
            )
          reservation.resize(Math.max(reservation.bytes, workspace))
        }
        message = JSON.parse(this.decoder.decode(frame))
        heldBytes = freezeNativeJsonFrame(message)
        if (this.decisionMemory && heldBytes > DECISION_NATIVE_DTO_BYTES)
          throw new AgentExecutionError(
            'protocol_error',
            'Decision native DTO capacity is full.',
            false,
          )
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
      if (this.closed || !message || typeof message !== 'object') return
      reservation.resize(Math.max(reservation.bytes, heldBytes))
      if (Reflect.get(message, 'method') === 'skills/changed') this.skillChangeListener?.()
      const id = Reflect.get(message, 'id')
      if (
        typeof Reflect.get(message, 'method') !== 'string' &&
        typeof id === 'number' &&
        this.pendingRequests.has(id)
      ) {
        this.settleRequest(id, undefined, message)
        return
      }
      if (Object.hasOwn(message, 'id') && typeof Reflect.get(message, 'method') !== 'string') return
      for (const listener of this.backgroundListeners) if (listener(message)) return
      if (Object.hasOwn(message, 'id') && typeof Reflect.get(message, 'method') === 'string')
        for (const listener of this.serverRequestListeners) if (listener(message)) return
      if (this.notificationWaiter) {
        const waiter = this.notificationWaiter
        this.notificationWaiter = undefined
        this.cleanupNotificationWaiter(waiter)
        waiter.resolve(message)
        return
      }
      reservation.resize(heldBytes)
      this.notificationQueue.push({ message, bytes: wireBytes, reservation })
      retained = true
      this.queuedInboundBytes += wireBytes
      if (
        this.notificationQueue.length - this.notificationHead >
          (this.decisionMemory ? 64 : CODEX_QUEUE_MESSAGE_LIMIT) ||
        (this.decisionMemory && this.queuedInboundBytes > 512 * 1024)
      )
        throw new AgentExecutionError(
          'protocol_error',
          'Native notification item capacity is full.',
          false,
        )
      // A large notification can precede the ACK or approval needed to start its consumer.
      // Pause only when no request/control handler is waiting behind these notifications.
      this.updateStdoutPause()
    } finally {
      if (!retained) {
        if (parserPhysical) {
          const completion = parserPhysical
          void completion.then(() => {
            reservation.release()
            if (this.parserCompletion === completion) this.parserCompletion = undefined
            return undefined
          })
        } else reservation.release()
      }
    }
  }

  private settleRequest(
    id: number,
    error?: Error,
    message?: object,
    failureSource: DiagnosticFailureSource = 'transport_failure',
  ): void {
    const pending = this.pendingRequests.get(id)
    if (!pending) return
    if (message) pending.replied = true
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
  }

  private finishRequestWrite(id: number | undefined): void {
    if (id === undefined) return
    const pending = this.pendingRequests.get(id)
    if (!pending) return
    pending.writeJoined = true
    // A write rejection settles the logical request in its Promise handler.
    // Keep that record available until the handler has consumed the error.
    if (pending.logicalSettled) this.completePhysicalRequest(id, pending)
  }

  private completePhysicalRequest(id: number, pending: PendingRequest): void {
    if (!pending.logicalSettled || !pending.writeJoined || (!pending.replied && pending.dispatched))
      return
    if (this.pendingRequests.get(id) !== pending) return
    this.pendingRequests.delete(id)
    pending.physicalResolve(pending.replied ? 'reply' : 'not_sent')
    this.updateStdoutPause()
  }

  private settleNotificationWaiter(error: Error): void {
    const waiter = this.notificationWaiter
    if (!waiter) return
    this.notificationWaiter = undefined
    this.cleanupNotificationWaiter(waiter)
    waiter.reject(error)
  }

  private cleanupNotificationWaiter(waiter: NotificationWaiter): void {
    clearTimeout(waiter.timeout)
    waiter.pauseCleanup?.()
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort)
  }

  private resumeStdoutIfNeeded(): void {
    this.updateStdoutPause()
  }

  private updateStdoutPause(): void {
    const canWaitForConsumer =
      this.pendingRequests.size === 0 && this.serverRequestListeners.size === 0
    const queued = this.notificationQueue.length - this.notificationHead
    this.notificationQueuePaused =
      !this.closed &&
      (this.notificationQueuePaused
        ? this.queuedInboundBytes > CODEX_QUEUE_LOW_WATER_BYTES ||
          queued >= CODEX_QUEUE_MESSAGE_LIMIT / 2
        : this.queuedInboundBytes >= CODEX_QUEUE_HIGH_WATER_BYTES ||
          queued >= CODEX_QUEUE_MESSAGE_LIMIT / 2)
    const shouldPause =
      !this.closed &&
      (this.inboundProcessing || (canWaitForConsumer && this.notificationQueuePaused))
    if (shouldPause === this.stdoutPaused) return
    this.stdoutPaused = shouldPause
    if (shouldPause) this.child.stdout.pause()
    else this.child.stdout.resume()
  }

  private enqueue(
    message: object,
    options: {
      requestId?: number | undefined
      onDispatch?: (() => void) | undefined
      canDispatch?: (() => boolean) | undefined
      cancelBeforeWriteSignal?: AbortSignal | undefined
    },
  ): Promise<void> {
    if (!this.isOpen) {
      this.finishRequestWrite(options.requestId)
      return Promise.reject(this.closeError ?? new Error('Codex app-server is unavailable.'))
    }
    let heldBytes: number
    let bytes: Buffer | undefined
    let reservation: NativeMemoryReservation
    let counting: NativeMemoryReservation | undefined
    try {
      if (this.decisionMemory) counting = this.memory.reserve(64 * 1024)
      heldBytes = freezeNativeJsonFrame(message)
      if (!this.decisionMemory && heldBytes <= CODEX_INLINE_ENCODING_MEMORY_BYTES) {
        bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
        heldBytes += bytes.length * 3
      }
      heldBytes += CODEX_FRAME_WORKSPACE_BYTES
      reservation = this.memory.reserve(heldBytes)
    } catch (error) {
      this.finishRequestWrite(options.requestId)
      return Promise.reject(error)
    } finally {
      counting?.release()
    }
    if (
      this.outboundQueue.length - this.outboundHead >=
      (this.decisionMemory ? 8 : CODEX_QUEUE_MESSAGE_LIMIT)
    ) {
      reservation.release()
      this.finishRequestWrite(options.requestId)
      return Promise.reject(
        new AgentExecutionError(
          'runtime_incompatible',
          'Native request preparation capacity is full. This frame was not written.',
          false,
        ),
      )
    }
    this.queuedOutboundBytes += heldBytes
    return new Promise((resolve, reject) => {
      const physical = options.requestId === undefined ? Promise.withResolvers<void>() : undefined
      if (physical)
        this.observePhysicalOperation?.(options.cancelBeforeWriteSignal, physical.promise)
      this.outboundQueue.push({
        message,
        expiresAt: Date.now() + CODEX_OUTBOUND_DRAIN_TIMEOUT_MS,
        bytes,
        heldBytes,
        released: false,
        reservation,
        controller: new AbortController(),
        resolve,
        reject,
        physicalResolve: physical?.resolve,
        ...options,
      })
      this.pumpOutbound()
    })
  }

  private pumpOutbound(): void {
    if (this.writing || this.closed) return
    const frame = this.outboundQueue[this.outboundHead]
    if (!frame) return
    if (frame.expiresAt <= Date.now()) {
      this.finishOutbound(
        frame,
        new NativeFrameWriteError('Native frame expired before writing.', false),
      )
      this.pumpOutbound()
      return
    }
    if (
      frame.requestId !== undefined &&
      (!this.pendingRequests.has(frame.requestId) ||
        this.pendingRequests.get(frame.requestId)?.logicalSettled)
    ) {
      this.finishOutbound(frame, new Error('Codex request expired before dispatch.'))
      this.pumpOutbound()
      return
    }
    this.writing = true
    this.activeOutboundFrame = frame
    const signal =
      frame.cancelBeforeWriteSignal ?? this.pendingRequests.get(frame.requestId ?? -1)?.signal
    const writeSignal = frame.controller.signal
    const source = (physicalSignal: AbortSignal): AsyncIterable<Uint8Array> =>
      frame.bytes
        ? (async function* (): AsyncIterable<Uint8Array> {
            for (
              let offset = 0;
              offset < frame.bytes!.length;
              offset += NATIVE_FRAME_WRITE_CHUNK_BYTES
            ) {
              physicalSignal.throwIfAborted()
              yield frame.bytes!.subarray(offset, offset + NATIVE_FRAME_WRITE_CHUNK_BYTES)
            }
          })()
        : encodeNativeJsonFrame(frame.message, physicalSignal)
    const writing = writeNativeFrame(this.child.stdin, source, {
      signal: writeSignal,
      ...(signal ? { cancelBeforeWriteSignal: signal } : {}),
      onFirstWrite: () => frame.onDispatch?.(),
      canDispatch: () =>
        this.isOpen &&
        (this.isLifetimeCurrent?.() ?? true) &&
        (frame.requestId === undefined ||
          (this.pendingRequests.has(frame.requestId) &&
            !this.pendingRequests.get(frame.requestId)?.logicalSettled)) &&
        (frame.canDispatch?.() ?? true),
      deadlineMs: Math.max(1, frame.expiresAt - Date.now()),
    }).then(
      () => {
        this.finishOutbound(frame)
        this.pumpOutbound()
        return undefined
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error('Native frame write failed.')
        this.finishOutbound(frame, failure)
        if (error instanceof NativeFrameWriteError && error.possiblyWritten)
          void this.close(failure).catch(() => undefined)
        else this.pumpOutbound()
        return undefined
      },
    )
    this.outboundWriteTask = writing
  }

  private releaseOutbound(frame: OutboundFrame): void {
    if (frame.released) return
    frame.released = true
    this.queuedOutboundBytes -= frame.heldBytes
    frame.reservation.release()
  }

  private finishOutbound(frame: OutboundFrame, error?: Error): void {
    // A closed queue may already have rejected this frame, but its actual writer still owned the DTO.
    this.releaseOutbound(frame)
    this.finishRequestWrite(frame.requestId)
    frame.physicalResolve?.()
    if (this.activeOutboundFrame === frame) this.activeOutboundFrame = undefined
    if (this.outboundQueue[this.outboundHead] !== frame) return
    this.outboundQueue[this.outboundHead] = undefined
    this.outboundHead += 1
    this.writing = false
    this.compactOutboundQueue()
    if (error) frame.reject(error)
    else frame.resolve()
  }

  private recordExit(code: number | null): void {
    if (this.exitRecorded) return
    this.exitRecorded = true
    recordDiagnostic({
      operation: 'process',
      scope: 'process',
      phase: 'closed',
      level: this.closed ? 'info' : 'error',
      agentId: 'codex',
      executorId: this.executorId,
      failureSource: 'process_exit',
      ...(this.child.pid ? { pid: this.child.pid } : {}),
      ...(code === null ? {} : { exitCode: code }),
      ...(this.closed ? {} : { code: 'agent_process_crash' }),
    })
  }

  private fail(error: Error, failureSource: DiagnosticFailureSource = 'transport_failure'): void {
    if (this.closed) return
    this.closed = true
    this.closeError = error
    this.child.stdout.removeListener('data', this.receive)
    this.child.stderr.removeListener('data', this.receiveError)
    this.child.removeListener('exit', this.processExited)
    this.child.removeListener('close', this.exited)
    this.activeOutboundFrame?.controller.abort()
    this.inboundController.abort()
    this.frameReservation?.release()
    this.frameReservation = undefined
    clearTimeout(this.frameDeadline)
    this.frameDeadline = undefined
    for (const id of this.pendingRequests.keys())
      this.settleRequest(id, error, undefined, failureSource)
    this.settleNotificationWaiter(error)
    for (let index = this.outboundHead; index < this.outboundQueue.length; index += 1) {
      const frame = this.outboundQueue[index]
      if (frame) {
        if (frame !== this.activeOutboundFrame) {
          this.releaseOutbound(frame)
          this.finishRequestWrite(frame.requestId)
          frame.physicalResolve?.()
        }
        frame.reject(error)
      }
    }
    this.outboundQueue.length = 0
    this.outboundHead = 0
    for (const queued of this.notificationQueue) queued?.reservation.release()
    this.notificationQueue.length = 0
    this.backgroundListeners.clear()
    this.skillChangeListener = undefined
    this.serverRequestListeners.clear()
    this.notificationHead = 0
    this.frameChunks = []
    this.frameBytes = 0
    this.queuedInboundBytes = 0
    this.notificationQueuePaused = false
    // A physically active writer retains its reservation until its iterator closes.
    this.writing = false
    if (this.stdoutPaused) this.child.stdout.resume()
    this.stdoutPaused = false
    this.onClosed?.()
  }

  private compactNotificationQueue(): void {
    if (this.notificationHead < 1_024 || this.notificationHead * 2 < this.notificationQueue.length)
      return
    this.notificationQueue.splice(0, this.notificationHead)
    this.notificationHead = 0
  }

  private compactOutboundQueue(): void {
    if (this.outboundHead < 1_024 || this.outboundHead * 2 < this.outboundQueue.length) return
    this.outboundQueue.splice(0, this.outboundHead)
    this.outboundHead = 0
  }

  private async shutdown(): Promise<void> {
    if (this.closeOwnedProcess) {
      await this.closeOwnedProcess()
      this.recordExit(this.child.exitCode)
      return
    }
    if (this.child.exitCode !== null || this.child.signalCode != null) {
      this.recordExit(this.child.exitCode)
      return
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let forceTimeout: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): boolean => {
        if (settled) return false
        settled = true
        clearTimeout(timeout)
        clearTimeout(forceTimeout)
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
      const timeout = setTimeout(() => {
        try {
          this.child.kill('SIGKILL')
        } catch (error) {
          fail(error)
          return
        }
        forceTimeout = setTimeout(() => {
          fail(new Error('Codex process did not exit after SIGKILL.'))
        }, CODEX_FORCE_EXIT_TIMEOUT_MS)
      }, CODEX_SHUTDOWN_TIMEOUT_MS)
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
