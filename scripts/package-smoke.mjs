import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import identities from '../apps/desktop/app-identities.json' with { type: 'json' }
import {
  loadProviderConfiguration,
  prepareProviderEnvironment,
} from '../tests/e2e/provider-environment.ts'

const PACKAGE_SMOKE_ENV = 'PACT_PACKAGE_SMOKE'
const PACKAGE_SMOKE_PHASE_ENV = 'PACT_PACKAGE_SMOKE_PHASE'
const PACKAGE_SMOKE_USER_DATA_ENV = 'PACT_PACKAGE_SMOKE_USER_DATA'
const PACKAGE_SMOKE_PASS_MARKER = 'PACT_PACKAGE_SMOKE:PASS'
const PACKAGE_SMOKE_TIMEOUT_MS = 30_000
const PACKAGE_REAL_CORE_TIMEOUT_MS = 600_000
const PACKAGE_SMOKE_KILL_GRACE_MS = 5_000
const MAX_LOG_LENGTH = 16_000
const repositoryRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const releaseRoot = join(repositoryRoot, 'apps/desktop/release')

async function pathExists(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findPackagedExecutable(local) {
  const identity = identities[local ? 'production-local' : 'production-ci']
  const selectedReleaseRoot = join(releaseRoot, identity.outputDirectory)
  if (process.platform === 'darwin') {
    const executable = join(
      selectedReleaseRoot,
      `mac-${process.arch}`,
      `${identity.name}.app`,
      'Contents',
      'MacOS',
      identity.name,
    )
    if (await pathExists(executable)) return executable
  }

  if (process.platform === 'win32') {
    const executable = join(selectedReleaseRoot, 'win-unpacked', `${identity.name}.exe`)
    if (await pathExists(executable)) return executable
  }

  throw new Error(`No packaged Pact executable found for ${process.platform}-${process.arch}.`)
}

function appendLog(current, chunk) {
  return `${current}${chunk}`.slice(-MAX_LOG_LENGTH)
}

/** The launcher owns one process group, two bounded pipes and its deadline until close. */
async function runPackagedProcess(executable, environment, phase, spawnProcess, redact, timeoutMs) {
  await new Promise((resolve, reject) => {
    const child = spawnProcess(executable, [], {
      cwd: dirname(executable),
      env: environment,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    let timedOut = false
    let cancelled = false
    let startupError
    let forceKillTimer

    const signalOwnedProcess = (signal) => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal)
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      } else if (child.exitCode === null && !child.signalCode) child.kill(signal)
    }
    const stop = () => {
      signalOwnedProcess('SIGTERM')
      forceKillTimer = setTimeout(() => {
        signalOwnedProcess('SIGKILL')
      }, PACKAGE_SMOKE_KILL_GRACE_MS)
    }
    const onInterrupt = () => {
      if (cancelled || timedOut) return
      cancelled = true
      stop()
    }
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onInterrupt)
    const timeout = setTimeout(
      () => {
        if (cancelled) return
        timedOut = true
        stop()
      },
      timeoutMs ?? (phase ? PACKAGE_SMOKE_TIMEOUT_MS : PACKAGE_REAL_CORE_TIMEOUT_MS),
    )

    child.stdout.on('data', (chunk) => {
      output = appendLog(output, chunk)
    })
    child.stderr.on('data', (chunk) => {
      output = appendLog(output, chunk)
    })
    child.once('error', (error) => {
      startupError = error
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onInterrupt)

      if (startupError) {
        reject(new Error(`Packaged process failed to start (${startupError.code ?? 'unknown'}).`))
        return
      }
      if (
        !timedOut &&
        !cancelled &&
        exitCode === 0 &&
        (!phase || output.includes(PACKAGE_SMOKE_PASS_MARKER))
      ) {
        resolve()
        return
      }

      const termination = cancelled
        ? 'cancelled'
        : timedOut
          ? 'timed out'
          : `exited with code ${exitCode ?? 'null'}`
      reject(
        new Error(
          `Packaged ${phase ? 'smoke' : 'core inspection'} ${termination} (signal: ${signal ?? 'none'}).\n${redact(output)}`,
        ),
      )
    })
  })
}

/** UI smoke never loads model credentials; real core inspection fails before launch without them. */
export async function main({
  executable,
  sourceEnvironment = process.env,
  realCore = false,
  local = false,
  spawnProcess = spawn,
} = {}) {
  const selectedExecutable = executable ?? (await findPackagedExecutable(local))
  const config = realCore
    ? await loadProviderConfiguration(undefined, sourceEnvironment)
    : undefined
  const requestedRoot = await mkdtemp(join(tmpdir(), 'pact-package-smoke-'))
  try {
    const root = await realpath(requestedRoot)
    const prepared = await prepareProviderEnvironment(root, config, sourceEnvironment)
    await mkdir(join(root, 'logs', 'production'), { recursive: true, mode: 0o700 })
    const environment = { ...prepared.env, PACT_E2E_ROOT: root }
    if (realCore) {
      const projectDirectory = join(root, 'project')
      await mkdir(projectDirectory, { mode: 0o700 })
      console.log(
        'Isolated packaged core inspection started. Verify both Agents, tools and restart recovery in the native UI; quit Pact when finished. This launcher does not mark business scenarios passed.',
      )
      console.log(`Test CLI paths: Claude=${config.claudePath}; Codex=${config.codexPath}`)
      console.log(`Add this owned test Project in Pact: ${projectDirectory}`)
      const deadline = Date.now() + PACKAGE_REAL_CORE_TIMEOUT_MS
      await runPackagedProcess(
        selectedExecutable,
        environment,
        undefined,
        spawnProcess,
        (text) => config.redact(text),
        Math.max(1, deadline - Date.now()),
      )
      console.log(
        'Restarting the same isolated packaged profile. Verify the saved messages, Native identities and recovery, then quit Pact again.',
      )
      await runPackagedProcess(
        selectedExecutable,
        environment,
        undefined,
        spawnProcess,
        (text) => config.redact(text),
        Math.max(1, deadline - Date.now()),
      )
      await config.assertSourceIntegrity()
      console.log(
        'Packaged core inspection closed; record the actual business verification separately.',
      )
    } else {
      const smokeEnvironment = {
        ...environment,
        [PACKAGE_SMOKE_ENV]: '1',
        [PACKAGE_SMOKE_USER_DATA_ENV]: prepared.userDataDirectory,
      }
      await runPackagedProcess(
        selectedExecutable,
        {
          ...smokeEnvironment,
          [PACKAGE_SMOKE_PHASE_ENV]: 'seed',
        },
        'seed',
        spawnProcess,
        (text) => text,
      )
      await runPackagedProcess(
        selectedExecutable,
        {
          ...smokeEnvironment,
          [PACKAGE_SMOKE_PHASE_ENV]: 'verify',
        },
        'verify',
        spawnProcess,
        (text) => text,
      )
      console.log(`Packaged smoke passed: ${selectedExecutable}`)
    }
  } finally {
    await rm(requestedRoot, { force: true, recursive: true })
  }
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void Promise.resolve()
    .then(() => {
      if (
        process.argv.slice(2).some((argument) => !['--real-core', '--local'].includes(argument))
      ) {
        throw new Error('Supported packaged invocation: package-smoke.mjs [--real-core] [--local]')
      }
      return main({
        realCore: process.argv.includes('--real-core'),
        local: process.argv.includes('--local'),
      })
    })
    .catch((error) => {
      console.error('Packaged smoke failed.', error)
      process.exitCode = 1
    })
}
