import type { NativePermissionWait } from '../native-permission-wait'
import type { NativeMemoryReservation } from '../native-working-memory'
import type {
  AgyIngress,
  AgyOrderedSessionStream,
  AgySessionNotificationStream,
  IngressWaiter,
  NotificationWaiter,
  QueuedIngressItem,
  SessionNotificationConsumer,
} from './protocol'

import { AgentExecutionError, NativeCapacityError } from '../agent-execution-error'
import {
  AGY_MAX_CONTEXTS,
  AGY_QUEUE_HARD_LIMIT_BYTES,
  AGY_QUEUE_HIGH_WATER_BYTES,
  AGY_QUEUE_LOW_WATER_BYTES,
  AGY_QUEUE_MESSAGE_LIMIT,
  formatCloseErrorDetail,
} from './protocol'

export interface AgyIngressRouterHost {
  readonly permissionWait: NativePermissionWait
  isOpen(): boolean
  isClosed(): boolean
  isExitDrainPending(): boolean
  getCloseError(): Error | undefined
  getUnavailableError(): Error
  sendUnconsumedServerRequestCancel(rpcId: string | number, method: string): Promise<void>
  onTaintAndClose(error: Error): void
  onCloseIfNotClosed(error: Error): void
  onBackpressureChanged(): void
  onIdleCheck(): void
}

/**
 * Deep bounded ingress router for Antigravity ACP connections.
 * Owns ordered & legacy per-session streams, global pre-stream notification buffering,
 * 4 MiB / 2 MiB hysteresis backpressure accounting, 8 MiB / 4096-item hard bounds,
 * producer sealing without dropping buffered tail frames, and unconsumed server-request cancellation.
 */
export class AgySessionStreamRouter {
  private readonly sessionConsumers = new Map<string, SessionNotificationConsumer>()
  private readonly streamHandleToConsumer = new WeakMap<object, SessionNotificationConsumer>()
  private readonly notificationQueue: Array<QueuedIngressItem | undefined> = []
  private notificationHead = 0
  private notificationWaiter: NotificationWaiter | undefined
  private readonly pendingServerRequestCancels: Array<
    { readonly rpcId: string | number; readonly method: string } | undefined
  > = []
  private pendingServerRequestCancelsHead = 0
  private drainingServerRequestCancels = false
  private queuedInboundBytesCount = 0
  private queuedInboundItemCount = 0
  private nextInboundSeqValue = 0
  private queuePaused = false

  constructor(private readonly host: AgyIngressRouterHost) {}

  nextSeq(): number {
    this.nextInboundSeqValue += 1
    return this.nextInboundSeqValue
  }

  get queuedInboundBytes(): number {
    return this.queuedInboundBytesCount
  }

  get queuedInboundCount(): number {
    return this.queuedInboundItemCount
  }

  get hasGlobalWaiter(): boolean {
    return Boolean(this.notificationWaiter)
  }

  get hasWaitingConsumer(): boolean {
    if (this.notificationWaiter) return true
    for (const consumer of this.sessionConsumers.values()) {
      if (consumer.waiter || consumer.ingressWaiter) return true
    }
    return false
  }

  get hasPendingWork(): boolean {
    return (
      this.sessionConsumers.size > 0 ||
      this.drainingServerRequestCancels ||
      this.pendingServerRequestCancelsHead < this.pendingServerRequestCancels.length
    )
  }

  lookupConsumerForStream(
    stream: AgyOrderedSessionStream | AgySessionNotificationStream,
  ): SessionNotificationConsumer | undefined {
    return this.streamHandleToConsumer.get(stream)
  }

  getActiveConsumer(sessionId: string): SessionNotificationConsumer | undefined {
    const consumer = this.sessionConsumers.get(sessionId)
    return consumer && !consumer.abandoned && !consumer.producerSealed ? consumer : undefined
  }

  getActiveOrderedConsumer(sessionId: string | undefined): SessionNotificationConsumer | undefined {
    if (sessionId === undefined) return undefined
    const consumer = this.sessionConsumers.get(sessionId)
    return consumer && consumer.ordered && !consumer.abandoned && !consumer.producerSealed
      ? consumer
      : undefined
  }

  listActiveOrderedConsumers(): SessionNotificationConsumer[] {
    const result: SessionNotificationConsumer[] = []
    for (const consumer of this.sessionConsumers.values()) {
      if (consumer.ordered && !consumer.abandoned && !consumer.producerSealed) {
        result.push(consumer)
      }
    }
    return result
  }

  evaluateQueuePause(closed: boolean): boolean {
    this.queuePaused =
      !closed &&
      (this.queuePaused
        ? this.queuedInboundBytesCount > AGY_QUEUE_LOW_WATER_BYTES ||
          this.queuedInboundItemCount >= AGY_QUEUE_MESSAGE_LIMIT / 2
        : this.queuedInboundBytesCount >= AGY_QUEUE_HIGH_WATER_BYTES ||
          this.queuedInboundItemCount >= AGY_QUEUE_MESSAGE_LIMIT / 2)
    return this.queuePaused
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
    if (!sessionId || sessionId.length > 1024) {
      throw new AgentExecutionError('protocol_error', 'Invalid ACP session identity.', false)
    }
    if (this.sessionConsumers.has(sessionId)) {
      throw new AgentExecutionError(
        'protocol_error',
        'This ACP session already has an active notification stream.',
        false,
      )
    }
    if (this.sessionConsumers.size >= AGY_MAX_CONTEXTS) {
      throw new NativeCapacityError('Antigravity session stream capacity is full.')
    }

    const ordered = options?.ordered === true
    const consumer: SessionNotificationConsumer = {
      sessionId,
      ordered,
      queue: [],
      head: 0,
      waiter: undefined,
      ingressWaiter: undefined,
      producerSealed: false,
      endItem: undefined,
      endDelivered: false,
      endError: undefined,
      abandoned: false,
    }
    for (let i = this.notificationHead; i < this.notificationQueue.length; i += 1) {
      const entry = this.notificationQueue[i]
      if (!entry || entry.sessionId !== sessionId) continue
      this.notificationQueue[i] = undefined
      consumer.queue.push(entry)
    }
    const remaining = this.notificationQueue
      .slice(this.notificationHead)
      .filter((entry): entry is QueuedIngressItem => entry !== undefined)
    this.notificationQueue.splice(0, this.notificationQueue.length, ...remaining)
    this.notificationHead = 0

    if (this.host.isClosed()) {
      const closeError = this.host.getCloseError()
      this.sealConsumerProducer(
        consumer,
        'transport',
        true,
        formatCloseErrorDetail(closeError ?? 'Antigravity ACP server is unavailable.'),
        closeError ?? new Error('Antigravity ACP server is unavailable.'),
      )
    } else {
      this.sessionConsumers.set(sessionId, consumer)
      this.host.onBackpressureChanged()
    }

    const abandon = (): void => {
      this.abandonSessionConsumer(consumer)
    }

    if (ordered) {
      const stream: AgyOrderedSessionStream = {
        sessionId,
        shift: () => this.shiftSessionIngress(consumer),
        nextIngress: (timeoutMs?: number, signal?: AbortSignal) =>
          this.nextSessionIngress(consumer, timeoutMs, signal),
        next: () => this.nextOrderedIteratorResult(consumer),
        return: () => {
          abandon()
          return Promise.resolve({ value: undefined, done: true })
        },
        close: abandon,
        abandon,
        [Symbol.asyncIterator]() {
          return stream
        },
      }
      this.streamHandleToConsumer.set(stream, consumer)
      return stream
    }

    const legacyStream: AgySessionNotificationStream = {
      sessionId,
      shift: () => {
        const item = this.shiftQueuedConsumerItem(consumer)
        return item ? item.ingress.message : undefined
      },
      next: (timeoutMs?: number, signal?: AbortSignal) =>
        this.nextSessionNotification(consumer, timeoutMs, signal),
      close: abandon,
      abandon,
    }
    this.streamHandleToConsumer.set(legacyStream, consumer)
    return legacyStream
  }

  enqueueSessionIngress(
    consumer: SessionNotificationConsumer,
    ingress: Exclude<AgyIngress, { kind: 'end' }>,
    wireBytes: number,
    heldBytes: number,
    reservation: NativeMemoryReservation,
  ): boolean {
    if (consumer.ordered) {
      if (consumer.ingressWaiter) {
        const waiter = consumer.ingressWaiter
        consumer.ingressWaiter = undefined
        this.cleanupIngressWaiter(waiter)
        waiter.resolve(ingress)
        return false
      }
      this.admitQueuedNotification(wireBytes, heldBytes, reservation)
      consumer.queue.push({
        sessionId: consumer.sessionId,
        ingress,
        bytes: wireBytes,
        reservation,
      })
      this.host.onBackpressureChanged()
      return true
    }
    if (consumer.waiter) {
      const waiter = consumer.waiter
      consumer.waiter = undefined
      this.cleanupNotificationWaiter(waiter)
      waiter.resolve(ingress.message)
      return false
    }
    this.admitQueuedNotification(wireBytes, heldBytes, reservation)
    consumer.queue.push({
      sessionId: consumer.sessionId,
      ingress,
      bytes: wireBytes,
      reservation,
    })
    this.host.onBackpressureChanged()
    return true
  }

  deliverGlobalNotification(
    sessionId: string | undefined,
    ingress: Exclude<AgyIngress, { kind: 'end' }>,
    wireBytes: number,
    heldBytes: number,
    reservation: NativeMemoryReservation,
  ): boolean {
    if (this.notificationWaiter) {
      const waiter = this.notificationWaiter
      this.notificationWaiter = undefined
      this.cleanupNotificationWaiter(waiter)
      waiter.resolve(ingress.message)
      this.host.onIdleCheck()
      return false
    }
    this.admitQueuedNotification(wireBytes, heldBytes, reservation)
    this.notificationQueue.push({
      sessionId,
      ingress,
      bytes: wireBytes,
      reservation,
    })
    this.host.onBackpressureChanged()
    return true
  }

  nextNotification(timeoutMs: number | undefined, signal?: AbortSignal): Promise<object> {
    if (signal?.aborted) {
      return Promise.reject(
        new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
      )
    }
    const queued = this.notificationQueue[this.notificationHead]
    if (queued) {
      this.notificationQueue[this.notificationHead] = undefined
      this.notificationHead += 1
      this.queuedInboundBytesCount -= queued.bytes
      this.queuedInboundItemCount -= 1
      queued.reservation.release()
      this.compactNotificationQueue()
      this.host.onBackpressureChanged()
      return Promise.resolve(queued.ingress.message)
    }
    if (!this.host.isOpen() && !this.host.isExitDrainPending()) {
      return Promise.reject(this.host.getUnavailableError())
    }
    if (this.notificationWaiter) {
      return Promise.reject(
        new AgentExecutionError(
          'protocol_error',
          'Antigravity has more than one global notification consumer.',
          false,
        ),
      )
    }
    return this.createWaiter(
      timeoutMs,
      signal,
      (waiter) => {
        this.notificationWaiter = waiter
      },
      () => {
        this.settleNotificationWaiter(
          new AgentExecutionError(
            'transient_transport',
            'Antigravity produced no progress before the deadline.',
            true,
          ),
        )
      },
      () => {
        this.settleNotificationWaiter(
          new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
        )
      },
    )
  }

  sealAllOnClose(
    cause: 'eof' | 'transport' | 'deadline',
    incomplete: boolean,
    detail: string | undefined,
    error: Error,
  ): void {
    this.pendingServerRequestCancels.length = 0
    this.pendingServerRequestCancelsHead = 0
    this.settleNotificationWaiter(error)
    for (const consumer of this.sessionConsumers.values()) {
      this.sealConsumerProducer(consumer, cause, incomplete, detail, error)
    }
    this.sessionConsumers.clear()
    for (let i = this.notificationHead; i < this.notificationQueue.length; i += 1) {
      const queued = this.notificationQueue[i]
      if (!queued) continue
      this.notificationQueue[i] = undefined
      this.queuedInboundBytesCount -= queued.bytes
      this.queuedInboundItemCount -= 1
      queued.reservation.release()
    }
    this.notificationQueue.length = 0
    this.notificationHead = 0
    this.queuePaused = false
  }

  private shiftQueuedConsumerItem(
    consumer: SessionNotificationConsumer,
  ): QueuedIngressItem | undefined {
    if (consumer.abandoned) return undefined
    const queued = consumer.queue[consumer.head]
    if (!queued) return undefined
    consumer.queue[consumer.head] = undefined
    consumer.head += 1
    this.queuedInboundBytesCount -= queued.bytes
    this.queuedInboundItemCount -= 1
    queued.reservation.release()
    if (consumer.head >= 512 && consumer.head * 2 >= consumer.queue.length) {
      consumer.queue.splice(0, consumer.head)
      consumer.head = 0
    }
    this.host.onBackpressureChanged()
    return queued
  }

  private shiftSessionIngress(consumer: SessionNotificationConsumer): AgyIngress | undefined {
    if (consumer.abandoned) return undefined
    const queued = this.shiftQueuedConsumerItem(consumer)
    if (queued) return queued.ingress
    if (consumer.producerSealed && !consumer.endDelivered && consumer.endItem) {
      consumer.endDelivered = true
      return consumer.endItem
    }
    return undefined
  }

  private drainPendingServerRequestCancels(): void {
    if (this.drainingServerRequestCancels) return
    if (this.pendingServerRequestCancelsHead >= this.pendingServerRequestCancels.length) {
      this.pendingServerRequestCancels.length = 0
      this.pendingServerRequestCancelsHead = 0
      return
    }
    this.drainingServerRequestCancels = true
    const drain = (async () => {
      try {
        while (this.pendingServerRequestCancelsHead < this.pendingServerRequestCancels.length) {
          if (!this.host.isOpen()) {
            this.host.onCloseIfNotClosed(
              this.host.getCloseError() ??
                new Error(
                  'Antigravity ACP connection closed before cancelling unconsumed server requests.',
                ),
            )
            return
          }
          const next = this.pendingServerRequestCancels[this.pendingServerRequestCancelsHead]!
          try {
            // oxlint-disable-next-line no-await-in-loop -- Drain unconsumed server-request cancellations one frame at a time under outbound memory backpressure.
            await this.host.sendUnconsumedServerRequestCancel(next.rpcId, next.method)
            this.pendingServerRequestCancels[this.pendingServerRequestCancelsHead] = undefined
            this.pendingServerRequestCancelsHead += 1
          } catch (error: unknown) {
            const cancelError =
              error instanceof Error
                ? error
                : new Error('Antigravity failed to cancel unconsumed server request.')
            this.host.onTaintAndClose(cancelError)
            return
          }
        }
      } finally {
        if (this.pendingServerRequestCancelsHead >= this.pendingServerRequestCancels.length) {
          this.pendingServerRequestCancels.length = 0
          this.pendingServerRequestCancelsHead = 0
        }
        this.drainingServerRequestCancels = false
        this.host.onIdleCheck()
      }
    })()
    void drain.catch(() => undefined)
  }

  private abandonSessionConsumer(consumer: SessionNotificationConsumer): void {
    if (consumer.abandoned) return
    consumer.abandoned = true
    if (this.sessionConsumers.get(consumer.sessionId) === consumer) {
      this.sessionConsumers.delete(consumer.sessionId)
    }
    if (consumer.waiter) {
      const waiter = consumer.waiter
      consumer.waiter = undefined
      this.cleanupNotificationWaiter(waiter)
      waiter.reject(new AgentExecutionError('agent_process_crash', 'Session stream closed.', false))
    }
    if (consumer.ingressWaiter) {
      const waiter = consumer.ingressWaiter
      consumer.ingressWaiter = undefined
      this.cleanupIngressWaiter(waiter)
      if (waiter.resolveOnAbandon) {
        waiter.resolveOnAbandon()
      } else {
        waiter.reject(
          new AgentExecutionError('agent_process_crash', 'Session stream closed.', false),
        )
      }
    }
    const pendingCancels: Array<{ readonly rpcId: string | number; readonly method: string }> = []
    for (let i = consumer.head; i < consumer.queue.length; i += 1) {
      const item = consumer.queue[i]
      if (!item) continue
      consumer.queue[i] = undefined
      if (item.ingress.kind === 'server_request') {
        pendingCancels.push({ rpcId: item.ingress.rpcId, method: item.ingress.method })
      }
      this.queuedInboundBytesCount -= item.bytes
      this.queuedInboundItemCount -= 1
      item.reservation.release()
    }
    consumer.queue.length = 0
    consumer.head = 0
    if (pendingCancels.length > 0 && !this.host.isClosed()) {
      for (const entry of pendingCancels) {
        this.pendingServerRequestCancels.push(entry)
      }
      this.drainPendingServerRequestCancels()
    }
    this.host.onBackpressureChanged()
    this.host.onIdleCheck()
  }

  private sealConsumerProducer(
    consumer: SessionNotificationConsumer,
    cause: 'eof' | 'transport' | 'deadline',
    incomplete: boolean,
    detail: string | undefined,
    error: Error,
  ): void {
    if (consumer.abandoned || consumer.producerSealed) return
    consumer.producerSealed = true
    this.host.onBackpressureChanged()
    const endItem: Extract<AgyIngress, { kind: 'end' }> = {
      kind: 'end',
      seq: this.nextSeq(),
      cause,
      incomplete,
      ...(detail !== undefined ? { detail } : {}),
    }
    consumer.endItem = endItem
    consumer.endError = error
    const hasQueued =
      consumer.head < consumer.queue.length && consumer.queue[consumer.head] !== undefined
    if (hasQueued) return
    if (consumer.waiter) {
      const waiter = consumer.waiter
      consumer.waiter = undefined
      consumer.endDelivered = true
      this.cleanupNotificationWaiter(waiter)
      waiter.reject(error)
    }
    if (consumer.ingressWaiter) {
      const waiter = consumer.ingressWaiter
      consumer.ingressWaiter = undefined
      consumer.endDelivered = true
      this.cleanupIngressWaiter(waiter)
      waiter.resolve(endItem)
    }
  }

  private nextSessionNotification(
    consumer: SessionNotificationConsumer,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<object> {
    if (signal?.aborted || consumer.abandoned) {
      return Promise.reject(
        new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
      )
    }
    const queued = this.shiftQueuedConsumerItem(consumer)
    if (queued) return Promise.resolve(queued.ingress.message)
    if (consumer.producerSealed) {
      consumer.endDelivered = true
      return Promise.reject(
        consumer.endError ??
          this.host.getCloseError() ??
          new Error('Antigravity ACP server is unavailable.'),
      )
    }
    if (this.host.isClosed()) {
      return Promise.reject(
        this.host.getCloseError() ?? new Error('Antigravity ACP server is unavailable.'),
      )
    }
    if (consumer.waiter) {
      return Promise.reject(
        new AgentExecutionError(
          'protocol_error',
          'Antigravity session stream already has an active waiter.',
          false,
        ),
      )
    }
    return this.createWaiter(
      timeoutMs,
      signal,
      (waiter) => {
        consumer.waiter = waiter
      },
      () => {
        const waiter = consumer.waiter
        if (!waiter) return
        consumer.waiter = undefined
        this.cleanupNotificationWaiter(waiter)
        waiter.reject(
          new AgentExecutionError(
            'transient_transport',
            'Antigravity did not accept or advance the session before its deadline.',
            true,
          ),
        )
      },
      () => {
        const waiter = consumer.waiter
        if (!waiter) return
        consumer.waiter = undefined
        this.cleanupNotificationWaiter(waiter)
        waiter.reject(
          new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
        )
      },
    )
  }

  private nextSessionIngress(
    consumer: SessionNotificationConsumer,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<AgyIngress> {
    if (signal?.aborted || consumer.abandoned) {
      return Promise.reject(
        new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
      )
    }
    const queued = this.shiftQueuedConsumerItem(consumer)
    if (queued) return Promise.resolve(queued.ingress)
    if (consumer.producerSealed) {
      if (!consumer.endDelivered && consumer.endItem) {
        consumer.endDelivered = true
        return Promise.resolve(consumer.endItem)
      }
      return Promise.reject(
        consumer.endError ??
          this.host.getCloseError() ??
          new Error('Antigravity ACP server is unavailable.'),
      )
    }
    if (consumer.ingressWaiter) {
      return Promise.reject(
        new AgentExecutionError(
          'protocol_error',
          'Antigravity session stream already has an active waiter.',
          false,
        ),
      )
    }
    return this.createIngressWaiter(
      timeoutMs,
      signal,
      undefined,
      (waiter) => {
        consumer.ingressWaiter = waiter
      },
      () => {
        const waiter = consumer.ingressWaiter
        if (!waiter) return
        consumer.ingressWaiter = undefined
        this.cleanupIngressWaiter(waiter)
        waiter.reject(
          new AgentExecutionError(
            'transient_transport',
            'Antigravity did not accept or advance the session before its deadline.',
            true,
          ),
        )
      },
      () => {
        const waiter = consumer.ingressWaiter
        if (!waiter) return
        consumer.ingressWaiter = undefined
        this.cleanupIngressWaiter(waiter)
        waiter.reject(
          new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
        )
      },
    )
  }

  private nextOrderedIteratorResult(
    consumer: SessionNotificationConsumer,
  ): Promise<IteratorResult<AgyIngress, void>> {
    if (consumer.abandoned) {
      return Promise.resolve({ value: undefined, done: true })
    }
    const queued = this.shiftQueuedConsumerItem(consumer)
    if (queued) {
      return Promise.resolve({ value: queued.ingress, done: false })
    }
    if (consumer.producerSealed) {
      if (!consumer.endDelivered && consumer.endItem) {
        consumer.endDelivered = true
        return Promise.resolve({ value: consumer.endItem, done: false })
      }
      return Promise.resolve({ value: undefined, done: true })
    }
    if (consumer.ingressWaiter) {
      return Promise.reject(
        new AgentExecutionError(
          'protocol_error',
          'Antigravity session stream already has an active waiter.',
          false,
        ),
      )
    }
    return new Promise<IteratorResult<AgyIngress, void>>((resolveIter, rejectIter) => {
      const waiter: IngressWaiter = {
        resolve: (item) => resolveIter({ value: item, done: false }),
        reject: rejectIter,
        resolveOnAbandon: () => resolveIter({ value: undefined, done: true }),
        timeout: undefined,
      }
      consumer.ingressWaiter = waiter
    })
  }

  private createWaiter(
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    install: (waiter: NotificationWaiter) => void,
    onExpired: () => void,
    onAborted: () => void,
  ): Promise<object> {
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = { resolve, reject, timeout: undefined, signal }
      const arm = (): void => {
        clearTimeout(waiter.timeout)
        waiter.timeout =
          this.host.permissionWait.waiting || timeoutMs === undefined
            ? undefined
            : setTimeout(onExpired, timeoutMs)
      }
      waiter.pauseCleanup = this.host.permissionWait.subscribe(arm)
      arm()
      if (signal) {
        waiter.abort = onAborted
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      install(waiter)
    })
  }

  private createIngressWaiter(
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    resolveOnAbandon: (() => void) | undefined,
    install: (waiter: IngressWaiter) => void,
    onExpired: () => void,
    onAborted: () => void,
  ): Promise<AgyIngress> {
    return new Promise((resolve, reject) => {
      const waiter: IngressWaiter = {
        resolve,
        reject,
        resolveOnAbandon,
        timeout: undefined,
        signal,
      }
      const arm = (): void => {
        clearTimeout(waiter.timeout)
        waiter.timeout =
          this.host.permissionWait.waiting || timeoutMs === undefined
            ? undefined
            : setTimeout(onExpired, timeoutMs)
      }
      waiter.pauseCleanup = this.host.permissionWait.subscribe(arm)
      arm()
      if (signal) {
        waiter.abort = onAborted
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      install(waiter)
    })
  }

  private settleNotificationWaiter(error: Error): void {
    const waiter = this.notificationWaiter
    if (!waiter) return
    this.notificationWaiter = undefined
    this.cleanupNotificationWaiter(waiter)
    waiter.reject(error)
    this.host.onIdleCheck()
  }

  private cleanupNotificationWaiter(waiter: NotificationWaiter): void {
    clearTimeout(waiter.timeout)
    waiter.pauseCleanup?.()
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort)
  }

  private cleanupIngressWaiter(waiter: IngressWaiter): void {
    clearTimeout(waiter.timeout)
    waiter.pauseCleanup?.()
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort)
  }

  private admitQueuedNotification(
    wireBytes: number,
    heldBytes: number,
    reservation: NativeMemoryReservation,
  ): void {
    if (
      this.queuedInboundItemCount + 1 > AGY_QUEUE_MESSAGE_LIMIT ||
      this.queuedInboundBytesCount + wireBytes > AGY_QUEUE_HARD_LIMIT_BYTES
    ) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity notification queue exceeded its 8 MiB / 4096-item capacity.',
        false,
      )
    }
    reservation.resize(heldBytes)
    this.queuedInboundBytesCount += wireBytes
    this.queuedInboundItemCount += 1
  }

  private compactNotificationQueue(): void {
    if (
      this.notificationHead < 1_024 ||
      this.notificationHead * 2 < this.notificationQueue.length
    ) {
      return
    }
    this.notificationQueue.splice(0, this.notificationHead)
    this.notificationHead = 0
  }
}
