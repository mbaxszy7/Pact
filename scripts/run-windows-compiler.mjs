import { execFile } from 'node:child_process'
import { realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { setImmediate as preparationTurn } from 'node:timers/promises'

import {
  removeWindowsRpcLauncherSync,
  WindowsLaunchPreparationError,
  writeWindowsObservedLauncher,
} from '../tests/e2e/windows-cli-launcher.ts'

let active

export class WindowsCompilerError extends Error {
  constructor(reason, physicalReleased, preserveWorkspace, rootExitCode = null) {
    super(
      `Windows compiler failed (${reason}; rootExit=${rootExitCode}; released=${physicalReleased}).`,
    )
    this.name = 'WindowsCompilerError'
    this.physicalReleased = physicalReleased
    this.preserveWorkspace = preserveWorkspace
    this.rootExitCode = rootExitCode
  }
}

async function compilerPath(env, check) {
  if (process.platform !== 'win32') throw new Error('A native Windows compiler host is required')
  const directories = (env.PATH ?? env.Path ?? '').split(delimiter).filter(isAbsolute)
  if (directories.length > 128) throw new Error('Compiler lookup exceeds its bound')
  for (const directory of directories) {
    check()
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Inspect the ordered bounded PATH without starting a process.
      const path = await realpath(join(directory, 'cl.exe'))
      check()
      // oxlint-disable-next-line eslint/no-await-in-loop -- Only a real native compiler file may be admitted.
      if ((await stat(path)).isFile()) return path
    } catch {
      /* Continue only while the original deadline is live. */
    }
    check()
  }
  throw new Error('Native compiler unavailable')
}

const defaultHost = {
  resolveCompiler: compilerPath,
  prepare: writeWindowsObservedLauncher,
  execute: execFile,
  remove: removeWindowsRpcLauncherSync,
}

/** One compile action, no queue. Its Job also owns compiler services after cl.exe exits. */
export async function runWindowsCompiler(args, options, host = defaultHost) {
  if (active) throw new WindowsCompilerError('capacity-unavailable', false, false)
  if (
    !Array.isArray(args) ||
    args.length > 128 ||
    args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    Buffer.byteLength(JSON.stringify(args)) > 64 * 1024 ||
    typeof options?.cwd !== 'string' ||
    !isAbsolute(options.cwd) ||
    !Number.isSafeInteger(options.timeout) ||
    options.timeout <= 0 ||
    options.timeout > 60_000 ||
    !Number.isSafeInteger(options.maxBuffer) ||
    options.maxBuffer <= 0 ||
    options.maxBuffer > 256 * 1024
  )
    throw new WindowsCompilerError('invalid-admission', true, false)
  const ticket = Symbol('compiler-action')
  active = ticket
  const deadlineAt = performance.now() + options.timeout
  const env = options.env ?? process.env
  const interrupted = Promise.withResolvers()
  void interrupted.promise.catch(() => undefined)
  const preparationAbort = new AbortController()
  let interruption, retainedPreparation
  const check = () => {
    if (interruption || options.signal?.aborted || performance.now() >= deadlineAt) {
      interrupt()
      throw new Error('Compiler admission expired or cancelled')
    }
  }
  let owner, child, root, emptyFact, closeFact, outputFact
  let inputFailed = false,
    cancelFailed = false
  let deadlineTimer,
    cleanupTimer,
    reason = 'preparation',
    result
  let physicalReleased = true,
    preserveWorkspace = false
  const cleanupExpired = Promise.withResolvers()
  void cleanupExpired.promise.catch(() => undefined)
  const beginCleanup = () => {
    if (!owner || cleanupTimer) return
    // This is the existing physical cleanup window, never a fresh compilation budget.
    cleanupTimer = setTimeout(() => {
      child?.kill()
      cleanupExpired.reject(new Error('Compiler Job release was not confirmed'))
    }, 5000)
    try {
      owner.cancel()
    } catch {
      cancelFailed = true
    }
  }
  const interrupt = () => {
    if (interruption) return
    interruption = options.signal?.aborted ? 'cancelled' : 'deadline'
    preparationAbort.abort()
    interrupted.reject(new Error('Compiler preparation interrupted'))
    beginCleanup()
  }
  const releasePreparation = () => {
    physicalReleased = true
    if (active === ticket) active = undefined
  }
  const prepareWithinDeadline = async (work, releaseLate) => {
    let began = false
    const pending = Promise.resolve().then(() => {
      check()
      began = true
      return work()
    })
    try {
      return await Promise.race([pending, interrupted.promise])
    } catch (error) {
      if (began && releaseLate)
        physicalReleased =
          error instanceof WindowsLaunchPreparationError && error.preparationReleased
      if (interruption) {
        physicalReleased = false
        // Preparation cannot dispatch cl.exe. Keep its slot until it really finishes.
        retainedPreparation = pending
          .then(
            async (value) => {
              if (releaseLate) await releaseLate(value)
              releasePreparation()
              return undefined
            },
            (failure) => {
              if (
                !began ||
                !releaseLate ||
                (failure instanceof WindowsLaunchPreparationError && failure.preparationReleased)
              )
                releasePreparation()
              return undefined
            },
          )
          .catch(() => undefined)
      }
      throw error
    }
  }
  options.signal?.addEventListener('abort', interrupt, { once: true })
  deadlineTimer = setTimeout(interrupt, Math.max(1, deadlineAt - performance.now()))
  let joined
  try {
    check()
    const compiler = await prepareWithinDeadline(() => host.resolveCompiler(env, check))
    check()
    owner = await prepareWithinDeadline(
      () =>
        host.prepare(tmpdir(), compiler, Math.max(1, Math.floor(deadlineAt - performance.now())), {
          deadlineAt,
          signal: preparationAbort.signal,
        }),
      async (lateOwner) => {
        await lateOwner.disposeControl()
        host.remove(lateOwner.directory)
      },
    )
    await preparationTurn(undefined, { signal: preparationAbort.signal })
    check()
    owner.armStartup(Math.min(deadlineAt, performance.now() + 15_000))
    check()
    const output = Promise.withResolvers(),
      closed = Promise.withResolvers()
    reason = 'execution'
    child = host.execute(
      owner.executablePath,
      args,
      {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        maxBuffer: options.maxBuffer,
        timeout: Math.max(1, Math.ceil(deadlineAt - performance.now())) + 5000,
      },
      (error, stdout, stderr) => {
        outputFact = { error, stdout, stderr }
        output.resolve(outputFact)
      },
    )
    physicalReleased = false
    child.once('close', (code, signal) => {
      closeFact = { code, signal }
      closed.resolve(closeFact)
    })
    child.stdin?.once('error', () => {
      inputFailed = true
      beginCleanup()
    })
    child.stdin?.end()
    const empty = owner.empty.then((fact) => {
      emptyFact = fact
      return fact
    })
    joined = Promise.allSettled([empty, closed.promise, output.promise])
    check()
    root = await Promise.race([
      owner.rootExit,
      closed.promise.then(() => {
        throw new Error('Compiler root exit was not observed')
      }),
      cleanupExpired.promise,
    ])
    beginCleanup()
    reason = 'physical-release'
    await Promise.race([joined, cleanupExpired.promise])
    physicalReleased = emptyFact?.active === 0 && Boolean(closeFact)
    reason = 'compiler-result'
    check()
    const diagnostic = owner.diagnostic()
    const clean =
      diagnostic.stoppingReason === undefined
        ? closeFact.code === 0 && emptyFact.exitCode === 0 && !outputFact.error
        : diagnostic.stoppingReason === 'control-closed' &&
          closeFact.code === 1 &&
          emptyFact.exitCode === 1 &&
          outputFact.error?.code === 1 &&
          !outputFact.error.killed
    if (
      !physicalReleased ||
      root.natural !== true ||
      root.exitCode !== 0 ||
      diagnostic.firstFailure !== undefined ||
      diagnostic.nativeErrorCode !== undefined ||
      inputFailed ||
      cancelFailed ||
      closeFact.signal !== null ||
      !clean
    )
      throw new Error('Compiler completion facts are inconsistent')
    result = { stdout: outputFact.stdout, stderr: outputFact.stderr }
  } catch {
    beginCleanup()
    if (joined) {
      try {
        await Promise.race([joined, cleanupExpired.promise])
      } catch {
        /* Remain unconfirmed. */
      }
      physicalReleased = emptyFact?.active === 0 && Boolean(closeFact)
    }
    // A helper that never received go cannot have admitted a compiler Job.
    if (
      owner &&
      !Object.hasOwn(owner.diagnostic().stages, 'go') &&
      (!child || (closeFact && outputFact))
    )
      physicalReleased = true
    preserveWorkspace = !physicalReleased && !retainedPreparation
  } finally {
    clearTimeout(deadlineTimer)
    clearTimeout(cleanupTimer)
    options.signal?.removeEventListener('abort', interrupt)
    if (owner) {
      try {
        await owner.disposeControl()
        if (physicalReleased) host.remove(owner.directory)
      } catch {
        result = undefined
        preserveWorkspace = true
        reason = 'owner-cleanup'
      }
      if (preserveWorkspace) {
        try {
          const facts = JSON.stringify({
            version: 1,
            reason,
            physicalReleased,
            rootExitCode: root?.exitCode ?? null,
            helperExitCode: closeFact?.code ?? null,
            helperSignal: closeFact?.signal ?? null,
            control: owner.diagnostic(),
          })
          if (Buffer.byteLength(facts) <= 16 * 1024)
            await writeFile(join(owner.directory, 'compiler-failure.json'), facts, {
              flag: 'wx',
              mode: 0o600,
            })
        } catch {
          /* Keep the original descriptor and directory even if observation fails. */
        }
      }
    }
    if (physicalReleased && !preserveWorkspace && !retainedPreparation && active === ticket)
      active = undefined
  }
  if (result) {
    try {
      check()
      const control = owner.diagnostic()
      if (control.firstFailure !== undefined || control.nativeErrorCode !== undefined)
        throw new Error('Compiler control cleanup was not confirmed')
    } catch {
      result = undefined
      reason = interruption ?? 'owner-cleanup'
    }
  }
  if (!result)
    throw new WindowsCompilerError(
      reason,
      physicalReleased,
      preserveWorkspace,
      root?.exitCode ?? null,
    )
  return result
}
