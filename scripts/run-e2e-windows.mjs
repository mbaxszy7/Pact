import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, delimiter, isAbsolute, join } from 'node:path'

const outputLimit = 256 * 1024

/** NSIS parses its raw command line, not CRT argv; only these owned operations opt in. */
export function validateWindowsArgumentMode(args, mode = 'crt') {
  if (mode === 'crt') return mode
  if (mode !== 'nsis' || !Array.isArray(args) || args[0] !== '/S' || ![1, 2].includes(args.length))
    throw new Error('Invalid named NSIS invocation')
  if (args.length === 2) {
    const directory =
      typeof args[1] === 'string' && args[1].startsWith('/D=') ? args[1].slice(3) : ''
    if (
      !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/iu.test(directory) ||
      /["\0\r\n]/u.test(directory) ||
      /\/D=/iu.test(directory)
    )
      throw new Error('Invalid owned NSIS installation directory')
  }
  return mode
}

async function executablePath(name, candidates = [], env = process.env) {
  const directories = (env.PATH ?? '').split(delimiter).filter(isAbsolute)
  if (directories.length > 128) throw new Error('Executable discovery limit')
  for (const candidate of [
    ...candidates,
    ...(isAbsolute(name) ? [] : directories.map((directory) => join(directory, name))),
  ]) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Ordered bounded executable discovery has no process side effects.
      const actual = await realpath(candidate)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Verify the chosen native executable before any process starts.
      if (/\.exe$/iu.test(actual) && (await stat(actual)).isFile()) return actual
    } catch {
      /* Try the next explicitly bounded path. */
    }
  }
  throw new Error('Native executable unavailable')
}

async function targetPath(executable, env = process.env) {
  if (executable !== 'pnpm')
    return {
      executable: await executablePath(executable, isAbsolute(executable) ? [executable] : [], env),
      prefix: [],
    }
  const entry = env.npm_execpath
  if (entry && isAbsolute(entry) && /^pnpm\.(?:cjs|mjs|js)$/iu.test(basename(entry))) {
    const actual = await realpath(entry)
    if (!(await stat(actual)).isFile()) throw new Error('Package manager entry is not a file')
    return { executable: process.execPath, prefix: [actual] }
  }
  const directories = (env.PATH ?? '').split(delimiter).filter(isAbsolute)
  return {
    executable: await executablePath(
      'pnpm.exe',
      [
        ...(env.npm_execpath ? [env.npm_execpath] : []),
        ...directories.map((directory) => join(directory, 'node_modules/pnpm/pnpm.exe')),
      ],
      env,
    ),
    prefix: [],
  }
}

/** One native Job owns all Windows descendants; POSIX ownership remains in run-e2e.mjs. */
export async function runWindows(args, timeout, options, { failure, scrubHeaders }) {
  let argumentMode
  try {
    argumentMode = validateWindowsArgumentMode(args, options.windowsArgumentMode)
  } catch {
    throw failure('Windows NSIS arguments failed admission; no job was started.')
  }
  const env = options.env ?? process.env
  const signal = options.signal
  if (signal?.aborted) throw failure('Windows E2E job cancelled before admission.')
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw failure('E2E job deadline must be positive and finite.')
  const startedAt = performance.now()
  let lookupTimer
  let target, powershell
  try {
    ;[target, powershell] = await Promise.race([
      Promise.all([
        targetPath(options.executable, env),
        executablePath(
          env.PACT_E2E_POWERSHELL_EXECUTABLE ?? 'pwsh.exe',
          env.PACT_E2E_POWERSHELL_EXECUTABLE ? [env.PACT_E2E_POWERSHELL_EXECUTABLE] : [],
          env,
        ),
      ]),
      new Promise((_, reject) => {
        lookupTimer = setTimeout(
          () => reject(new Error('Lookup deadline')),
          Math.min(timeout, 10_000),
        )
      }),
    ])
  } catch {
    throw failure(
      'Windows E2E needs native executable targets and PowerShell 7 (pwsh.exe); no job was started.',
    )
  } finally {
    clearTimeout(lookupTimer)
  }
  const pipeName = `pact-e2e-${process.pid}-${randomUUID()}`
  if (signal?.aborted) throw failure('Windows E2E job cancelled before admission.')
  const token = randomUUID()
  const request = JSON.stringify({
    pipe: pipeName,
    token,
    executable: target.executable,
    args: [...target.prefix, ...args],
    argumentMode,
    cwd: options.cwd,
    timeout: Math.max(1, timeout - (performance.now() - startedAt)),
  })
  if (
    !Array.isArray(args) ||
    args.length > 128 ||
    args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    Buffer.byteLength(request) > 64 * 1024
  )
    throw failure('Windows E2E startup request exceeds its bound.')
  return new Promise((done, reject) => {
    const server = createServer()
    server.maxConnections = 1
    const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    const abort = new AbortController()
    let child,
      socket,
      control = Buffer.alloc(0),
      authenticated = false
    let stopping = false,
      settled = false,
      closed = false,
      pumpsClosed = false,
      groupGone = false
    let pid = null,
      ownedProcessCount = 0,
      exitCode = 1,
      error,
      killTimer,
      startupTimer,
      bufferedBytes = 0,
      maxBufferedBytes = 0
    const state = (kind, reason) => {
      if (settled && kind !== 'settled') return
      try {
        options.onState({
          kind,
          reason,
          pid,
          ownerPid: child?.pid ?? null,
          bufferedBytes,
          maxBufferedBytes,
          groupGone,
          ownedProcessCount,
          ownedGroupCount: groupGone ? 0 : 1,
        })
      } catch {
        stop('observer-failed')
      }
    }
    const finish = () => {
      if (settled || !closed || !pumpsClosed) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(killTimer)
      clearTimeout(startupTimer)
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
      signal?.removeEventListener('abort', onCancel)
      socket?.destroy()
      server.close()
      control = Buffer.alloc(0)
      if (!groupGone) error ??= failure('Windows E2E Job closure could not be confirmed.')
      state('settled')
      if (error) reject(error)
      else done(stopping ? 1 : exitCode)
    }
    const stop = (reason) => {
      if (stopping || settled) return
      stopping = true
      buffers.stdout = Buffer.alloc(0)
      buffers.stderr = Buffer.alloc(0)
      bufferedBytes = 0
      abort.abort()
      state('stopping', reason)
      if (authenticated) socket?.end('stop\n')
      else socket?.destroy()
      killTimer = setTimeout(() => {
        child?.kill()
        if (!child) {
          closed = true
          pumpsClosed = true
          groupGone = true
          finish()
        }
      }, 5000)
    }
    const onInterrupt = () => stop('interrupted-SIGINT')
    const onTerminate = () => stop('interrupted-SIGTERM')
    const onCancel = () => stop('cancelled')
    const deadline = setTimeout(
      () => stop('deadline'),
      Math.max(1, timeout - (performance.now() - startedAt)),
    )
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    signal?.addEventListener('abort', onCancel, { once: true })
    const emitLine = async (channel, bytes) => {
      if (stopping) return
      const text = scrubHeaders(options.redact(bytes.toString('utf8'))) + '\n'
      if (Buffer.byteLength(text) > outputLimit) return stop('redacted-output-budget')
      if (options.write) {
        let onAbort
        try {
          await Promise.race([
            options.write(channel, text),
            new Promise((_, rejectTransfer) => {
              onAbort = () => rejectTransfer(new Error('Output transfer cancelled'))
              if (abort.signal.aborted) onAbort()
              else abort.signal.addEventListener('abort', onAbort, { once: true })
            }),
          ])
        } finally {
          if (onAbort) abort.signal.removeEventListener('abort', onAbort)
        }
      } else if (!process[channel].write(text))
        await once(process[channel], 'drain', { signal: abort.signal })
    }
    const pump = async (channel, stream) => {
      try {
        for await (const chunk of stream) {
          let offset = 0
          while (offset < chunk.length) {
            if (stopping) break
            const newline = chunk.indexOf(10, offset),
              end = newline < 0 ? chunk.length : newline
            const piece = chunk.subarray(offset, end)
            if (bufferedBytes + piece.length > outputLimit) {
              stop('output-budget')
              break
            }
            buffers[channel] = Buffer.concat([buffers[channel], piece])
            bufferedBytes += piece.length
            maxBufferedBytes = Math.max(maxBufferedBytes, bufferedBytes)
            state('buffered')
            if (newline < 0) break
            const line = buffers[channel]
            bufferedBytes -= line.length
            buffers[channel] = Buffer.alloc(0)
            // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve complete-line redaction and backpressure.
            await emitLine(channel, line)
            offset = newline + 1
          }
        }
        if (!stopping && buffers[channel].length) {
          const tail = buffers[channel]
          bufferedBytes -= tail.length
          buffers[channel] = Buffer.alloc(0)
          await emitLine(channel, tail)
        }
      } catch {
        if (!stopping) stop('output-transfer-failed')
      }
    }
    server.on('connection', (connection) => {
      socket = connection
      connection.on('error', () => stop('control-error'))
      connection.on('end', () => {
        if (!groupGone) stop('control-closed')
      })
      connection.on('data', (chunk) => {
        control = Buffer.concat([control, chunk])
        if (control.length > 4096) return stop('control-budget')
        let newline
        while ((newline = control.indexOf(10)) >= 0) {
          let message
          try {
            message = JSON.parse(control.subarray(0, newline).toString('utf8'))
          } catch {
            return stop('control-invalid')
          }
          control = control.subarray(newline + 1)
          if (!authenticated) {
            if (message.kind !== 'hello' || message.token !== token || stopping)
              return stop('control-authentication')
            authenticated = true
            state('initializing')
            connection.write('go\n')
            continue
          }
          if (message.kind === 'started' && Number.isSafeInteger(message.pid) && message.pid > 0) {
            pid = message.pid
            ownedProcessCount = 1
            clearTimeout(startupTimer)
            state('started')
          } else if (
            message.kind === 'counts' &&
            Number.isInteger(message.active) &&
            message.active >= 0 &&
            message.active <= 256
          ) {
            ownedProcessCount = message.active
            state('ownership')
          } else if (message.kind === 'stopping')
            stop(message.reason === 'deadline' ? 'deadline' : 'descendants-still-running')
          else if (
            message.kind === 'empty' &&
            message.active === 0 &&
            Number.isSafeInteger(message.exitCode)
          ) {
            groupGone = true
            ownedProcessCount = 0
            exitCode = message.exitCode
          } else if (message.kind === 'error') {
            error = failure('Windows E2E supervisor could not execute its owned Job.')
            stop('supervisor-error')
          } else stop('control-invalid')
        }
      })
    })
    server.once('error', () => {
      error = failure('Windows E2E control pipe could not start.')
      stop('control-start-failed')
    })
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => {
      if (stopping) return
      child = spawn(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          join(import.meta.dirname, 'windows-e2e-job.ps1'),
        ],
        { cwd: options.cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      state('bootstrapping')
      startupTimer = setTimeout(
        () => stop('startup-deadline'),
        Math.min(15_000, Math.max(1, timeout - (performance.now() - startedAt))),
      )
      child.stdin.on('error', () => stop('bootstrap-transfer-failed'))
      child.stdin.end(request + '\n')
      child.once('error', () => {
        error = failure('Windows E2E supervisor could not start.')
        closed = true
        stop('spawn-failed')
        finish()
      })
      child.once('close', () => {
        closed = true
        finish()
      })
      void Promise.allSettled([pump('stdout', child.stdout), pump('stderr', child.stderr)]).then(
        () => {
          pumpsClosed = true
          finish()
          return undefined
        },
      )
    })
  })
}
