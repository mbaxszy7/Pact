import { randomUUID } from 'node:crypto'

import {
  directoryFileOperationInputSchema,
  directoryFileOperationMessageSchema,
  WORKSPACE_OPERATION_TIMEOUT_MS,
  type DirectoryFileOperationInput,
  type DirectoryFileOperationResult,
} from '@pact/contracts'

const MAX_PENDING_REQUESTS = 20
const MAX_REQUEST_BYTES = 64 * 1024
const CANCEL_CONFIRM_TIMEOUT_MS = 4_000
interface PendingDirectoryRequest {
  resolve: (result: DirectoryFileOperationResult) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal | undefined
  abort?: (() => void) | undefined
  cancelling: boolean
}

/** Correlates the core Utility's single-operation workers owned by Main. */
export class UtilityDirectoryFileClient {
  private readonly pending = new Map<string, PendingDirectoryRequest>()
  private disposed = false
  private readonly receive = (event: Electron.MessageEvent): void => {
    const parsed = directoryFileOperationMessageSchema.safeParse(event.data)
    if (!parsed.success || parsed.data.type !== 'workspace.directory.response') return
    this.settle(parsed.data.requestId, parsed.data.result)
  }

  constructor(private readonly parentPort: Electron.ParentPort) {
    parentPort.on('message', this.receive)
  }

  run(
    input: DirectoryFileOperationInput,
    signal?: AbortSignal,
  ): Promise<DirectoryFileOperationResult> {
    if (this.disposed || signal?.aborted)
      return Promise.resolve({
        ok: false,
        code: 'CANCELLED',
        message: 'The directory operation was cancelled before dispatch.',
      })
    const parsed = directoryFileOperationInputSchema.safeParse(input)
    if (!parsed.success)
      return Promise.resolve({
        ok: false,
        code: 'IO',
        message: 'The directory operation input is invalid.',
      })
    const requestId = randomUUID()
    const message = { type: 'workspace.directory.request' as const, requestId, input: parsed.data }
    if (
      this.pending.size >= MAX_PENDING_REQUESTS ||
      Buffer.byteLength(JSON.stringify(message)) > MAX_REQUEST_BYTES
    )
      return Promise.resolve({
        ok: false,
        code: 'TOO_LARGE',
        message: 'The directory operation exceeds its request budget.',
      })
    return new Promise((resolve) => {
      const request: PendingDirectoryRequest = {
        resolve,
        timer: setTimeout(() => this.cancel(requestId), WORKSPACE_OPERATION_TIMEOUT_MS),
        signal,
        cancelling: false,
      }
      this.pending.set(requestId, request)
      if (signal) {
        request.abort = () => this.cancel(requestId)
        signal.addEventListener('abort', request.abort, { once: true })
      }
      try {
        this.parentPort.postMessage(message)
      } catch {
        this.settle(requestId, {
          ok: false,
          code: 'IO',
          message: 'Main could not receive the directory operation.',
        })
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const requestId of this.pending.keys()) {
      this.postCancel(requestId)
      this.settle(requestId, {
        ok: false,
        code: 'CANCELLED',
        message: 'The directory client is closing.',
      })
    }
    this.parentPort.removeListener('message', this.receive)
  }

  private cancel(requestId: string): void {
    const request = this.pending.get(requestId)
    if (!request || request.cancelling) return
    request.cancelling = true
    clearTimeout(request.timer)
    this.postCancel(requestId)
    // Keep the request owned until Main confirms child exit. A missing ACK is
    // a recovery error, not permission to continue writing or blindly retry.
    request.timer = setTimeout(
      () =>
        this.settle(requestId, {
          ok: false,
          code: 'IO',
          message:
            'The directory worker stop could not be confirmed. Saved files must be reconciled before further writes.',
        }),
      CANCEL_CONFIRM_TIMEOUT_MS,
    )
  }

  private postCancel(requestId: string): void {
    try {
      this.parentPort.postMessage({ type: 'workspace.directory.cancel', requestId })
    } catch {
      /* Main exit is reported by the owned acknowledgement deadline. */
    }
  }

  private settle(requestId: string, result: DirectoryFileOperationResult): void {
    const request = this.pending.get(requestId)
    if (!request) return
    this.pending.delete(requestId)
    clearTimeout(request.timer)
    if (request.abort) request.signal?.removeEventListener('abort', request.abort)
    request.resolve(result)
  }
}
