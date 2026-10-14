import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'

import {
  loadProviderConfiguration,
  prepareProviderEnvironment,
} from '../tests/e2e/provider-environment.ts'
import { applicationContent, hashFile } from './build-distribution.mjs'
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
  const installedArtifact = { ...selected }
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
  const dispose = async () => {
    if (await pathExists(uninstaller)) {
      const exit = await run(['/S'], 120_000, {
        executable: uninstaller,
        cwd: destination,
        env: environment,
        write: () => {},
      })
      if (exit !== 0) throw new Error(`Owned NSIS uninstall failed with exit code ${exit}.`)
      if (await pathExists(uninstaller))
        throw new Error('Owned NSIS uninstaller did not remove the installation.')
    }
  }
  try {
    const exit = await run(['/S', `/D=${destination}`], 120_000, {
      executable: artifact,
      cwd: dirname(artifact),
      env: environment,
      write: () => {},
    })
    if (exit !== 0) throw new Error(`Owned NSIS installation failed with exit code ${exit}.`)
    if (!(await pathExists(uninstaller)))
      throw new Error('NSIS did not install its owned uninstaller.')
    return {
      applicationPath: destination,
      executable: await verifyApplication(destination, manifest, true),
      artifact: installedArtifact,
      verificationMode: 'installed-nsis',
      installationVerified: true,
      dispose,
    }
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
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

async function runOwnedPackagedProcess(executable, environment, phase, redact, timeoutMs) {
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
  manifestPath,
  applicationPath,
  artifactPath,
  reportPath,
  unpacked = false,
  productionPaths = false,
  sourceEnvironment = process.env,
  realCore = false,
  spawnProcess = spawn,
} = {}) {
  const config = realCore
    ? await loadProviderConfiguration(undefined, sourceEnvironment)
    : undefined
  const manifest = manifestPath
    ? await readDistributionManifest(resolvePath(manifestPath))
    : undefined
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
  const requestedRoot = await mkdtemp(join(tmpdir(), 'pact-package-smoke-'))
  let application
  let pendingReport
  let preserveRoot = false
  let providerHomes = []
  const cleanup = async () => {
    try {
      await application?.dispose()
    } catch (error) {
      preserveRoot = true
      throw new Error(
        `Packaged installation cleanup failed; recovery is preserved at ${requestedRoot}.`,
        { cause: error },
      )
    } finally {
      await Promise.all(providerHomes.map((path) => rm(path, { force: true, recursive: true })))
      if (!preserveRoot) await rm(requestedRoot, { force: true, recursive: true })
    }
  }
  try {
    const root = await realpath(requestedRoot)
    const prepared = await prepareProviderEnvironment(root, config, sourceEnvironment)
    providerHomes = [prepared.claudeHome, prepared.codexHome]
    await mkdir(join(root, 'logs', 'production'), { recursive: true, mode: 0o700 })
    const environment = { ...prepared.env, PACT_E2E_ROOT: root }
    application = manifest
      ? await prepareApplication({
          manifest,
          manifestPath: resolvePath(manifestPath),
          applicationPath,
          artifactPath,
          unpacked,
          root,
          environment,
        })
      : undefined
    const selectedExecutable = application?.executable ?? executable
    if (!selectedExecutable) throw new Error('No explicit packaged executable was supplied.')
    const launch =
      spawnProcess === spawn
        ? (selected, env, phase, _spawn, redact, timeout) =>
            runOwnedPackagedProcess(selected, env, phase, redact, timeout)
        : runPackagedProcess
    if (realCore) {
      const projectDirectory = join(root, 'project')
      await mkdir(projectDirectory, { mode: 0o700 })
      console.log(
        'Isolated packaged core inspection started. Verify both Agents, tools and restart recovery in the native UI; quit Pact when finished. This launcher does not mark business scenarios passed.',
      )
      console.log(`Test CLI paths: Claude=${config.claudePath}; Codex=${config.codexPath}`)
      console.log(`Add this owned test Project in Pact: ${projectDirectory}`)
      const deadline = Date.now() + PACKAGE_REAL_CORE_TIMEOUT_MS
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
      await launch(
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
          const productionIdentity = await runOwnedPackagedProcess(
            selectedExecutable,
            {
              ...nativeEnvironment,
              [PACKAGE_SMOKE_ENV]: '1',
              [PACKAGE_SMOKE_PHASE_ENV]: 'production-paths',
              PACT_PACKAGE_EXPECTED_IDENTITY: smokeEnvironment.PACT_PACKAGE_EXPECTED_IDENTITY,
            },
            'production-paths',
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
      console.log(`Packaged smoke passed: ${selectedExecutable}`)
    }
  } catch (error) {
    preserveRoot = error?.preserveRoot === true
    throw error
  } finally {
    await cleanup()
  }
  if (pendingReport && reportPath) {
    await writeFile(
      resolvePath(reportPath),
      `${JSON.stringify({ ...pendingReport, cleanupVerified: true }, null, 2)}\n`,
      { flag: 'wx' },
    )
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
    .catch((error) => {
      console.error(`Packaged smoke failed: ${error.message}`)
      process.exitCode = 1
    })
}
