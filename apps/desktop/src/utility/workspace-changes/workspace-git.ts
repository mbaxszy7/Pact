import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { WORKSPACE_FILE_BYTES, WORKSPACE_OPERATION_TIMEOUT_MS } from '@pact/contracts'

const OUTPUT_BYTES = 128 * 1024
const STDERR_BYTES = 16 * 1024
const EXIT_GRACE_MS = 1_000
const EXIT_CONFIRM_MS = 1_000
const MAX_GIT_CHILDREN = 5
let ownedGitChildren = 0

/** Git owns the patch/merge algorithms. This function owns only its bounded process. */
export async function workspaceGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  outputFile?: string,
): Promise<{ code: number; output: string }> {
  const controller = new AbortController()
  const aborted = (): void => controller.abort(signal.reason)
  if (signal.aborted) aborted()
  else signal.addEventListener('abort', aborted, { once: true })
  const deadline = setTimeout(
    () => controller.abort(new Error('Git exceeded its workspace deadline.')),
    WORKSPACE_OPERATION_TIMEOUT_MS,
  )
  try {
    const operationSignal = controller.signal
    operationSignal.throwIfAborted()
    const executable = await findGit(operationSignal)
    operationSignal.throwIfAborted()
    if (ownedGitChildren >= MAX_GIT_CHILDREN)
      throw new Error(
        'All five protected Git process slots are occupied. A child whose exit is unconfirmed keeps its slot.',
      )
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    )
    env['GIT_CONFIG_NOSYSTEM'] = '1'
    env['GIT_CONFIG_GLOBAL'] = process.platform === 'win32' ? 'NUL' : '/dev/null'
    env['GIT_OPTIONAL_LOCKS'] = '0'
    env['GIT_CEILING_DIRECTORIES'] = cwd
    const child = spawn(
      executable,
      ['--no-pager', '-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', ...args],
      { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    ownedGitChildren += 1
    let stdoutBytes = 0
    let stderrBytes = 0
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let terminating = false
    let rejectExit: ((error: Error) => void) | undefined
    const terminate = (): void => {
      if (terminating || child.exitCode !== null || child.signalCode !== null) return
      terminating = true
      child.kill()
      forceExit = setTimeout(() => {
        child.kill('SIGKILL')
        exitConfirmation = setTimeout(
          () =>
            rejectExit?.(new Error('Git exit could not be confirmed after forced termination.')),
          EXIT_CONFIRM_MS,
        )
      }, EXIT_GRACE_MS)
    }
    let forceExit: ReturnType<typeof setTimeout> | undefined
    let exitConfirmation: ReturnType<typeof setTimeout> | undefined
    operationSignal.addEventListener('abort', terminate, { once: true })
    child.stderr.on('data', (bytes: Buffer) => {
      const remaining = STDERR_BYTES - stderrBytes
      if (remaining > 0) errors.push(bytes.subarray(0, remaining))
      stderrBytes += bytes.length
    })
    const boundedOutput = new Transform({
      transform(bytes: Buffer, _encoding, callback) {
        stdoutBytes += bytes.length
        if (stdoutBytes > (outputFile ? WORKSPACE_FILE_BYTES : OUTPUT_BYTES)) {
          terminate()
          callback(new Error('Git output exceeded the workspace operation budget.'))
          return
        }
        if (outputFile) callback(null, bytes)
        else {
          output.push(bytes)
          callback()
        }
      },
    })
    const exit = new Promise<number>((resolve, reject) => {
      rejectExit = reject
      child.once('error', reject)
      child.once('close', (code) => {
        ownedGitChildren -= 1
        resolve(code ?? 255)
      })
    })
    const drain = outputFile
      ? pipeline(
          child.stdout,
          boundedOutput,
          createWriteStream(outputFile, { flags: 'wx', mode: 0o600 }),
          { signal: operationSignal },
        )
      : pipeline(child.stdout, boundedOutput, { signal: operationSignal })
    try {
      const [code] = await Promise.all([exit, drain])
      operationSignal.throwIfAborted()
      if (code >= 128)
        throw new Error(
          Buffer.concat(errors).toString('utf8').trim() || 'Git could not process this change.',
        )
      return { code, output: Buffer.concat(output).toString('utf8') }
    } catch (error) {
      terminate()
      await exit.catch(() => undefined)
      throw error
    } finally {
      operationSignal.removeEventListener('abort', terminate)
      if (forceExit) clearTimeout(forceExit)
      if (exitConfirmation) clearTimeout(exitConfirmation)
      child.stderr.removeAllListeners('data')
    }
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener('abort', aborted)
  }
}

async function findGit(signal: AbortSignal): Promise<string> {
  const paths = (process.env['PATH'] ?? '').split(delimiter).slice(0, 128)
  const candidates = [
    ...(process.platform === 'win32' ? [] : ['/usr/bin/git', '/opt/homebrew/bin/git']),
    ...paths
      .filter(isAbsolute)
      .map((path) => join(path, process.platform === 'win32' ? 'git.exe' : 'git')),
  ]
  for (const candidate of candidates) {
    signal.throwIfAborted()
    try {
      // Executable discovery is bounded; it never executes a Project-provided script.
      // oxlint-disable-next-line no-await-in-loop
      await access(candidate)
      // oxlint-disable-next-line no-await-in-loop
      return await realpath(candidate)
    } catch {
      signal.throwIfAborted()
      // Try the next explicit candidate, not a shell interpolation.
    }
  }
  throw new Error('Git is required for protected file changes. Install Git and try again.')
}
