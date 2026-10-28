import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path'

import { prepareWindowsRunnerLauncher } from '../tests/e2e/windows-cli-launcher.ts'

const outputLimit = 256 * 1024

function diagnosticInteger(number, min, max) {
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error('Invalid diagnostic number')
  return number
}
function diagnosticMembers(snapshot) {
  if (
    !Array.isArray(snapshot?.members) ||
    snapshot.members.length > 16 ||
    typeof snapshot.membersIncomplete !== 'boolean'
  )
    throw new Error('Invalid diagnostic members')
  return {
    members: snapshot.members.map((member) => {
      if (
        !['root', 'descendant'].includes(member?.role) ||
        ![
          'codex',
          'node',
          'cmd',
          'conhost',
          'git',
          'rg',
          'other',
          'pnpm',
          'esbuild',
          'app-builder',
          '7zip',
          'nsis',
          'compiler',
          'powershell',
          'owned-helper',
          'electron',
          'crash-reporter',
        ].includes(member.image)
      )
        throw new Error('Invalid diagnostic category')
      return {
        pid: diagnosticInteger(member.pid, 1, 4294967295),
        createdMs: diagnosticInteger(member.createdMs, 0, Number.MAX_SAFE_INTEGER),
        role: member.role,
        image: member.image,
      }
    }),
    membersIncomplete: snapshot.membersIncomplete,
  }
}

/** Diagnostics never authorize release; only fixed, bounded facts may enter CI logs. */
export function windowsJobDiagnostic(value) {
  try {
    if (value?.version !== 1) throw new Error('Missing diagnostic')
    let root = null,
      stop = null,
      afterTerminate = null
    if (value.root !== null) {
      if (typeof value.root?.natural !== 'boolean') throw new Error('Invalid root diagnostic')
      root = {
        pid: diagnosticInteger(value.root.pid, 1, 4294967295),
        exitCode: diagnosticInteger(value.root.exitCode, -2147483648, 2147483647),
        elapsedMs: diagnosticInteger(value.root.elapsedMs, 0, Number.MAX_SAFE_INTEGER),
        natural: value.root.natural,
        active: diagnosticInteger(value.root.active, 0, 256),
        ...diagnosticMembers(value.root),
      }
    }
    if (value.stop !== null) {
      if (!['control-closed', 'deadline', 'descendants-still-running'].includes(value.stop?.reason))
        throw new Error('Invalid stop diagnostic')
      stop = { reason: value.stop.reason, active: diagnosticInteger(value.stop.active, 0, 256) }
    }
    if (value.afterTerminate !== null) {
      if (value.afterTerminate?.phase !== 'after-terminate')
        throw new Error('Invalid capture phase')
      afterTerminate = { phase: 'after-terminate', ...diagnosticMembers(value.afterTerminate) }
    }
    return {
      version: 1,
      root,
      stop,
      afterTerminate,
      errorCode:
        value.errorCode === null
          ? null
          : diagnosticInteger(value.errorCode, -2147483648, 2147483647),
    }
  } catch {
    return { incomplete: true }
  }
}

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
  const deadlineAt = startedAt + timeout
  let lookupTimer
  let target
  try {
    target = await Promise.race([
      targetPath(options.executable, env),
      new Promise((_, reject) => {
        lookupTimer = setTimeout(
          () => reject(new Error('Lookup deadline')),
          Math.min(timeout, 10_000),
        )
      }),
    ])
  } catch {
    throw failure('Windows E2E needs a native executable target; no job was started.')
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
  let launcher
  const preparationState = (kind) =>
    options.onState({
      kind,
      pid: null,
      ownerPid: null,
      bufferedBytes: 0,
      maxBufferedBytes: 0,
      groupGone: true,
      ownedProcessCount: 0,
      ownedGroupCount: 0,
    })
  try {
    preparationState('preparing')
    launcher = prepareWindowsRunnerLauncher(
      {
        executable: target.executable,
        args: [...target.prefix, ...args],
        cwd: resolve(options.cwd ?? process.cwd()),
        pipe: pipeName,
        token,
        argumentMode,
      },
      deadlineAt,
    )
    preparationState('prepared')
    if (signal?.aborted || performance.now() >= deadlineAt)
      throw new Error('Command admission is obsolete')
  } catch {
    launcher?.dispose()
    throw failure('Windows E2E supervisor image preparation failed; no job was started.')
  }
  return new Promise((done, reject) => {
    const server = createServer()
    server.maxConnections = 1
    const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    const abort = new AbortController()
    let child,
      socket,
      control = Buffer.alloc(0),
      authenticated = false,
      goMayHaveBeenSent = false,
      startupDeadlineAt = null
    let stopping = false,
      settled = false,
      closed = false,
      pumpsClosed = false,
      groupGone = false
    let pid = null,
      ownedProcessCount = 0,
      exitCode = 1,
      supervisorExitCode = null,
      firstStopReason = null,
      diagnostic = { incomplete: true },
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
          jobAdmitted: goMayHaveBeenSent,
        })
      } catch {
        stop('observer-failed')
      }
    }
    const finish = () => {
      if (settled || !closed || !pumpsClosed) return
      currentBudget()
      // The trusted helper cannot create a Job before go. This is evidence of
      // non-admission after actual close, never a substitute for an admitted Job's empty receipt.
      if (!goMayHaveBeenSent) groupGone = true
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
      if (groupGone) {
        try {
          launcher.dispose()
        } catch {
          error ??= failure('Windows E2E launcher cleanup could not be confirmed.')
        }
      }
      state('settled')
      const result = stopping || signal?.aborted || performance.now() >= deadlineAt ? 1 : exitCode
      if (error || result !== 0) {
        try {
          console.error(
            '[pact-windows-job]',
            JSON.stringify({
              firstStopReason,
              supervisorExitCode,
              exitCode,
              closed,
              pumpsClosed,
              groupGone,
              ownedProcessCount,
              jobAdmitted: goMayHaveBeenSent,
              failed: Boolean(error),
              diagnostic,
            }),
          )
        } catch {
          /* Failure observations must not change the execution result. */
        }
      }
      if (error) reject(error)
      else done(result)
    }
    const stop = (reason) => {
      if (stopping || settled) return
      stopping = true
      firstStopReason = reason
      buffers.stdout = Buffer.alloc(0)
      buffers.stderr = Buffer.alloc(0)
      bufferedBytes = 0
      abort.abort()
      // Cancellation cannot write to the receipt pipe: EPIPE from an already
      // exited helper would destroy its still-unread genuine empty receipt.
      if (goMayHaveBeenSent) child?.stdin.end()
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
      state('stopping', reason)
    }
    const onInterrupt = () => stop('interrupted-SIGINT')
    const onTerminate = () => stop('interrupted-SIGTERM')
    const onCancel = () => stop('cancelled')
    const currentBudget = () => {
      if (stopping || settled) return false
      if (signal?.aborted) {
        stop('cancelled')
        return false
      }
      const now = performance.now()
      if (now >= deadlineAt) {
        stop('deadline')
        return false
      }
      if (startupDeadlineAt !== null && pid === null && now >= startupDeadlineAt) {
        stop('startup-deadline')
        return false
      }
      return true
    }
    const deadline = setTimeout(
      () => stop('deadline'),
      Math.max(1, timeout - (performance.now() - startedAt)),
    )
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    signal?.addEventListener('abort', onCancel, { once: true })
    const emitLine = async (channel, bytes) => {
      if (!currentBudget()) return
      const text = scrubHeaders(options.redact(bytes.toString('utf8'))) + '\n'
      if (Buffer.byteLength(text) > outputLimit) return stop('redacted-output-budget')
      if (!currentBudget()) return
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
      currentBudget()
    }
    const pump = async (channel, stream) => {
      try {
        for await (const chunk of stream) {
          let offset = 0
          while (offset < chunk.length) {
            if (!currentBudget()) break
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
        currentBudget()
      } catch {
        if (!stopping) stop('output-transfer-failed')
      }
    }
    server.on('connection', (connection) => {
      if (socket || stopping || settled) {
        connection.destroy()
        return
      }
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
          if (!message || typeof message !== 'object' || Array.isArray(message))
            return stop('control-invalid')
          control = control.subarray(newline + 1)
          if (!authenticated) {
            if (message.kind !== 'hello' || message.token !== token)
              return stop('control-authentication')
            if (!currentBudget()) return
            authenticated = true
            state('initializing')
            if (!currentBudget()) return
            // Reserve possible admission before writing; a failed write cannot prove unsent go.
            goMayHaveBeenSent = true
            connection.write('go\n')
            continue
          }
          if (message.kind === 'started' && Number.isSafeInteger(message.pid) && message.pid > 0) {
            if (pid !== null) return stop('control-invalid')
            if (!currentBudget()) continue
            pid = message.pid
            ownedProcessCount = 1
            clearTimeout(startupTimer)
            state('started')
            currentBudget()
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
            diagnostic = windowsJobDiagnostic(message.diagnostic)
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
      if (!currentBudget()) return
      startupDeadlineAt = Math.min(deadlineAt, performance.now() + 15_000)
      child = spawn(launcher.executablePath, [], {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      startupTimer = setTimeout(
        () => stop('startup-deadline'),
        Math.max(1, startupDeadlineAt - performance.now()),
      )
      child.stdin.on('error', () => stop('bootstrap-transfer-failed'))
      child.once('error', () => {
        error = failure('Windows E2E supervisor could not start.')
        stop('spawn-failed')
      })
      child.once('close', (code) => {
        supervisorExitCode = Number.isInteger(code) ? code : null
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
      state('bootstrapping')
      currentBudget()
    })
  })
}
