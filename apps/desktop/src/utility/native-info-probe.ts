import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import {
  query,
  type Options as ClaudeQueryOptions,
  type Query,
} from '@anthropic-ai/claude-agent-sdk'
import { createInterface } from 'node:readline'

import { OwnedProcessGroup } from './owned-process-group'

export async function withProbeTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    const aborted = new Error('The native probe was aborted.', { cause: signal.reason })
    aborted.name = 'AbortError'
    throw aborted
  }
  let timeout: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), Math.max(0, timeoutMs))
        if (signal) {
          onAbort = () => {
            const aborted = new Error('The native probe was aborted.', { cause: signal.reason })
            aborted.name = 'AbortError'
            reject(aborted)
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function* idleClaudeInput(signal: AbortSignal): AsyncGenerator<never, void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  )
  yield* []
}

export type ClaudeProbeQueryOptions = Omit<
  ClaudeQueryOptions,
  'abortController' | 'cwd' | 'pathToClaudeCodeExecutable' | 'spawnClaudeCodeProcess'
>

export interface ClaudeInfoProbeRequest<T> {
  executablePath: string
  workingDirectory: string
  signal: AbortSignal
  timeoutMs: number
  timeoutMessage?: string
  queryOptions: ClaudeProbeQueryOptions
  ownProbe: (signal: AbortSignal, onCloseInput: () => void | Promise<void>) => OwnedProcessGroup
  inspect: (
    session: Query,
    helpers: { withTimeout: <R>(operation: Promise<R>, ms?: number) => Promise<R> },
  ) => Promise<T>
  onFailure?: (error: unknown) => T
  onCloseError?: (error: unknown) => void
  onProbeSettled?: (probe: OwnedProcessGroup) => void
}

export async function runClaudeInfoProbe<T>(request: ClaudeInfoProbeRequest<T>): Promise<T> {
  const abortController = new AbortController()
  let session: Query | undefined
  const probe = request.ownProbe(request.signal, async () => {
    abortController.abort()
    session?.close()
    await session?.return(undefined).catch(() => undefined)
  })
  try {
    try {
      session = query({
        prompt: idleClaudeInput(abortController.signal),
        options: {
          ...request.queryOptions,
          abortController,
          cwd: request.workingDirectory,
          pathToClaudeCodeExecutable: request.executablePath,
          spawnClaudeCodeProcess: (specification) => {
            const child = probe.spawn(specification.command, specification.args, {
              cwd: specification.cwd,
              env: specification.env,
              signal: specification.signal,
            })
            child.stderr.resume()
            return child
          },
        },
      })
      const timeoutMessage = request.timeoutMessage ?? 'Claude probe timed out.'
      return await withProbeTimeout(
        request.inspect(session, {
          withTimeout: <R>(operation: Promise<R>, ms = request.timeoutMs): Promise<R> =>
            withProbeTimeout(operation, ms, timeoutMessage, request.signal),
        }),
        request.timeoutMs,
        timeoutMessage,
        request.signal,
      )
    } catch (error) {
      if (request.onFailure) return request.onFailure(error)
      throw error
    }
  } finally {
    await probe.close().catch((error: unknown) => {
      request.onCloseError?.(error)
      throw error
    })
    request.onProbeSettled?.(probe)
  }
}

export interface CodexInfoProbeTransport {
  request(method: string, params: Record<string, unknown>): Promise<unknown>
}

export interface CodexInfoProbeRequest<T> {
  executablePath: string
  workingDirectory: string
  env?: NodeJS.ProcessEnv
  signal: AbortSignal
  timeoutMs: number
  timeoutMessage?: string
  maxFrameBytes: number
  maxTotalBytes: number
  initializeParams: Record<string, unknown>
  ownProbe: (signal: AbortSignal, onCloseInput: () => void | Promise<void>) => OwnedProcessGroup
  onNotification?: (method: string, params: unknown) => void
  inspect: (transport: CodexInfoProbeTransport) => Promise<T>
  onFailure?: (error: unknown) => T
  onCloseError?: (error: unknown) => void
  onProbeSettled?: (probe: OwnedProcessGroup) => void
}

const MAX_PENDING_CODEX_REQUESTS = 16

function startCodexAppServer(
  executablePath: string,
  workingDirectory: string,
  probe: OwnedProcessGroup,
  env?: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const isWindowsCommand = process.platform === 'win32' && /\.cmd$/iu.test(executablePath)
  if (isWindowsCommand && /[&|<>^%!"\r\n]/u.test(executablePath)) {
    throw new Error('Unsafe Windows executable path.')
  }
  const target = isWindowsCommand ? (process.env.ComSpec ?? 'cmd.exe') : executablePath
  const args = isWindowsCommand
    ? ['/d', '/s', '/c', `""${executablePath}" app-server"`]
    : ['app-server']
  return probe.spawn(target, args, {
    cwd: workingDirectory,
    ...(env ? { env } : {}),
    windowsHide: true,
    windowsVerbatimArguments: isWindowsCommand,
  })
}

export async function runCodexInfoProbe<T>(request: CodexInfoProbeRequest<T>): Promise<T> {
  let child: ChildProcessWithoutNullStreams | undefined
  const probe = request.ownProbe(request.signal, () => {
    child?.stdin.end()
  })
  let lineReader: ReturnType<typeof createInterface> | undefined
  try {
    try {
      const runningChild = startCodexAppServer(
        request.executablePath,
        request.workingDirectory,
        probe,
        request.env,
      )
      child = runningChild
      runningChild.stderr.resume()
      const lines = createInterface({ input: runningChild.stdout })
      lineReader = lines

      let settled = false
      let totalBytes = 0
      let nextRequestId = 1
      const pending = new Map<
        number,
        { resolve: (result: unknown) => void; reject: (error: Error) => void }
      >()

      const send = (message: unknown): void => {
        if (settled || runningChild.stdin.destroyed) return
        runningChild.stdin.write(`${JSON.stringify(message)}\n`)
      }

      const timeoutMessage = request.timeoutMessage ?? 'Codex App Server probe timed out.'

      const result = await withProbeTimeout(
        new Promise<T>((resolve, reject) => {
          const fail = (error: Error): void => {
            if (settled) return
            settled = true
            for (const waiter of pending.values()) waiter.reject(error)
            pending.clear()
            reject(error)
          }
          const succeed = (value: T): void => {
            if (settled) return
            settled = true
            for (const waiter of pending.values()) {
              waiter.reject(new Error('Codex App Server probe finished before pending requests.'))
            }
            pending.clear()
            resolve(value)
          }

          const transport: CodexInfoProbeTransport = {
            request: (method, params) => {
              if (settled) return Promise.reject(new Error('Codex App Server probe already ended.'))
              if (pending.size >= MAX_PENDING_CODEX_REQUESTS) {
                return Promise.reject(new Error('Codex App Server pending request limit exceeded.'))
              }
              const id = nextRequestId
              nextRequestId += 1
              return new Promise<unknown>((resolveRpc, rejectRpc) => {
                pending.set(id, { resolve: resolveRpc, reject: rejectRpc })
                send({ method, id, params })
              })
            },
          }

          const onData = (chunk: Buffer | string): void => {
            totalBytes +=
              typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length
            if (totalBytes > request.maxTotalBytes) {
              runningChild.stdout.destroy()
              fail(new Error('Codex App Server exceeded its output budget.'))
            }
          }

          const onError = (error: Error): void => fail(error)
          const onExit = (code: number | null): void =>
            fail(new Error(`Codex App Server exited (${code}).`))

          runningChild.stdout.on('data', onData)
          runningChild.once('error', onError)
          runningChild.once('exit', onExit)

          lines.on('line', (line) => {
            if (settled) return
            if (Buffer.byteLength(line, 'utf8') > request.maxFrameBytes) {
              fail(new Error('Codex App Server returned an oversized message.'))
              return
            }
            let message: unknown
            try {
              message = JSON.parse(line)
            } catch {
              return
            }
            if (typeof message !== 'object' || message === null) return

            const id = Reflect.get(message, 'id')
            if (typeof id !== 'number') {
              const method = Reflect.get(message, 'method')
              if (typeof method === 'string') {
                request.onNotification?.(method, Reflect.get(message, 'params'))
              }
              return
            }

            if (id === 0) {
              pending.delete(0)
              if (!Reflect.has(message, 'result')) {
                fail(new Error('Codex App Server initialization failed.'))
                return
              }
              send({ method: 'initialized', params: {} })
              void request.inspect(transport).then(succeed, (error: unknown) => {
                fail(error instanceof Error ? error : new Error('Codex App Server probe failed.'))
              })
              return
            }

            const waiter = pending.get(id)
            if (!waiter) return
            pending.delete(id)
            if (Reflect.has(message, 'error')) {
              const errorValue: unknown = Reflect.get(message, 'error')
              const rawErrorMessage: unknown =
                errorValue && typeof errorValue === 'object'
                  ? Reflect.get(errorValue, 'message')
                  : undefined
              const errorMessage =
                typeof rawErrorMessage === 'string'
                  ? rawErrorMessage
                  : 'Codex App Server RPC failed.'
              waiter.reject(new Error(errorMessage))
              return
            }
            if (!Reflect.has(message, 'result')) {
              waiter.reject(new Error('Codex App Server returned an invalid response.'))
              return
            }
            waiter.resolve(Reflect.get(message, 'result'))
          })

          send({
            method: 'initialize',
            id: 0,
            params: request.initializeParams,
          })
        }),
        request.timeoutMs,
        timeoutMessage,
        request.signal,
      )
      return result
    } catch (error) {
      if (request.onFailure) return request.onFailure(error)
      throw error
    }
  } finally {
    lineReader?.close()
    await probe.close().catch((error: unknown) => {
      request.onCloseError?.(error)
      throw error
    })
    request.onProbeSettled?.(probe)
  }
}
