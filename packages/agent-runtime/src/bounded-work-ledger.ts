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
  private readonly confirmedToProvisional = new Map<string, Set<string>>()
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

  get aliasCount(): number {
    return this.provisionalToConfirmed.size
  }

  get hasActiveTasks(): boolean {
    return this.activeCount > 0
  }

  get overflowed(): boolean {
    return this.overflowedFlag
  }

  markAmbient(taskId: string): void {
    if (!taskId) return
    let removed = false
    this.addBoundedId(this.ambientIds, taskId)

    const mappedConfirmed = this.provisionalToConfirmed.get(taskId)
    if (mappedConfirmed !== undefined) {
      this.addBoundedId(this.ambientIds, mappedConfirmed)
      if (this.confirmed.delete(mappedConfirmed)) removed = true
      const linked = this.unlinkConfirmedAliases(mappedConfirmed)
      for (const launchId of linked) {
        this.addBoundedId(this.ambientIds, launchId)
        if (this.provisional.delete(launchId)) removed = true
      }
    }

    const linkedProvisionals = this.unlinkConfirmedAliases(taskId)
    for (const launchId of linkedProvisionals) {
      this.addBoundedId(this.ambientIds, launchId)
      if (this.provisional.delete(launchId)) removed = true
    }

    if (this.confirmed.delete(taskId)) removed = true
    if (this.provisional.delete(taskId)) removed = true
    this.earlyCompletedIds.delete(taskId)
    if (removed) {
      this.onChange?.()
    }
  }

  isAmbient(taskId: string): boolean {
    return this.ambientIds.has(taskId)
  }

  registerProvisional(launchId: string, meta: TMeta): boolean {
    if (!launchId || this.ambientIds.has(launchId)) return false
    if (this.earlyCompletedIds.has(launchId)) {
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
    if (!confirmedTaskId) return false
    if (
      this.ambientIds.has(confirmedTaskId) ||
      (provisionalLaunchId !== undefined && this.ambientIds.has(provisionalLaunchId))
    ) {
      let removed = false
      this.addBoundedId(this.ambientIds, confirmedTaskId)
      if (provisionalLaunchId !== undefined) {
        this.addBoundedId(this.ambientIds, provisionalLaunchId)
        if (this.provisional.delete(provisionalLaunchId)) removed = true
        this.unlinkProvisionalAlias(provisionalLaunchId)
      }
      if (this.confirmed.delete(confirmedTaskId)) removed = true
      const linked = this.unlinkConfirmedAliases(confirmedTaskId)
      for (const launchId of linked) {
        this.addBoundedId(this.ambientIds, launchId)
        if (this.provisional.delete(launchId)) removed = true
      }
      if (removed) this.onChange?.()
      return false
    }

    const existingMapped =
      provisionalLaunchId !== undefined
        ? this.provisionalToConfirmed.get(provisionalLaunchId)
        : undefined
    const conflictingConfirmedAlias =
      existingMapped !== undefined && existingMapped !== confirmedTaskId
    if (conflictingConfirmedAlias) {
      // Two contradictory confirmed IDs claimed the same provisional launch ID:
      // preserve the already-mapped confirmed task and latch observation uncertainty.
      this.latchOverflow(
        `Conflicting confirmed task identities for provisional launch ${provisionalLaunchId}.`,
      )
    }

    const hadProvisional =
      provisionalLaunchId !== undefined ? this.provisional.delete(provisionalLaunchId) : false

    const completedByConfirmed = this.earlyCompletedIds.has(confirmedTaskId)
    const completedByProvisional =
      provisionalLaunchId !== undefined &&
      !conflictingConfirmedAlias &&
      this.earlyCompletedIds.has(provisionalLaunchId)
    if (completedByConfirmed || completedByProvisional) {
      let removed = hadProvisional
      if (this.confirmed.delete(confirmedTaskId)) removed = true
      const linked = this.unlinkConfirmedAliases(confirmedTaskId)
      for (const launchId of linked) {
        if (this.provisional.delete(launchId)) removed = true
        this.recordCompletedId(launchId)
      }
      if (provisionalLaunchId !== undefined && !conflictingConfirmedAlias) {
        this.unlinkProvisionalAlias(provisionalLaunchId)
        this.recordCompletedId(provisionalLaunchId)
      }
      this.recordCompletedId(confirmedTaskId)
      if (removed) this.onChange?.()
      return true
    }

    if (this.confirmed.has(confirmedTaskId)) {
      if (provisionalLaunchId && !conflictingConfirmedAlias) {
        this.linkAlias(provisionalLaunchId, confirmedTaskId)
      }
      this.confirmed.set(confirmedTaskId, {
        ...(provisionalLaunchId && !conflictingConfirmedAlias
          ? { provisionalId: provisionalLaunchId }
          : {}),
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

    if (provisionalLaunchId && !conflictingConfirmedAlias) {
      this.linkAlias(provisionalLaunchId, confirmedTaskId)
    }
    this.confirmed.set(confirmedTaskId, {
      ...(provisionalLaunchId && !conflictingConfirmedAlias
        ? { provisionalId: provisionalLaunchId }
        : {}),
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
    const retiredIds = new Set<string>([id])
    if (this.confirmed.delete(id)) {
      removed = true
    }
    const linkedFromConfirmed = this.unlinkConfirmedAliases(id)
    for (const launchId of linkedFromConfirmed) {
      retiredIds.add(launchId)
      if (this.provisional.delete(launchId)) removed = true
    }
    if (this.provisional.delete(id)) {
      removed = true
    }
    const mappedConfirmed = this.provisionalToConfirmed.get(id)
    if (mappedConfirmed !== undefined) {
      retiredIds.add(mappedConfirmed)
      if (this.confirmed.delete(mappedConfirmed)) {
        removed = true
      }
      const linked = this.unlinkConfirmedAliases(mappedConfirmed)
      for (const launchId of linked) {
        retiredIds.add(launchId)
        if (this.provisional.delete(launchId)) removed = true
      }
      this.unlinkProvisionalAlias(id)
    }
    for (const retiredId of retiredIds) {
      this.recordCompletedId(retiredId)
    }
    if (removed) {
      this.onChange?.()
      return true
    }
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
    this.confirmedToProvisional.clear()
    this.earlyCompletedIds.clear()
    this.ambientIds.clear()
    if (hadAny) this.onChange?.()
  }

  private addBoundedId(target: Set<string>, id: string): void {
    if (target.size >= this.maxEarlyTombstones && !target.has(id)) {
      const oldest = target.values().next().value
      if (oldest !== undefined) target.delete(oldest)
    }
    target.add(id)
  }

  private recordCompletedId(id: string): void {
    if (this.earlyCompletedIds.has(id)) return
    if (this.earlyCompletedIds.size >= this.maxEarlyTombstones) {
      const oldest = this.earlyCompletedIds.values().next().value
      if (oldest !== undefined) this.earlyCompletedIds.delete(oldest)
      this.latchOverflow(
        `Background task completion tombstones exceeded ${this.maxEarlyTombstones} entries.`,
      )
    }
    this.earlyCompletedIds.add(id)
  }

  private linkAlias(provisionalId: string, confirmedId: string): void {
    const previousConfirmed = this.provisionalToConfirmed.get(provisionalId)
    if (previousConfirmed !== undefined && previousConfirmed !== confirmedId) {
      this.unlinkProvisionalAlias(provisionalId)
    }
    const maxAliases = Math.max(this.maxTasks * 2, this.maxEarlyTombstones)
    if (
      !this.provisionalToConfirmed.has(provisionalId) &&
      this.provisionalToConfirmed.size >= maxAliases
    ) {
      const oldestProvisional = this.provisionalToConfirmed.keys().next().value
      if (oldestProvisional !== undefined) {
        this.unlinkProvisionalAlias(oldestProvisional)
        this.latchOverflow(`Background task alias table exceeded ${maxAliases} entries.`)
      }
    }
    this.provisionalToConfirmed.set(provisionalId, confirmedId)
    let set = this.confirmedToProvisional.get(confirmedId)
    if (!set) {
      set = new Set<string>()
      this.confirmedToProvisional.set(confirmedId, set)
    }
    set.add(provisionalId)
  }

  private unlinkProvisionalAlias(provisionalId: string): void {
    const confirmedId = this.provisionalToConfirmed.get(provisionalId)
    if (confirmedId === undefined) return
    this.provisionalToConfirmed.delete(provisionalId)
    const set = this.confirmedToProvisional.get(confirmedId)
    if (set) {
      set.delete(provisionalId)
      if (set.size === 0) this.confirmedToProvisional.delete(confirmedId)
    }
  }

  private unlinkConfirmedAliases(confirmedId: string): readonly string[] {
    const set = this.confirmedToProvisional.get(confirmedId)
    if (!set) return []
    const linked = [...set]
    this.confirmedToProvisional.delete(confirmedId)
    for (const launchId of linked) {
      if (this.provisionalToConfirmed.get(launchId) === confirmedId) {
        this.provisionalToConfirmed.delete(launchId)
      }
    }
    return linked
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
  readonly droppedCount: number
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
  private droppedCountValue = 0
  private overflowedFlag = false
  private admittingFlag = true
  private abortedFlag = false
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

  get failedCount(): number {
    return this.failedCountValue
  }

  get droppedCount(): number {
    return this.droppedCountValue
  }

  get overflowed(): boolean {
    return this.overflowedFlag
  }

  get closed(): boolean {
    return !this.admittingFlag
  }

  /** Returns a live synchronous snapshot of queue settlement counters. */
  snapshot(): RecordingDrainResult {
    return this.snapshotResult(
      this.activeCountValue === 0 && this.queuedCount === 0,
      this.abortedFlag,
    )
  }

  /** Stops accepting new work while allowing already-accepted queued entries to finish. */
  closeAdmission(): void {
    this.admittingFlag = false
  }

  enqueue(work: (signal: AbortSignal) => Promise<void>): boolean {
    if (!this.admittingFlag || this.abortedFlag || this.controller.signal.aborted) {
      this.droppedCountValue += 1
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
    this.closeAdmission()
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

  /** Resolves once all currently active workers have physically finished. */
  async whenWorkersIdle(): Promise<void> {
    if (this.activeCountValue === 0 && this.queuedCount === 0) return
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve)
    })
  }

  /**
   * Aborts all in-flight work, drops unstarted queued entries, and prevents future enqueues.
   */
  abortAll(): void {
    this.admittingFlag = false
    this.abortedFlag = true
    const remaining = this.queuedCount
    if (remaining > 0) {
      this.droppedCountValue += remaining
    }
    this.queue.length = 0
    this.head = 0
    if (!this.controller.signal.aborted) {
      this.controller.abort()
    }
    this.notifyIdleIfEmpty()
  }

  private pump(): void {
    while (
      !this.abortedFlag &&
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
      droppedCount: this.droppedCountValue,
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
