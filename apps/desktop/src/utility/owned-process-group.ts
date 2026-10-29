import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import type { DecisionPhysicalWitness } from '@pact/contracts'
import type { DiagnosticEvent } from '@pact/contracts/diagnostics'

import type { NativeMemoryAllocator } from './conversation/native-working-memory'

import {
  cleanupWindowsPhysicalReceipt,
  proveWindowsPhysicalRelease,
  WindowsOwnedProcess,
  type PhysicalReceiptOperation,
  type PhysicalReceiptRetirementResult,
  type WindowsOwnedProcessConfiguration,
  type WindowsOwnedProcessOptions,
} from './win32-owned-process-group'

export { configureOwnedProcessGroups } from './win32-owned-process-group'
export type {
  PhysicalReceiptOperation,
  PhysicalReceiptRetirementResult,
  WindowsOwnedProcessConfiguration,
} from './win32-owned-process-group'

type IdentityDiagnostic = NonNullable<DiagnosticEvent['settingsCatalogIdentity']>
type IdentityCapture = Pick<
  IdentityDiagnostic,
  'reason' | 'initialPresent' | 'refreshed' | 'captureExited' | 'captureClosed'
>
type IdentityCleanup = Omit<IdentityDiagnostic, keyof IdentityCapture>

/** Fixed failure evidence only; none of these observations authorize release or signals. */
export class OwnedProcessIdentityError extends Error {
  private readonly capture: Readonly<IdentityCapture>
  private cleanup: Readonly<IdentityCleanup> | undefined

  constructor(capture: IdentityCapture) {
    super('The owned process did not establish its owned group.')
    this.capture = Object.freeze({ ...capture })
  }

  observeCleanup(facts: IdentityCleanup): void {
    this.cleanup ??= Object.freeze({ ...facts })
  }

  get diagnostic(): IdentityDiagnostic | undefined {
    return this.cleanup ? Object.freeze({ ...this.capture, ...this.cleanup }) : undefined
  }
}

const CLEANUP_MS = 4_000
const TERM_GRACE_MS = 250
const MAX_IDENTITIES = 256
const MAX_IDENTITY_BYTES = 32 * 1024
type Identity = { pid: number; ppid: number; pgid: number; started: string; state: string }
type Options = {
  cwd?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  signal?: AbortSignal | undefined
  windowsHide?: boolean | undefined
  windowsVerbatimArguments?: boolean | undefined
}
let processTableRead: Promise<Map<number, Identity>> | undefined

/** One bounded, shared OS observation, never a process-identity cache. */
function readProcesses(): Promise<Map<number, Identity>> {
  processTableRead ??= new Promise<Map<number, Identity>>((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,pgid=,lstart=,stat='],
      {
        timeout: 1_000,
        maxBuffer: 256 * 1024,
        encoding: 'utf8',
        shell: false,
        env: { PATH: process.env.PATH, LC_ALL: 'C', TZ: 'UTC' },
      },
      (error, output) => {
        if (error) {
          reject(new Error('Process group identities could not be checked.', { cause: error }))
          return
        }
        const lines = output.trim().split('\n')
        if (lines.length > 4096) {
          reject(new Error('Process group observation exceeded its limit.'))
          return
        }
        const rows = new Map<number, Identity>()
        for (const line of lines) {
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s+(\S+)\s*$/u.exec(line)
          if (!match || match[4]!.length > 64 || match[5]!.length > 8) {
            reject(new Error('Process group observation was invalid.'))
            return
          }
          const row = {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            started: match[4]!,
            state: match[5]!,
          }
          if (![row.pid, row.ppid, row.pgid].every(Number.isSafeInteger)) {
            reject(new Error('Process group identity was invalid.'))
            return
          }
          rows.set(row.pid, row)
        }
        resolve(rows)
      },
    )
  }).finally(() => {
    processTableRead = undefined
  })
  return processTableRead
}
const sameIdentity = (known: Identity, row: Identity | undefined): boolean =>
  Boolean(row && row.pid === known.pid && row.pgid === known.pgid && row.started === known.started)
const same = (known: Identity, row: Identity | undefined): boolean =>
  Boolean(row && !/^[ZX]/u.test(row.state) && sameIdentity(known, row))
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
const observeZero = (pid: number | undefined): IdentityDiagnostic['pidZero'] => {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid === 0) return 'not_observed'
  try {
    process.kill(pid, 0)
    return 'success'
  } catch (error) {
    const code = errorCode(error)
    return code === 'ESRCH' || code === 'EPERM' ? code : 'other_error'
  }
}

/** One native root and its OS containment. The caller owns business admission. */
export class OwnedProcessGroup {
  private child: ChildProcessWithoutNullStreams | undefined
  private windows: WindowsOwnedProcess | undefined
  private readonly windowsOptions: WindowsOwnedProcessOptions
  private root: Promise<Identity> | undefined
  private readonly identities = new Map<number, Identity>()
  private closing = false
  private cleanup: Promise<void> | undefined
  private childClosed = false
  private readonly ignoreChildError = (): void => undefined
  private didRelease = false
  private readonly signal: AbortSignal | undefined
  private readonly onCloseInput: (() => void | Promise<void>) | undefined
  private readonly startupObservationMs: number
  private startupDeadline = 0
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private startupObservation: Promise<void> | undefined
  private closingDeadline: number | undefined
  private inputCloseTask: Promise<void> | undefined
  private signalObservation: Promise<void> | undefined
  private readonly abort = (): void => {
    void this.close().catch(() => undefined)
  }

  constructor(
    options: WindowsOwnedProcessOptions & {
      signal?: AbortSignal | undefined
      onCloseInput?: (() => void | Promise<void>) | undefined
      startupObservationMs?: number | undefined
    } = {},
  ) {
    this.signal = options.signal
    this.windowsOptions = Object.freeze({ ...options })
    this.onCloseInput = options.onCloseInput
    this.startupObservationMs = options.startupObservationMs ?? 0
    if (
      !Number.isSafeInteger(this.startupObservationMs) ||
      this.startupObservationMs < 0 ||
      this.startupObservationMs > 2_000
    )
      throw new Error('Process startup observation exceeds its deadline.')
    this.signal?.addEventListener('abort', this.abort, { once: true })
    if (this.signal?.aborted) this.abort()
  }

  get released(): boolean {
    return this.didRelease
  }

  spawn(command: string, args: string[], options: Options = {}): ChildProcessWithoutNullStreams {
    if (this.closing || this.child || this.signal?.aborted || options.signal?.aborted)
      throw new Error('This owned process scope cannot start another child.')
    if (process.platform === 'win32') {
      this.windows = new WindowsOwnedProcess(command, args, options, this.windowsOptions)
      this.child = this.windows.child
      this.child.once('close', () => {
        this.childClosed = true
      })
      return this.child
    }
    const child = spawn(command, args, {
      ...options,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })
    // JS cannot start another observation during synchronous spawn. Any read already
    // in flight at this boundary may include a pre-group birth row, even if it looks valid.
    const observationAtSpawn = processTableRead
    this.child = child
    // The SDK owns protocol interpretation; this owner retains no stderr content.
    child.once('close', () => {
      this.childClosed = true
      clearTimeout(this.startupTimer)
      this.startupTimer = undefined
      child.off('error', this.ignoreChildError)
    })
    child.once('error', this.ignoreChildError)
    this.root = !child.pid
      ? Promise.resolve({
          pid: child.pid ?? 0,
          ppid: process.pid,
          pgid: child.pid ?? 0,
          started: '',
          state: '',
        })
      : (() => {
          const firstObservation = readProcesses()
          return firstObservation.then(async (initialRows) => {
            this.assertClosingDeadline()
            // Replace an earlier epoch regardless of its contents. A fresh failed row
            // is final: this is a birth-freshness fence, never a failed-identity retry.
            const rows =
              firstObservation === observationAtSpawn ? await readProcesses() : initialRows
            this.assertClosingDeadline()
            const root = rows.get(child.pid!)
            if (!root || root.ppid !== process.pid || root.pgid !== child.pid)
              throw new OwnedProcessIdentityError({
                reason: !root
                  ? 'missing'
                  : root.ppid !== process.pid
                    ? root.pgid !== child.pid
                      ? 'ppid_and_pgid_mismatch'
                      : 'ppid_mismatch'
                    : 'pgid_mismatch',
                initialPresent: initialRows.has(child.pid!),
                refreshed: rows !== initialRows,
                captureExited: child.exitCode !== null || child.signalCode !== null,
                captureClosed: this.childClosed,
              })
            this.remember(rows, root)
            return root
          })
        })()
    // A failed observation remains visible to close(), without an unhandled rejection.
    void this.root.catch(() => undefined)
    if (this.startupObservationMs) {
      this.startupDeadline = Date.now() + this.startupObservationMs
      void this.root.then(
        () => this.observeStartup(),
        () => undefined,
      )
    }
    return child
  }

  close(): Promise<void> {
    this.closingDeadline ??= Date.now() + CLEANUP_MS
    this.closing = true
    clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    this.cleanup ??= Promise.resolve().then(() => this.release())
    return this.cleanup
  }

  /** Preserve currently verified helper identities before the caller sends natural EOF. */
  async observe(): Promise<void> {
    if (this.closing) throw new Error('The owned process group is already closing.')
    if (!this.child || process.platform === 'win32' || !this.child.pid) return
    const root = await this.root!
    this.assertClosingDeadline()
    if (this.groupGone(root.pgid)) return
    const rows = await readProcesses()
    if ([...rows.values()].some((row) => row.pgid === root.pgid && !/^[ZX]/u.test(row.state)))
      this.remember(rows, root)
  }

  /** Durable identity evidence before inference, never a PID-only permission to signal. */
  async physicalWitness(ownerId: string): Promise<DecisionPhysicalWitness> {
    if (this.windows && !this.closing) return this.windows.physicalWitness(ownerId)
    if (process.platform !== 'darwin' || !this.root || this.closing)
      throw Error('Physical witness unavailable')
    const { decisionPhysicalWitnessSchema } =
      await import('@pact/contracts/decision-physical-witness')
    await this.observe()
    const root = await this.root
    this.assertClosingDeadline()
    const rows = await readProcesses(),
      owner = rows.get(process.pid)
    if (!owner || !same(root, rows.get(root.pid))) throw Error('Physical witness unavailable')
    this.remember(rows, root)
    return decisionPhysicalWitnessSchema.parse({
      version: 1,
      platform: 'darwin',
      ownerId,
      owner: { pid: owner.pid, started: owner.started },
      root: { pid: root.pid, pgid: root.pgid, started: root.started },
      members: [...this.identities.values()].map((member) => ({
        pid: member.pid,
        pgid: member.pgid,
        started: member.started,
      })),
    })
  }

  /** Read-only restart proof. Both the old Utility and every owned native identity must be gone. */
  static async provePhysicalRelease(
    value: unknown,
    windows?: WindowsOwnedProcessConfiguration,
    memory?: NativeMemoryAllocator,
    operation?: PhysicalReceiptOperation,
  ): Promise<boolean> {
    const { decisionPhysicalWitnessSchema } =
      await import('@pact/contracts/decision-physical-witness')
    const parsed = decisionPhysicalWitnessSchema.safeParse(value)
    if (!parsed.success) return false
    if (parsed.data.platform === 'win32')
      return process.platform === 'win32'
        ? proveWindowsPhysicalRelease(parsed.data, windows, memory, operation).catch(() => false)
        : false
    if (process.platform !== 'darwin') return false
    const witness = parsed.data,
      rows = await readProcesses()
    // A changed/reused PID is not proof that this owner's other work released.
    // Require actual absence; no credentials, files, signals or retries are involved.
    try {
      process.kill(witness.owner.pid, 0)
      return false
    } catch (error) {
      if (errorCode(error) !== 'ESRCH') return false
    }
    const alive = (known: { pid: number; started: string }) => {
      const current = rows.get(known.pid)
      return current?.started === known.started && !/^[ZX]/u.test(current.state)
    }
    if (alive(witness.owner) || witness.members.some(alive)) return false
    // ESRCH for the whole private group is stronger than an exited owner/PID.
    // EPERM, a reused/nonempty group or any other uncertainty retains admission.
    try {
      process.kill(-witness.root.pgid, 0)
      return false
    } catch (error) {
      return errorCode(error) === 'ESRCH'
    }
  }

  /** The Repository must first commit a retiring intent for this exact witness
   * from a physically closed generation. Unknown owners are ineligible. A result
   * is withheld until all helper/I/O/handles join; already_absent acknowledges
   * only the validated owned path, never process release. */
  static async cleanupPhysicalReceipt(
    value: unknown,
    windows?: WindowsOwnedProcessConfiguration,
    memory?: NativeMemoryAllocator,
    operation?: PhysicalReceiptOperation,
  ): Promise<PhysicalReceiptRetirementResult> {
    const { decisionPhysicalWitnessSchema } =
      await import('@pact/contracts/decision-physical-witness')
    const parsed = decisionPhysicalWitnessSchema.safeParse(value)
    if (!parsed.success || parsed.data.platform !== 'win32') return 'unconfirmed'
    return process.platform === 'win32'
      ? cleanupWindowsPhysicalReceipt(parsed.data, windows, memory, operation).catch(
          () => 'unconfirmed' as const,
        )
      : 'unconfirmed'
  }

  private observeStartup(): void {
    if (this.closing || this.childClosed || Date.now() >= this.startupDeadline) return
    // At most twenty startup observations, one in flight, then no idle/stream
    // polling. Preserve helper birth identities before an unexpected CLI exit.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined
      const observation = (async () => {
        const root = await this.root!
        this.assertClosingDeadline()
        const rows = await readProcesses()
        this.remember(rows, root)
      })()
      this.startupObservation = observation
      void observation.then(
        () => {
          if (this.startupObservation === observation) this.startupObservation = undefined
          this.observeStartup()
          return undefined
        },
        () => {
          if (this.startupObservation === observation) this.startupObservation = undefined
          // Do not adopt unverified helpers or retry failed observations.
          // close() still requires fresh identity and physical release proof.
          return undefined
        },
      )
    }, 100)
  }

  private hasLiveAnchor(rows: Map<number, Identity>, root: Identity): boolean {
    return (
      same(root, rows.get(root.pid)) ||
      [...this.identities.values()].some((known) => same(known, rows.get(known.pid)))
    )
  }

  private remember(rows: Map<number, Identity>, root: Identity): void {
    this.assertClosingDeadline()
    if (!this.hasLiveAnchor(rows, root))
      throw new Error('The owned group lost its verified process identity.')
    const leader = rows.get(root.pgid)
    if (leader && !sameIdentity(root, leader)) throw new Error('The owned group identity changed.')
    for (const row of rows.values()) {
      if (row.pgid !== root.pgid) continue
      if (!this.identities.has(row.pid) && this.identities.size === MAX_IDENTITIES)
        throw new Error('Process group ownership exceeded its identity limit.')
      const previous = this.identities.get(row.pid)
      this.identities.set(row.pid, row)
      if (Buffer.byteLength(JSON.stringify([...this.identities.values()])) > MAX_IDENTITY_BYTES) {
        if (previous) this.identities.set(row.pid, previous)
        else this.identities.delete(row.pid)
        throw new Error('Process group ownership exceeded its identity limit.')
      }
    }
    if (
      this.identities.size > MAX_IDENTITIES ||
      Buffer.byteLength(JSON.stringify([...this.identities.values()])) > MAX_IDENTITY_BYTES
    )
      throw new Error('Process group ownership exceeded its identity limit.')
  }

  private groupGone(pgid: number): boolean {
    try {
      process.kill(-pgid, 0)
      return false
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return true
      // XNU can report EPERM while only zombies remain. It proves neither
      // release nor permission to signal; wait for child.close and ESRCH.
      if (errorCode(error) === 'EPERM') return false
      throw new Error('Process group release could not be confirmed.', { cause: error })
    }
  }

  private async signalGroup(
    root: Identity,
    signal: NodeJS.Signals,
    deadline: number,
  ): Promise<void> {
    this.assertDeadline(deadline)
    if (this.groupGone(root.pgid)) return
    const rows = await readProcesses()
    this.assertDeadline(deadline)
    const leader = rows.get(root.pgid)
    if (leader && !sameIdentity(root, leader)) throw new Error('The owned group identity changed.')
    if (![...rows.values()].some((row) => row.pgid === root.pgid && !/^[ZX]/u.test(row.state)))
      return
    // A closed root can leave an unobserved helper. Without a live anchor, do
    // not signal or adopt it; the existing deadline still requires real ESRCH.
    if (this.childClosed && !this.hasLiveAnchor(rows, root)) return
    this.remember(rows, root)
    // Signalling uses only a private group with a currently verified original identity.
    this.assertDeadline(deadline)
    try {
      process.kill(-root.pgid, signal)
    } catch (error) {
      // Darwin can return EPERM while a group is exiting. It is not release:
      // the original deadline still requires actual child close and group ESRCH.
      const code = errorCode(error)
      if (code !== 'ESRCH' && !(process.platform === 'darwin' && code === 'EPERM'))
        throw new Error('The owned owned group could not be stopped.', { cause: error })
    }
  }

  private async release(): Promise<void> {
    const deadline = this.closingDeadline!
    let closeInput: Promise<void> | undefined
    try {
      if (this.windows) {
        closeInput = this.startClosingInput()
        void closeInput.catch(() => undefined)
        await this.windows.close(deadline)
        await this.withDeadline(closeInput, deadline)
        this.didRelease = this.windows.released
        return
      }
      const child = this.child
      if (this.startupObservation)
        await this.withDeadline(
          this.startupObservation.catch(() => undefined),
          deadline,
        )
      if (!child) {
        closeInput = this.startClosingInput()
        await this.withDeadline(closeInput, deadline)
        this.didRelease = true
        return
      }
      let root: Identity
      try {
        root = await this.withDeadline(this.root!, deadline)
      } catch (error) {
        if (error instanceof OwnedProcessIdentityError) {
          try {
            error.observeCleanup({
              cleanupExited: child.exitCode !== null || child.signalCode !== null,
              cleanupClosed: this.childClosed,
              pidZero: observeZero(child.pid),
              groupZero: observeZero(child.pid === undefined ? undefined : -child.pid),
            })
          } catch {
            // Optional evidence cannot replace the original cleanup failure.
          }
        }
        // A short-lived child can be reaped before its birth observation.
        // Physical absence permits settlement without any group signal.
        if (this.childClosed && (!child.pid || this.groupGone(child.pid))) {
          closeInput = this.startClosingInput()
          await this.withDeadline(closeInput, deadline)
          this.didRelease = true
          return
        }
        throw error
      }
      if (root.pid > 0) await this.signalBeforeDeadline(root, 'SIGTERM', deadline)
      closeInput = this.startClosingInput()
      void closeInput.catch(() => undefined)
      const killAt = Date.now() + TERM_GRACE_MS
      let killed = false
      while (Date.now() < deadline) {
        const gone = root.pid === 0 || this.groupGone(root.pgid)
        if (this.childClosed && gone) {
          // oxlint-disable-next-line no-await-in-loop -- Physical release is the gate for this one scope's input cleanup.
          await this.withDeadline(closeInput, deadline)
          this.didRelease = true
          return
        }
        if (!killed && Date.now() >= killAt) {
          if (!gone) {
            // oxlint-disable-next-line no-await-in-loop -- Revalidate the same owned group before the single KILL escalation.
            await this.signalBeforeDeadline(root, 'SIGKILL', deadline)
          }
          killed = true
        }
        // oxlint-disable-next-line no-await-in-loop -- One cleanup owner observes its fixed deadline; there is no retry or work queue.
        await pause(Math.min(25, Math.max(1, deadline - Date.now())))
      }
      throw new Error('The owned process scope did not release before its deadline.')
    } finally {
      this.signal?.removeEventListener('abort', this.abort)
      // SDK cancellation is also required after an ownership-observation failure.
      if (!closeInput) {
        closeInput = this.startClosingInput()
        await this.withDeadline(closeInput, deadline)
      }
      if (this.didRelease) this.identities.clear()
    }
  }

  private startClosingInput(): Promise<void> {
    this.inputCloseTask ??= Promise.resolve().then(() => this.onCloseInput?.())
    void this.inputCloseTask.catch(() => undefined)
    return this.inputCloseTask
  }

  private signalBeforeDeadline(
    root: Identity,
    signal: NodeJS.Signals,
    deadline: number,
  ): Promise<void> {
    const task = this.signalGroup(root, signal, deadline)
    this.signalObservation = task
    const settled = (): void => {
      if (this.signalObservation === task) this.signalObservation = undefined
    }
    void task.then(settled, settled)
    return this.withDeadline(task, deadline)
  }

  private assertClosingDeadline(): void {
    if (this.closingDeadline !== undefined) this.assertDeadline(this.closingDeadline)
  }

  private assertDeadline(deadline: number): void {
    if (Date.now() >= deadline)
      throw new Error('The owned process scope did not release before its deadline.')
  }

  private async withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    void work.catch(() => undefined)
    try {
      this.assertDeadline(deadline)
      const result = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('The owned process scope did not release before its deadline.')),
            Math.max(1, deadline - Date.now()),
          )
        }),
      ])
      this.assertDeadline(deadline)
      return result
    } finally {
      clearTimeout(timer)
    }
  }
}
