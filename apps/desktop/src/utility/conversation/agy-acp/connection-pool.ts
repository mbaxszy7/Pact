import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'

import type {
  AgyAcpConnectionPoolOptions,
  AgyPermissionScope,
  AgyPoolAcquireInput,
  AgyPoolIdleRetirement,
  AgyPoolLease,
  OwnedAgyProcess,
  PoolCapacityWaiter,
  PooledConnectionEntry,
} from './protocol'

import { OwnedProcessGroup } from '../../owned-process-group'
import {
  AgentExecutionError,
  NativeCapacityError,
  PermissionModeRejectedError,
} from '../agent-execution-error'
import { AgyAcpConnection } from './connection'
import {
  AGY_CONTROL_RPC_TIMEOUT_MS,
  AGY_IDLE_CONNECTION_TIMEOUT_MS,
  AGY_INITIALIZATION_TIMEOUT_MS,
  AGY_MAX_CONTEXTS,
  DisposedSpawnCloseError,
  agyProcessEnvironment,
  buildAgySpawnArgs,
  createUnconfirmedProcessError,
  formatAndValidateAgyOwnedSpawnArgs,
  resolveConfiguredAgyGeminiDir,
} from './protocol'

export class AgyAcpConnectionPool {
  private readonly entries = new Map<string, PooledConnectionEntry>()
  private readonly retiringEntries = new Set<PooledConnectionEntry>()
  private readonly unconfirmedClosedSessions = new Set<string>()
  private readonly pendingLeaseReservations = new Set<symbol>()
  private readonly capacityWaiters = new Set<PoolCapacityWaiter>()
  private readonly physicalOperationListeners = new Set<
    (signal: AbortSignal | undefined, physicalCompletion: Promise<unknown>) => void
  >()
  private readonly closingTasks = new Set<Promise<void>>()
  private readonly activeClosingConnections = new Set<AgyAcpConnection>()
  private readonly unconfirmedClosingConnections = new Set<AgyAcpConnection>()
  private readonly shutdownDeadlineListeners = new Set<(deadlineAt: number) => void>()
  private boundedUnconfirmedProbeTimer: ReturnType<typeof setInterval> | undefined
  private activeShutdownWaiters = 0
  private disposed = false
  private activeDisposal: Promise<void> | undefined
  private disposalSettledCleanly = false
  private shutdownDeadlineAt: number | undefined
  private latestExecutorId = randomUUID()
  private readonly idleTimeoutMs: number
  private readonly clientInfo: { name: string; title: string; version: string }

  constructor(private readonly options: AgyAcpConnectionPoolOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? AGY_IDLE_CONNECTION_TIMEOUT_MS
    this.clientInfo = {
      name: options.clientInfo?.name ?? 'pact',
      title: options.clientInfo?.title ?? 'Pact',
      version: options.clientInfo?.version ?? '0.4.0',
    }
    if (options.observePhysicalOperation) {
      this.physicalOperationListeners.add(options.observePhysicalOperation)
    }
  }

  subscribePhysicalOperations(
    listener: (signal: AbortSignal | undefined, physicalCompletion: Promise<unknown>) => void,
  ): () => void {
    this.physicalOperationListeners.add(listener)
    return () => {
      this.physicalOperationListeners.delete(listener)
    }
  }

  get executorId(): string {
    for (const entry of this.entries.values()) {
      if (entry.connection?.isOpen) return entry.connection.executorId
    }
    for (const entry of this.retiringEntries) {
      if (entry.connection?.isOpen) return entry.connection.executorId
    }
    return this.latestExecutorId
  }

  hasExecutor(executorId: string): boolean {
    if (!executorId) return false
    for (const entry of this.entries.values()) {
      if (entry.connection?.isOpen && entry.connection.executorId === executorId) {
        return true
      }
    }
    for (const entry of this.retiringEntries) {
      if (entry.connection?.isOpen && entry.connection.executorId === executorId) {
        return true
      }
    }
    return false
  }

  get unconfirmedClosingCount(): number {
    return this.unconfirmedClosingConnections.size
  }

  get retiringCount(): number {
    return this.retiringEntries.size
  }

  get unconfirmedClosedSessionCount(): number {
    return this.unconfirmedClosedSessions.size
  }

  hasUnconfirmedClosedSession(sessionId: string): boolean {
    return this.unconfirmedClosedSessions.has(sessionId)
  }

  get activeLeaseCount(): number {
    let total = this.pendingLeaseReservations.size
    for (const entry of this.entries.values()) total += entry.activeLeases.size
    for (const entry of this.retiringEntries) total += entry.activeLeases.size
    return total
  }

  private hasPhysicalSlot(entry: PooledConnectionEntry): boolean {
    return Boolean(entry.connection || entry.starting || entry.processSlotReserved)
  }

  get occupiedProcessSlotCount(): number {
    let count = this.unconfirmedClosingConnections.size
    for (const conn of this.activeClosingConnections) {
      if (!this.unconfirmedClosingConnections.has(conn)) count += 1
    }
    for (const entry of this.entries.values()) {
      if (this.hasPhysicalSlot(entry)) count += 1
    }
    for (const entry of this.retiringEntries) {
      if (this.hasPhysicalSlot(entry)) count += 1
    }
    return count
  }

  private isReusableEntry(entry: PooledConnectionEntry): boolean {
    return (
      !entry.retiring &&
      !entry.closing &&
      (Boolean(entry.connection?.isOpen) || Boolean(entry.starting) || entry.processSlotReserved)
    )
  }

  private detachNonReusableEntry(entry: PooledConnectionEntry): void {
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key)
    }
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    entry.retiring = true
    if (entry.connection && !entry.closing) {
      if (!this.disposed) this.retiringEntries.add(entry)
      void this.closeEntryConnection(
        entry,
        new Error('Antigravity ACP connection closed.'),
        entry.connection,
      ).catch(() => undefined)
      return
    }
    if (entry.activeLeases.size > 0 || this.hasPhysicalSlot(entry) || Boolean(entry.closing)) {
      if (!this.disposed) this.retiringEntries.add(entry)
    } else {
      this.retiringEntries.delete(entry)
    }
  }

  private removeEntry(entry: PooledConnectionEntry): void {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key)
    }
    this.retiringEntries.delete(entry)
  }

  private recheckUnconfirmedClosings(): void {
    for (const conn of this.unconfirmedClosingConnections) {
      conn.recheckPhysicalRelease()
      if (conn.isPhysicallyReleased) {
        this.unconfirmedClosingConnections.delete(conn)
      }
    }
    this.updateBoundedUnconfirmedProbe()
  }

  private hasProbeableUnconfirmedClosings(): boolean {
    for (const conn of this.unconfirmedClosingConnections) {
      if (conn.supportsReleaseProbe()) return true
    }
    return false
  }

  private updateBoundedUnconfirmedProbe(): void {
    const shouldProbe =
      (this.capacityWaiters.size > 0 || this.activeShutdownWaiters > 0) &&
      this.hasProbeableUnconfirmedClosings()
    if (!shouldProbe) {
      if (this.boundedUnconfirmedProbeTimer) {
        clearInterval(this.boundedUnconfirmedProbeTimer)
        this.boundedUnconfirmedProbeTimer = undefined
      }
      return
    }
    if (this.boundedUnconfirmedProbeTimer) return
    this.boundedUnconfirmedProbeTimer = setInterval(() => {
      this.recheckUnconfirmedClosings()
    }, 25)
    this.boundedUnconfirmedProbeTimer.unref?.()
  }

  private quarantineUnconfirmedConnection(target: AgyAcpConnection): void {
    if (target.isPhysicallyReleased || this.unconfirmedClosingConnections.has(target)) return
    this.unconfirmedClosingConnections.add(target)
    this.updateBoundedUnconfirmedProbe()
    void target.whenPhysicallyReleased().finally(() => {
      if (this.unconfirmedClosingConnections.delete(target)) {
        this.updateBoundedUnconfirmedProbe()
        this.notifyCapacityWaiters()
      }
    })
  }

  poolSnapshot(): Array<{
    canonicalCwd: string
    permissionScope: AgyPermissionScope
    open: boolean
    activeLeases: number
    fullAccessSessions: number
    drainingFullAccess: boolean
    retiring: boolean
  }> {
    return [...this.entries.values(), ...this.retiringEntries].map((entry) => ({
      canonicalCwd: entry.canonicalCwd,
      permissionScope: entry.permissionScope,
      open: Boolean(entry.connection?.isOpen),
      activeLeases: entry.activeLeases.size,
      fullAccessSessions: entry.fullAccessSessions.size,
      drainingFullAccess: entry.drainingFullAccess,
      retiring: entry.retiring,
    }))
  }

  async acquire(input: AgyPoolAcquireInput): Promise<AgyPoolLease> {
    input.signal?.throwIfAborted()
    if (this.disposed || this.activeDisposal) {
      throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
    }
    if (input.permissionScope === 'full') {
      if (input.readOnly === true || input.permissionMode !== 'full') {
        throw new PermissionModeRejectedError(
          'Antigravity Full access process pool cannot be used for read-only stages or non-Full permission modes.',
        )
      }
    }
    if (this.activeLeaseCount >= AGY_MAX_CONTEXTS) {
      throw new NativeCapacityError(
        'Antigravity has too many active native contexts. Wait for one to settle; no new task was submitted.',
      )
    }

    const leaseToken = Symbol('agy-pool-lease')
    this.pendingLeaseReservations.add(leaseToken)

    let canonicalCwd: string
    let pooledEntry: PooledConnectionEntry
    let capacityDeadlineAt: number | undefined
    try {
      canonicalCwd = await realpath(input.cwd)
      input.signal?.throwIfAborted()
      if (this.disposed || this.activeDisposal) {
        throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
      }

      // If a non-read-only Run enters `'native' | 'ask' | 'auto'`, that session has left `'full'`!
      if (
        input.permissionScope === 'standard' &&
        input.readOnly !== true &&
        input.sessionId !== undefined
      ) {
        await this.retireFullAccess({ sessionId: input.sessionId, canonicalCwd })
      }

      const key = `${canonicalCwd}\0${input.permissionScope}`
      let entry = this.entries.get(key)
      if (entry && !this.isReusableEntry(entry)) {
        this.detachNonReusableEntry(entry)
        entry = undefined
      }
      if (!entry) {
        capacityDeadlineAt = Date.now() + AGY_CONTROL_RPC_TIMEOUT_MS
        this.recheckUnconfirmedClosings()
        this.evictSettledEntries()
        while (!entry && this.occupiedProcessSlotCount >= AGY_MAX_CONTEXTS * 2) {
          input.signal?.throwIfAborted()
          if (this.disposed || this.activeDisposal) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity is shutting down.',
              false,
            )
          }
          if (Date.now() >= capacityDeadlineAt) {
            throw new NativeCapacityError(
              'Antigravity connection pool reached its 16-directory capacity with all connections active or unconfirmed.',
            )
          }
          const candidate = this.findEvictableEntry()
          if (candidate) {
            const eviction = this.closeEntryConnection(
              candidate,
              new Error(
                candidate.connection?.isOpen
                  ? 'Antigravity idle connection evicted at pool capacity.'
                  : 'Antigravity closed connection finalized at pool capacity.',
              ),
            ).catch(() => undefined)
            // oxlint-disable-next-line no-await-in-loop -- Physically closes one 0-lease idle or dead connection under the shared admission deadline.
            await this.waitForCapacityOrTask(eviction, input.signal, capacityDeadlineAt)
          } else {
            // oxlint-disable-next-line no-await-in-loop -- Waits until a retiring/closing process confirms release or an active entry becomes idle.
            await this.waitForCapacitySlot(input.signal, capacityDeadlineAt)
          }
          input.signal?.throwIfAborted()
          if (this.disposed || this.activeDisposal) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity is shutting down.',
              false,
            )
          }
          this.recheckUnconfirmedClosings()
          this.evictSettledEntries()
          const existing = this.entries.get(key)
          if (existing && this.isReusableEntry(existing)) {
            entry = existing
          } else if (existing) {
            this.detachNonReusableEntry(existing)
          }
        }
        if (!entry) {
          input.signal?.throwIfAborted()
          if (this.disposed || this.activeDisposal) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity is shutting down.',
              false,
            )
          }
          if (Date.now() >= capacityDeadlineAt) {
            throw new NativeCapacityError(
              'Antigravity connection pool reached its 16-directory capacity with all connections active or unconfirmed.',
            )
          }
          entry = {
            key,
            canonicalCwd,
            permissionScope: input.permissionScope,
            connection: undefined,
            ownedConnection: undefined,
            processSlotReserved: true,
            starting: undefined,
            closing: undefined,
            initializing: undefined,
            initializedResult: undefined,
            activeLeases: new Set(),
            fullAccessSessions: new Set(),
            unconfirmedClosedSessions: new Set(),
            drainingFullAccess: false,
            retiring: false,
            closeWhenIdle: false,
            idleTimer: undefined,
          }
          this.entries.set(key, entry)
        }
      }

      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
      entry.closeWhenIdle = false

      if (input.permissionScope === 'full') {
        entry.drainingFullAccess = false
        if (input.sessionId) entry.fullAccessSessions.add(input.sessionId)
      }

      pooledEntry = entry
      this.pendingLeaseReservations.delete(leaseToken)
      pooledEntry.activeLeases.add(leaseToken)
    } catch (error) {
      this.pendingLeaseReservations.delete(leaseToken)
      throw error
    }

    let released = false
    const release = (): void => {
      if (released) return
      released = true
      pooledEntry.activeLeases.delete(leaseToken)
      this.onEntryUpdated(pooledEntry)
    }

    try {
      const connection = await this.ensureEntryConnection(
        pooledEntry,
        input.signal,
        capacityDeadlineAt,
      )
      input.signal?.throwIfAborted()
      return {
        connection,
        canonicalCwd,
        permissionScope: input.permissionScope,
        ensureInitialized: (signal) => this.initializeEntry(pooledEntry, connection, signal),
        closeSession: async (sessionId, options) => {
          const result = await connection.closeSession(sessionId, options)
          if (!result.confirmed) {
            this.recordUnconfirmedClosedSession(pooledEntry, connection, sessionId)
          }
          return result
        },
        recordUnconfirmedSessionClose: (sessionId: string) => {
          this.recordUnconfirmedClosedSession(pooledEntry, connection, sessionId)
        },
        disposeIfIdle: async () => {
          release()
          if (pooledEntry.activeLeases.size > 0) return
          if (pooledEntry.connection === connection) {
            const hasActiveWork = pooledEntry.retiring
              ? connection.hasActiveWorkExcludingUnconfirmedCloses()
              : connection.hasPendingPhysicalWork()
            if (!hasActiveWork) {
              await this.closeEntryConnection(
                pooledEntry,
                new Error(
                  pooledEntry.retiring
                    ? 'Antigravity ACP retiring connection drained and closed.'
                    : 'Antigravity cold verification session settled.',
                ),
                connection,
              )
            } else {
              pooledEntry.closeWhenIdle = true
            }
          } else if (pooledEntry.closing) {
            await pooledEntry.closing
          } else if (pooledEntry.ownedConnection === connection) {
            connection.recheckPhysicalRelease()
            if (!connection.isPhysicallyReleased) {
              const existingClose = connection.existingClosePromise()
              if (existingClose) {
                await existingClose
              } else {
                await this.closeEntryConnection(
                  pooledEntry,
                  new Error('Antigravity ACP connection did not confirm physical release.'),
                  connection,
                )
              }
            }
          }
        },
        release,
      }
    } catch (error) {
      release()
      throw error
    }
  }

  /**
   * Retires Full access for a specific `sessionId` (or all sessions in `cwd`), draining
   * any active sibling runs and immediately closing idle `'full'` connections.
   */
  async retireFullAccess(
    options: { sessionId?: string; cwd?: string; canonicalCwd?: string } = {},
  ): Promise<void> {
    let targetCanonical = options.canonicalCwd
    if (!targetCanonical && options.cwd) {
      try {
        targetCanonical = await realpath(options.cwd)
      } catch {
        targetCanonical = options.cwd
      }
    }
    const closings: Promise<void>[] = []
    for (const entry of [...this.entries.values(), ...this.retiringEntries]) {
      if (entry.permissionScope !== 'full') continue
      if (targetCanonical && entry.canonicalCwd !== targetCanonical) continue
      if (options.sessionId) {
        entry.fullAccessSessions.delete(options.sessionId)
      } else {
        entry.fullAccessSessions.clear()
      }
      if (entry.fullAccessSessions.size === 0) {
        entry.drainingFullAccess = true
        const hasActiveWork = entry.retiring
          ? Boolean(entry.connection?.hasActiveWorkExcludingUnconfirmedCloses())
          : Boolean(entry.connection?.hasPendingPhysicalWork())
        if (entry.activeLeases.size === 0 && (!hasActiveWork || !entry.connection?.isOpen)) {
          if (entry.connection) {
            closings.push(
              this.closeEntryConnection(
                entry,
                new Error('Antigravity Full access connection retired after draining.'),
              ),
            )
          } else if (entry.closing) {
            closings.push(entry.closing)
          }
        }
      }
    }
    if (closings.length > 0) await Promise.all(closings)
  }

  capShutdownDeadline(deadlineAt: number): void {
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) {
      throw new Error('Invalid Antigravity shutdown deadline.')
    }
    const next = Math.min(this.shutdownDeadlineAt ?? deadlineAt, deadlineAt)
    const tightened = this.shutdownDeadlineAt === undefined || next < this.shutdownDeadlineAt
    this.shutdownDeadlineAt = next
    for (const entry of this.entries.values()) {
      entry.connection?.capShutdownDeadline(this.shutdownDeadlineAt)
      if (entry.ownedConnection && entry.ownedConnection !== entry.connection) {
        entry.ownedConnection.capShutdownDeadline(this.shutdownDeadlineAt)
      }
    }
    for (const entry of this.retiringEntries) {
      entry.connection?.capShutdownDeadline(this.shutdownDeadlineAt)
      if (entry.ownedConnection && entry.ownedConnection !== entry.connection) {
        entry.ownedConnection.capShutdownDeadline(this.shutdownDeadlineAt)
      }
    }
    for (const conn of this.activeClosingConnections) {
      conn.capShutdownDeadline(this.shutdownDeadlineAt)
    }
    for (const conn of this.unconfirmedClosingConnections) {
      conn.capShutdownDeadline(this.shutdownDeadlineAt)
    }
    if (tightened) {
      for (const listener of Array.from(this.shutdownDeadlineListeners)) {
        listener(next)
      }
    }
  }

  private awaitSettledWithShutdownDeadline<T>(
    tasks: Promise<T>[],
    timeoutMessage: string,
  ): Promise<PromiseSettledResult<T>[]> {
    if (tasks.length === 0) return Promise.resolve([])
    const allSettled = Promise.allSettled(tasks)
    if (this.shutdownDeadlineAt !== undefined && this.shutdownDeadlineAt <= Date.now()) {
      return Promise.reject(createUnconfirmedProcessError(timeoutMessage))
    }
    return new Promise<PromiseSettledResult<T>[]>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        clearTimeout(timer)
        timer = undefined
        this.shutdownDeadlineListeners.delete(rearm)
      }
      const finishResolve = (results: PromiseSettledResult<T>[]): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(results)
      }
      const finishReject = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const rearm = (): void => {
        if (settled) return
        clearTimeout(timer)
        timer = undefined
        if (this.shutdownDeadlineAt === undefined) return
        const remainingMs = this.shutdownDeadlineAt - Date.now()
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
      void allSettled.then(finishResolve)
    })
  }

  /**
   * Synchronously checks whether this entire pool is idle (allowing healthy settled connections
   * holding only the 5-minute `idleTimer`), and atomically seals against new `acquire()` calls
   * before initiating physical shutdown while keeping `occupiedProcessSlotCount` tied to actual exit.
   */
  tryRetireIdle(deadlineAt?: number): AgyPoolIdleRetirement {
    if (deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0)) {
      throw new Error('Invalid Antigravity shutdown deadline.')
    }
    this.recheckUnconfirmedClosings()
    this.evictSettledEntries()
    if (
      this.disposed ||
      this.activeDisposal ||
      this.activeLeaseCount > 0 ||
      this.unconfirmedClosingConnections.size > 0 ||
      this.activeClosingConnections.size > 0 ||
      this.retiringEntries.size > 0 ||
      this.closingTasks.size > 0
    ) {
      return { kind: 'busy' }
    }
    for (const entry of this.entries.values()) {
      if (
        entry.activeLeases.size > 0 ||
        entry.starting !== undefined ||
        entry.initializing !== undefined ||
        entry.processSlotReserved ||
        entry.closing !== undefined ||
        entry.retiring ||
        entry.drainingFullAccess ||
        entry.fullAccessSessions.size > 0
      ) {
        return { kind: 'busy' }
      }
      if (
        entry.connection &&
        (!entry.connection.isOpen ||
          entry.connection.hasPendingPhysicalWork() ||
          entry.connection.hasActiveSessionOwners())
      ) {
        return { kind: 'busy' }
      }
    }
    // Atomically seal against new `acquire()` calls before initiating physical close.
    const physical = this.dispose(deadlineAt)
    return { kind: 'retiring', physical }
  }

  retireIdleCandidate(deadlineAt?: number): AgyPoolIdleRetirement {
    return this.tryRetireIdle(deadlineAt)
  }

  dispose(flushDeadlineAt?: number): Promise<void> {
    if (
      flushDeadlineAt !== undefined &&
      (!Number.isSafeInteger(flushDeadlineAt) || flushDeadlineAt <= 0)
    ) {
      return Promise.reject(new Error('Invalid Antigravity shutdown deadline.'))
    }
    if (flushDeadlineAt !== undefined) this.capShutdownDeadline(flushDeadlineAt)
    this.disposed = true
    this.rejectAllCapacityWaiters(
      new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false),
    )
    if (this.activeDisposal) return this.activeDisposal
    if (this.disposalSettledCleanly) {
      this.recheckUnconfirmedClosings()
      if (
        this.occupiedProcessSlotCount === 0 &&
        this.closingTasks.size === 0 &&
        this.unconfirmedClosingConnections.size === 0
      ) {
        return Promise.resolve()
      }
      this.disposalSettledCleanly = false
    }

    const attempt = (async () => {
      this.recheckUnconfirmedClosings()
      if (this.unconfirmedClosingConnections.size > 0) {
        await Promise.resolve()
        this.recheckUnconfirmedClosings()
      }
      const tasks: Promise<void>[] = []
      const seenTasks = new Set<Promise<void>>()
      const pushTask = (task: Promise<void>): void => {
        if (seenTasks.has(task)) return
        seenTasks.add(task)
        tasks.push(task)
      }
      for (const entry of [...this.entries.values(), ...this.retiringEntries]) {
        clearTimeout(entry.idleTimer)
        entry.idleTimer = undefined
        entry.processSlotReserved = false
        if (entry.starting) {
          const startingTask = entry.starting
          pushTask(
            startingTask.then(
              (conn) =>
                this.closeEntryConnection(entry, new Error('Antigravity pool disposed.'), conn),
              (spawnError: unknown) => {
                if (spawnError instanceof DisposedSpawnCloseError) throw spawnError.closeCause
              },
            ),
          )
        } else if (entry.connection) {
          pushTask(this.closeEntryConnection(entry, new Error('Antigravity pool disposed.')))
        } else if (entry.closing) {
          pushTask(entry.closing)
        }
      }
      for (const closing of this.closingTasks) {
        pushTask(closing)
      }
      for (const unconfirmed of this.unconfirmedClosingConnections) {
        unconfirmed.recheckPhysicalRelease()
        if (unconfirmed.isPhysicallyReleased) {
          this.unconfirmedClosingConnections.delete(unconfirmed)
          continue
        }
        const existingClose = unconfirmed.existingClosePromise()
        if (!existingClose) {
          pushTask(unconfirmed.close(new Error('Antigravity pool disposed.')))
        } else if (unconfirmed.isCloseInFlight()) {
          pushTask(existingClose)
        } else if (unconfirmed.hasObservedPhysicalRelease()) {
          pushTask(unconfirmed.whenPhysicallyReleased())
        } else {
          // Prior close timed out/failed and process has still not confirmed physical release:
          // surface the prior failure without spawning a duplicate kill or extending deadlines.
          pushTask(existingClose)
        }
      }

      let firstError: unknown
      let hasError = false
      this.activeShutdownWaiters += 1
      this.updateBoundedUnconfirmedProbe()
      try {
        const settled = await this.awaitSettledWithShutdownDeadline(
          tasks,
          'Antigravity pool disposal did not confirm physical release before its deadline.',
        )
        for (const result of settled) {
          if (result.status === 'rejected' && !hasError) {
            hasError = true
            firstError = result.reason
          }
        }
      } finally {
        this.activeShutdownWaiters -= 1
        for (const entry of [...this.entries.values(), ...this.retiringEntries]) {
          clearTimeout(entry.idleTimer)
          entry.idleTimer = undefined
          entry.processSlotReserved = false
        }
        this.entries.clear()
        this.retiringEntries.clear()
        this.unconfirmedClosedSessions.clear()
        this.pendingLeaseReservations.clear()
        this.physicalOperationListeners.clear()
        this.rejectAllCapacityWaiters(
          new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false),
        )
        this.recheckUnconfirmedClosings()
      }
      if (hasError) {
        throw firstError instanceof Error ? firstError : new Error(String(firstError))
      }
      if (
        this.unconfirmedClosingConnections.size > 0 ||
        this.closingTasks.size > 0 ||
        this.occupiedProcessSlotCount > 0
      ) {
        throw createUnconfirmedProcessError(
          'Antigravity connection pool still has unconfirmed process slots.',
        )
      }
      this.disposalSettledCleanly = true
    })().finally(() => {
      if (this.activeDisposal === attempt) {
        this.activeDisposal = undefined
      }
    })
    this.activeDisposal = attempt
    return attempt
  }

  private recordUnconfirmedClosedSession(
    entry: PooledConnectionEntry,
    connection: AgyAcpConnection,
    sessionId: string,
  ): void {
    if (this.disposed) return
    if (sessionId && sessionId.length <= 1024) {
      if (
        this.unconfirmedClosedSessions.size >= 64 &&
        !this.unconfirmedClosedSessions.has(sessionId)
      ) {
        const oldest = this.unconfirmedClosedSessions.values().next().value
        if (oldest !== undefined) this.unconfirmedClosedSessions.delete(oldest)
      }
      this.unconfirmedClosedSessions.add(sessionId)
    }
    connection.markUnconfirmedCloseRequests(sessionId)
    if (entry.connection !== connection && entry.ownedConnection !== connection) return
    if (entry.unconfirmedClosedSessions.size < 64) {
      entry.unconfirmedClosedSessions.add(sessionId)
    }
    this.markEntryRetiring(entry)
  }

  private markEntryRetiring(entry: PooledConnectionEntry): void {
    if (this.disposed) return
    if (!entry.retiring) {
      entry.retiring = true
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key)
      }
      if (entry.activeLeases.size > 0 || this.hasPhysicalSlot(entry)) {
        this.retiringEntries.add(entry)
      }
    }
    this.onEntryUpdated(entry)
  }

  private notifyCapacityWaiters(): void {
    if (this.capacityWaiters.size === 0) return
    const waiters = Array.from(this.capacityWaiters)
    for (const waiter of waiters) {
      this.removeCapacityWaiter(waiter)
      waiter.resolve()
    }
  }

  private rejectAllCapacityWaiters(error: Error): void {
    if (this.capacityWaiters.size === 0) return
    const waiters = Array.from(this.capacityWaiters)
    for (const waiter of waiters) {
      this.removeCapacityWaiter(waiter)
      waiter.reject(error)
    }
  }

  private removeCapacityWaiter(waiter: PoolCapacityWaiter): void {
    this.capacityWaiters.delete(waiter)
    clearTimeout(waiter.timeout)
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    this.updateBoundedUnconfirmedProbe()
  }

  private waitForCapacitySlot(signal: AbortSignal | undefined, deadlineAt: number): Promise<void> {
    return this.waitForCapacityOrTask(undefined, signal, deadlineAt)
  }

  private waitForCapacityOrTask(
    task: Promise<void> | undefined,
    signal: AbortSignal | undefined,
    deadlineAt: number,
  ): Promise<void> {
    if (this.disposed || this.activeDisposal) {
      return Promise.reject(
        new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false),
      )
    }
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason instanceof Error
          ? signal.reason
          : new AgentExecutionError('agent_process_crash', 'Antigravity was interrupted.', false),
      )
    }
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0 || this.capacityWaiters.size >= AGY_MAX_CONTEXTS) {
      return Promise.reject(
        new NativeCapacityError(
          'Antigravity connection pool reached its 16-directory capacity with all connections active or unconfirmed.',
        ),
      )
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: PoolCapacityWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.removeCapacityWaiter(waiter)
          reject(
            new NativeCapacityError(
              'Antigravity connection pool reached its 16-directory capacity with all connections active or unconfirmed.',
            ),
          )
        }, remainingMs),
        signal,
      }
      if (signal) {
        waiter.onAbort = () => {
          this.removeCapacityWaiter(waiter)
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new AgentExecutionError(
                  'agent_process_crash',
                  'Antigravity was interrupted.',
                  false,
                ),
          )
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.capacityWaiters.add(waiter)
      this.updateBoundedUnconfirmedProbe()
      if (task) {
        const wake = (): void => {
          if (!this.capacityWaiters.has(waiter)) return
          this.removeCapacityWaiter(waiter)
          waiter.resolve()
        }
        void task.then(wake, wake)
      }
    })
  }

  private async ensureEntryConnection(
    entry: PooledConnectionEntry,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<AgyAcpConnection> {
    if (this.disposed || this.activeDisposal) {
      entry.processSlotReserved = false
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key)
      }
      this.retiringEntries.delete(entry)
      this.notifyCapacityWaiters()
      throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
    }
    if (entry.connection?.isOpen) return entry.connection
    if (entry.starting) return entry.starting
    if (!entry.processSlotReserved || entry.ownedConnection || entry.closing || entry.retiring) {
      throw new AgentExecutionError(
        'agent_process_crash',
        'Antigravity ACP connection generation is no longer active.',
        true,
      )
    }

    const task = this.spawnEntryConnection(entry, signal, deadlineAt).finally(() => {
      if (entry.starting === task) entry.starting = undefined
    })
    entry.starting = task
    return task
  }

  private async spawnEntryConnection(
    entry: PooledConnectionEntry,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<AgyAcpConnection> {
    let owned: OwnedAgyProcess
    try {
      signal?.throwIfAborted()
      if (this.disposed || this.activeDisposal) {
        throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
      }
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        throw new NativeCapacityError(
          'Antigravity connection pool reached its 16-directory capacity with all connections active or unconfirmed.',
        )
      }
      const env = agyProcessEnvironment()
      const geminiDir = resolveConfiguredAgyGeminiDir(env, this.options.geminiDir)
      const args = buildAgySpawnArgs(
        entry.permissionScope,
        this.options.relativeAppDataDir,
        geminiDir,
      )
      owned = this.options.processFactory
        ? await this.spawnInjected(entry.canonicalCwd, args, entry.permissionScope, env)
        : this.spawnOwnedGroup(entry.canonicalCwd, args, env)
    } catch (error) {
      entry.processSlotReserved = false
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key)
      }
      this.retiringEntries.delete(entry)
      this.notifyCapacityWaiters()
      throw error
    }

    const ownsProcessGroup = Boolean(owned.isOwnedGroup || owned.physicalWitness)

    if (this.disposed) {
      entry.processSlotReserved = false
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key)
      }
      const disposedConnection = new AgyAcpConnection(
        owned.child,
        entry.canonicalCwd,
        entry.permissionScope,
        undefined,
        owned.close,
        this.options.ipcTraffic,
        () => false,
        undefined,
        undefined,
        owned.isReleased,
        owned.whenReleased,
        ownsProcessGroup,
        undefined,
        owned.needsReleaseProbe,
      )
      if (this.shutdownDeadlineAt !== undefined) {
        disposedConnection.capShutdownDeadline(this.shutdownDeadlineAt)
      }
      this.activeClosingConnections.add(disposedConnection)
      try {
        await disposedConnection.close(new Error('Antigravity is shutting down.'))
      } catch (closeError) {
        if (!disposedConnection.isPhysicallyReleased) {
          this.quarantineUnconfirmedConnection(disposedConnection)
        }
        throw new DisposedSpawnCloseError(closeError)
      } finally {
        this.activeClosingConnections.delete(disposedConnection)
      }
      throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
    }

    const connection = new AgyAcpConnection(
      owned.child,
      entry.canonicalCwd,
      entry.permissionScope,
      () => {
        if (entry.connection === connection) {
          entry.connection = undefined
          entry.initializing = undefined
          entry.initializedResult = undefined
        }
        clearTimeout(entry.idleTimer)
        entry.idleTimer = undefined
        void this.closeEntryConnection(
          entry,
          new Error('Antigravity ACP connection closed.'),
          connection,
        ).catch(() => undefined)
      },
      owned.close,
      this.options.ipcTraffic,
      () => !this.disposed,
      (opSignal, physicalCompletion) => {
        for (const listener of this.physicalOperationListeners) {
          listener(opSignal, physicalCompletion)
        }
      },
      () => {
        if (entry.connection === connection) {
          this.onEntryUpdated(entry)
        }
      },
      owned.isReleased,
      owned.whenReleased,
      ownsProcessGroup,
      (reason) => {
        if (entry.connection === connection || entry.ownedConnection === connection) {
          this.markEntryRetiring(entry)
          void this.closeEntryConnection(entry, reason, connection).catch(() => undefined)
        }
      },
      owned.needsReleaseProbe,
    )
    if (this.shutdownDeadlineAt !== undefined) {
      connection.capShutdownDeadline(this.shutdownDeadlineAt)
    }
    entry.connection = connection
    entry.ownedConnection = connection
    entry.processSlotReserved = false
    entry.initializing = undefined
    entry.initializedResult = undefined
    entry.unconfirmedClosedSessions.clear()
    this.latestExecutorId = connection.executorId
    return connection
  }

  private async spawnInjected(
    canonicalCwd: string,
    args: readonly string[],
    permissionScope: AgyPermissionScope,
    env: NodeJS.ProcessEnv,
  ): Promise<OwnedAgyProcess> {
    const supplied = await this.options.processFactory!(canonicalCwd, args, permissionScope, env)
    return 'child' in supplied ? supplied : { child: supplied, isOwnedGroup: false }
  }

  private spawnOwnedGroup(
    canonicalCwd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): OwnedAgyProcess {
    const executablePath = this.options.executablePath
    const { target, spawnArgs, isWindowsCommand } = formatAndValidateAgyOwnedSpawnArgs(
      executablePath,
      args,
      process.platform,
      env,
    )
    const processGroup = new OwnedProcessGroup({ startupObservationMs: 2_000 })
    const child = processGroup.spawn(target, spawnArgs, {
      cwd: canonicalCwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: isWindowsCommand,
    })
    return {
      child,
      close: (deadlineAt) => processGroup.close(deadlineAt),
      physicalWitness: (ownerId) => processGroup.physicalWitness(ownerId),
      isOwnedGroup: true,
      isReleased:
        process.platform === 'win32'
          ? () => processGroup.released
          : () => processGroup.released || processGroup.settledAfterCloseTimeout(),
      whenReleased: () => processGroup.whenReleased(),
      needsReleaseProbe: process.platform !== 'win32',
    }
  }

  private initializeEntry(
    entry: PooledConnectionEntry,
    connection: AgyAcpConnection,
    signal: AbortSignal,
  ): Promise<object> {
    if (entry.connection === connection && entry.initializedResult) {
      return Promise.resolve(entry.initializedResult)
    }
    if (entry.connection === connection && entry.initializing) {
      return entry.initializing
    }
    const task = (async () => {
      try {
        const response = await connection.request(
          'initialize',
          {
            protocolVersion: 1,
            capabilities: { elicitation: { form: {} } },
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
              elicitation: { form: {} },
            },
            clientInfo: this.clientInfo,
          },
          { timeoutMs: AGY_INITIALIZATION_TIMEOUT_MS, signal },
        )
        const error = Reflect.get(response, 'error')
        const result = Reflect.get(response, 'result')
        if (error || !result || typeof result !== 'object') {
          throw new AgentExecutionError(
            'protocol_error',
            error
              ? JSON.stringify(error)
              : 'Antigravity ACP server did not acknowledge initialize.',
            false,
          )
        }
        if (entry.connection === connection) {
          entry.initializedResult = result
        }
        return result
      } catch (error) {
        if (entry.connection === connection) {
          entry.initializing = undefined
          entry.initializedResult = undefined
          await this.closeEntryConnection(
            entry,
            error instanceof Error ? error : new Error('Antigravity initialization failed.'),
            connection,
          )
        }
        throw error
      }
    })().finally(() => {
      if (entry.initializing === task) {
        entry.initializing = undefined
      }
    })
    entry.initializing = task
    return task
  }

  private onEntryUpdated(entry: PooledConnectionEntry): void {
    if (this.disposed) return
    if (entry.activeLeases.size > 0) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
      entry.closeWhenIdle = false
      return
    }
    const connection = entry.connection
    if (!connection) {
      if (!entry.starting && !entry.closing && !entry.processSlotReserved) {
        this.removeEntry(entry)
        this.notifyCapacityWaiters()
      }
      return
    }
    if (!connection.isOpen) {
      if (!entry.closing) {
        void this.closeEntryConnection(
          entry,
          connection.taintReason ?? new Error('Antigravity ACP connection closed.'),
          connection,
        ).catch(() => undefined)
      }
      return
    }
    if (entry.retiring) {
      if (connection.hasActiveWorkExcludingUnconfirmedCloses()) return
      entry.closeWhenIdle = false
      void this.closeEntryConnection(
        entry,
        new Error('Antigravity ACP retiring connection drained and closed.'),
        connection,
      ).catch(() => undefined)
      return
    }
    if (connection.hasPendingPhysicalWork()) return

    if (
      (entry.permissionScope === 'full' &&
        (entry.drainingFullAccess || entry.fullAccessSessions.size === 0)) ||
      entry.closeWhenIdle
    ) {
      entry.closeWhenIdle = false
      void this.closeEntryConnection(
        entry,
        new Error('Antigravity Full access connection drained and closed.'),
        connection,
      ).catch(() => undefined)
      return
    }

    if (connection.hasActiveSessionOwners()) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
      return
    }

    this.notifyCapacityWaiters()

    clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined
      if (
        !entry.retiring &&
        entry.activeLeases.size === 0 &&
        entry.connection === connection &&
        !connection.hasPendingPhysicalWork() &&
        !connection.hasActiveSessionOwners()
      ) {
        void this.closeEntryConnection(
          entry,
          new Error('Antigravity ACP connection closed after five minutes idle.'),
          connection,
        ).catch(() => undefined)
      }
    }, this.idleTimeoutMs)
  }

  private evictSettledEntries(): void {
    for (const [key, entry] of this.entries) {
      if (
        entry.activeLeases.size === 0 &&
        !entry.starting &&
        !entry.closing &&
        !entry.connection &&
        !entry.processSlotReserved
      ) {
        clearTimeout(entry.idleTimer)
        entry.idleTimer = undefined
        this.entries.delete(key)
      }
    }
    for (const entry of this.retiringEntries) {
      if (
        entry.activeLeases.size === 0 &&
        !entry.starting &&
        !entry.closing &&
        !entry.connection &&
        !entry.processSlotReserved
      ) {
        clearTimeout(entry.idleTimer)
        entry.idleTimer = undefined
        this.retiringEntries.delete(entry)
      }
    }
  }

  private findEvictableEntry(): PooledConnectionEntry | undefined {
    for (const entry of [...this.retiringEntries, ...this.entries.values()]) {
      if (!entry.starting && !entry.closing && entry.connection && !entry.connection.isOpen) {
        return entry
      }
    }
    for (const entry of this.retiringEntries) {
      if (
        entry.activeLeases.size === 0 &&
        !entry.starting &&
        !entry.closing &&
        entry.connection?.isOpen &&
        !entry.connection.hasActiveWorkExcludingUnconfirmedCloses()
      ) {
        return entry
      }
    }
    for (const entry of this.entries.values()) {
      if (
        entry.activeLeases.size === 0 &&
        !entry.starting &&
        !entry.initializing &&
        !entry.closing &&
        !entry.drainingFullAccess &&
        entry.fullAccessSessions.size === 0 &&
        entry.connection?.isOpen &&
        !entry.connection.hasPendingPhysicalWork() &&
        !entry.connection.hasActiveSessionOwners()
      ) {
        return entry
      }
    }
    return undefined
  }

  private closeEntryConnection(
    entry: PooledConnectionEntry,
    error: Error,
    target = entry.connection,
  ): Promise<void> {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    if (entry.closing) return entry.closing
    if (!target) return Promise.resolve()
    entry.retiring = true
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key)
    }
    if (!this.disposed) {
      this.retiringEntries.add(entry)
    }
    if (entry.connection === target) {
      entry.connection = undefined
      entry.initializing = undefined
      entry.initializedResult = undefined
      entry.unconfirmedClosedSessions.clear()
    }
    entry.processSlotReserved = false
    this.activeClosingConnections.add(target)
    if (this.shutdownDeadlineAt !== undefined) {
      target.capShutdownDeadline(this.shutdownDeadlineAt)
    }
    const closing: Promise<void> = Promise.resolve().then(async () => {
      try {
        if (this.shutdownDeadlineAt !== undefined) {
          target.capShutdownDeadline(this.shutdownDeadlineAt)
        }
        await target.close(error)
      } catch (closeError: unknown) {
        if (!target.isPhysicallyReleased) {
          this.quarantineUnconfirmedConnection(target)
        }
        throw closeError
      } finally {
        this.activeClosingConnections.delete(target)
        this.closingTasks.delete(closing)
        if (entry.closing === closing) entry.closing = undefined
        if (
          entry.activeLeases.size === 0 &&
          !entry.connection &&
          !entry.starting &&
          !entry.processSlotReserved
        ) {
          this.removeEntry(entry)
        }
        if (this.occupiedProcessSlotCount < AGY_MAX_CONTEXTS * 2 || this.findEvictableEntry()) {
          this.notifyCapacityWaiters()
        }
      }
    })
    entry.closing = closing
    this.closingTasks.add(closing)
    return closing
  }
}
