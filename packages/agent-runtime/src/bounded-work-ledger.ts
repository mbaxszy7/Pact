export const DEFAULT_MAX_BACKGROUND_TASKS = 64
export const DEFAULT_RECORDING_MAX_CONCURRENCY = 8
export const DEFAULT_RECORDING_MAX_QUEUE = 64
export const DEFAULT_MAX_EARLY_TOMBSTONES = 128

export interface BackgroundTaskRecord<TMeta = undefined> {
  readonly provisionalId?: string | undefined
  readonly confirmedTaskId?: string | undefined
  readonly stage: 'provisional' | 'confirmed'
  readonly meta: TMeta
}

export interface BackgroundTaskTableOptions {
  readonly maxTasks?: number | undefined
  readonly maxEarlyTombstones?: number | undefined
  readonly onOverflow?: ((reason: string) => void) | undefined
  readonly onChange?: (() => void) | undefined
}

/**
 * Two-stage bounded background work table shared across Claude, Codex, and Agy.
 *
 * Distinguishes:
 * - `provisional`: a native tool/subagent launch observed before its provider task ID arrives.
 * - `confirmed`: a provider-authenticated background task ID.
 * - `ambient`: provider-internal ambient tasks excluded from root settlement gating (L4).
 *
 * Fail-closed guarantee: once active entries exceed `maxTasks` (default 64), `overflowed`
 * latches permanently to `true` so callers report `unknown` instead of falsely claiming `settled`.
 */
export class BoundedBackgroundTaskTable<TMeta = undefined> {
  private readonly maxTasks: number
  private readonly maxEarlyTombstones: number
  private readonly onOverflow?: ((reason: string) => void) | undefined
  private readonly onChange?: (() => void) | undefined

  private readonly provisional = new Map<string, BackgroundTaskRecord<TMeta>>()
  private readonly confirmed = new Map<string, BackgroundTaskRecord<TMeta>>()
  private readonly provisionalToConfirmed = new Map<string, string>()
  private readonly ambientIds = new Set<string>()
  private readonly earlyCompletedIds = new Set<string>()
  private overflowedFlag = false

  constructor(options: BackgroundTaskTableOptions = {}) {
    this.maxTasks = options.maxTasks ?? DEFAULT_MAX_BACKGROUND_TASKS
    this.maxEarlyTombstones = options.maxEarlyTombstones ?? DEFAULT_MAX_EARLY_TOMBSTONES
    this.onOverflow = options.onOverflow
    this.onChange = options.onChange
  }

  get activeCount(): number {
    return this.provisional.size + this.confirmed.size
  }

  get provisionalCount(): number {
    return this.provisional.size
  }

  get confirmedCount(): number {
    return this.confirmed.size
  }

  get hasActiveTasks(): boolean {
    return this.activeCount > 0
  }

  get overflowed(): boolean {
    return this.overflowedFlag
  }

  markAmbient(taskId: string): void {
    if (!taskId) return
    if (this.ambientIds.size >= this.maxEarlyTombstones && !this.ambientIds.has(taskId)) {
      const oldest = this.ambientIds.values().next().value
      if (oldest !== undefined) this.ambientIds.delete(oldest)
    }
    this.ambientIds.add(taskId)
    const removedConfirmed = this.confirmed.delete(taskId)
    const removedProvisional = this.provisional.delete(taskId)
    if (removedConfirmed || removedProvisional) {
      this.onChange?.()
    }
  }

  isAmbient(taskId: string): boolean {
    return this.ambientIds.has(taskId)
  }

  registerProvisional(launchId: string, meta: TMeta): boolean {
    if (!launchId || this.ambientIds.has(launchId)) return false
    if (this.earlyCompletedIds.delete(launchId)) {
      return true
    }
    const alreadyConfirmedId = this.provisionalToConfirmed.get(launchId)
    if (alreadyConfirmedId !== undefined) {
      return true
    }
    if (this.provisional.has(launchId)) {
      this.provisional.set(launchId, { provisionalId: launchId, stage: 'provisional', meta })
      return true
    }
    if (this.activeCount >= this.maxTasks) {
      this.latchOverflow(`Background task table exceeded ${this.maxTasks} active entries.`)
      return false
    }
    this.provisional.set(launchId, { provisionalId: launchId, stage: 'provisional', meta })
    this.onChange?.()
    return true
  }

  confirmTask(confirmedTaskId: string, meta: TMeta, provisionalLaunchId?: string): boolean {
    if (!confirmedTaskId || this.ambientIds.has(confirmedTaskId)) return false
    if (provisionalLaunchId && this.ambientIds.has(provisionalLaunchId)) return false

    const hadProvisional =
      provisionalLaunchId !== undefined ? this.provisional.delete(provisionalLaunchId) : false

    if (this.earlyCompletedIds.delete(confirmedTaskId)) {
      if (provisionalLaunchId) this.provisionalToConfirmed.delete(provisionalLaunchId)
      if (hadProvisional) this.onChange?.()
      return true
    }

    if (this.confirmed.has(confirmedTaskId)) {
      if (provisionalLaunchId) {
        this.provisionalToConfirmed.set(provisionalLaunchId, confirmedTaskId)
      }
      this.confirmed.set(confirmedTaskId, {
        ...(provisionalLaunchId ? { provisionalId: provisionalLaunchId } : {}),
        confirmedTaskId,
        stage: 'confirmed',
        meta,
      })
      if (hadProvisional) this.onChange?.()
      return true
    }

    if (this.activeCount >= this.maxTasks) {
      this.latchOverflow(`Background task table exceeded ${this.maxTasks} active entries.`)
      return false
    }

    if (provisionalLaunchId) {
      this.provisionalToConfirmed.set(provisionalLaunchId, confirmedTaskId)
    }
    this.confirmed.set(confirmedTaskId, {
      ...(provisionalLaunchId ? { provisionalId: provisionalLaunchId } : {}),
      confirmedTaskId,
      stage: 'confirmed',
      meta,
    })
    this.onChange?.()
    return true
  }

  completeTask(id: string): boolean {
    if (!id || this.ambientIds.has(id)) return false
    let removed = false
    if (this.confirmed.delete(id)) {
      removed = true
      for (const [launchId, confirmedId] of this.provisionalToConfirmed) {
        if (confirmedId === id) {
          this.provisionalToConfirmed.delete(launchId)
        }
      }
    }
    if (this.provisional.delete(id)) {
      removed = true
    }
    const mappedConfirmed = this.provisionalToConfirmed.get(id)
    if (mappedConfirmed !== undefined) {
      this.provisionalToConfirmed.delete(id)
      if (this.confirmed.delete(mappedConfirmed)) {
        removed = true
      }
    }
    if (removed) {
      this.onChange?.()
      return true
    }
    // Out-of-order completion before confirmation: retain bounded tombstone.
    if (this.earlyCompletedIds.size >= this.maxEarlyTombstones) {
      const oldest = this.earlyCompletedIds.values().next().value
      if (oldest !== undefined) this.earlyCompletedIds.delete(oldest)
    }
    this.earlyCompletedIds.add(id)
    return false
  }

  getConfirmed(confirmedTaskId: string): BackgroundTaskRecord<TMeta> | undefined {
    return this.confirmed.get(confirmedTaskId)
  }

  getProvisional(launchId: string): BackgroundTaskRecord<TMeta> | undefined {
    return this.provisional.get(launchId)
  }

  snapshot(): {
    readonly provisional: readonly BackgroundTaskRecord<TMeta>[]
    readonly confirmed: readonly BackgroundTaskRecord<TMeta>[]
    readonly overflowed: boolean
  } {
    return {
      provisional: [...this.provisional.values()],
      confirmed: [...this.confirmed.values()],
      overflowed: this.overflowedFlag,
    }
  }

  markOverflowed(reason: string): void {
    this.latchOverflow(reason)
  }

  clear(): void {
    const hadAny = this.activeCount > 0
    this.provisional.clear()
    this.confirmed.clear()
    this.provisionalToConfirmed.clear()
    this.earlyCompletedIds.clear()
    this.ambientIds.clear()
    if (hadAny) this.onChange?.()
  }

  private latchOverflow(reason: string): void {
    if (this.overflowedFlag) return
    this.overflowedFlag = true
    this.onOverflow?.(reason)
  }
}

export interface BoundedRecordingQueueOptions {
  readonly maxConcurrency?: number | undefined
  readonly maxQueue?: number | undefined
  readonly onOverflow?: ((reason: string) => void) | undefined
  readonly onTaskError?: ((error: unknown) => void) | undefined
}

export interface RecordingDrainResult {
  readonly drained: boolean
  readonly completedCount: number
  readonly failedCount: number
  readonly overflowed: boolean
  readonly aborted: boolean
}

interface QueuedRecording {
  readonly work: (signal: AbortSignal) => Promise<void>
}

/**
 * Bounded async recording queue enforcing Pact's architecture resource limits:
 * - At most `maxConcurrency` (default 8) concurrent recording workers.
 * - At most `maxQueue` (default 64) FIFO waiting entries.
 * - Fail-closed overflow signaling (`onOverflow`) so callers mark effects uncertain
 *   instead of allowing unbounded memory growth or silently dropping writes.
 */
export class BoundedRecordingQueue {
  private readonly maxConcurrency: number
  private readonly maxQueue: number
  private readonly onOverflow?: ((reason: string) => void) | undefined
  private readonly onTaskError?: ((error: unknown) => void) | undefined

  private readonly controller = new AbortController()
  private readonly queue: Array<QueuedRecording | undefined> = []
  private head = 0
  private activeCountValue = 0
  private completedCountValue = 0
  private failedCountValue = 0
  private overflowedFlag = false
  private closedFlag = false
  private idleWaiters: Array<() => void> = []

  constructor(options: BoundedRecordingQueueOptions = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_RECORDING_MAX_CONCURRENCY)
    this.maxQueue = Math.max(1, options.maxQueue ?? DEFAULT_RECORDING_MAX_QUEUE)
    this.onOverflow = options.onOverflow
    this.onTaskError = options.onTaskError
  }

  get activeCount(): number {
    return this.activeCountValue
  }

  get queuedCount(): number {
    return this.queue.length - this.head
  }

  get overflowed(): boolean {
    return this.overflowedFlag
  }

  get closed(): boolean {
    return this.closedFlag
  }

  enqueue(work: (signal: AbortSignal) => Promise<void>): boolean {
    if (this.closedFlag || this.controller.signal.aborted) {
      return false
    }
    if (this.activeCountValue < this.maxConcurrency && this.queuedCount === 0) {
      this.startWorker(work)
      return true
    }
    if (this.queuedCount >= this.maxQueue) {
      this.overflowedFlag = true
      this.onOverflow?.(
        `Native recording queue exceeded its ${this.maxQueue}-item FIFO bound (${this.maxConcurrency} workers active).`,
      )
      return false
    }
    this.queue.push({ work })
    this.pump()
    return true
  }

  /**
   * Stops accepting new work and resolves once all currently active and queued tasks finish,
   * or early if `deadlineSignal` aborts.
   */
  async drain(deadlineSignal?: AbortSignal): Promise<RecordingDrainResult> {
    if (this.activeCountValue === 0 && this.queuedCount === 0) {
      return this.snapshotResult(true, Boolean(deadlineSignal?.aborted))
    }
    if (deadlineSignal?.aborted) {
      return this.snapshotResult(false, true)
    }

    const drained = await new Promise<boolean>((resolve) => {
      let settled = false
      const onIdle = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(true)
      }
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(false)
      }
      const cleanup = (): void => {
        this.idleWaiters = this.idleWaiters.filter((entry) => entry !== onIdle)
        deadlineSignal?.removeEventListener('abort', onAbort)
      }
      this.idleWaiters.push(onIdle)
      deadlineSignal?.addEventListener('abort', onAbort, { once: true })
    })

    return this.snapshotResult(drained, !drained && Boolean(deadlineSignal?.aborted))
  }

  /**
   * Aborts all in-flight work, drops unstarted queued entries, and prevents future enqueues.
   */
  abortAll(): void {
    this.closedFlag = true
    this.queue.length = 0
    this.head = 0
    if (!this.controller.signal.aborted) {
      this.controller.abort()
    }
    this.notifyIdleIfEmpty()
  }

  private pump(): void {
    while (
      !this.closedFlag &&
      !this.controller.signal.aborted &&
      this.activeCountValue < this.maxConcurrency &&
      this.head < this.queue.length
    ) {
      const entry = this.queue[this.head]
      this.queue[this.head] = undefined
      this.head += 1
      if (this.head >= 64 && this.head * 2 >= this.queue.length) {
        this.queue.splice(0, this.head)
        this.head = 0
      }
      if (entry) {
        this.startWorker(entry.work)
      }
    }
  }

  private startWorker(work: (signal: AbortSignal) => Promise<void>): void {
    this.activeCountValue += 1
    void Promise.resolve()
      .then(() => work(this.controller.signal))
      .then(
        () => {
          this.completedCountValue += 1
          return undefined
        },
        (error: unknown) => {
          this.failedCountValue += 1
          this.onTaskError?.(error)
          return undefined
        },
      )
      .finally(() => {
        this.activeCountValue -= 1
        this.pump()
        this.notifyIdleIfEmpty()
      })
  }

  private notifyIdleIfEmpty(): void {
    if (this.activeCountValue > 0 || this.queuedCount > 0) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const wake of waiters) {
      wake()
    }
  }

  private snapshotResult(drained: boolean, aborted: boolean): RecordingDrainResult {
    return {
      drained,
      completedCount: this.completedCountValue,
      failedCount: this.failedCountValue,
      overflowed: this.overflowedFlag,
      aborted,
    }
  }
}

export interface BoundedWorkLedgerOptions {
  readonly tasks?: BackgroundTaskTableOptions | undefined
  readonly recordings?: BoundedRecordingQueueOptions | undefined
}

/**
 * Combined bounded ledger pairing the two-stage background task table with the
 * 8-concurrency / 64-FIFO recording queue for a single Run owner.
 */
export class BoundedWorkLedger<TMeta = undefined> {
  readonly tasks: BoundedBackgroundTaskTable<TMeta>
  readonly recordings: BoundedRecordingQueue

  constructor(options: BoundedWorkLedgerOptions = {}) {
    this.tasks = new BoundedBackgroundTaskTable<TMeta>(options.tasks)
    this.recordings = new BoundedRecordingQueue(options.recordings)
  }

  get hasPendingWork(): boolean {
    return (
      this.tasks.hasActiveTasks ||
      this.recordings.activeCount > 0 ||
      this.recordings.queuedCount > 0
    )
  }

  get hasUncertainOverflow(): boolean {
    return this.tasks.overflowed || this.recordings.overflowed
  }

  dispose(): void {
    this.recordings.abortAll()
    this.tasks.clear()
  }
}
