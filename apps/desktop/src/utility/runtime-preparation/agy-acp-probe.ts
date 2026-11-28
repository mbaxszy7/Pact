import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { constants, lstatSync, realpathSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, win32 as win32Path } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import desktopPackage from '../../../package.json'
import { OwnedProcessGroup } from '../owned-process-group'

const MAX_PENDING_ACP_REQUESTS = 16
const DEFAULT_INITIALIZE_TIMEOUT_MS = 4_000
const SESSION_CLOSE_GRACE_MS = 1_000
const MAX_LOG_FILE_PATH_BYTES = 4_096
const SAFE_PROBE_SESSION_ID = /^[a-zA-Z0-9_-]{8,128}$/u
const UNSAFE_WINDOWS_CMD_METACHARS = /[&|<>^%!"\r\n\0]/u
const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:\\(?:[^\\/:*?"<>|]+\\)*[^\\/:*?"<>|]*$/u

function hasAsciiControlChar(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

function isEnoentError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export interface UnconfirmedAgyProbeArtifact {
  readonly probeRoot: string
}

export type AgyProbeErrorKind =
  | 'start_failed'
  | 'timeout'
  | 'output_overflow'
  | 'unauthenticated'
  | 'protocol'
  | 'close_unconfirmed'

export class AgyProbeError extends Error {
  constructor(
    readonly kind: AgyProbeErrorKind,
    message: string,
    readonly rpcCode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AgyProbeError'
  }
}

export interface AgyAcpRpcTransport {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

export interface AgyAcpSessionContext {
  readonly sessionId: string
  readonly newSessionResult: Record<string, unknown>
  readonly agentInfoVersion: string | undefined
  readonly probeCwd: string
  readonly transport: AgyAcpRpcTransport
}

export interface AgyAcpProbeRequest<T> {
  readonly executablePath: string
  readonly env?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly initializeTimeoutMs?: number
  readonly timeoutMs: number
  readonly businessDeadlineAt?: number
  readonly closeDeadlineAt?: number
  readonly getShutdownDeadlineAt?: () => number | undefined
  readonly maxFrameBytes: number
  readonly maxTotalBytes: number
  readonly ownProbe: (
    signal: AbortSignal,
    onCloseInput: () => void | Promise<void>,
  ) => OwnedProcessGroup
  readonly onAgentInfoVersion?: (version: string) => void
  readonly onNotification?: (method: string, params: unknown) => void
  readonly inspectSession: (context: AgyAcpSessionContext) => Promise<T>
  readonly onCloseError?: (
    error: unknown,
    probe: OwnedProcessGroup,
    artifact: UnconfirmedAgyProbeArtifact,
  ) => void
  readonly onProbeSettled?: (
    probe: OwnedProcessGroup,
    artifact: UnconfirmedAgyProbeArtifact,
    artifactRemoved: boolean,
  ) => void
  readonly reconcileArtifact?: (artifact: UnconfirmedAgyProbeArtifact) => Promise<boolean>
}

export function isAgyProbeSettled(probe: OwnedProcessGroup): boolean {
  return probe.released || probe.settledAfterCloseTimeout()
}

export function isUnsafeWindowsCmdPath(executablePath: string): boolean {
  return UNSAFE_WINDOWS_CMD_METACHARS.test(executablePath)
}

function readEnvCaseInsensitive(env: NodeJS.ProcessEnv, targetKey: string): string | undefined {
  const lowerTarget = targetKey.toLowerCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lowerTarget && typeof value === 'string') {
      return value
    }
  }
  return undefined
}

/**
 * Derives a trusted absolute `%SystemRoot%\\System32\\cmd.exe` path without falling back to
 * bare `cmd.exe` or trusting relative/overridden `ComSpec`.
 */
export function deriveTrustedWindowsCmdPath(env?: NodeJS.ProcessEnv): string | undefined {
  const sourceEnv = env ?? process.env
  const systemRoot =
    readEnvCaseInsensitive(sourceEnv, 'SystemRoot') ?? readEnvCaseInsensitive(sourceEnv, 'WINDIR')
  if (
    !systemRoot ||
    hasAsciiControlChar(systemRoot) ||
    isUnsafeWindowsCmdPath(systemRoot) ||
    !WINDOWS_DRIVE_ABSOLUTE_PATH.test(systemRoot)
  ) {
    return undefined
  }
  const segments = systemRoot.split('\\').slice(1)
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return undefined
  }
  const trustedCmd = win32Path.resolve(systemRoot, 'System32', 'cmd.exe')
  if (
    isUnsafeWindowsCmdPath(trustedCmd) ||
    !trustedCmd.toLowerCase().endsWith('\\system32\\cmd.exe')
  ) {
    return undefined
  }
  return trustedCmd
}

export interface ResolveTrustedWindowsCmdExeOptions {
  readonly platform?: NodeJS.Platform
  readonly lstat?: typeof lstatSync
  readonly realpath?: typeof realpathSync
}

/**
 * Resolves `%SystemRoot%\\System32\\cmd.exe` and, on Windows, verifies non-symlink directory and
 * executable identity before returning it.
 */
export function resolveTrustedWindowsCmdExe(
  env?: NodeJS.ProcessEnv,
  options?: ResolveTrustedWindowsCmdExeOptions,
): string | undefined {
  const trustedCmd = deriveTrustedWindowsCmdPath(env)
  if (!trustedCmd) return undefined
  const platform = options?.platform ?? process.platform
  const verifyOnDisk =
    platform === 'win32' && (options?.lstat !== undefined || process.platform === 'win32')
  if (verifyOnDisk) {
    const statFn = options?.lstat ?? lstatSync
    const realpathFn = options?.realpath ?? realpathSync
    const system32Dir = win32Path.dirname(trustedCmd)
    const systemRootDir = win32Path.dirname(system32Dir)
    try {
      const rootStat = statFn(systemRootDir)
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined
      const sys32Stat = statFn(system32Dir)
      if (!sys32Stat.isDirectory() || sys32Stat.isSymbolicLink()) return undefined
      const cmdStat = statFn(trustedCmd)
      if (!cmdStat.isFile() || cmdStat.isSymbolicLink()) return undefined
      if (realpathFn(trustedCmd).toLowerCase() !== trustedCmd.toLowerCase()) return undefined
    } catch {
      return undefined
    }
  }
  return trustedCmd
}

export function resolvePactClientVersion(): string {
  const rawIdentity = process.argv[6]
  if (rawIdentity) {
    try {
      const parsed: unknown = JSON.parse(rawIdentity)
      const appVersion =
        parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'appVersion') : undefined
      if (typeof appVersion === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}/u.test(appVersion)) {
        return appVersion
      }
    } catch {
      /* Fall back to embedded package metadata. */
    }
  }
  return desktopPackage.version
}

export function isSafeAgyProbeSessionId(sessionId: string): boolean {
  return SAFE_PROBE_SESSION_ID.test(sessionId)
}

export async function removeDirConfirmed(dirPath: string): Promise<boolean> {
  await rm(dirPath, { recursive: true, force: true }).catch(() => undefined)
  try {
    await lstat(dirPath)
    return false
  } catch (error) {
    return isEnoentError(error)
  }
}

/**
 * Confirms deletion of a settled Antigravity ACP probe's isolated `0o700` temp directory.
 */
export async function reconcileSettledAgyProbeArtifact(
  artifact: UnconfirmedAgyProbeArtifact,
): Promise<boolean> {
  return await removeDirConfirmed(artifact.probeRoot)
}

function resolveEffectiveCloseDeadline(
  closeDeadlineAt?: number,
  shutdownDeadlineAt?: number,
): number | undefined {
  if (closeDeadlineAt !== undefined && shutdownDeadlineAt !== undefined) {
    return Math.min(closeDeadlineAt, shutdownDeadlineAt)
  }
  return closeDeadlineAt ?? shutdownDeadlineAt
}

function isSafeAgyStoragePath(filePath: string): boolean {
  return (
    isAbsolute(filePath) &&
    !filePath.includes('\0') &&
    Buffer.byteLength(filePath, 'utf8') <= MAX_LOG_FILE_PATH_BYTES
  )
}

function spawnAgyAcpServer(
  executablePath: string,
  workingDirectory: string,
  probeGeminiDir: string,
  probeLogFile: string,
  probe: OwnedProcessGroup,
  env?: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  if (!isSafeAgyStoragePath(probeGeminiDir) || !isSafeAgyStoragePath(probeLogFile)) {
    throw new AgyProbeError('start_failed', 'Unsafe Antigravity probe storage path.')
  }
  const isWindowsCommand = process.platform === 'win32' && /\.cmd$/iu.test(executablePath)
  if (
    isWindowsCommand &&
    (isUnsafeWindowsCmdPath(executablePath) ||
      isUnsafeWindowsCmdPath(probeGeminiDir) ||
      isUnsafeWindowsCmdPath(probeLogFile))
  ) {
    throw new AgyProbeError('start_failed', 'Unsafe Windows executable or probe storage path.')
  }
  const target = isWindowsCommand ? resolveTrustedWindowsCmdExe(env) : executablePath
  if (isWindowsCommand && !target) {
    throw new AgyProbeError(
      'start_failed',
      'Trusted Windows command interpreter could not be confirmed.',
    )
  }
  const resolvedTarget = target ?? executablePath
  const args = isWindowsCommand
    ? [
        '/d',
        '/s',
        '/c',
        `""${executablePath}" acp --disable-telemetry --gemini-dir "${probeGeminiDir}" --app-data-dir probe --log-file "${probeLogFile}""`,
      ]
    : [
        'acp',
        '--disable-telemetry',
        '--gemini-dir',
        probeGeminiDir,
        '--app-data-dir',
        'probe',
        '--log-file',
        probeLogFile,
      ]
  return probe.spawn(resolvedTarget, args, {
    cwd: workingDirectory,
    ...(env ? { env } : {}),
    windowsHide: true,
    windowsVerbatimArguments: isWindowsCommand,
  })
}

function isUnauthenticatedRpcError(code: number | undefined, message: string): boolean {
  return (
    code === -32000 ||
    /authentication required|not logged in|unauthenticated|sign in required/iu.test(message)
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const MAX_SOURCE_SETTINGS_BYTES = 65_536
const MAX_MODEL_PROVIDER_LENGTH = 64

function resolveAgyGeminiDirForProbe(env?: NodeJS.ProcessEnv): string | undefined {
  const sourceEnv = env ?? process.env
  const explicitGeminiDir = readEnvCaseInsensitive(sourceEnv, 'ANTIGRAVITY_GEMINI_DIR')?.trim()
  if (explicitGeminiDir !== undefined && explicitGeminiDir.length > 0) {
    return isAbsolute(explicitGeminiDir) && !hasAsciiControlChar(explicitGeminiDir)
      ? explicitGeminiDir
      : undefined
  }
  const home =
    readEnvCaseInsensitive(sourceEnv, 'HOME')?.trim() ||
    readEnvCaseInsensitive(sourceEnv, 'USERPROFILE')?.trim() ||
    homedir()
  if (!home || !isAbsolute(home) || hasAsciiControlChar(home)) return undefined
  return join(home, '.gemini')
}

function throwIfSetupCancelledOrExpired(signal: AbortSignal | undefined, deadlineAt: number): void {
  if (signal?.aborted) {
    throw abortError(signal.reason)
  }
  if (Date.now() >= deadlineAt) {
    throw new AgyProbeError('timeout', 'The Antigravity ACP probe timed out before initialization.')
  }
}

async function runWithSetupBudget<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  deadlineAt: number,
): Promise<T> {
  throwIfSetupCancelledOrExpired(signal, deadlineAt)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  void operation.catch(() => undefined)
  const budgetPromise = new Promise<never>((_resolve, reject) => {
    const remainingMs = Number.isFinite(deadlineAt)
      ? Math.max(0, deadlineAt - Date.now())
      : undefined
    if (remainingMs !== undefined) {
      timer = setTimeout(() => {
        reject(
          new AgyProbeError(
            'timeout',
            'The Antigravity ACP probe timed out before initialization.',
          ),
        )
      }, remainingMs)
      timer.unref?.()
    }
    if (signal) {
      onAbort = () => reject(abortError(signal.reason))
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    return await Promise.race([operation, budgetPromise])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function seedProbeModelProviderSettings(
  probeGeminiDir: string,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  deadlineAt = Infinity,
): Promise<void> {
  throwIfSetupCancelledOrExpired(signal, deadlineAt)
  const baseGeminiDir = resolveAgyGeminiDirForProbe(env)
  if (!baseGeminiDir) return
  const sourceSettingsPath = join(baseGeminiDir, 'antigravity-cli', 'settings.json')
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let modelProvider: string | undefined
  try {
    const before = await lstat(sourceSettingsPath)
    throwIfSetupCancelledOrExpired(signal, deadlineAt)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 2 ||
      before.size > MAX_SOURCE_SETTINGS_BYTES
    ) {
      return
    }
    const openFlags =
      constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0))
    handle = await open(sourceSettingsPath, openFlags)
    throwIfSetupCancelledOrExpired(signal, deadlineAt)
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.size > MAX_SOURCE_SETTINGS_BYTES
    ) {
      return
    }
    const buffer = Buffer.allocUnsafe(before.size + 1)
    let totalRead = 0
    while (totalRead < buffer.length) {
      throwIfSetupCancelledOrExpired(signal, deadlineAt)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Bounded positional read of <= 64 KiB settings.json.
      const { bytesRead } = await handle.read(
        buffer,
        totalRead,
        buffer.length - totalRead,
        totalRead,
      )
      if (bytesRead === 0) break
      totalRead += bytesRead
    }
    if (totalRead !== before.size || totalRead > MAX_SOURCE_SETTINGS_BYTES) return
    const parsed: unknown = JSON.parse(
      buffer
        .subarray(0, totalRead)
        .toString('utf8')
        .replace(/^\uFEFF/u, ''),
    )
    if (!isPlainRecord(parsed) || typeof parsed.modelProvider !== 'string') return
    const trimmed = parsed.modelProvider.trim()
    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_MODEL_PROVIDER_LENGTH ||
      hasAsciiControlChar(trimmed)
    ) {
      return
    }
    modelProvider = trimmed
  } catch (error) {
    if (error instanceof AgyProbeError || (error instanceof Error && error.name === 'AbortError')) {
      throw error
    }
    return
  } finally {
    await handle?.close().catch(() => undefined)
  }

  if (!modelProvider) return
  throwIfSetupCancelledOrExpired(signal, deadlineAt)
  const probeAppDataDir = join(probeGeminiDir, 'probe')
  await mkdir(probeAppDataDir, { mode: 0o700 })
  await chmod(probeAppDataDir, 0o700)
  await writeFile(join(probeAppDataDir, 'settings.json'), JSON.stringify({ modelProvider }), {
    mode: 0o600,
    flag: 'wx',
  })
}

function abortError(reason?: unknown): Error {
  const error = new Error('The Antigravity ACP probe was aborted.', { cause: reason })
  error.name = 'AbortError'
  return error
}

export async function runAgyAcpProbe<T>(request: AgyAcpProbeRequest<T>): Promise<T> {
  if (request.signal?.aborted) {
    throw abortError(request.signal.reason)
  }
  const initTimeoutMs = Math.max(0, request.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS)
  let activeDeadlineAt = Math.min(
    Date.now() + initTimeoutMs,
    request.businessDeadlineAt ?? Infinity,
  )
  if (Date.now() >= activeDeadlineAt) {
    throw new AgyProbeError('timeout', 'The Antigravity ACP probe timed out before initialization.')
  }

  const probeRoot = await mkdtemp(join(tmpdir(), 'pact-agy-acp-'))
  const probeCwd = join(probeRoot, 'cwd')
  const probeGeminiDir = join(probeRoot, 'gemini')
  const probeLogFile = join(probeRoot, 'acp-probe.log')
  const processAbort = new AbortController()
  let child: ChildProcessWithoutNullStreams | undefined
  let probe: OwnedProcessGroup | undefined
  let openedSessionId: string | undefined
  let sessionResult!: T
  const onCallerAbort = (): void => {
    if (!openedSessionId) {
      processAbort.abort(request.signal?.reason)
    }
  }
  let hasBodyError = false
  let bodyError: unknown
  let closeFailureError: AgyProbeError | undefined

  try {
    request.signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (request.signal?.aborted) {
      processAbort.abort(request.signal.reason)
      throw abortError(request.signal.reason)
    }
    await runWithSetupBudget(
      (async () => {
        await chmod(probeRoot, 0o700)
        await mkdir(probeCwd, { mode: 0o700 })
        await chmod(probeCwd, 0o700)
        await mkdir(probeGeminiDir, { mode: 0o700 })
        await chmod(probeGeminiDir, 0o700)
        await seedProbeModelProviderSettings(
          probeGeminiDir,
          request.env,
          processAbort.signal,
          activeDeadlineAt,
        )
      })(),
      processAbort.signal,
      activeDeadlineAt,
    )
    throwIfSetupCancelledOrExpired(processAbort.signal, activeDeadlineAt)

    probe = request.ownProbe(processAbort.signal, () => {
      if (child && !child.stdin.destroyed) child.stdin.end()
    })

    const runningChild = spawnAgyAcpServer(
      request.executablePath,
      probeCwd,
      probeGeminiDir,
      probeLogFile,
      probe,
      request.env,
    )
    child = runningChild

    let transportClosed = false
    let spawnFailed = false
    let totalBytes = 0
    let bufferedLineBytes = 0
    let bufferedLine = ''
    let nextId = 1
    const decoder = new StringDecoder('utf8')
    const pending = new Map<
      number,
      {
        resolve: (value: unknown) => void
        reject: (error: Error) => void
        timer: ReturnType<typeof setTimeout> | undefined
      }
    >()

    const rejectAllPending = (error: Error): void => {
      if (transportClosed) return
      transportClosed = true
      for (const entry of pending.values()) {
        if (entry.timer) clearTimeout(entry.timer)
        entry.reject(error)
      }
      pending.clear()
    }

    const writeFrame = (payload: unknown): void => {
      if (transportClosed || runningChild.stdin.destroyed || !runningChild.stdin.writable) {
        throw new AgyProbeError('protocol', 'Antigravity ACP stdin is closed.')
      }
      runningChild.stdin.write(`${JSON.stringify(payload)}\n`)
    }

    const handleLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed) return
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return

      const rawId: unknown = Reflect.get(parsed, 'id')
      const rawMethod: unknown = Reflect.get(parsed, 'method')

      // Unexpected server-to-client requests during a zero-Turn probe are explicitly declined
      // so the server never blocks waiting for interactive client approval.
      if (
        typeof rawMethod === 'string' &&
        (typeof rawId === 'number' || typeof rawId === 'string')
      ) {
        try {
          writeFrame({
            jsonrpc: '2.0',
            id: rawId,
            error: { code: -32601, message: 'Interactive probe requests are not supported.' },
          })
        } catch {
          /* Ignore write errors while closing. */
        }
        return
      }

      if (typeof rawMethod === 'string') {
        request.onNotification?.(rawMethod, Reflect.get(parsed, 'params'))
        return
      }

      if (typeof rawId !== 'number') return
      const waiter = pending.get(rawId)
      if (!waiter) return
      pending.delete(rawId)
      if (waiter.timer) clearTimeout(waiter.timer)

      if (Reflect.has(parsed, 'error')) {
        const errorObj: unknown = Reflect.get(parsed, 'error')
        const rawCode =
          errorObj && typeof errorObj === 'object' ? Reflect.get(errorObj, 'code') : undefined
        const code = typeof rawCode === 'number' ? rawCode : undefined
        const rawMsg =
          errorObj && typeof errorObj === 'object' ? Reflect.get(errorObj, 'message') : undefined
        const message = typeof rawMsg === 'string' ? rawMsg : 'Antigravity ACP RPC failed.'
        if (isUnauthenticatedRpcError(code, message)) {
          waiter.reject(new AgyProbeError('unauthenticated', message, code))
        } else {
          waiter.reject(new AgyProbeError('protocol', message, code))
        }
        return
      }

      if (!Reflect.has(parsed, 'result')) {
        waiter.reject(new AgyProbeError('protocol', 'Antigravity ACP returned an invalid reply.'))
        return
      }
      waiter.resolve(Reflect.get(parsed, 'result'))
    }

    const onStdout = (chunk: Buffer): void => {
      if (transportClosed) return
      totalBytes += chunk.length
      if (totalBytes > request.maxTotalBytes) {
        runningChild.stdout.destroy()
        runningChild.stderr.destroy()
        rejectAllPending(
          new AgyProbeError('output_overflow', 'Antigravity ACP exceeded its output budget.'),
        )
        return
      }
      const decoded = decoder.write(chunk)
      let cursor = 0
      while (cursor < decoded.length) {
        const newlineIndex = decoded.indexOf('\n', cursor)
        if (newlineIndex < 0) {
          const tail = decoded.slice(cursor)
          bufferedLineBytes += Buffer.byteLength(tail, 'utf8')
          if (bufferedLineBytes > request.maxFrameBytes) {
            runningChild.stdout.destroy()
            runningChild.stderr.destroy()
            rejectAllPending(
              new AgyProbeError('output_overflow', 'Antigravity ACP returned an oversized frame.'),
            )
            return
          }
          bufferedLine += tail
          break
        }
        const segment = decoded.slice(cursor, newlineIndex)
        const frameBytes = bufferedLineBytes + Buffer.byteLength(segment, 'utf8')
        if (frameBytes > request.maxFrameBytes) {
          runningChild.stdout.destroy()
          runningChild.stderr.destroy()
          rejectAllPending(
            new AgyProbeError('output_overflow', 'Antigravity ACP returned an oversized frame.'),
          )
          return
        }
        const completeLine = bufferedLine + segment
        bufferedLine = ''
        bufferedLineBytes = 0
        cursor = newlineIndex + 1
        handleLine(completeLine)
        if (transportClosed) return
      }
    }

    const onStderr = (chunk: Buffer): void => {
      if (transportClosed) return
      totalBytes += chunk.length
      if (totalBytes > request.maxTotalBytes) {
        runningChild.stdout.destroy()
        runningChild.stderr.destroy()
        rejectAllPending(
          new AgyProbeError('output_overflow', 'Antigravity ACP exceeded its output budget.'),
        )
      }
    }

    const onChildError = (error: Error): void => {
      spawnFailed = true
      rejectAllPending(
        new AgyProbeError('start_failed', 'Antigravity ACP could not start.', undefined, {
          cause: error,
        }),
      )
    }

    const onChildExit = (code: number | null): void => {
      if (spawnFailed) return
      rejectAllPending(new AgyProbeError('protocol', `Antigravity ACP exited (${code}).`))
    }

    runningChild.stdout.on('data', onStdout)
    runningChild.stderr.on('data', onStderr)
    runningChild.once('error', onChildError)
    runningChild.once('exit', onChildExit)

    const sendRpcRequest = (
      method: string,
      params: Record<string, unknown>,
      customTimeoutMs?: number,
      clampToActiveDeadline = true,
      ignoreCallerAbort = false,
    ): Promise<unknown> => {
      if (!ignoreCallerAbort && request.signal?.aborted) {
        return Promise.reject(abortError(request.signal.reason))
      }
      if (processAbort.signal.aborted) {
        return Promise.reject(abortError(processAbort.signal.reason))
      }
      const remainingMs = clampToActiveDeadline
        ? customTimeoutMs === undefined
          ? activeDeadlineAt - Date.now()
          : Math.min(customTimeoutMs, activeDeadlineAt - Date.now())
        : (customTimeoutMs ?? SESSION_CLOSE_GRACE_MS)
      if (remainingMs <= 0) {
        return Promise.reject(new AgyProbeError('timeout', 'Antigravity ACP probe timed out.'))
      }
      if (transportClosed) {
        return Promise.reject(
          new AgyProbeError(
            spawnFailed ? 'start_failed' : 'protocol',
            'Antigravity ACP transport already closed.',
          ),
        )
      }
      if (pending.size >= MAX_PENDING_ACP_REQUESTS) {
        return Promise.reject(
          new AgyProbeError('protocol', 'Antigravity ACP pending request limit exceeded.'),
        )
      }
      const id = nextId
      nextId += 1
      return new Promise<unknown>((resolveRpc, rejectRpc) => {
        const detachAbortListeners = (): void => {
          if (!ignoreCallerAbort) {
            request.signal?.removeEventListener('abort', onCallerSignalAbort)
          }
          processAbort.signal.removeEventListener('abort', onProcessAbort)
        }
        const cancelWaiter = (reason: unknown): void => {
          const entry = pending.get(id)
          if (!entry) return
          pending.delete(id)
          if (entry.timer) clearTimeout(entry.timer)
          detachAbortListeners()
          rejectRpc(abortError(reason))
        }
        const onCallerSignalAbort = (): void => cancelWaiter(request.signal?.reason)
        const onProcessAbort = (): void => cancelWaiter(processAbort.signal.reason)
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return
          detachAbortListeners()
          rejectRpc(new AgyProbeError('timeout', 'Antigravity ACP probe timed out.'))
        }, remainingMs)
        if (!ignoreCallerAbort) {
          request.signal?.addEventListener('abort', onCallerSignalAbort, { once: true })
        }
        processAbort.signal.addEventListener('abort', onProcessAbort, { once: true })
        pending.set(id, {
          timer,
          resolve: (value) => {
            detachAbortListeners()
            resolveRpc(value)
          },
          reject: (error) => {
            detachAbortListeners()
            rejectRpc(error)
          },
        })
        try {
          writeFrame({ jsonrpc: '2.0', id, method, params })
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          detachAbortListeners()
          rejectRpc(
            error instanceof Error
              ? error
              : new AgyProbeError('protocol', 'Antigravity ACP request write failed.'),
          )
        }
      })
    }

    const transport: AgyAcpRpcTransport = {
      request: (method, params, customTimeoutMs) => sendRpcRequest(method, params, customTimeoutMs),
    }

    try {
      const initRaw = await transport.request('initialize', {
        protocolVersion: 1,
        clientInfo: {
          name: 'pact',
          version: resolvePactClientVersion(),
        },
      })
      if (!initRaw || typeof initRaw !== 'object' || Array.isArray(initRaw)) {
        throw new AgyProbeError('protocol', 'Antigravity ACP returned an invalid initialize reply.')
      }
      const agentInfo: unknown = Reflect.get(initRaw, 'agentInfo')
      const rawAgentVersion =
        agentInfo && typeof agentInfo === 'object' ? Reflect.get(agentInfo, 'version') : undefined
      const agentInfoVersion =
        typeof rawAgentVersion === 'string' && rawAgentVersion.trim().length > 0
          ? rawAgentVersion.trim().slice(0, 160)
          : undefined
      if (agentInfoVersion) {
        request.onAgentInfoVersion?.(agentInfoVersion)
      }

      // Stage 2 starts a separate session deadline once initialize handshake succeeds.
      activeDeadlineAt = Math.min(
        Date.now() + Math.max(0, request.timeoutMs),
        request.businessDeadlineAt ?? Infinity,
      )

      const newSessionRaw = await transport.request('session/new', {
        cwd: probeCwd,
        mcpServers: [],
      })
      if (!isPlainRecord(newSessionRaw)) {
        throw new AgyProbeError(
          'protocol',
          'Antigravity ACP returned an invalid session/new reply.',
        )
      }
      const rawSessionId = newSessionRaw.sessionId
      if (
        typeof rawSessionId !== 'string' ||
        rawSessionId.length === 0 ||
        rawSessionId.length > 256
      ) {
        throw new AgyProbeError('protocol', 'Antigravity ACP returned an invalid sessionId.')
      }
      openedSessionId = rawSessionId

      try {
        sessionResult = await request.inspectSession({
          sessionId: rawSessionId,
          newSessionResult: newSessionRaw,
          agentInfoVersion,
          probeCwd,
          transport,
        })
      } finally {
        if (!transportClosed && !processAbort.signal.aborted && openedSessionId) {
          const effectiveCloseDeadlineAt = resolveEffectiveCloseDeadline(
            request.closeDeadlineAt,
            request.getShutdownDeadlineAt?.(),
          )
          const closeWaitMs =
            effectiveCloseDeadlineAt !== undefined
              ? Math.min(
                  SESSION_CLOSE_GRACE_MS,
                  Math.max(0, effectiveCloseDeadlineAt - Date.now() - 1_000),
                )
              : SESSION_CLOSE_GRACE_MS
          if (closeWaitMs > 0) {
            await sendRpcRequest(
              'session/close',
              { sessionId: rawSessionId },
              closeWaitMs,
              false,
              true,
            ).catch(() => undefined)
          }
        }
      }
    } finally {
      runningChild.stdout.off('data', onStdout)
      runningChild.stderr.off('data', onStderr)
      runningChild.off('error', onChildError)
      runningChild.off('exit', onChildExit)
      if (!runningChild.stdin.destroyed) runningChild.stdin.end()
    }
  } catch (error) {
    hasBodyError = true
    bodyError = error
  }

  request.signal?.removeEventListener('abort', onCallerAbort)
  if (request.signal?.aborted && !processAbort.signal.aborted) {
    processAbort.abort(request.signal.reason)
  }

  const artifact: UnconfirmedAgyProbeArtifact = { probeRoot }
  if (probe) {
    const currentProbe = probe
    let closeThrew = false
    let closeError: unknown
    const effectiveCloseDeadlineAt = resolveEffectiveCloseDeadline(
      request.closeDeadlineAt,
      request.getShutdownDeadlineAt?.(),
    )
    try {
      await currentProbe.close(effectiveCloseDeadlineAt)
    } catch (error) {
      closeThrew = true
      closeError = error
    }
    if (isAgyProbeSettled(currentProbe)) {
      const reconcile = request.reconcileArtifact ?? reconcileSettledAgyProbeArtifact
      let artifactRemoved = false
      try {
        artifactRemoved = await reconcile(artifact).catch(() => false)
      } finally {
        request.onProbeSettled?.(currentProbe, artifact, artifactRemoved)
      }
      if (closeThrew) {
        request.onCloseError?.(closeError, currentProbe, artifact)
        closeFailureError = new AgyProbeError(
          'close_unconfirmed',
          'Antigravity ACP probe cleanup could not be confirmed.',
          undefined,
          { cause: closeError },
        )
      }
    } else {
      const effectiveError = closeThrew
        ? closeError
        : new Error('Antigravity ACP probe did not confirm settlement.')
      request.onCloseError?.(effectiveError, currentProbe, artifact)
      closeFailureError = new AgyProbeError(
        'close_unconfirmed',
        'Antigravity ACP probe cleanup could not be confirmed.',
        undefined,
        { cause: effectiveError },
      )
    }
  } else {
    const reconcile = request.reconcileArtifact ?? reconcileSettledAgyProbeArtifact
    await reconcile(artifact).catch(() => false)
  }

  if (closeFailureError) {
    throw closeFailureError
  }
  if (hasBodyError) {
    throw bodyError
  }
  return sessionResult
}
