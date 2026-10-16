import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import type { DiagnosticEvent } from '@pact/contracts/diagnostics'

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
        env: { PATH: process.env.PATH, LC_ALL: 'C' },
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

/** One child and its private POSIX group. The caller decides when work may be stopped. */
export class OwnedProcessGroup {
  private child: ChildProcessWithoutNullStreams | undefined
  private root: Promise<Identity> | undefined
  private readonly identities = new Map<number, Identity>()
  private closing = false
  private cleanup: Promise<void> | undefined
  private childClosed = false
  private readonly ignoreChildError = (): void => undefined
  private readonly ignoreInputError = (): void => undefined
  private didRelease = false
  private readonly signal: AbortSignal | undefined
  private readonly onCloseInput: (() => void | Promise<void>) | undefined
  private readonly startupObservationMs: number
  private startupDeadline = 0
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private startupObservation: Promise<void> | undefined
  private readonly abort = (): void => {
    void this.close().catch(() => undefined)
  }

  constructor(
    options: {
      signal?: AbortSignal | undefined
      onCloseInput?: (() => void | Promise<void>) | undefined
      startupObservationMs?: number | undefined
    } = {},
  ) {
    this.signal = options.signal
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
    const child = spawn(command, args, {
      ...options,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })
    this.child = child
    // The SDK owns protocol interpretation; this owner retains no stderr content.
    child.once('close', () => {
      this.childClosed = true
      clearTimeout(this.startupTimer)
      this.startupTimer = undefined
      child.off('error', this.ignoreChildError)
      if (process.platform === 'win32') child.stdin.off('error', this.ignoreInputError)
    })
    child.once('error', this.ignoreChildError)
    if (process.platform === 'win32') child.stdin.on('error', this.ignoreInputError)
    this.root =
      process.platform === 'win32' || !child.pid
        ? Promise.resolve({
            pid: child.pid ?? 0,
            ppid: process.pid,
            pgid: child.pid ?? 0,
            started: '',
            state: '',
          })
        : readProcesses().then(async (initialRows) => {
            // Another scope's in-flight observation can predate this spawn.
            const rows =
              initialRows.has(child.pid!) || this.childClosed ? initialRows : await readProcesses()
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
    // A failed observation remains visible to close(), without an unhandled rejection.
    void this.root.catch(() => undefined)
    if (process.platform !== 'win32' && this.startupObservationMs) {
      this.startupDeadline = Date.now() + this.startupObservationMs
      void this.root.then(
        () => this.observeStartup(),
        () => undefined,
      )
    }
    return child
  }

  close(): Promise<void> {
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
    if (this.groupGone(root.pgid)) return
    const rows = await readProcesses()
    if ([...rows.values()].some((row) => row.pgid === root.pgid && !/^[ZX]/u.test(row.state)))
      this.remember(rows, root)
  }

  private observeStartup(): void {
    if (this.closing || this.childClosed || Date.now() >= this.startupDeadline) return
    // At most twenty startup observations, one in flight, then no idle/stream
    // polling. Preserve helper birth identities before an unexpected CLI exit.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined
      const observation = (async () => {
        const root = await this.root!
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

  private async signalGroup(root: Identity, signal: NodeJS.Signals): Promise<void> {
    if (this.groupGone(root.pgid)) return
    const rows = await readProcesses()
    const leader = rows.get(root.pgid)
    if (leader && !sameIdentity(root, leader)) throw new Error('The owned group identity changed.')
    if (![...rows.values()].some((row) => row.pgid === root.pgid && !/^[ZX]/u.test(row.state)))
      return
    // A closed root can leave an unobserved helper. Without a live anchor, do
    // not signal or adopt it; the existing deadline still requires real ESRCH.
    if (this.childClosed && !this.hasLiveAnchor(rows, root)) return
    this.remember(rows, root)
    // Signalling uses only a private group with a currently verified original identity.
    try {
      process.kill(-root.pgid, signal)
    } catch (error) {
      if (errorCode(error) !== 'ESRCH')
        throw new Error('The owned owned group could not be stopped.', { cause: error })
    }
  }

  private async release(): Promise<void> {
    const deadline = Date.now() + CLEANUP_MS
    let closeInput: Promise<void> | undefined
    try {
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
        root = await this.root!
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
        if (
          this.childClosed &&
          (process.platform === 'win32' || !child.pid || this.groupGone(child.pid))
        ) {
          closeInput = this.startClosingInput()
          await this.withDeadline(closeInput, deadline)
          this.didRelease = true
          return
        }
        throw error
      }
      if (process.platform === 'win32') {
        // Preserve the existing Windows capability; this proves only this child,
        // not Windows tree release, which requires its OS-specific verification.
        // Let native relays observe real EOF/close before forcibly closing their Job.
        if (!this.childClosed && !child.stdin.destroyed && !child.stdin.writableEnded)
          child.stdin.end()
      } else if (root.pid > 0) await this.signalGroup(root, 'SIGTERM')
      closeInput = this.startClosingInput()
      void closeInput.catch(() => undefined)
      const killAt = Date.now() + TERM_GRACE_MS
      const forceAt = killAt + (process.platform === 'win32' ? TERM_GRACE_MS : 0)
      let terminated = process.platform !== 'win32'
      let killed = false
      while (Date.now() < deadline) {
        const gone = process.platform === 'win32' || root.pid === 0 || this.groupGone(root.pgid)
        if (this.childClosed && gone) {
          // oxlint-disable-next-line no-await-in-loop -- Physical release is the gate for this one scope's input cleanup.
          await this.withDeadline(closeInput, deadline)
          this.didRelease = true
          return
        }
        if (!terminated && Date.now() >= killAt) {
          if (!this.childClosed) child.kill('SIGTERM')
          terminated = true
        }
        if (!killed && Date.now() >= forceAt) {
          if (process.platform === 'win32') {
            if (!this.childClosed) child.kill('SIGKILL')
          } else if (!gone) {
            // oxlint-disable-next-line no-await-in-loop -- Revalidate the same owned group before the single KILL escalation.
            await this.signalGroup(root, 'SIGKILL')
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
    return process.platform === 'win32'
      ? Promise.resolve().then(() => this.onCloseInput?.())
      : Promise.resolve(this.onCloseInput?.())
  }

  private async withDeadline(work: Promise<void>, deadline: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Process input cleanup did not settle.')),
            Math.max(1, deadline - Date.now()),
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
