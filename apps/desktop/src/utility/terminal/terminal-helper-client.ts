import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  TERMINAL_STARTUP_DEADLINE_MS,
} from '@pact/contracts'

// oxlint-disable-next-line eslint/no-underscore-dangle -- Build-time Vite define constant embedded inside ASAR bundle.
declare const __PACT_TERMINAL_HELPER_META__: unknown

const FRAME_READY = 0x01
const FRAME_OUTPUT = 0x02
const FRAME_ACTIVITY = 0x03
const FRAME_EXIT = 0x04
const FRAME_ERROR = 0x05
const FRAME_SHELL_EXITED = 0x06

const FRAME_INPUT = 0x10
const FRAME_RESIZE = 0x11
const FRAME_SHUTDOWN = 0x13
const FRAME_PING_ACTIVITY = 0x14

const MAX_INCOMING_FRAME_BYTES = 1024 * 1024
const MAX_BINARY_BYTES = 4 * 1024 * 1024
const MAX_METADATA_BYTES = 4096
const STDERR_CAP_BYTES = 4096
const SHA256_RE = /^[a-f0-9]{64}$/u
const LC_SEGMENT_64 = 0x19
const LC_CODE_SIGNATURE = 0x1d
const LINKEDIT_SEGNAME = Buffer.from('__LINKEDIT\0\0\0\0\0\0', 'ascii')

export interface TerminalHelperActivity {
  hasActiveChild: boolean
  childCount: number
  foregroundCommand: string | null
}

export interface TerminalHelperShellExit {
  exitCode: number | null
  signal: string | null
}

export interface TerminalHelperExit {
  exitCode: number | null
  signal: string | null
  cleanupConfirmed: boolean
}

export interface TerminalHelperReady {
  protocolVersion: number
  pid: number
  shell: string
}

export interface TerminalHelperCallbacks {
  onReady: (info: TerminalHelperReady) => void
  onOutput: (chunk: string) => void
  onActivity: (activity: TerminalHelperActivity) => void
  onShellExited?: (info: TerminalHelperShellExit) => void
  onExit: (exit: TerminalHelperExit) => void
  onError: (message: string) => void
}

interface VerifiedHelperMetadata {
  protocolVersion: 1
  platform: string
  arch: string
  filename: string
  sourceSha256: string
  binarySha256: string
  binaryBytes: number
  machoPreSignatureSha256?: string
}

function isRunningInsideAsar(): boolean {
  return typeof __dirname === 'string' && __dirname.includes('.asar')
}

function expectedHelperFilename(): string {
  if (process.platform === 'darwin') return `terminal-darwin-${process.arch}`
  if (process.platform === 'win32') return `terminal-win32-${process.arch}.exe`
  throw new Error(`Integrated terminal is not supported on ${process.platform}.`)
}

function parseHelperMetadata(
  raw: unknown,
  expectedFilename: string,
): VerifiedHelperMetadata | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const protocolVersion = Reflect.get(raw, 'protocolVersion')
  const platform = Reflect.get(raw, 'platform')
  const arch = Reflect.get(raw, 'arch')
  const filename = Reflect.get(raw, 'filename')
  const sourceSha256 = Reflect.get(raw, 'sourceSha256')
  const binarySha256 = Reflect.get(raw, 'binarySha256')
  const binaryBytes = Reflect.get(raw, 'binaryBytes')
  const machoPreSignatureSha256 = Reflect.get(raw, 'machoPreSignatureSha256')
  if (
    protocolVersion !== 1 ||
    platform !== process.platform ||
    arch !== process.arch ||
    filename !== expectedFilename ||
    typeof sourceSha256 !== 'string' ||
    !SHA256_RE.test(sourceSha256) ||
    typeof binarySha256 !== 'string' ||
    !SHA256_RE.test(binarySha256) ||
    typeof binaryBytes !== 'number' ||
    !Number.isSafeInteger(binaryBytes) ||
    binaryBytes < 64 ||
    binaryBytes > MAX_BINARY_BYTES ||
    (machoPreSignatureSha256 !== undefined &&
      (typeof machoPreSignatureSha256 !== 'string' || !SHA256_RE.test(machoPreSignatureSha256)))
  ) {
    return null
  }
  return {
    protocolVersion: 1,
    platform,
    arch,
    filename,
    sourceSha256,
    binarySha256,
    binaryBytes,
    ...(typeof machoPreSignatureSha256 === 'string' ? { machoPreSignatureSha256 } : {}),
  }
}

function computeMachoPreSignatureSha256(bytes: Buffer, arch: string): string | null {
  if (bytes.byteLength < 32) return null
  const expectedCpu = arch === 'arm64' ? 0x0100000c : arch === 'x64' ? 0x01000007 : 0
  if (expectedCpu === 0) return null
  if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== expectedCpu) return null
  const ncmds = bytes.readUInt32LE(16)
  const sizeofcmds = bytes.readUInt32LE(20)
  if (ncmds === 0 || ncmds > 1024 || sizeofcmds < 16 || sizeofcmds > bytes.byteLength - 32) {
    return null
  }
  const commandsEnd = 32 + sizeofcmds
  let offset = 32
  let linkeditOffset = -1
  let linkeditFileoff = 0n
  let linkeditFilesize = 0n
  let codeSigOffset = -1
  let dataoff = 0
  let datasize = 0

  for (let i = 0; i < ncmds; i += 1) {
    if (offset + 8 > commandsEnd) return null
    const cmd = bytes.readUInt32LE(offset)
    const cmdsize = bytes.readUInt32LE(offset + 4)
    if (cmdsize < 8 || cmdsize % 8 !== 0 || cmdsize > commandsEnd - offset) return null
    if (cmd === LC_SEGMENT_64) {
      if (cmdsize < 72) return null
      if (bytes.subarray(offset + 8, offset + 24).equals(LINKEDIT_SEGNAME)) {
        if (linkeditOffset !== -1) return null
        linkeditOffset = offset
        linkeditFileoff = bytes.readBigUInt64LE(offset + 40)
        linkeditFilesize = bytes.readBigUInt64LE(offset + 48)
      }
    } else if (cmd === LC_CODE_SIGNATURE) {
      if (cmdsize !== 16 || codeSigOffset !== -1) return null
      codeSigOffset = offset
      dataoff = bytes.readUInt32LE(offset + 8)
      datasize = bytes.readUInt32LE(offset + 12)
    }
    offset += cmdsize
  }

  if (linkeditOffset === -1 || codeSigOffset === -1) return null
  if (dataoff < commandsEnd || datasize === 0 || dataoff > bytes.byteLength - datasize) return null
  if (
    BigInt(dataoff) < linkeditFileoff ||
    linkeditFileoff + linkeditFilesize !== BigInt(bytes.byteLength)
  ) {
    return null
  }
  const trailing = bytes.byteLength - (dataoff + datasize)
  if (trailing < 0 || trailing >= 16) return null
  for (let i = dataoff + datasize; i < bytes.byteLength; i += 1) {
    if (bytes[i] !== 0) return null
  }
  const normalized = Buffer.from(bytes.subarray(0, dataoff))
  normalized.fill(0, linkeditOffset + 32, linkeditOffset + 40)
  normalized.fill(0, linkeditOffset + 48, linkeditOffset + 56)
  normalized.fill(0, codeSigOffset + 8, codeSigOffset + 16)
  return createHash('sha256').update(normalized).digest('hex')
}

function readPinnedBytes(filePath: string, minBytes: number, maxBytes: number): Buffer {
  const pre = lstatSync(filePath, { bigint: true })
  if (!pre.isFile() || pre.isSymbolicLink()) {
    throw new Error(`Terminal helper resource must be a regular non-symlink file: ${filePath}`)
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const fd = openSync(filePath, fsConstants.O_RDONLY | noFollow)
  try {
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile()) {
      throw new Error(`Terminal helper resource is not a regular file: ${filePath}`)
    }
    const size = Number(info.size)
    if (!Number.isSafeInteger(size) || size < minBytes || size > maxBytes) {
      throw new Error(`Terminal helper resource exceeds its byte bound: ${filePath}`)
    }
    const buf = Buffer.allocUnsafe(size + 1)
    let off = 0
    while (off < buf.byteLength) {
      const n = readSync(fd, buf, off, buf.byteLength - off, off)
      if (n === 0) break
      off += n
    }
    if (off !== size || off > maxBytes) {
      throw new Error(`Terminal helper resource changed during verification: ${filePath}`)
    }
    return buf.subarray(0, size)
  } finally {
    closeSync(fd)
  }
}

function verifyHelperBytes(
  bytes: Buffer,
  expected: VerifiedHelperMetadata,
  packaged: boolean,
): void {
  const actualSha = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength === expected.binaryBytes && actualSha === expected.binarySha256) {
    return
  }
  if (process.platform === 'darwin' && packaged && expected.machoPreSignatureSha256) {
    const actualPreSig = computeMachoPreSignatureSha256(bytes, process.arch)
    if (actualPreSig && actualPreSig === expected.machoPreSignatureSha256) {
      return
    }
  }
  throw new Error('Terminal helper binary failed integrity verification.')
}

async function isRegularExecutableFile(filePath: string): Promise<boolean> {
  try {
    const link = await lstat(filePath)
    if (link.isSymbolicLink() || !link.isFile()) return false
    const canonical = await realpath(filePath)
    const info = await stat(canonical)
    if (!info.isFile()) return false
    if (process.platform !== 'win32') {
      await access(canonical, fsConstants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

async function lstat(path: string) {
  const { lstat: fsLstat } = await import('node:fs/promises')
  return fsLstat(path)
}

export async function resolveTerminalHelperExecutable(explicitPath?: string): Promise<string> {
  const filename = expectedHelperFilename()
  const packaged = isRunningInsideAsar()
  const embeddedMeta = parseHelperMetadata(
    typeof __PACT_TERMINAL_HELPER_META__ !== 'undefined' ? __PACT_TERMINAL_HELPER_META__ : null,
    filename,
  )

  if (packaged) {
    if (!embeddedMeta) {
      throw new Error('Packaged terminal helper lacks embedded integrity metadata.')
    }
    if (!process.resourcesPath) {
      throw new Error('Packaged terminal resources directory is unavailable.')
    }
    const pinnedPath = resolve(join(process.resourcesPath, 'native', filename))
    if (explicitPath && resolve(explicitPath) !== pinnedPath) {
      throw new Error('Packaged terminal helper must load from application resources.')
    }
    if (!(await isRegularExecutableFile(pinnedPath))) {
      throw new Error(`Terminal helper executable ${filename} is missing or inaccessible.`)
    }
    const bytes = readPinnedBytes(pinnedPath, 64, MAX_BINARY_BYTES)
    verifyHelperBytes(bytes, embeddedMeta, true)
    return pinnedPath
  }

  const fixedCandidates = [
    ...(explicitPath && isAbsolute(explicitPath) ? [resolve(explicitPath)] : []),
    ...(process.resourcesPath ? [resolve(join(process.resourcesPath, 'native', filename))] : []),
    resolve(__dirname, '../native', filename),
    resolve(__dirname, '../../native', filename),
    resolve(__dirname, '../../../out/native', filename),
  ]

  for (const candidate of new Set(fixedCandidates)) {
    try {
      const linkInfo = lstatSync(candidate)
      if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) continue
      if (process.platform !== 'win32') {
        // oxlint-disable-next-line no-await-in-loop -- Fixed short list of build-anchored candidate paths.
        await access(candidate, fsConstants.X_OK)
      }
      const bytes = readPinnedBytes(candidate, 64, MAX_BINARY_BYTES)
      let expected = embeddedMeta
      if (!expected) {
        const metaBytes = readPinnedBytes(`${candidate}.json`, 2, MAX_METADATA_BYTES)
        expected = parseHelperMetadata(JSON.parse(metaBytes.toString('utf8')), filename)
      }
      if (!expected) {
        throw new Error(`Invalid terminal helper metadata at ${candidate}.json`)
      }
      verifyHelperBytes(bytes, expected, false)
      return candidate
    } catch {
      // Try next build-anchored location.
    }
  }

  throw new Error(
    `Verified terminal helper executable ${filename} is missing or stale. Run build:terminal-helper.`,
  )
}

export async function resolveUserShell(): Promise<{ executable: string; login: boolean }> {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const cmd = join(systemRoot, 'System32', 'cmd.exe')
    const [hasPowershell, hasCmd] = await Promise.all([
      isRegularExecutableFile(powershell),
      isRegularExecutableFile(cmd),
    ])
    if (hasPowershell) return { executable: powershell, login: false }
    if (hasCmd) return { executable: cmd, login: false }
    throw new Error('System32 PowerShell or cmd.exe could not be located.')
  }

  let accountShell: string | undefined
  try {
    const candidate = userInfo().shell
    if (candidate && isAbsolute(candidate)) accountShell = candidate
  } catch {
    accountShell = undefined
  }
  let etcShells = new Set<string>()
  try {
    const raw = readFileSync('/etc/shells', 'utf8')
    etcShells = new Set(
      raw
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('/')),
    )
  } catch {
    etcShells = new Set(['/bin/zsh', '/bin/bash', '/bin/sh'])
  }

  const candidates = [
    ...(accountShell && etcShells.has(accountShell) ? [accountShell] : []),
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ]
  const checks = await Promise.all(
    candidates.map(async (candidate) =>
      (await isRegularExecutableFile(candidate)) ? candidate : undefined,
    ),
  )
  const chosen = checks.find((item): item is string => item !== undefined)
  if (chosen) {
    const name = basename(chosen)
    const supportsLogin = name === 'zsh' || name === 'bash' || name === 'sh' || name === 'fish'
    return { executable: chosen, login: supportsLogin }
  }
  throw new Error('No interactive POSIX shell executable could be located.')
}

function buildSanitizedTerminalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    if (
      upper.startsWith('PACT_') ||
      upper.startsWith('ELECTRON_') ||
      upper.startsWith('DYLD_') ||
      upper.startsWith('LD_') ||
      upper.startsWith('CHROME_') ||
      upper.startsWith('NODE_REPL_') ||
      upper === 'NODE_OPTIONS' ||
      upper === 'NODE_EXTRA_CA_CERTS' ||
      upper === 'NODE_PATH' ||
      upper === 'NODE_TLS_REJECT_UNAUTHORIZED' ||
      upper === 'NODE_V8_COVERAGE' ||
      upper === 'GOOGLE_API_KEY' ||
      upper === '_NT_SYMBOL_PATH' ||
      upper === 'COR_ENABLE_PROFILING' ||
      upper === 'CORECLR_ENABLE_PROFILING' ||
      upper === 'ZDOTDIR' ||
      upper === 'PWD' ||
      upper === 'OLDPWD'
    ) {
      delete env[key]
    }
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Pact'
  if (process.platform !== 'win32') {
    const lang = env.LANG ?? ''
    const ctype = env.LC_CTYPE ?? ''
    if (!lang.toLowerCase().includes('utf-8') && !ctype.toLowerCase().includes('utf-8')) {
      env.LANG = 'en_US.UTF-8'
    }
  }
  return env
}

/**
 * Owns one native PTY/ConPTY helper subprocess over framed stdin/stdout.
 */
export class TerminalHelperClient {
  private readonly utf8Decoder = new StringDecoder('utf8')
  private rxBuffer: Buffer = Buffer.alloc(0)
  private stderrText = ''
  private child: ChildProcessWithoutNullStreams | undefined
  private readySettled = false
  private shellExited = false
  private exited = false
  private shutdownRequested = false
  private abortedBeforeStart = false
  private outputPaused = false
  private exitResolvers: Array<(exit: TerminalHelperExit) => void> = []
  private latestExit: TerminalHelperExit | undefined
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private startupReject: ((error: Error) => void) | undefined
  private pendingResize: { cols: number; rows: number } | undefined

  constructor(private readonly callbacks: TerminalHelperCallbacks) {}

  async start(options: {
    helperExecutable: string
    shellExecutable: string
    login: boolean
    cwd: string
    cols: number
    rows: number
  }): Promise<TerminalHelperReady> {
    if (this.abortedBeforeStart || this.shutdownRequested || this.exited) {
      throw new Error('Terminal startup was cancelled before helper launch.')
    }

    const requestedCols = this.pendingResize?.cols ?? options.cols
    const requestedRows = this.pendingResize?.rows ?? options.rows
    this.pendingResize = undefined
    const cols = Math.max(MIN_TERMINAL_COLS, Math.min(MAX_TERMINAL_COLS, Math.floor(requestedCols)))
    const rows = Math.max(MIN_TERMINAL_ROWS, Math.min(MAX_TERMINAL_ROWS, Math.floor(requestedRows)))
    const args = [
      '--cwd',
      options.cwd,
      '--cols',
      String(cols),
      '--rows',
      String(rows),
      ...(options.login ? ['--login'] : ['--no-login']),
    ]

    const child = spawn(options.helperExecutable, args, {
      cwd: dirname(options.helperExecutable),
      env: buildSanitizedTerminalEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })
    this.child = child

    return new Promise<TerminalHelperReady>((resolveReady, rejectReady) => {
      this.startupReject = (err: Error) => {
        if (!this.readySettled) {
          this.readySettled = true
          rejectReady(err)
        }
      }
      this.startupTimer = setTimeout(() => {
        if (!this.readySettled) {
          this.readySettled = true
          this.forceTerminateProcess()
          rejectReady(new Error('Terminal helper timed out before initializing PTY.'))
        }
      }, TERMINAL_STARTUP_DEADLINE_MS)

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (this.stderrText.length < STDERR_CAP_BYTES) {
          this.stderrText += chunk.slice(0, STDERR_CAP_BYTES - this.stderrText.length)
        }
      })

      child.stdout.on('data', (chunk: Buffer) => {
        this.handleStdoutChunk(chunk, resolveReady, rejectReady)
      })

      child.stdin.on('error', () => {
        // Handled via exit/close/writable state.
      })

      child.once('error', (error) => {
        if (this.startupTimer) clearTimeout(this.startupTimer)
        if (!this.readySettled) {
          this.readySettled = true
          rejectReady(error)
        } else {
          this.callbacks.onError(error.message)
          this.finishExit({ exitCode: null, signal: null, cleanupConfirmed: false })
        }
      })

      child.once('close', (code, signal) => {
        if (this.startupTimer) clearTimeout(this.startupTimer)
        const remaining = this.utf8Decoder.end()
        if (remaining) this.callbacks.onOutput(remaining)
        if (!this.readySettled) {
          this.readySettled = true
          const detail = this.stderrText.trim()
          rejectReady(
            new Error(
              detail || `Terminal helper exited before startup (${code ?? signal ?? 'closed'}).`,
            ),
          )
          this.finishExit({ exitCode: code, signal: signal ?? null, cleanupConfirmed: false })
          return
        }
        if (!this.exited) {
          // Helper closing without emitting FRAME_EXIT leaves subprocess cleanup unconfirmed.
          this.finishExit({
            exitCode: code,
            signal: signal ?? null,
            cleanupConfirmed: false,
          })
        }
      })
    })
  }

  pauseOutput(): void {
    if (this.outputPaused || !this.child) return
    this.outputPaused = true
    this.child.stdout.pause()
  }

  resumeOutput(): void {
    if (!this.outputPaused || !this.child) return
    this.outputPaused = false
    this.child.stdout.resume()
  }

  writeInput(data: string): boolean {
    if (
      this.exited ||
      this.shellExited ||
      this.shutdownRequested ||
      !this.readySettled ||
      !this.child ||
      this.child.stdin.destroyed ||
      !this.child.stdin.writable
    ) {
      return false
    }
    return this.sendFrame(FRAME_INPUT, Buffer.from(data, 'utf8'))
  }

  resize(cols: number, rows: number): void {
    if (this.exited || this.shellExited || this.shutdownRequested) return
    const clampedCols = Math.max(MIN_TERMINAL_COLS, Math.min(MAX_TERMINAL_COLS, Math.floor(cols)))
    const clampedRows = Math.max(MIN_TERMINAL_ROWS, Math.min(MAX_TERMINAL_ROWS, Math.floor(rows)))
    if (
      !this.readySettled ||
      !this.child ||
      this.child.stdin.destroyed ||
      !this.child.stdin.writable
    ) {
      this.pendingResize = { cols: clampedCols, rows: clampedRows }
      return
    }
    this.pendingResize = undefined
    const payload = Buffer.allocUnsafe(4)
    payload.writeUInt16BE(clampedCols, 0)
    payload.writeUInt16BE(clampedRows, 2)
    this.sendFrame(FRAME_RESIZE, payload)
  }

  requestActivityPing(): void {
    if (this.exited || !this.child || !this.child.stdin.writable) return
    this.sendFrame(FRAME_PING_ACTIVITY, Buffer.alloc(0))
  }

  async shutdown(
    options: { force?: boolean; graceMs?: number; deadlineMs?: number } = {},
  ): Promise<TerminalHelperExit> {
    if (this.latestExit) return this.latestExit
    if (!this.child) {
      this.abortedBeforeStart = true
      this.shutdownRequested = true
      this.exited = true
      const settled: TerminalHelperExit = { exitCode: null, signal: null, cleanupConfirmed: true }
      this.latestExit = settled
      return settled
    }
    this.shutdownRequested = true
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = undefined
    }
    if (!this.readySettled) {
      this.startupReject?.(new Error('Terminal startup was cancelled during shutdown.'))
    }
    this.resumeOutput()

    const force = Boolean(options.force)
    const graceMs = Math.max(0, Math.min(10_000, Math.floor(options.graceMs ?? 2_000)))
    const payload = Buffer.allocUnsafe(5)
    payload.writeUInt8(force ? 1 : 0, 0)
    payload.writeUInt32BE(graceMs, 1)
    if (this.child.stdin.writable && !this.child.stdin.destroyed) {
      const sent = this.sendFrame(FRAME_SHUTDOWN, payload)
      if (!sent) this.forceTerminateProcess()
    } else {
      this.forceTerminateProcess()
    }

    const waitMs = Math.max(250, options.deadlineMs ?? graceMs + 1_800)
    return new Promise<TerminalHelperExit>((resolveShutdown) => {
      const timer = setTimeout(() => {
        this.forceTerminateProcess()
        const idx = this.exitResolvers.indexOf(onExit)
        if (idx >= 0) this.exitResolvers.splice(idx, 1)
        resolveShutdown({ exitCode: null, signal: 'SIGKILL', cleanupConfirmed: false })
      }, waitMs)
      const onExit = (exit: TerminalHelperExit): void => {
        clearTimeout(timer)
        resolveShutdown(exit)
      }
      this.exitResolvers.push(onExit)
    })
  }

  private forceTerminateProcess(): void {
    try {
      this.child?.kill('SIGKILL')
    } catch {
      // Process already exited.
    }
  }

  private sendFrame(frameType: number, payload: Buffer): boolean {
    if (!this.child || !this.child.stdin.writable || this.child.stdin.destroyed) return false
    const header = Buffer.allocUnsafe(5)
    header.writeUInt8(frameType, 0)
    header.writeUInt32BE(payload.length, 1)
    try {
      this.child.stdin.write(payload.length > 0 ? Buffer.concat([header, payload]) : header)
      return true
    } catch {
      return false
    }
  }

  private handleStdoutChunk(
    chunk: Buffer,
    resolveReady: (info: TerminalHelperReady) => void,
    rejectReady: (error: Error) => void,
  ): void {
    this.rxBuffer = this.rxBuffer.length > 0 ? Buffer.concat([this.rxBuffer, chunk]) : chunk
    while (this.rxBuffer.length >= 5) {
      const frameType = this.rxBuffer.readUInt8(0)
      const length = this.rxBuffer.readUInt32BE(1)
      if (length > MAX_INCOMING_FRAME_BYTES) {
        this.forceTerminateProcess()
        if (!this.readySettled) {
          this.readySettled = true
          rejectReady(new Error('Terminal helper emitted an oversized control frame.'))
        }
        return
      }
      if (this.rxBuffer.length < 5 + length) break
      const payload = this.rxBuffer.subarray(5, 5 + length)
      this.rxBuffer = this.rxBuffer.subarray(5 + length)
      this.dispatchFrame(frameType, payload, resolveReady, rejectReady)
    }
  }

  private dispatchFrame(
    frameType: number,
    payload: Buffer,
    resolveReady: (info: TerminalHelperReady) => void,
    rejectReady: (error: Error) => void,
  ): void {
    if (frameType === FRAME_OUTPUT) {
      const text = this.utf8Decoder.write(payload)
      if (text) this.callbacks.onOutput(text)
      return
    }
    let parsedValue: unknown
    try {
      parsedValue = JSON.parse(payload.toString('utf8'))
    } catch {
      return
    }
    if (!parsedValue || typeof parsedValue !== 'object') return

    const readNum = (key: string): number | null => {
      const val = Reflect.get(parsedValue, key)
      return typeof val === 'number' ? val : null
    }
    const readStr = (key: string): string | null => {
      const val = Reflect.get(parsedValue, key)
      return typeof val === 'string' ? val : null
    }

    if (frameType === FRAME_READY) {
      if (this.startupTimer) clearTimeout(this.startupTimer)
      const info: TerminalHelperReady = {
        protocolVersion: readNum('protocolVersion') ?? 1,
        pid: readNum('pid') ?? 0,
        shell: readStr('shell') ?? 'shell',
      }
      if (!this.readySettled) {
        this.readySettled = true
        if (this.pendingResize) {
          const pending = this.pendingResize
          this.pendingResize = undefined
          this.resize(pending.cols, pending.rows)
        }
        resolveReady(info)
      }
      this.callbacks.onReady(info)
      return
    }

    if (frameType === FRAME_ACTIVITY) {
      this.callbacks.onActivity({
        hasActiveChild: Reflect.get(parsedValue, 'hasActiveChild') === true,
        childCount: readNum('childCount') ?? 0,
        foregroundCommand: readStr('foregroundCommand'),
      })
      return
    }

    if (frameType === FRAME_SHELL_EXITED) {
      this.shellExited = true
      this.callbacks.onShellExited?.({
        exitCode: readNum('exitCode'),
        signal: readStr('signal'),
      })
      return
    }

    if (frameType === FRAME_EXIT) {
      const remainingTail = this.utf8Decoder.end()
      if (remainingTail) this.callbacks.onOutput(remainingTail)
      this.finishExit({
        exitCode: readNum('exitCode'),
        signal: readStr('signal'),
        cleanupConfirmed: Reflect.get(parsedValue, 'cleanupConfirmed') === true,
      })
      return
    }

    if (frameType === FRAME_ERROR) {
      const message = readStr('message') ?? 'Terminal helper reported an error.'
      if (!this.readySettled) {
        if (this.startupTimer) clearTimeout(this.startupTimer)
        this.readySettled = true
        rejectReady(new Error(message))
      } else {
        this.callbacks.onError(message)
      }
    }
  }

  private finishExit(exit: TerminalHelperExit): void {
    if (this.exited) return
    this.exited = true
    this.latestExit = exit
    this.callbacks.onExit(exit)
    const waiters = this.exitResolvers.splice(0, this.exitResolvers.length)
    for (const waiterResolve of waiters) waiterResolve(exit)
  }
}
