import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'

import {
  loadProviderConfiguration,
  prepareProviderEnvironment,
} from '../tests/e2e/provider-environment.ts'
import { applicationContent, hashFile } from './build-distribution.mjs'
import { ciEnvironment } from './ci.mjs'
import { run } from './run-e2e.mjs'
import { isScriptEntry } from './script-entry.mjs'

const PACKAGE_SMOKE_ENV = 'PACT_PACKAGE_SMOKE'
const PACKAGE_SMOKE_PHASE_ENV = 'PACT_PACKAGE_SMOKE_PHASE'
const PACKAGE_SMOKE_USER_DATA_ENV = 'PACT_PACKAGE_SMOKE_USER_DATA'
const PACKAGE_SMOKE_PASS_MARKER = 'PACT_PACKAGE_SMOKE:PASS'
const PACKAGE_SMOKE_TIMEOUT_MS = 30_000
const PACKAGE_REAL_CORE_TIMEOUT_MS = 600_000
const PACKAGE_SMOKE_KILL_GRACE_MS = 5_000
const MAX_LOG_LENGTH = 16_000
const execFileAsync = promisify(execFile)
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

async function pathExists(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveWithin(directory, path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path))
    throw new Error('Distribution path must be a nonempty relative path.')
  const result = resolvePath(directory, path)
  const remainder = relative(directory, result)
  if (
    remainder === '..' ||
    remainder.startsWith('../') ||
    remainder.startsWith('..\\') ||
    isAbsolute(remainder)
  )
    throw new Error('Distribution path escapes its output directory.')
  return result
}

export async function readDistributionManifest(path) {
  if ((await lstat(path)).size > MAX_MANIFEST_BYTES)
    throw new Error('Distribution manifest exceeds its byte bound.')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  const expectedName = manifest.channel === 'dev' ? 'Pact Dev' : 'Pact'
  const expectedId = manifest.channel === 'dev' ? 'com.pact.desktop.dev' : 'com.pact.desktop'
  if (
    manifest.schemaVersion !== 1 ||
    !['dev', 'stable'].includes(manifest.channel) ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    manifest.productName !== expectedName ||
    manifest.appId !== expectedId ||
    typeof manifest.version !== 'string' ||
    manifest.version.length > 128 ||
    !/^\d+\.\d+\.\d+(?:-dev\.\d+\.sha[a-f0-9]{12})?$/u.test(manifest.version) ||
    !/^[a-f0-9]{40}$/u.test(manifest.sourceSha) ||
    !/^\d{1,16}$/u.test(manifest.buildNumber) ||
    !manifest.application ||
    !/^[a-f0-9]{64}$/u.test(manifest.application.contentSha256) ||
    !Array.isArray(manifest.application.entries) ||
    manifest.application.entries.length > 16_384 ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length > 2
  )
    throw new Error('Distribution manifest has invalid identity, schema, or target architecture.')
  resolveWithin(dirname(path), manifest.application.path)
  resolveWithin(
    resolveWithin(dirname(path), manifest.application.path),
    manifest.application.executable,
  )
  for (const artifact of manifest.artifacts) {
    if (
      !['nsis', 'dmg', 'zip'].includes(artifact.kind) ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 1 ||
      typeof artifact.path !== 'string' ||
      artifact.path.length > 255 ||
      /[\r\n\0]/u.test(artifact.path) ||
      basename(artifact.path) !== artifact.path
    )
      throw new Error('Distribution artifact metadata is invalid.')
  }
  return manifest
}

export async function verifyApplication(application, manifest, installed) {
  const extras =
    installed && manifest.platform === 'win32' ? [`Uninstall ${manifest.productName}.exe`] : []
  const content = await applicationContent(application, manifest.platform, {
    allowedExtraFiles: extras,
  })
  if (
    content.sha256 !== manifest.application.contentSha256 ||
    JSON.stringify(content.entries) !== JSON.stringify(manifest.application.entries)
  )
    throw new Error('Installed application content differs from the exact manifest payload.')
  const executable = resolveWithin(application, manifest.application.executable)
  if (!(await pathExists(executable)))
    throw new Error('The explicit packaged executable is missing or not executable.')
  return executable
}

/** The harness owns only an extracted bundle or an installation in an ephemeral Windows runner. */
export async function prepareApplication({
  manifest,
  manifestPath,
  applicationPath,
  artifactPath,
  unpacked,
  root,
  environment,
  facts = { processes: [] },
  runProcess = run,
}) {
  if (unpacked) {
    if (artifactPath) throw new Error('Unpacked validation cannot select an installation artifact.')
    const application = applicationPath
      ? resolvePath(applicationPath)
      : resolveWithin(dirname(manifestPath), manifest.application.path)
    return {
      applicationPath: application,
      executable: await verifyApplication(application, manifest, false),
      verificationMode: 'unpacked',
      installationVerified: false,
      dispose: async () => {},
    }
  }
  if (applicationPath)
    throw new Error(
      'An explicit application directory requires --unpacked; installation evidence requires an artifact.',
    )
  const selected = artifactPath
    ? manifest.artifacts.find(
        (artifact) =>
          resolveWithin(dirname(manifestPath), artifact.path) === resolvePath(artifactPath),
      )
    : manifest.artifacts.find(
        (artifact) => artifact.kind === (process.platform === 'darwin' ? 'dmg' : 'nsis'),
      )
  if (!selected)
    throw new Error('The explicit manifest does not identify the requested installation artifact.')
  const artifact = resolveWithin(dirname(manifestPath), selected.path)
  if (
    (await lstat(artifact)).size !== selected.bytes ||
    (await hashFile(artifact)) !== selected.sha256
  )
    throw new Error('Installation artifact hash or byte count does not match the manifest.')
  const destination = join(root, 'installed')
  await mkdir(destination, { mode: 0o700 })
  const installedArtifact = Object.fromEntries(
    ['path', 'kind', 'sha256', 'bytes'].map((name) => [name, selected[name]]),
  )
  if (process.platform === 'darwin') {
    const application = join(destination, manifest.application.bundleName)
    if (
      basename(manifest.application.bundleName) !== manifest.application.bundleName ||
      !manifest.application.bundleName.endsWith('.app')
    )
      throw new Error('Manifest bundle name is invalid.')
    if (selected.kind === 'dmg') {
      const mount = join(root, 'mount')
      await mkdir(mount, { mode: 0o700 })
      let mounted = false
      const detachMount = async () => {
        try {
          if (!mounted) {
            const information = await execFileAsync('/usr/bin/hdiutil', ['info', '-plist'], {
              shell: false,
              timeout: 10_000,
              maxBuffer: 256 * 1024,
              env: environment,
            })
            const escapedMount = mount
              .replaceAll('&', '&amp;')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;')
            mounted = information.stdout.includes(`<string>${escapedMount}</string>`)
          }
          if (mounted)
            await execFileAsync('/usr/bin/hdiutil', ['detach', mount], {
              shell: false,
              timeout: 30_000,
              maxBuffer: 16_000,
              env: environment,
            })
        } catch (error) {
          throw Object.assign(
            new Error(
              'Owned DMG mount cleanup could not be confirmed; its recovery root is preserved.',
              { cause: error },
            ),
            { preserveRoot: true },
          )
        }
      }
      try {
        await execFileAsync(
          '/usr/bin/hdiutil',
          ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, artifact],
          { shell: false, timeout: 60_000, maxBuffer: 16_000, env: environment },
        )
        mounted = true
        await execFileAsync(
          '/usr/bin/ditto',
          [join(mount, manifest.application.bundleName), application],
          { shell: false, timeout: 60_000, maxBuffer: 16_000, env: environment },
        )
      } finally {
        await detachMount()
      }
    } else if (selected.kind === 'zip') {
      await execFileAsync('/usr/bin/ditto', ['-x', '-k', artifact, destination], {
        shell: false,
        timeout: 60_000,
        maxBuffer: 16_000,
        env: environment,
      })
    } else throw new Error('A macOS smoke requires a DMG or ZIP artifact.')
    return {
      applicationPath: application,
      executable: await verifyApplication(application, manifest, true),
      artifact: installedArtifact,
      verificationMode: selected.kind === 'dmg' ? 'mounted-dmg-copy' : 'extracted-zip',
      installationVerified: true,
      dispose: async () => {},
    }
  }
  if (
    process.platform !== 'win32' ||
    selected.kind !== 'nsis' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    !process.env.RUNNER_TEMP ||
    !isAbsolute(process.env.RUNNER_TEMP)
  )
    throw new Error(
      'TODO: NSIS installation smoke requires an ephemeral native Windows GitHub runner; production installation debugging remains unverified.',
    )
  const uninstaller = join(destination, `Uninstall ${manifest.productName}.exe`)
  let stage = 'installer-run'
  const invokeNsis = async (args, executable, cwd, operation) => {
    const observation = { phase: 'installation', operation, releaseVerified: false }
    facts.processes.push(observation)
    const began = performance.now()
    try {
      const exit = await runProcess(args, 120_000, {
        executable,
        cwd,
        env: environment,
        windowsArgumentMode: 'nsis',
        write: () => {},
        onState: (state) => {
          if (state.kind === 'settled')
            observation.releaseVerified = state.groupGone === true && state.ownedProcessCount === 0
          if (state.kind === 'stopping')
            observation.failureReason = [
              'deadline',
              'cancelled',
              'interrupted-SIGINT',
              'interrupted-SIGTERM',
              'supervisor-error',
              'descendants-still-running',
            ].includes(state.reason)
              ? state.reason
              : 'other'
          if (state.kind === 'stopping' && state.reason === 'deadline') facts.timedOut = true
          if (
            state.kind === 'stopping' &&
            ['cancelled', 'interrupted-SIGINT', 'interrupted-SIGTERM'].includes(state.reason)
          )
            facts.interrupted = true
        },
      })
      if (!observation.releaseVerified) throw new Error('Owned NSIS process release is unconfirmed')
      return exit
    } catch (error) {
      if (!observation.releaseVerified)
        throw Object.assign(
          new Error('Owned NSIS process release is unconfirmed', { cause: error }),
          { preserveRoot: true },
        )
      throw error
    } finally {
      observation.milliseconds = Math.ceil(performance.now() - began)
    }
  }
  const dispose = async () => {
    facts.installationCleanupVerified = false
    try {
      stage = 'uninstaller-check'
      if (await pathExists(uninstaller)) {
        stage = 'uninstall-run'
        const exit = await invokeNsis(['/S'], uninstaller, root, 'uninstall')
        if (exit !== 0) throw new Error(`Owned NSIS uninstall failed with exit code ${exit}.`)
        stage = 'uninstaller-removal'
        if (await pathExists(uninstaller))
          throw new Error('Owned NSIS uninstaller did not remove the installation.')
      } else {
        const remaining = await readdir(destination).catch((error) => {
          if (error.code === 'ENOENT') return []
          throw error
        })
        if (remaining.length) throw new Error('Partial NSIS installation has no owned uninstaller')
      }
      stage = 'installation-removal'
      const remaining = await readdir(destination).catch((error) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      if (remaining.length) throw new Error('Owned NSIS uninstall left installed payload behind')
      facts.installationCleanupVerified = true
    } catch (error) {
      facts.installationCleanupFailureStage = stage
      throw Object.assign(
        new Error('Owned NSIS installation cleanup is unconfirmed', { cause: error }),
        {
          preserveRoot: true,
        },
      )
    }
  }
  try {
    const exit = await invokeNsis(
      ['/S', `/D=${destination}`],
      artifact,
      dirname(artifact),
      'install',
    )
    if (exit !== 0) throw new Error(`Owned NSIS installation failed with exit code ${exit}.`)
    stage = 'uninstaller-check'
    if (!(await pathExists(uninstaller)))
      throw new Error('NSIS did not install its owned uninstaller.')
    stage = 'application-content'
    const executable = await verifyApplication(destination, manifest, true)
    return {
      applicationPath: destination,
      executable,
      artifact: installedArtifact,
      verificationMode: 'installed-nsis',
      installationVerified: true,
      dispose,
    }
  } catch (error) {
    facts.installationFailureStage = stage
    if (error?.preserveRoot === true) throw error
    try {
      await dispose()
    } catch (cleanupError) {
      facts.installationCleanupFailureStage = stage
      throw Object.assign(
        new AggregateError(
          [error, cleanupError],
          'Owned NSIS installation cleanup failed; its recovery root is preserved.',
          { cause: error },
        ),
        { preserveRoot: true },
      )
    }
    throw error
  }
}

async function runOwnedPackagedProcess(executable, environment, phase, redact, timeoutMs, onState) {
  let passed = false
  let identity
  let output = ''
  const exit = await run(
    [],
    timeoutMs ?? (phase ? PACKAGE_SMOKE_TIMEOUT_MS : PACKAGE_REAL_CORE_TIMEOUT_MS),
    {
      executable,
      cwd: dirname(executable),
      env: environment,
      onState,
      redact,
      write: (_channel, text) => {
        output = appendLog(output, text)
        if (text.trim() === PACKAGE_SMOKE_PASS_MARKER) passed = true
        if (text.startsWith('PACT_PACKAGE_IDENTITY:')) {
          if (identity) throw new Error('Packaged process emitted duplicate identities.')
          identity = JSON.parse(text.slice('PACT_PACKAGE_IDENTITY:'.length))
        }
      },
    },
  )
  if (exit !== 0) {
    const summary = output.match(/^PACT_PACKAGE_SMOKE:FAIL ([^\r\n]{1,512})/mu)?.[1]
    throw new Error(
      `Packaged ${phase ?? 'core inspection'} exited with code ${exit}.${summary ? ` ${redact(summary)}` : ''}`,
    )
  }
  if (phase && (!passed || !identity))
    throw new Error(
      `Packaged ${phase} omitted required runtime identity or PASS evidence.\n${redact(output)}`,
    )
  return identity
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
        Object.assign(
          new Error(
            `Packaged ${phase ? 'smoke' : 'core inspection'} ${termination} (signal: ${signal ?? 'none'}).\n${redact(output)}`,
          ),
          { packageSmokeOutcome: cancelled ? 'interrupted' : timedOut ? 'timed-out' : 'failed' },
        ),
      )
    })
  })
}

const smokePhases = new Set([
  'configuration',
  'manifest',
  'admission',
  'environment',
  'installation',
  'seed',
  'verify',
  'content',
  'production-paths',
  'real-core',
  'real-core-restart',
  'source-integrity',
  'cleanup',
  'report',
])

/** Fixed metadata only; errors, paths and optional package fields never enter reports. */
export function packageSmokeFailureReport(facts) {
  const identity = facts.manifest
  const projection = identity
    ? Object.fromEntries(
        ['sourceSha', 'version', 'channel', 'platform', 'arch', 'appId', 'productName'].map(
          (name) => [name, identity[name]],
        ),
      )
    : {}
  const processes = facts.processes.map((item) => ({
    phase: smokePhases.has(item.phase) ? item.phase : 'admission',
    releaseVerified: item.releaseVerified === true,
    ...(['install', 'uninstall'].includes(item.operation) ? { operation: item.operation } : {}),
    ...(Number.isSafeInteger(item.milliseconds) &&
    item.milliseconds >= 0 &&
    item.milliseconds <= 1_000_000_000
      ? { milliseconds: item.milliseconds }
      : {}),
    ...([
      'deadline',
      'cancelled',
      'interrupted-SIGINT',
      'interrupted-SIGTERM',
      'supervisor-error',
      'descendants-still-running',
      'other',
    ].includes(item.failureReason)
      ? { failureReason: item.failureReason }
      : {}),
  }))
  const processReleaseVerified = processes.every((item) => item.releaseVerified)
  return {
    schemaVersion: 1,
    status: 'blocked',
    ...projection,
    ...(identity ? { appContentHash: identity.application.contentSha256 } : {}),
    manifestIdentityVerified: Boolean(identity),
    applicationContentVerified: facts.applicationContentVerified === true,
    runtimeIdentityVerified: facts.runtimeIdentityVerified === true,
    installationVerified: facts.installationVerified === true,
    verificationMode: ['unpacked', 'mounted-dmg-copy', 'extracted-zip', 'installed-nsis'].includes(
      facts.verificationMode,
    )
      ? facts.verificationMode
      : 'unconfirmed',
    failurePhase: smokePhases.has(facts.failurePhase ?? facts.phase)
      ? (facts.failurePhase ?? facts.phase)
      : 'admission',
    failureCode:
      facts.cleanupFailed === true
        ? 'CLEANUP_UNCONFIRMED'
        : facts.interrupted === true
          ? 'EXECUTION_INTERRUPTED'
          : facts.timedOut === true
            ? 'EXECUTION_TIMED_OUT'
            : 'VERIFICATION_FAILED',
    ...Object.fromEntries(
      [
        'installationFailureStage',
        'installationCleanupFailureStage',
        'cleanupFailureStage',
      ].flatMap((key) =>
        [
          'installer-run',
          'uninstaller-check',
          'application-content',
          'uninstall-run',
          'uninstaller-removal',
          'installation-removal',
          'private-root-removal',
          'provider-copies',
          'process-release',
        ].includes(facts[key])
          ? [[key, facts[key]]]
          : [],
      ),
    ),
    ...([
      'HOST_ENVIRONMENT_BOUNDS',
      'OWNED_DIRECTORY_IDENTITY',
      'FILESYSTEM_ACCESS',
      'ENVIRONMENT_PREPARATION',
    ].includes(facts.environmentFailure)
      ? { environmentFailure: facts.environmentFailure }
      : {}),
    processes,
    processReleaseVerified,
    installationCleanupVerified: facts.installationCleanupVerified === true,
    providerCopiesCleanupVerified: facts.providerCopiesCleanupVerified === true,
    privateRootCreated: facts.privateRootCreated === true,
    privateRootCleanupVerified: facts.privateRootCleanupVerified === true,
    recoveryPreserved: facts.recoveryPreserved === true,
    cleanupVerified:
      processReleaseVerified &&
      facts.installationCleanupVerified === true &&
      facts.providerCopiesCleanupVerified === true &&
      facts.privateRootCleanupVerified === true,
  }
}

async function writeSmokeReport(path, report) {
  const file = resolvePath(path)
  if (Buffer.byteLength(file) > 4096 || /[\r\n\0]/u.test(file))
    throw new Error('Invalid packaged report destination')
  const bytes = `${JSON.stringify(report, null, 2)}\n`
  if (Buffer.byteLength(bytes) > 16 * 1024)
    throw new Error('Packaged report exceeds its fixed byte bound')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const parent = await lstat(dirname(file))
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error('Packaged report destination cannot be redirected')
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
}

/** UI smoke never loads model credentials; real core inspection fails before launch without them. */
async function performPackagedSmoke(
  {
    executable,
    manifestPath,
    applicationPath,
    artifactPath,
    reportPath,
    unpacked = false,
    productionPaths = false,
    sourceEnvironment = process.env,
    realCore = false,
    spawnProcess = spawn,
  } = {},
  facts,
) {
  const config = realCore
    ? await loadProviderConfiguration(undefined, sourceEnvironment)
    : undefined
  facts.phase = 'manifest'
  const manifest = manifestPath
    ? await readDistributionManifest(resolvePath(manifestPath))
    : undefined
  facts.manifest = manifest
  facts.phase = 'admission'
  if (!manifest && spawnProcess === spawn)
    throw new Error(
      'Packaged launch requires --manifest <exact distribution-manifest.json>; no package paths are guessed.',
    )
  if (manifest && executable)
    throw new Error(
      'Use the manifest application or installation artifact, rather than an arbitrary executable.',
    )
  if (manifest && spawnProcess !== spawn)
    throw new Error('A distribution verification report requires the genuine owned process runner.')
  if (
    productionPaths &&
    (!manifest || manifest.smokeProtocolVersion !== 2 || spawnProcess !== spawn)
  )
    throw new Error(
      'Production paths require a genuine application with smoke protocol 2; older packages cannot safely serve that probe.',
    )
  facts.phase = 'environment'
  const requestedRoot = await mkdtemp(join(tmpdir(), 'pact-package-smoke-'))
  facts.privateRootCreated = true
  facts.privateRootCleanupVerified = false
  let application
  let pendingReport
  let preserveRoot = false
  let providerHomes = []
  const cleanup = async () => {
    let cleanupError
    const unresolvedProcess =
      spawnProcess === spawn && facts.processes.some((item) => !item.releaseVerified)
    if (unresolvedProcess) {
      facts.cleanupFailureStage = 'process-release'
      preserveRoot = true
      if (application) facts.installationCleanupVerified = false
      cleanupError = new Error('Packaged process release was not confirmed')
    } else {
      try {
        await application?.dispose()
        if (application) facts.installationCleanupVerified = true
      } catch (error) {
        facts.cleanupFailureStage = 'uninstall-run'
        preserveRoot = true
        facts.installationCleanupVerified = false
        cleanupError = error
      }
    }
    const unresolvedAfterCleanup =
      spawnProcess === spawn && facts.processes.some((item) => !item.releaseVerified)
    if (unresolvedAfterCleanup) facts.providerCopiesCleanupVerified = providerHomes.length === 0
    else {
      const providerCleanup = await Promise.allSettled(
        providerHomes.map((path) => rm(path, { force: true, recursive: true })),
      )
      facts.providerCopiesCleanupVerified = providerCleanup.every(
        (item) => item.status === 'fulfilled',
      )
    }
    if (!facts.providerCopiesCleanupVerified) {
      facts.cleanupFailureStage ??= 'provider-copies'
      preserveRoot = true
      cleanupError ??= new Error('Provider copy cleanup was not confirmed')
    }
    if (!preserveRoot) {
      try {
        await rm(requestedRoot, { force: true, recursive: true })
        try {
          await lstat(requestedRoot)
          throw new Error('Packaged private root still exists')
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          facts.privateRootCleanupVerified = true
        }
      } catch (error) {
        facts.cleanupFailureStage ??= 'private-root-removal'
        preserveRoot = true
        cleanupError ??= error
      }
    }
    facts.recoveryPreserved = preserveRoot
    if (cleanupError) {
      facts.cleanupFailed = true
      facts.failurePhase ??= 'cleanup'
      throw new Error('Packaged cleanup could not be confirmed', { cause: cleanupError })
    }
  }
  try {
    facts.phase = 'environment'
    const root = await realpath(requestedRoot)
    const prepared = await prepareProviderEnvironment(root, config, sourceEnvironment)
    providerHomes = [prepared.claudeHome, prepared.codexHome]
    await mkdir(join(root, 'logs', 'production'), { recursive: true, mode: 0o700 })
    const environment = { ...prepared.env, PACT_E2E_ROOT: root }
    facts.phase = 'installation'
    if (manifest) facts.installationCleanupVerified = false
    application = manifest
      ? await prepareApplication({
          manifest,
          manifestPath: resolvePath(manifestPath),
          applicationPath,
          artifactPath,
          unpacked,
          root,
          environment,
          facts,
        })
      : undefined
    facts.installationVerified = application?.installationVerified === true
    facts.verificationMode = application?.verificationMode
    facts.applicationContentVerified = Boolean(application)
    const selectedExecutable = application?.executable ?? executable
    if (!selectedExecutable) throw new Error('No explicit packaged executable was supplied.')
    const launch = async (selected, env, phase, selectedSpawn, redact, timeout) => {
      const observation = { phase: facts.phase, releaseVerified: false }
      facts.processes.push(observation)
      if (spawnProcess !== spawn)
        return runPackagedProcess(selected, env, phase, selectedSpawn, redact, timeout)
      return runOwnedPackagedProcess(selected, env, phase, redact, timeout, (state) => {
        observation.releaseVerified =
          state.kind === 'settled' &&
          state.groupGone === true &&
          state.ownedProcessCount === 0 &&
          state.ownershipEvidenceIncomplete !== true &&
          state.ownershipProbeIncomplete !== true
        if (
          state.kind === 'stopping' &&
          ['interrupted-SIGINT', 'interrupted-SIGTERM', 'cancelled'].includes(state.reason)
        )
          facts.interrupted = true
        if (state.kind === 'stopping' && state.reason === 'deadline') facts.timedOut = true
      })
    }
    if (realCore) {
      const projectDirectory = join(root, 'project')
      await mkdir(projectDirectory, { mode: 0o700 })
      console.log(
        'Isolated packaged core inspection started. Verify both Agents, tools and restart recovery in the native UI; quit Pact when finished. This launcher does not mark business scenarios passed.',
      )
      console.log(`Test CLI paths: Claude=${config.claudePath}; Codex=${config.codexPath}`)
      console.log(`Add this owned test Project in Pact: ${projectDirectory}`)
      const deadline = Date.now() + PACKAGE_REAL_CORE_TIMEOUT_MS
      facts.phase = 'real-core'
      await launch(
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
      facts.phase = 'real-core-restart'
      await launch(
        selectedExecutable,
        environment,
        undefined,
        spawnProcess,
        (text) => config.redact(text),
        Math.max(1, deadline - Date.now()),
      )
      facts.phase = 'source-integrity'
      await config.assertSourceIntegrity()
      console.log(
        'Packaged core inspection closed; record the actual business verification separately.',
      )
    } else {
      const smokeEnvironment = {
        ...environment,
        [PACKAGE_SMOKE_ENV]: '1',
        [PACKAGE_SMOKE_USER_DATA_ENV]: prepared.userDataDirectory,
        ...(manifest
          ? {
              PACT_PACKAGE_EXPECTED_IDENTITY: JSON.stringify({
                channel: manifest.channel,
                productName: manifest.productName,
                appId: manifest.appId,
                version: manifest.version,
                sourceSha: manifest.sourceSha,
                buildNumber: manifest.buildNumber,
                platform: manifest.platform,
                arch: manifest.arch,
                smokeProtocolVersion: manifest.smokeProtocolVersion,
              }),
            }
          : {}),
      }
      facts.phase = 'seed'
      const seededIdentity = await launch(
        selectedExecutable,
        {
          ...smokeEnvironment,
          [PACKAGE_SMOKE_PHASE_ENV]: 'seed',
        },
        'seed',
        spawnProcess,
        (text) => text,
      )
      facts.runtimeIdentityVerified = Boolean(seededIdentity)
      facts.phase = 'verify'
      const verifiedIdentity = await launch(
        selectedExecutable,
        {
          ...smokeEnvironment,
          [PACKAGE_SMOKE_PHASE_ENV]: 'verify',
        },
        'verify',
        spawnProcess,
        (text) => text,
      )
      if (manifest) {
        facts.phase = 'content'
        await verifyApplication(
          application.applicationPath,
          manifest,
          application.installationVerified,
        )
        if (JSON.stringify(seededIdentity) !== JSON.stringify(verifiedIdentity))
          throw new Error(
            'Packaged runtime identity or paths changed between seed and cold verification.',
          )
        let productionDataRootVerified = false
        if (productionPaths) {
          facts.phase = 'production-paths'
          const pureRoot = join(root, 'production-path-probe')
          const pure = await prepareProviderEnvironment(pureRoot, undefined, sourceEnvironment)
          const nativeEnvironment = { ...pure.env }
          for (const key of [
            'HOME',
            'USERPROFILE',
            'HOMEDRIVE',
            'HOMEPATH',
            'APPDATA',
            'LOCALAPPDATA',
            'XDG_CONFIG_HOME',
            'XDG_CACHE_HOME',
            'XDG_DATA_HOME',
            'XDG_STATE_HOME',
            'XDG_RUNTIME_DIR',
          ]) {
            if (sourceEnvironment[key] === undefined) delete nativeEnvironment[key]
            else nativeEnvironment[key] = sourceEnvironment[key]
          }
          const productionIdentity = await launch(
            selectedExecutable,
            {
              ...nativeEnvironment,
              [PACKAGE_SMOKE_ENV]: '1',
              [PACKAGE_SMOKE_PHASE_ENV]: 'production-paths',
              PACT_PACKAGE_EXPECTED_IDENTITY: smokeEnvironment.PACT_PACKAGE_EXPECTED_IDENTITY,
            },
            'production-paths',
            spawnProcess,
            (text) => text,
          )
          if (
            !productionIdentity ||
            productionIdentity.productionDataRootVerified !== true ||
            productionIdentity.sourceSha !== manifest.sourceSha ||
            productionIdentity.version !== manifest.version ||
            productionIdentity.channel !== manifest.channel ||
            productionIdentity.platform !== manifest.platform ||
            productionIdentity.arch !== manifest.arch
          )
            throw new Error('Actual native production data-root identity was not verified.')
          productionDataRootVerified = true
        }
        pendingReport = {
          schemaVersion: 1,
          status: 'passed',
          sourceSha: manifest.sourceSha,
          version: manifest.version,
          channel: manifest.channel,
          platform: manifest.platform,
          arch: manifest.arch,
          appId: manifest.appId,
          productName: manifest.productName,
          appContentHash: manifest.application.contentSha256,
          artifacts: application.artifact ? [application.artifact] : [],
          installationVerified: application.installationVerified,
          verificationMode: application.verificationMode,
          phases: ['seed', 'verify'],
          processOwnership: process.platform === 'win32' ? 'native-job' : 'verified-process-groups',
          defaultChannelPathsVerified: true,
          productionDataRootVerified,
        }
      }
      console.log('Packaged smoke passed.')
    }
  } catch (error) {
    preserveRoot = error?.preserveRoot === true
    facts.failurePhase = facts.phase
    if (preserveRoot) facts.installationCleanupVerified = false
    throw error
  } finally {
    await cleanup()
  }
  if (pendingReport && reportPath) {
    facts.phase = 'report'
    await writeSmokeReport(reportPath, { ...pendingReport, cleanupVerified: true })
  }
}

/** The existing smoke owner publishes failure facts only after its cleanup attempt. */
export async function main(options = {}) {
  // The host may have hundreds of unrelated runner variables. Admit only the existing
  // bounded system/CLI allowlist; explicit library environments keep their strict validation.
  if (options.sourceEnvironment === undefined) {
    const environment = ciEnvironment(process.env)
    if (process.env.PACT_E2E_ENV_DIR !== undefined)
      environment.PACT_E2E_ENV_DIR = process.env.PACT_E2E_ENV_DIR
    options = { ...options, sourceEnvironment: environment }
  }
  if (options.reportPath) {
    const path = resolvePath(options.reportPath)
    if (Buffer.byteLength(path) > 4096 || /[\r\n\0]/u.test(path))
      throw new Error('Invalid packaged report destination')
    try {
      await lstat(path)
      throw Object.assign(new Error('Existing packaged report cannot be overwritten'), {
        code: 'EEXIST',
      })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const facts = {
    phase: 'configuration',
    processes: [],
    installationCleanupVerified: true,
    providerCopiesCleanupVerified: true,
    privateRootCleanupVerified: true,
  }
  try {
    return await performPackagedSmoke(options, facts)
  } catch (error) {
    if (facts.phase === 'environment') {
      facts.environmentFailure =
        error?.message ===
        'E2E provider configuration: input environment exceeds 128 entries or 64 KiB'
          ? 'HOST_ENVIRONMENT_BOUNDS'
          : error?.message ===
              'E2E provider configuration: owned directory resolves through a symlink or is not a directory'
            ? 'OWNED_DIRECTORY_IDENTITY'
            : ['EACCES', 'EPERM'].includes(error?.code)
              ? 'FILESYSTEM_ACCESS'
              : 'ENVIRONMENT_PREPARATION'
    }
    if (error.packageSmokeOutcome === 'interrupted') facts.interrupted = true
    if (error.packageSmokeOutcome === 'timed-out') facts.timedOut = true
    if (options.reportPath) {
      try {
        await writeSmokeReport(options.reportPath, packageSmokeFailureReport(facts))
      } catch (reportError) {
        throw new AggregateError([error, reportError], 'Packaged verification or report failed', {
          cause: reportError,
        })
      }
    }
    throw error
  }
}

if (isScriptEntry(import.meta.url)) {
  void Promise.resolve()
    .then(() => {
      const options = {}
      const names = {
        '--manifest': 'manifestPath',
        '--app': 'applicationPath',
        '--artifact': 'artifactPath',
        '--report': 'reportPath',
      }
      const seen = new Set()
      const args = process.argv.slice(2)
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]
        if (seen.has(argument)) throw new Error(`Duplicate package smoke argument: ${argument}`)
        seen.add(argument)
        if (argument === '--real-core') {
          options.realCore = true
          continue
        }
        if (argument === '--unpacked') {
          options.unpacked = true
          continue
        }
        if (argument === '--production-paths') {
          options.productionPaths = true
          continue
        }
        if (!names[argument] || !args[index + 1] || args[index + 1].startsWith('--'))
          throw new Error(
            'Supported invocation: package-smoke.mjs --manifest <path> [--artifact <path> | --unpacked [--app <path>]] [--report <path>] [--real-core]',
          )
        options[names[argument]] = args[++index]
      }
      return main(options)
    })
    .catch(() => {
      console.error(
        'Packaged smoke failed; inspect the bounded verification report when available.',
      )
      process.exitCode = 1
    })
}
