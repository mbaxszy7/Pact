import { mkdir, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { applicationContent } from './build-distribution.mjs'
import { ciEnvironment } from './ci.mjs'
import { prepareApplication, readDistributionManifest } from './package-smoke.mjs'
import { run } from './run-e2e.mjs'
import { isScriptEntry } from './script-entry.mjs'
import { evaluateSoak } from './soak-statistics.mjs'

export function soakArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    if (
      !['--manifest', '--duration-ms', '--report'].includes(key) ||
      !args[index + 1] ||
      values[key]
    )
      throw new Error('Soak requires unique manifest, duration-ms and report arguments')
    values[key] = args[index + 1]
  }
  const durationMs = Number(values['--duration-ms'])
  if (
    !values['--manifest'] ||
    !values['--report'] ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1000 ||
    durationMs > 7_200_000
  )
    throw new Error(
      'Soak duration must be between one second and two hours; acceptance requires at least one hour',
    )
  return {
    manifestPath: resolve(values['--manifest']),
    reportPath: resolve(values['--report']),
    durationMs,
  }
}

export async function main(args = process.argv.slice(2), source = process.env) {
  const { manifestPath, reportPath, durationMs } = soakArguments(args)
  try {
    await lstat(reportPath)
    throw new Error('An existing soak report cannot be overwritten')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const manifest = await readDistributionManifest(manifestPath)
  const root = await mkdtemp(join(source.RUNNER_TEMP ?? tmpdir(), 'pact-soak-'))
  let application,
    workerState,
    evidence = {
      durationMs: 0,
      cleanupVerified: false,
      resourceLifecycleVerified: false,
      recoveryVerified: false,
      missingObservations: ['driver-did-not-complete'],
    }
  let problem
  try {
    application = await prepareApplication({
      manifest,
      manifestPath,
      root,
      environment: ciEnvironment(source),
      unpacked: false,
    })
    if (!application.installationVerified)
      throw new Error('A packaged soak requires an actual installation or artifact extraction')
    const dataRoot = join(root, 'fixture')
    await mkdir(dataRoot, { mode: 0o700 })
    const settings = join(root, 'settings.json'),
      observation = join(root, 'observations.json')
    await writeFile(
      settings,
      JSON.stringify({
        schemaVersion: 1,
        dataRoot,
        executable: application.executable,
        observation,
        durationMs,
        manifest: {
          sourceSha: manifest.sourceSha,
          version: manifest.version,
          channel: manifest.channel,
          platform: manifest.platform,
          arch: manifest.arch,
        },
      }),
      { flag: 'wx', mode: 0o600 },
    )
    const code = await run(
      [
        '--experimental-transform-types',
        '--import',
        join(import.meta.dirname, 'soak-module-loader.mjs'),
        join(import.meta.dirname, 'soak-driver.mjs'),
        settings,
      ],
      durationMs + 10 * 60_000,
      {
        executable: process.execPath,
        cwd: resolve(import.meta.dirname, '..'),
        env: ciEnvironment(source),
        onState: (state) => {
          workerState = state
        },
      },
    )
    const info = await lstat(observation)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 768 * 1024)
      throw new Error('Soak observation record exceeds its private byte bound')
    evidence = JSON.parse(await readFile(observation, 'utf8'))
    if (code !== 0) problem = 'The continuous driver or its verified process ownership failed'
    const content = await applicationContent(application.applicationPath, manifest.platform, {
      allowedExtraFiles:
        manifest.platform === 'win32' ? [`Uninstall ${manifest.productName}.exe`] : [],
    })
    if (
      content.sha256 !== manifest.application.contentSha256 ||
      JSON.stringify(content.entries) !== JSON.stringify(manifest.application.entries)
    )
      throw new Error('The installed application content changed during soak')
  } catch {
    problem = 'Packaged soak preparation, continuous observation or identity verification failed'
  } finally {
    try {
      await application?.dispose()
    } catch {
      problem = 'Packaged soak installer cleanup could not be confirmed'
    }
    const processesReleased = workerState?.groupGone === true && workerState.ownedProcessCount === 0
    if (processesReleased || !workerState) {
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
      } catch {
        problem = 'Packaged soak temporary data cleanup could not be confirmed'
      }
    } else problem = 'Unconfirmed owned processes retain their private recovery directory'
    try {
      await lstat(root)
      evidence.cleanupVerified = false
    } catch (error) {
      evidence.cleanupVerified =
        error.code === 'ENOENT' && Object.is(evidence.cleanupVerified, true) && processesReleased
    }
  }
  const budgets = evaluateSoak(evidence, durationMs)
  const report = {
    ...evidence,
    ...budgets,
    schemaVersion: 1,
    status: !problem && budgets.budgetPass ? 'passed' : 'blocked',
    sourceSha: manifest.sourceSha,
    version: manifest.version,
    channel: manifest.channel,
    platform: manifest.platform,
    arch: manifest.arch,
    appContentHash: manifest.application.contentSha256,
    artifacts: manifest.artifacts,
    installationVerified: application?.installationVerified === true,
    verificationMode: application?.verificationMode ?? 'unconfirmed',
    requestedDurationMs: durationMs,
    ...(problem ? { failure: problem } : {}),
  }
  const bytes = JSON.stringify(report, null, 2) + '\n'
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('Soak report exceeds 1 MiB')
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, bytes, { flag: 'wx', mode: 0o600 })
  if (report.status !== 'passed')
    throw new Error(
      'Packaged soak lacks complete passing duration, performance or resource evidence; inspect its bounded report',
    )
  return report
}

if (isScriptEntry(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
