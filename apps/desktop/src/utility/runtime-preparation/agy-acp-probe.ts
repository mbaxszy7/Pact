import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { BigIntStats } from 'node:fs'

import Database from 'better-sqlite3'
import { chmod, lstat, mkdtemp, open, realpath, rm, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'

import desktopPackage from '../../../package.json'
import { OwnedProcessGroup } from '../owned-process-group'

const MAX_PENDING_ACP_REQUESTS = 16
const SESSION_CLOSE_GRACE_MS = 1_000
const MAX_PROBE_DB_INSPECT_BYTES = 16 * 1024 * 1024
const PROBE_CLOCK_SKEW_MS = 2_000
const COPY_CHUNK_BYTES = 64 * 1024
const SAFE_PROBE_SESSION_ID = /^[a-zA-Z0-9_-]{8,128}$/u
const UNSAFE_WINDOWS_CMD_METACHARS = /[&|<>^%!"\r\n\0]/u

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
  readonly timeoutMs: number
  readonly closeDeadlineAt?: number
  readonly maxFrameBytes: number
  readonly maxTotalBytes: number
  readonly deleteProbeSessionDb?: boolean
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
    probeCwd: string,
    openedSessionId: string | undefined,
  ) => void
  readonly onProbeSettled?: (probe: OwnedProcessGroup) => void
  readonly onSessionCleanupNote?: (note: string) => void
}

export function isAgyProbeSettled(probe: OwnedProcessGroup): boolean {
  return probe.released || probe.settledAfterCloseTimeout()
}

export function isUnsafeWindowsCmdPath(executablePath: string): boolean {
  return UNSAFE_WINDOWS_CMD_METACHARS.test(executablePath)
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

export function resolveEffectiveAgyAppDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const customGeminiDir = env.ANTIGRAVITY_GEMINI_DIR
  const geminiRoot =
    customGeminiDir && isAbsolute(customGeminiDir)
      ? customGeminiDir
      : join(env.HOME || env.USERPROFILE || homedir(), '.gemini')
  return resolve(join(geminiRoot, 'antigravity-cli'))
}

function resolveAgyConversationsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveEffectiveAgyAppDataDir(env), 'conversations')
}

async function statBigintIfPresent(filePath: string): Promise<BigIntStats | null> {
  try {
    return await lstat(filePath, { bigint: true })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function sameRegularFileIdentity(expected: BigIntStats, current: BigIntStats): boolean {
  return (
    !current.isSymbolicLink() &&
    current.isFile() &&
    expected.dev === current.dev &&
    expected.ino === current.ino &&
    expected.size === current.size &&
    expected.mtimeNs === current.mtimeNs
  )
}

async function copyRegularFileExclusiveBounded(
  srcPath: string,
  expectedStat: BigIntStats,
  destPath: string,
): Promise<boolean> {
  if (expectedStat.size < 0n || expectedStat.size > BigInt(MAX_PROBE_DB_INSPECT_BYTES)) {
    return false
  }
  const srcHandle = await open(srcPath, 'r')
  try {
    const fdStat = await srcHandle.stat({ bigint: true })
    if (!sameRegularFileIdentity(expectedStat, fdStat)) {
      return false
    }
    const destHandle = await open(destPath, 'wx', 0o600)
    try {
      const buffer = Buffer.allocUnsafe(
        Math.min(COPY_CHUNK_BYTES, Math.max(1, Number(expectedStat.size))),
      )
      let totalCopied = 0
      while (totalCopied < Number(expectedStat.size)) {
        const remaining = Number(expectedStat.size) - totalCopied
        // oxlint-disable-next-line no-await-in-loop -- Sequential bounded copy into exclusive staging handle.
        const { bytesRead } = await srcHandle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, remaining),
          totalCopied,
        )
        if (bytesRead <= 0) return false
        let writtenOffset = 0
        while (writtenOffset < bytesRead) {
          // oxlint-disable-next-line no-await-in-loop -- Complete short writes sequentially.
          const { bytesWritten } = await destHandle.write(
            buffer,
            writtenOffset,
            bytesRead - writtenOffset,
          )
          if (bytesWritten <= 0) return false
          writtenOffset += bytesWritten
        }
        totalCopied += bytesRead
        if (totalCopied > MAX_PROBE_DB_INSPECT_BYTES) return false
      }
      const trailingCheck = Buffer.allocUnsafe(1)
      const extra = await srcHandle.read(trailingCheck, 0, 1, totalCopied)
      if (extra.bytesRead > 0) return false
      return totalCopied === Number(expectedStat.size)
    } finally {
      await destHandle.close().catch(() => undefined)
    }
  } catch {
    return false
  } finally {
    await srcHandle.close().catch(() => undefined)
  }
}

function metadataContainsPositiveProbeWorkspaceUri(
  rawText: string,
  allowedFileUrls: readonly string[],
): boolean {
  if (!rawText.includes('file://')) return false
  const fileUrlTokens = rawText.match(/file:\/\/[^\s"\0<>'`]+/gu)
  if (!fileUrlTokens || fileUrlTokens.length === 0) return false
  return fileUrlTokens.every((token) =>
    allowedFileUrls.some(
      (allowed) =>
        allowed.length > 0 &&
        (token === allowed || token.startsWith(`${allowed}/`) || allowed.startsWith(`${token}/`)),
    ),
  )
}

async function verifyZeroStepProbeSessionDb(input: {
  sessionId: string
  probeCwd: string
  probeStartedAtMs: number
  dbPath: string
  walPath: string
  journalPath: string
}): Promise<
  | { readonly verified: true; readonly dbStat: BigIntStats; readonly walStat: BigIntStats | null }
  | { readonly verified: false }
> {
  if (!isSafeAgyProbeSessionId(input.sessionId)) return { verified: false }

  const journalBefore = await statBigintIfPresent(input.journalPath)
  if (journalBefore !== null) return { verified: false }

  const dbStat = await statBigintIfPresent(input.dbPath)
  const minWindowMs = BigInt(Math.max(0, input.probeStartedAtMs - PROBE_CLOCK_SKEW_MS))
  if (
    !dbStat ||
    !dbStat.isFile() ||
    dbStat.isSymbolicLink() ||
    dbStat.size <= 0n ||
    dbStat.size > BigInt(MAX_PROBE_DB_INSPECT_BYTES) ||
    dbStat.mtimeMs < minWindowMs ||
    (dbStat.birthtimeMs > 0n && dbStat.birthtimeMs < minWindowMs)
  ) {
    return { verified: false }
  }

  const walStat = await statBigintIfPresent(input.walPath)
  if (
    walStat &&
    (!walStat.isFile() ||
      walStat.isSymbolicLink() ||
      walStat.size < 0n ||
      walStat.size > BigInt(MAX_PROBE_DB_INSPECT_BYTES))
  ) {
    return { verified: false }
  }

  const canonicalProbeCwd = await realpath(input.probeCwd).catch(() => input.probeCwd)
  const allowedFileUrls = [
    pathToFileURL(input.probeCwd).href.replace(/\/+$/u, ''),
    pathToFileURL(canonicalProbeCwd).href.replace(/\/+$/u, ''),
  ]

  const stagingDir = await mkdtemp(join(tmpdir(), 'pact-agy-probe-inspect-'))
  try {
    await chmod(stagingDir, 0o700)
    const stagedDbPath = join(stagingDir, 'session.db')
    const stagedWalPath = join(stagingDir, 'session.db-wal')
    if (!(await copyRegularFileExclusiveBounded(input.dbPath, dbStat, stagedDbPath))) {
      return { verified: false }
    }
    if (
      walStat &&
      !(await copyRegularFileExclusiveBounded(input.walPath, walStat, stagedWalPath))
    ) {
      return { verified: false }
    }

    if ((await statBigintIfPresent(input.journalPath)) !== null) {
      return { verified: false }
    }

    let db: Database.Database | undefined
    try {
      db = new Database(stagedDbPath, { readonly: true, fileMustExist: true })
      const masterRows = db
        .prepare<[], { name: string; type: string }>(
          `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'`,
        )
        .all()
      if (masterRows.some((row) => row.type === 'view' || row.type === 'trigger')) {
        return { verified: false }
      }
      const tableNames = new Set(
        masterRows.filter((row) => row.type === 'table').map((row) => row.name),
      )
      if (!tableNames.has('steps')) return { verified: false }

      const stepCountRow = db
        .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "steps"')
        .get()
      if (!stepCountRow || stepCountRow.count !== 0) return { verified: false }

      let matchedWorkspaceUri = false

      if (tableNames.has('trajectory_meta')) {
        const metaRows = db
          .prepare<[], Record<string, unknown>>('SELECT * FROM "trajectory_meta" LIMIT 2')
          .all()
        if (metaRows.length > 1) return { verified: false }
        const metaRow = metaRows[0]
        if (metaRow) {
          const cascadeId = metaRow.cascade_id
          if (cascadeId !== undefined && cascadeId !== input.sessionId) return { verified: false }
          for (const colValue of Object.values(metaRow)) {
            if (typeof colValue === 'string' && colValue.includes('file://')) {
              if (!metadataContainsPositiveProbeWorkspaceUri(colValue, allowedFileUrls)) {
                return { verified: false }
              }
              matchedWorkspaceUri = true
            } else if (Buffer.isBuffer(colValue)) {
              if (colValue.byteLength > MAX_PROBE_DB_INSPECT_BYTES) return { verified: false }
              const text = colValue.toString('utf8')
              if (text.includes('file://')) {
                if (!metadataContainsPositiveProbeWorkspaceUri(text, allowedFileUrls)) {
                  return { verified: false }
                }
                matchedWorkspaceUri = true
              }
            }
          }
        }
      }

      if (tableNames.has('trajectory_metadata_blob')) {
        const blobRows = db
          .prepare<[], Record<string, unknown>>('SELECT * FROM "trajectory_metadata_blob" LIMIT 2')
          .all()
        if (blobRows.length > 1) return { verified: false }
        const rawData = blobRows[0]?.data
        if (Buffer.isBuffer(rawData)) {
          if (rawData.byteLength > MAX_PROBE_DB_INSPECT_BYTES) return { verified: false }
          const text = rawData.toString('utf8')
          if (text.includes('file://')) {
            if (!metadataContainsPositiveProbeWorkspaceUri(text, allowedFileUrls)) {
              return { verified: false }
            }
            matchedWorkspaceUri = true
          }
        }
      }

      if (!matchedWorkspaceUri) {
        return { verified: false }
      }
    } catch {
      return { verified: false }
    } finally {
      db?.close()
    }

    return { verified: true, dbStat, walStat }
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function unlinkVerifiedIdentity(
  filePath: string,
  expectedStat: BigIntStats,
): Promise<boolean> {
  const latest = await statBigintIfPresent(filePath)
  if (!latest || !sameRegularFileIdentity(expectedStat, latest)) {
    return false
  }
  await unlink(filePath).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw error
  })
  return true
}

async function cleanupVerifiedAgyProbeSessionDb(input: {
  sessionId: string
  probeCwd: string
  probeStartedAtMs: number
  sessionCloseSucceeded: boolean
  env: NodeJS.ProcessEnv | undefined
}): Promise<{ retained: boolean; note: string | undefined }> {
  if (!isSafeAgyProbeSessionId(input.sessionId)) {
    return {
      retained: true,
      note: 'Probe session cleanup was skipped because sessionId format could not be verified.',
    }
  }
  const conversationsDir = resolveAgyConversationsDir(input.env)
  const dbPath = join(conversationsDir, `${input.sessionId}.db`)
  const walPath = join(conversationsDir, `${input.sessionId}.db-wal`)
  const shmPath = join(conversationsDir, `${input.sessionId}.db-shm`)
  const journalPath = join(conversationsDir, `${input.sessionId}.db-journal`)

  const [dbStat, walStat, shmStat, journalStat] = await Promise.all([
    statBigintIfPresent(dbPath).catch(() => null),
    statBigintIfPresent(walPath).catch(() => null),
    statBigintIfPresent(shmPath).catch(() => null),
    statBigintIfPresent(journalPath).catch(() => null),
  ])
  const anyFilePresent = Boolean(dbStat || walStat || shmStat || journalStat)
  if (!anyFilePresent) {
    return {
      retained: false,
      note: input.sessionCloseSucceeded ? undefined : 'Probe session close was not acknowledged.',
    }
  }

  if (!input.sessionCloseSucceeded || journalStat !== null) {
    return {
      retained: true,
      note: 'Probe session file was retained because session/close or rollback journal settlement was not confirmed.',
    }
  }

  const verified = await verifyZeroStepProbeSessionDb({
    sessionId: input.sessionId,
    probeCwd: input.probeCwd,
    probeStartedAtMs: input.probeStartedAtMs,
    dbPath,
    walPath,
    journalPath,
  })
  if (!verified.verified) {
    return {
      retained: true,
      note: 'Probe session file was retained because exclusive probe ownership could not be confirmed.',
    }
  }

  const [latestJournal, latestDb, latestWal, latestShm] = await Promise.all([
    statBigintIfPresent(journalPath),
    statBigintIfPresent(dbPath),
    statBigintIfPresent(walPath),
    statBigintIfPresent(shmPath),
  ])
  if (
    latestJournal !== null ||
    !latestDb ||
    !sameRegularFileIdentity(verified.dbStat, latestDb) ||
    (verified.walStat
      ? !latestWal || !sameRegularFileIdentity(verified.walStat, latestWal)
      : latestWal !== null) ||
    (latestShm !== null &&
      (!latestShm.isFile() ||
        latestShm.isSymbolicLink() ||
        latestShm.size > BigInt(MAX_PROBE_DB_INSPECT_BYTES)))
  ) {
    return {
      retained: true,
      note: 'Probe session file changed before unlink and was retained safely.',
    }
  }

  const dbUnlinked = await unlinkVerifiedIdentity(dbPath, verified.dbStat)
  if (!dbUnlinked) {
    return {
      retained: true,
      note: 'Probe session file changed before unlink and was retained safely.',
    }
  }
  if (verified.walStat) {
    await unlinkVerifiedIdentity(walPath, verified.walStat)
  }
  if (latestShm) {
    await unlinkVerifiedIdentity(shmPath, latestShm)
  }
  return { retained: false, note: undefined }
}

function spawnAgyAcpServer(
  executablePath: string,
  workingDirectory: string,
  probe: OwnedProcessGroup,
  env?: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const isWindowsCommand = process.platform === 'win32' && /\.cmd$/iu.test(executablePath)
  if (isWindowsCommand && isUnsafeWindowsCmdPath(executablePath)) {
    throw new AgyProbeError('start_failed', 'Unsafe Windows executable path.')
  }
  const target = isWindowsCommand ? (process.env.ComSpec ?? 'cmd.exe') : executablePath
  const args = isWindowsCommand
    ? ['/d', '/s', '/c', `""${executablePath}" acp --disable-telemetry"`]
    : ['acp', '--disable-telemetry']
  return probe.spawn(target, args, {
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

function abortError(reason?: unknown): Error {
  const error = new Error('The Antigravity ACP probe was aborted.', { cause: reason })
  error.name = 'AbortError'
  return error
}

export async function runAgyAcpProbe<T>(request: AgyAcpProbeRequest<T>): Promise<T> {
  if (request.signal?.aborted) {
    throw abortError(request.signal.reason)
  }

  const probeCwd = await mkdtemp(join(tmpdir(), 'pact-agy-acp-'))
  const probeAbort = new AbortController()
  const onCallerAbort = (): void => probeAbort.abort(request.signal?.reason)
  let child: ChildProcessWithoutNullStreams | undefined
  let probe: OwnedProcessGroup | undefined
  let openedSessionId: string | undefined
  let probeStartedAtMs = Date.now()
  let sessionCloseSucceeded = false
  let closeFailed = false
  let sessionResult!: T

  try {
    await chmod(probeCwd, 0o700)
    request.signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (request.signal?.aborted) {
      probeAbort.abort(request.signal.reason)
      throw abortError(request.signal.reason)
    }

    probe = request.ownProbe(probeAbort.signal, () => {
      if (child && !child.stdin.destroyed) child.stdin.end()
    })

    const deadlineAt = Date.now() + Math.max(0, request.timeoutMs)
    const runningChild = spawnAgyAcpServer(request.executablePath, probeCwd, probe, request.env)
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

    const transport: AgyAcpRpcTransport = {
      request: (method, params, customTimeoutMs) => {
        if (request.signal?.aborted) {
          return Promise.reject(abortError(request.signal.reason))
        }
        const remainingMs =
          customTimeoutMs === undefined
            ? deadlineAt - Date.now()
            : Math.min(customTimeoutMs, deadlineAt - Date.now())
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
          const onSignalAbort = (): void => {
            const entry = pending.get(id)
            if (!entry) return
            pending.delete(id)
            if (entry.timer) clearTimeout(entry.timer)
            rejectRpc(abortError(request.signal?.reason))
          }
          const timer = setTimeout(() => {
            if (!pending.delete(id)) return
            request.signal?.removeEventListener('abort', onSignalAbort)
            rejectRpc(new AgyProbeError('timeout', 'Antigravity ACP probe timed out.'))
          }, remainingMs)
          request.signal?.addEventListener('abort', onSignalAbort, { once: true })
          pending.set(id, {
            timer,
            resolve: (value) => {
              request.signal?.removeEventListener('abort', onSignalAbort)
              resolveRpc(value)
            },
            reject: (error) => {
              request.signal?.removeEventListener('abort', onSignalAbort)
              rejectRpc(error)
            },
          })
          try {
            writeFrame({ jsonrpc: '2.0', id, method, params })
          } catch (error) {
            pending.delete(id)
            clearTimeout(timer)
            request.signal?.removeEventListener('abort', onSignalAbort)
            rejectRpc(
              error instanceof Error
                ? error
                : new AgyProbeError('protocol', 'Antigravity ACP request write failed.'),
            )
          }
        })
      },
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

      probeStartedAtMs = Date.now()

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
        if (!transportClosed && !request.signal?.aborted && Date.now() < deadlineAt) {
          const closeWaitMs = Math.min(
            SESSION_CLOSE_GRACE_MS,
            Math.max(100, deadlineAt - Date.now()),
          )
          await transport
            .request('session/close', { sessionId: rawSessionId }, closeWaitMs)
            .then(() => {
              sessionCloseSucceeded = true
              return undefined
            })
            .catch(() => {
              sessionCloseSucceeded = false
            })
        }
      }
    } finally {
      runningChild.stdout.off('data', onStdout)
      runningChild.stderr.off('data', onStderr)
      runningChild.off('error', onChildError)
      runningChild.off('exit', onChildExit)
      if (!runningChild.stdin.destroyed) runningChild.stdin.end()
    }
  } finally {
    request.signal?.removeEventListener('abort', onCallerAbort)
    if (probe) {
      const currentProbe = probe
      await currentProbe.close(request.closeDeadlineAt).catch((closeError: unknown) => {
        closeFailed = true
        request.onCloseError?.(closeError, currentProbe, probeCwd, openedSessionId)
        throw new AgyProbeError(
          'close_unconfirmed',
          'Antigravity ACP probe cleanup could not be confirmed.',
          undefined,
          { cause: closeError },
        )
      })
      if (isAgyProbeSettled(currentProbe)) {
        try {
          if (request.deleteProbeSessionDb && openedSessionId) {
            const dbCleanup = await cleanupVerifiedAgyProbeSessionDb({
              sessionId: openedSessionId,
              probeCwd,
              probeStartedAtMs,
              sessionCloseSucceeded,
              env: request.env,
            }).catch(() => ({
              retained: true,
              note: 'Probe session file was retained because probe cleanup inspection failed.',
            }))
            if (dbCleanup.note) {
              request.onSessionCleanupNote?.(dbCleanup.note)
            }
          }
        } finally {
          try {
            await rm(probeCwd, { recursive: true, force: true }).catch(() => undefined)
          } finally {
            request.onProbeSettled?.(currentProbe)
          }
        }
      }
    } else if (!closeFailed) {
      await rm(probeCwd, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  return sessionResult
}
