import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
} from 'electron'
import { dirname, join, resolve } from 'node:path'

import {
  AGY_STORAGE_MAX_WORKING_BYTES,
  agyStorageCancelRequestSchema,
  agyStorageClosedEventSchema,
  agyStorageInitMessageSchema,
  agyStorageOpenRequestSchema,
  agyStorageOpenResponseSchema,
  type AgyStorageAction,
  type AgyStorageJobKey,
  type AgyStorageOpenErrorCode,
  type AgyStorageOpenRequest,
} from '@pact/contracts'

import type { LogicalIpcTrafficCollector } from '../../shared/logical-ipc-traffic'

const MAX_AGY_STORAGE_WORKERS = 8
const MAX_IDENTITY_DEADLINE_MS = 3_000
const MAX_OPERATION_DEADLINE_MS = 10_000
const KILL_GRACE_MS = 2_000
const MAX_RETIRED_GENERATIONS = 64

const SAFE_STORAGE_CHILD_ENV_KEYS = [
  'ANTIGRAVITY_GEMINI_DIR',
  'PACT_AGY_APP_DATA_DIR',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'WINDIR',
  'SystemDrive',
  'LOCALAPPDATA',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
] as const

export interface AgyStorageSourceProcess {
  postMessage(message: unknown, transfer?: MessagePortMain[]): void
}

export interface AgyStorageOperationsOptions {
  readonly isPackaged?: boolean
  readonly maxWorkers?: number
  readonly maxTotalWorkingBytes?: number
  readonly nativeMode?: 'packaged' | 'development'
  readonly nativeDir?: string
  readonly createChannel?: () => { port1: MessagePortMain; port2: MessagePortMain }
}

interface ActiveAgyStorageJob {
  readonly id: string
  readonly jobKey: AgyStorageJobKey
  readonly action: AgyStorageAction
  readonly admittedDeadlineAt: number
  readonly source: AgyStorageSourceProcess
  readonly isSourceCurrent: () => boolean
  readonly child: UtilityProcess
  readonly workingBytes: number
  readonly port1: MessagePortMain
  readonly port2: MessagePortMain
  spawned: boolean
  electronExited: boolean
  finalized: boolean
  exitCode: number | null
  port1Transferred: boolean
  port2Transferred: boolean
  openOkSent: boolean
  openErrorSent: boolean
  stopping: boolean
  timedOut: boolean
  cancelled: boolean
  faultType: string | undefined
  deadline: ReturnType<typeof setTimeout> | undefined
  forceTimer: ReturnType<typeof setTimeout> | undefined
  readonly physical: Promise<void>
  readonly resolvePhysical: () => void
}

function formatJobKeyId(jobKey: AgyStorageJobKey): string {
  return `${jobKey.generation}:${jobKey.requestId}`
}

function maxDeadlineForAction(action: AgyStorageAction): number {
  return action === 'read-agy-trajectory-identity'
    ? MAX_IDENTITY_DEADLINE_MS
    : MAX_OPERATION_DEADLINE_MS
}

function detectNativeMode(
  childScriptPath: string,
  options?: Pick<AgyStorageOperationsOptions, 'isPackaged' | 'nativeMode'>,
): 'packaged' | 'development' {
  const authoritativePackaged =
    options?.isPackaged === true ||
    childScriptPath.includes('.asar') ||
    (typeof __dirname === 'string' && __dirname.includes('.asar'))
  if (authoritativePackaged) return 'packaged'
  if (options?.nativeMode) return options.nativeMode
  const envMode = process.env['PACT_AGY_NATIVE_MODE']?.trim()
  if (envMode === 'packaged' || envMode === 'development') return envMode
  return 'development'
}

function resolveNativeDir(
  mode: 'packaged' | 'development',
  childScriptPath: string,
  override?: string,
): string {
  if (override && override.trim().length > 0) return resolve(override)
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath
  if (mode === 'packaged') {
    if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
      return resolve(join(resourcesPath, 'native'))
    }
    return resolve(dirname(childScriptPath), '../../native')
  }
  const envDir = process.env['PACT_AGY_NATIVE_DIR']?.trim()
  if (envDir && envDir.length > 0) return resolve(envDir)
  return resolve(dirname(childScriptPath), '../../native')
}

function buildSanitizedChildEnv(
  nativeMode: 'packaged' | 'development',
  nativeDir: string,
): Record<string, string> {
  // Always populate fixed non-sensitive entries so Electron never treats env as empty
  // (Electron 44.3.0 inherits the full parent process environment when env is `{}`).
  const env: Record<string, string> = {
    PACT_AGY_STORAGE_CHILD: '1',
    PACT_AGY_NATIVE_MODE: nativeMode,
    PACT_AGY_NATIVE_DIR: nativeDir,
  }
  for (const key of SAFE_STORAGE_CHILD_ENV_KEYS) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

function closePortQuietly(port: MessagePortMain): void {
  try {
    port.close()
  } catch {
    /* Closing an already-closed or transferred port is best-effort. */
  }
}

/**
 * Main-process supervisor for isolated single-operation Antigravity storage child processes.
 *
 * Main owns ONLY child startup (`utilityProcess.fork`), per-job `MessageChannelMain` plumbing,
 * bounded `deadlineAt` enforcement, cancellation, Utility generation isolation, and confirmed
 * OS PID exit (`agy-storage.closed.event`). Business payloads travel strictly over the dedicated
 * Utility <-> Child `MessagePort` pair and are NEVER relayed or inspected by Main.
 */
export class AgyStorageOperations {
  private readonly jobs = new Map<string, ActiveAgyStorageJob>()
  private readonly sourceGenerations = new Map<AgyStorageSourceProcess, string>()
  private readonly retiredGenerations = new Set<string>()
  private readonly maxWorkers: number
  private readonly maxTotalWorkingBytes: number
  private readonly nativeMode: 'packaged' | 'development'
  private readonly nativeDir: string
  private readonly createChannel: () => { port1: MessagePortMain; port2: MessagePortMain }
  private traffic: LogicalIpcTrafficCollector | undefined
  private disposed = false

  constructor(
    private readonly childScriptPath: string,
    options?: AgyStorageOperationsOptions,
  ) {
    this.maxWorkers = Math.max(
      1,
      Math.min(MAX_AGY_STORAGE_WORKERS, options?.maxWorkers ?? MAX_AGY_STORAGE_WORKERS),
    )
    const hardByteCap = this.maxWorkers * AGY_STORAGE_MAX_WORKING_BYTES
    this.maxTotalWorkingBytes = Math.min(
      hardByteCap,
      Math.max(AGY_STORAGE_MAX_WORKING_BYTES, options?.maxTotalWorkingBytes ?? hardByteCap),
    )
    this.nativeMode = detectNativeMode(childScriptPath, options)
    this.nativeDir = resolveNativeDir(this.nativeMode, childScriptPath, options?.nativeDir)
    this.createChannel = options?.createChannel ?? (() => new MessageChannelMain())
  }

  configureTraffic(traffic: LogicalIpcTrafficCollector | undefined): void {
    this.traffic = traffic
  }

  get activeCount(): number {
    return this.jobs.size
  }

  activeWorkingBytes(): number {
    let total = 0
    for (const job of this.jobs.values()) total += job.workingBytes
    return total
  }

  /**
   * Consumes Utility <-> Main `agy-storage.*` control packets. Returns `true` when the message
   * belongs to the `agy-storage.*` namespace (whether accepted or rejected).
   */
  receive(
    source: AgyStorageSourceProcess,
    message: unknown,
    isSourceCurrent: () => boolean,
  ): boolean {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      typeof message.type !== 'string' ||
      !message.type.startsWith('agy-storage.')
    ) {
      return false
    }

    if (message.type === 'agy-storage.open.request') {
      const parsed = agyStorageOpenRequestSchema.safeParse(message)
      if (!parsed.success) {
        this.traffic?.invalidate('unvalidated_message')
        return true
      }
      this.traffic?.record('utility-main.control', 'control', parsed.data)
      if (!isSourceCurrent()) return true
      this.handleOpenRequest(source, parsed.data, isSourceCurrent)
      return true
    }

    if (message.type === 'agy-storage.cancel.request') {
      const parsed = agyStorageCancelRequestSchema.safeParse(message)
      if (!parsed.success) {
        this.traffic?.invalidate('unvalidated_message')
        return true
      }
      this.traffic?.record('utility-main.control', 'control', parsed.data)
      const job = this.jobs.get(formatJobKeyId(parsed.data.jobKey))
      if (!job || job.source !== source) return true
      this.stopJob(job, parsed.data.reason === 'timeout', parsed.data.reason !== 'timeout')
      return true
    }

    this.traffic?.invalidate('unvalidated_message')
    return true
  }

  /**
   * Terminates all storage children started by a departing or replaced Utility generation while
   * preserving their slot accounting until confirmed OS PID exit.
   */
  cancelSource(source: AgyStorageSourceProcess): void {
    const generation = this.sourceGenerations.get(source)
    if (generation) {
      this.sourceGenerations.delete(source)
      this.retireGeneration(generation)
    }
    for (const job of this.jobs.values()) {
      if (job.source === source) {
        this.stopJob(job, false, true)
      }
    }
  }

  async settlement(deadlinePerformanceNow?: number): Promise<boolean> {
    if (this.jobs.size === 0) return true
    const allExited = Promise.all([...this.jobs.values()].map((job) => job.physical)).then(
      () => true,
    )
    if (deadlinePerformanceNow === undefined) return allExited
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        allExited,
        new Promise<boolean>((resolveTimer) => {
          timer = setTimeout(
            () => resolveTimer(false),
            Math.max(0, deadlinePerformanceNow - performance.now()),
          )
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const current = [...this.jobs.values()]
    for (const job of current) {
      this.stopJob(job, false, true)
    }
    await Promise.all(current.map((job) => job.physical))
  }

  private retireGeneration(generation: string): void {
    if (this.retiredGenerations.has(generation)) return
    if (this.retiredGenerations.size >= MAX_RETIRED_GENERATIONS) {
      const oldest = this.retiredGenerations.values().next().value
      if (oldest !== undefined) this.retiredGenerations.delete(oldest)
    }
    this.retiredGenerations.add(generation)
  }

  private handleOpenRequest(
    source: AgyStorageSourceProcess,
    request: AgyStorageOpenRequest,
    isSourceCurrent: () => boolean,
  ): void {
    const { jobKey, action, deadlineAt } = request
    if (this.disposed) {
      this.sendOpenError(source, jobKey, 'DISPOSED', 'Antigravity storage manager is closing.')
      return
    }

    if (this.retiredGenerations.has(jobKey.generation)) {
      this.sendOpenError(
        source,
        jobKey,
        'GENERATION_MISMATCH',
        'Storage request belongs to a retired Utility generation.',
      )
      return
    }
    const existingGeneration = this.sourceGenerations.get(source)
    if (existingGeneration && existingGeneration !== jobKey.generation) {
      this.sendOpenError(
        source,
        jobKey,
        'GENERATION_MISMATCH',
        'Storage request generation disagrees with the active Utility generation.',
      )
      return
    }
    for (const [otherSource, otherGen] of this.sourceGenerations) {
      if (otherSource !== source && otherGen === jobKey.generation) {
        this.sendOpenError(
          source,
          jobKey,
          'GENERATION_MISMATCH',
          'Storage request generation belongs to another Utility process.',
        )
        return
      }
    }
    this.sourceGenerations.set(source, jobKey.generation)

    const jobId = formatJobKeyId(jobKey)
    if (this.jobs.has(jobId)) {
      this.sendOpenError(source, jobKey, 'INVALID_REQUEST', 'Duplicate storage job key.')
      return
    }

    const now = Date.now()
    if (deadlineAt <= now) {
      this.sendOpenError(
        source,
        jobKey,
        'TIMEOUT',
        'Antigravity storage request deadline already expired.',
      )
      return
    }
    const remainingMs = Math.min(maxDeadlineForAction(action), deadlineAt - now)
    const admittedDeadlineAt = now + remainingMs

    // Always charge the full 128 MiB per active storage child regardless of peer-declared bytes.
    const chargedWorkingBytes = AGY_STORAGE_MAX_WORKING_BYTES
    if (
      this.jobs.size >= this.maxWorkers ||
      this.activeWorkingBytes() + chargedWorkingBytes > this.maxTotalWorkingBytes
    ) {
      this.sendOpenError(
        source,
        jobKey,
        'CAPACITY_EXCEEDED',
        'Antigravity isolated storage worker capacity is full.',
      )
      return
    }

    let port1: MessagePortMain
    let port2: MessagePortMain
    try {
      const channel = this.createChannel()
      port1 = channel.port1
      port2 = channel.port2
    } catch {
      this.sendOpenError(
        source,
        jobKey,
        'SPAWN_FAILED',
        'Antigravity isolated storage channel could not be created.',
      )
      return
    }

    let child: UtilityProcess
    try {
      child = utilityProcess.fork(this.childScriptPath, [], {
        env: buildSanitizedChildEnv(this.nativeMode, this.nativeDir),
        stdio: 'pipe',
        serviceName: 'Pact Antigravity Storage',
      })
    } catch {
      closePortQuietly(port1)
      closePortQuietly(port2)
      this.sendOpenError(
        source,
        jobKey,
        'SPAWN_FAILED',
        'Antigravity isolated storage child process could not start.',
      )
      return
    }

    const physical = Promise.withResolvers<void>()
    const job: ActiveAgyStorageJob = {
      id: jobId,
      jobKey,
      action,
      admittedDeadlineAt,
      source,
      isSourceCurrent,
      child,
      workingBytes: chargedWorkingBytes,
      port1,
      port2,
      spawned: false,
      electronExited: false,
      finalized: false,
      exitCode: null,
      port1Transferred: false,
      port2Transferred: false,
      openOkSent: false,
      openErrorSent: false,
      stopping: false,
      timedOut: false,
      cancelled: false,
      faultType: undefined,
      deadline: undefined,
      forceTimer: undefined,
      physical: physical.promise,
      resolvePhysical: physical.resolve,
    }
    this.jobs.set(jobId, job)

    // Register error listener immediately after fork so V8 fatal errors in the child never
    // trigger an uncaught EventEmitter exception in Main.
    child.on('error', (type: unknown) => {
      if (typeof type === 'string' && type.length > 0) {
        job.faultType = type.slice(0, 64)
      }
      if (!job.electronExited && !job.finalized) {
        this.stopJob(job, false, false)
      }
    })

    job.deadline = setTimeout(() => {
      job.deadline = undefined
      this.stopJob(job, true, false)
    }, remainingMs)

    child.once('exit', (code: number) => {
      job.electronExited = true
      job.exitCode = typeof code === 'number' && Number.isSafeInteger(code) ? code : null
      this.finalizeJob(job)
    })

    child.once('spawn', () => {
      job.spawned = true
      child.stdout?.resume()
      child.stderr?.resume()
      if (job.finalized || job.stopping || !job.isSourceCurrent()) {
        if (!job.port1Transferred) closePortQuietly(job.port1)
        if (!job.port2Transferred) closePortQuietly(job.port2)
        try {
          child.kill()
        } catch {
          /* Owned child kill is best-effort; retain slot until child exit settles. */
        }
        return
      }
      const initMsg = agyStorageInitMessageSchema.parse({
        type: 'init',
        jobKey,
        action: job.action,
        deadlineAt: job.admittedDeadlineAt,
      })
      try {
        child.postMessage(initMsg, [port2])
        job.port2Transferred = true
      } catch {
        closePortQuietly(port1)
        closePortQuietly(port2)
        this.traffic?.invalidate('transport_error')
        this.stopJob(job, false, true)
        return
      }
      const openOk = agyStorageOpenResponseSchema.parse({
        type: 'agy-storage.open.response',
        ok: true,
        jobKey,
      })
      try {
        source.postMessage(openOk, [port1])
        job.port1Transferred = true
        job.openOkSent = true
        this.traffic?.record('main-utility.control', 'control', openOk)
      } catch {
        closePortQuietly(port1)
        this.traffic?.invalidate('transport_error')
        this.stopJob(job, false, true)
      }
    })
  }

  private finalizeJob(job: ActiveAgyStorageJob): void {
    if (job.finalized) return
    job.finalized = true
    if (job.deadline !== undefined) {
      clearTimeout(job.deadline)
      job.deadline = undefined
    }
    if (job.forceTimer !== undefined) {
      clearTimeout(job.forceTimer)
      job.forceTimer = undefined
    }
    this.jobs.delete(job.id)
    if (!job.port1Transferred) closePortQuietly(job.port1)
    if (!job.port2Transferred) closePortQuietly(job.port2)

    if (job.openOkSent) {
      if (job.isSourceCurrent()) {
        const closedEvent = agyStorageClosedEventSchema.parse({
          type: 'agy-storage.closed.event',
          jobKey: job.jobKey,
          exitCode: job.exitCode,
          signal: null,
          timedOut: job.timedOut,
          cancelled: job.cancelled,
        })
        try {
          job.source.postMessage(closedEvent)
          this.traffic?.record('main-utility.control', 'control', closedEvent)
        } catch {
          this.traffic?.invalidate('transport_error')
          /* Departed Utility cannot receive closed events. */
        }
      }
    } else if (!job.openErrorSent && job.isSourceCurrent()) {
      this.sendStartupOpenError(job)
    }

    job.resolvePhysical()
  }

  private sendStartupOpenError(job: ActiveAgyStorageJob): void {
    if (job.openOkSent || job.openErrorSent) return
    job.openErrorSent = true
    const errorCode: AgyStorageOpenErrorCode = job.timedOut
      ? 'TIMEOUT'
      : job.cancelled
        ? 'CANCELLED'
        : 'SPAWN_FAILED'
    const errorMessage = job.timedOut
      ? 'Antigravity storage child timed out before startup.'
      : job.cancelled
        ? 'Antigravity storage child was cancelled before startup.'
        : 'Antigravity storage child exited before completing startup.'
    this.sendOpenError(job.source, job.jobKey, errorCode, errorMessage)
  }

  private sendOpenError(
    source: AgyStorageSourceProcess,
    jobKey: AgyStorageJobKey,
    code: AgyStorageOpenErrorCode,
    message: string,
  ): void {
    const packet = agyStorageOpenResponseSchema.parse({
      type: 'agy-storage.open.response',
      ok: false,
      jobKey,
      code,
      message,
    })
    try {
      source.postMessage(packet)
      this.traffic?.record('main-utility.control', 'control', packet)
    } catch {
      this.traffic?.invalidate('transport_error')
      /* Departed Utility cannot receive open error responses. */
    }
  }

  private stopJob(job: ActiveAgyStorageJob, timedOut: boolean, cancelled: boolean): void {
    if (timedOut) job.timedOut = true
    if (cancelled) job.cancelled = true
    if (job.finalized || !this.jobs.has(job.id)) return
    if (!job.spawned && !job.openOkSent && !job.openErrorSent) {
      // Reply logically immediately while retaining physical job tracking until child exit settles.
      if (!job.port1Transferred) closePortQuietly(job.port1)
      if (!job.port2Transferred) closePortQuietly(job.port2)
      if (job.isSourceCurrent()) {
        this.sendStartupOpenError(job)
      }
    }
    if (job.stopping) return
    job.stopping = true
    if (job.deadline !== undefined) {
      clearTimeout(job.deadline)
      job.deadline = undefined
    }
    try {
      job.child.kill()
    } catch {
      /* Keep slot ownership until child.once('exit') settles; retry owned kill on grace timer. */
    }
    if (job.finalized || job.electronExited || !this.jobs.has(job.id)) return
    job.forceTimer = setTimeout(() => {
      job.forceTimer = undefined
      if (job.finalized || job.electronExited) return
      try {
        job.child.kill()
      } catch {
        /* Never signal raw numeric PIDs or finalize before child.once('exit'). */
      }
    }, KILL_GRACE_MS)
  }
}
