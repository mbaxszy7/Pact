import { utilityProcess, type UtilityProcess } from 'electron'
import { isAbsolute } from 'node:path'

import {
  directoryFileOperationInputSchema,
  directoryFileOperationResultSchema,
  WORKSPACE_OPERATION_TIMEOUT_MS,
  type DirectoryFileOperationInput,
  type DirectoryFileOperationResult,
} from '@pact/contracts'

const MAX_DIRECTORY_WORKERS = 5
const MAX_DIRECTORY_REQUEST_BYTES = 64 * 1024
const KILL_GRACE_MS = 2_000
const FORCE_EXIT_CONFIRM_MS = 1_000
interface DirectoryWorker {
  child: UtilityProcess
  rootIdentity: string
  result?: DirectoryFileOperationResult | undefined
  resolve: (result: DirectoryFileOperationResult) => void
  promise: Promise<DirectoryFileOperationResult>
  deadline: ReturnType<typeof setTimeout>
  forceTimer?: ReturnType<typeof setTimeout> | undefined
  confirmTimer?: ReturnType<typeof setTimeout> | undefined
  signal?: AbortSignal | undefined
  abort?: (() => void) | undefined
  stopping: boolean
  settled: boolean
}

/** Main owns only process control; the anchored child owns filesystem effects. */
export class DirectoryFileOperations {
  private readonly workers = new Map<UtilityProcess, DirectoryWorker>()
  private disposed = false

  constructor(private readonly workerScriptPath: string) {}

  execute(
    input: DirectoryFileOperationInput,
    signal?: AbortSignal,
  ): Promise<DirectoryFileOperationResult> {
    if (this.disposed || signal?.aborted)
      return Promise.resolve({
        ok: false,
        code: 'CANCELLED',
        message: 'The directory operation was cancelled before startup.',
      })
    const parsed = directoryFileOperationInputSchema.safeParse(input)
    if (!parsed.success || !isAbsolute(parsed.data.rootPath))
      return Promise.resolve({
        ok: false,
        code: 'IO',
        message: 'The directory operation input is invalid.',
      })
    if (Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_DIRECTORY_REQUEST_BYTES)
      return Promise.resolve({
        ok: false,
        code: 'TOO_LARGE',
        message: 'The directory operation exceeds its request size.',
      })
    const rootIdentity = `${parsed.data.rootDevice}:${parsed.data.rootInode}`
    if (
      [...this.workers.values()].some(
        (worker) => worker.stopping && worker.rootIdentity === rootIdentity,
      )
    )
      return Promise.resolve({
        ok: false,
        code: 'IO',
        message: 'A previous file worker has not confirmed exit. This Project remains blocked.',
      })
    if (this.workers.size >= MAX_DIRECTORY_WORKERS)
      return Promise.resolve({
        ok: false,
        code: 'IO',
        message: 'All five protected directory workers are busy.',
      })
    let child: UtilityProcess
    try {
      const environment: Record<string, string> = {}
      for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) {
        const value = process.env[name]
        if (value) environment[name] = value
      }
      child = utilityProcess.fork(this.workerScriptPath, [], {
        cwd: parsed.data.rootPath,
        env: environment,
        stdio: 'pipe',
        serviceName: 'Pact Protected Directory Operation',
      })
    } catch {
      return Promise.resolve({
        ok: false,
        code: 'IO',
        message: 'The protected directory worker could not start.',
      })
    }
    const pending = Promise.withResolvers<DirectoryFileOperationResult>()
    const worker: DirectoryWorker = {
      child,
      rootIdentity,
      resolve: pending.resolve,
      promise: pending.promise,
      deadline: setTimeout(
        () =>
          this.stop(worker, {
            ok: false,
            code: 'CANCELLED',
            message: 'The protected directory operation exceeded its deadline.',
          }),
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
      signal,
      stopping: false,
      settled: false,
    }
    this.workers.set(child, worker)
    if (signal) {
      worker.abort = () =>
        this.stop(worker, {
          ok: false,
          code: 'CANCELLED',
          message: 'The protected directory operation was cancelled.',
        })
      signal.addEventListener('abort', worker.abort, { once: true })
    }
    child.on('message', (message: unknown) => {
      if (worker.stopping) return
      const response = directoryFileOperationResultSchema.safeParse(message)
      if (!response.success || worker.result) {
        this.stop(worker, {
          ok: false,
          code: 'IO',
          message: 'The directory worker returned an invalid response.',
        })
        return
      }
      worker.result = response.data
    })
    child.once('spawn', () => {
      child.stdout?.resume()
      child.stderr?.resume()
      if (worker.stopping) {
        try {
          child.kill()
        } catch {
          /* The owned force-exit deadline remains active. */
        }
        return
      }
      try {
        child.postMessage(parsed.data)
      } catch {
        this.stop(worker, {
          ok: false,
          code: 'IO',
          message: 'The directory worker could not receive its operation.',
        })
      }
    })
    child.once('exit', (code: number) => {
      this.workers.delete(child)
      clearTimeout(worker.deadline)
      if (worker.forceTimer) clearTimeout(worker.forceTimer)
      if (worker.confirmTimer) clearTimeout(worker.confirmTimer)
      if (worker.abort) worker.signal?.removeEventListener('abort', worker.abort)
      this.resolve(
        worker,
        worker.stopping || code === 0
          ? (worker.result ?? {
              ok: false,
              code: 'IO',
              message: 'The directory worker exited without an operation result.',
            })
          : {
              ok: false,
              code: 'IO',
              message: 'The directory worker exited before confirming its operation.',
            },
      )
    })
    return pending.promise
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const current = [...this.workers.values()]
    for (const worker of current)
      this.stop(worker, {
        ok: false,
        code: 'CANCELLED',
        message: 'The protected directory owner is closing.',
      })
    await Promise.all(current.map((worker) => worker.promise))
    if (this.workers.size) throw new Error('A protected directory worker did not confirm exit.')
  }

  private stop(worker: DirectoryWorker, result: DirectoryFileOperationResult): void {
    if (worker.stopping || !this.workers.has(worker.child)) return
    worker.stopping = true
    worker.result = result
    clearTimeout(worker.deadline)
    try {
      worker.child.kill()
    } catch {
      /* Keep ownership and escalate only through the bounded force-exit path. */
    }
    worker.forceTimer = setTimeout(() => {
      const pid = worker.child.pid
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* Retain the slot until exit; the confirmation deadline reports failure. */
        }
      }
      worker.confirmTimer = setTimeout(() => {
        // An unconfirmed child remains in workers and continues consuming its
        // slot. Resolving failure cannot pretend this process was reclaimed.
        this.resolve(worker, {
          ok: false,
          code: 'IO',
          message: 'Directory worker exit could not be confirmed. Further writes require recovery.',
        })
      }, FORCE_EXIT_CONFIRM_MS)
    }, KILL_GRACE_MS)
  }

  private resolve(worker: DirectoryWorker, result: DirectoryFileOperationResult): void {
    if (worker.settled) return
    worker.settled = true
    worker.resolve(result)
  }
}
