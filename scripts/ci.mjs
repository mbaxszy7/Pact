import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  readdir,
  mkdtemp,
  writeFile,
  appendFile,
  rm,
  mkdir,
  lstat,
  open,
  realpath,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, isAbsolute } from 'node:path'

import { loadProviderConfiguration } from '../tests/e2e/provider-environment.ts'
import { writeNativeReport } from './ci-native-report.mjs'
import { requireRealScope } from './real-e2e-policy.mjs'
import { run, runNaturally as runCiE2EJob } from './run-e2e.mjs'
import { isScriptEntry } from './script-entry.mjs'

const root = resolve(import.meta.dirname, '..')
const systemKeys = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'USER',
  'LOGNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'SYSTEMROOT',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'CI',
  'GITHUB_ACTIONS',
  'RUNNER_ENVIRONMENT',
  'RUNNER_TEMP',
  'PNPM_HOME',
  'npm_execpath',
  'PACT_E2E_POWERSHELL_EXECUTABLE',
  'PACT_E2E_CLAUDE_EXECUTABLE',
  'PACT_E2E_CODEX_EXECUTABLE',
  'PACT_NATIVE_CLAUDE_EXECUTABLE',
  'PACT_NATIVE_CODEX_EXECUTABLE',
  'PACT_NATIVE_CODEX_PACKAGE_ROOT',
  'PACT_GITLEAKS_EXECUTABLE',
]

/** CI admits only system and selected CLI paths, never the runner's credential environment. */
export function ciEnvironment(source) {
  const environment = {}
  let bytes = 0
  for (const key of systemKeys) {
    const value = source[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.includes('\0'))
      throw new Error('Invalid CI system environment')
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value)
    environment[key] = value
  }
  if (bytes > 64 * 1024) throw new Error('CI system environment exceeds 64 KiB')
  return environment
}

async function pnpm(args, env, deadline = 20 * 60_000, redact, cwd = root) {
  const code = await run(args, deadline, { cwd, env, redact })
  if (code !== 0) throw new Error('Required CI command failed')
}

export async function scriptTests(workspace = root) {
  const files = (await readdir(join(workspace, 'scripts')))
    .filter((name) => name.endsWith('.test.mjs'))
    .toSorted()
  if (files.length === 0 || files.length > 128) throw new Error('Invalid script test inventory')
  if (files.some((name) => !/^[a-z0-9._-]+\.test\.mjs$/iu.test(name)))
    throw new Error('Invalid script test path')
  return files.map((name) => `scripts/${name}`)
}

export async function evidenceEnvironment(lane, env, source) {
  const directory = source.PACT_CI_EVIDENCE_DIR
  if (!directory) return { env, forwarded: [] }
  if (
    !['ui', 'deterministic', 'real'].includes(lane) ||
    !isAbsolute(directory) ||
    Buffer.byteLength(directory) > 4096 ||
    /[\r\n\0]/u.test(directory)
  )
    throw new Error('CI evidence needs an explicit bounded private directory')
  const path = join(directory, `${lane}.json`)
  const outputDir = ['ui', 'deterministic'].includes(lane)
    ? join(directory, lane, 'test-results')
    : undefined
  if ([path, outputDir].some((value) => value && Buffer.byteLength(value) > 4096))
    throw new Error('CI evidence paths exceed their byte bound')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const rootInfo = await lstat(directory)
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      ((rootInfo.mode & 0o077) !== 0 || (process.getuid && rootInfo.uid !== process.getuid())))
  )
    throw new Error('CI evidence must use a regular private directory')
  try {
    await lstat(path)
    throw new Error('Existing E2E execution evidence cannot be overwritten')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (outputDir) {
    const laneDirectory = join(directory, lane)
    // Playwright clears only this lane's disposable output, never another lane's evidence.
    // An occupied lane directory retains its recovery value and is never replaced.
    await mkdir(laneDirectory, { mode: 0o700 })
  }
  return {
    env: {
      ...env,
      PLAYWRIGHT_JSON_OUTPUT_FILE: path,
      ...(outputDir ? { PACT_E2E_OUTPUT_DIR: outputDir } : {}),
    },
    forwarded: ['--reporter=line,json'],
    path,
  }
}

/** A named file carries explicit native auth across the CI/Playwright process boundary. */
export async function readCiProviderConfiguration(source = process.env) {
  const path = source.PACT_E2E_PROVIDER_ENV_FILE
  if (path === undefined) return loadProviderConfiguration(undefined, source)
  if (!isAbsolute(path) || !source.PACT_E2E_ENV_DIR || !isAbsolute(source.PACT_E2E_ENV_DIR))
    throw new Error('Explicit CI Provider environment needs its private configuration root')
  const directory = await realpath(source.PACT_E2E_ENV_DIR)
  if ((await realpath(path)) !== join(directory, 'provider-environment.json'))
    throw new Error('Explicit Provider environment escapes its configuration root')
  const rootInfo = await lstat(directory),
    fileInfo = await lstat(path)
  if (
    !rootInfo.isDirectory() ||
    !fileInfo.isFile() ||
    fileInfo.isSymbolicLink() ||
    fileInfo.size > 64 * 1024 ||
    (process.platform !== 'win32' &&
      ((rootInfo.mode & 0o077) !== 0 ||
        (fileInfo.mode & 0o077) !== 0 ||
        (process.getuid &&
          (rootInfo.uid !== process.getuid() || fileInfo.uid !== process.getuid()))))
  )
    throw new Error('Explicit Provider environment must be a private owned file')
  const read = async () => {
    const descriptor = await open(
      path,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    )
    try {
      const info = await descriptor.stat()
      if (
        !info.isFile() ||
        info.dev !== fileInfo.dev ||
        info.ino !== fileInfo.ino ||
        info.size > 64 * 1024
      )
        throw new Error('Explicit Provider environment identity changed')
      const buffer = Buffer.alloc(64 * 1024 + 1)
      let length = 0
      while (length < buffer.length) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Complete bounded positional reads to EOF rather than admitting a partial secret map.
        const { bytesRead } = await descriptor.read(buffer, length, buffer.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > 64 * 1024 || length !== info.size)
        throw new Error('Explicit Provider environment is incomplete or exceeds 64 KiB')
      return buffer.subarray(0, length)
    } finally {
      await descriptor.close()
    }
  }
  const bytes = await read(),
    digest = createHash('sha256').update(bytes).digest('hex')
  let environment
  try {
    environment = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('Explicit Provider environment is not valid JSON')
  }
  if (
    !environment ||
    typeof environment !== 'object' ||
    Array.isArray(environment) ||
    Object.keys(environment).length > 128
  )
    throw new Error('Explicit Provider environment has an invalid shape')
  const configuration = await loadProviderConfiguration(directory, source, environment)
  const originalIntegrity = configuration.assertSourceIntegrity.bind(configuration)
  configuration.assertSourceIntegrity = async () => {
    await originalIntegrity()
    if (
      createHash('sha256')
        .update(await read())
        .digest('hex') !== digest
    )
      throw new Error('Explicit Provider environment changed during execution')
  }
  return configuration
}

async function validateEvidence(path) {
  if (!path) return
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 8 * 1024 * 1024)
    throw new Error('E2E execution evidence is missing or exceeds 8 MiB')
}

/** Exit 1 is an assertion outcome only after natural, verified supervisor settlement. */
export { runCiE2EJob }

async function real(env, source, workspace, evidence, validateOnly = false, scope = 'full') {
  const parent = source.RUNNER_TEMP ?? tmpdir()
  const outputPath = source.GITHUB_OUTPUT
  const directory = await mkdtemp(join(parent, 'pact-ci-provider-'))
  let configuration
  let completedCode
  try {
    await Promise.all(
      ['claude', 'codex'].map((name) => mkdir(join(directory, name), { mode: 0o700 })),
    )
    const sources = [
      ['claude/settings.json', source.PACT_CLAUDE_SETTINGS_JSON],
      ['codex/config.toml', source.PACT_CODEX_CONFIG_TOML],
      ['codex/auth.json', source.PACT_CODEX_AUTH_JSON],
    ]
    let total = 0
    for (const [path, bytes] of sources) {
      if (typeof bytes !== 'string' || !bytes || Buffer.byteLength(bytes) > 256 * 1024)
        throw new Error('Missing or oversized CI provider configuration secret')
      total += Buffer.byteLength(bytes)
      if (total > 768 * 1024) throw new Error('CI provider configuration exceeds 768 KiB')
      // oxlint-disable-next-line eslint/no-await-in-loop -- Three private files are admitted before any model starts.
      await writeFile(join(directory, path), bytes, { mode: 0o600, flag: 'wx' })
    }
    const providerBytes = source.PACT_CODEX_PROVIDER_ENV_JSON || '{}'
    if (Buffer.byteLength(providerBytes) > 64 * 1024)
      throw new Error('Explicit Provider environment exceeds 64 KiB')
    const environmentPath = join(directory, 'provider-environment.json')
    await writeFile(environmentPath, providerBytes, { flag: 'wx', mode: 0o600 })
    const selected = {
      ...env,
      PACT_E2E_ENV_DIR: directory,
      PACT_E2E_PROVIDER_ENV_FILE: environmentPath,
    }
    configuration = await readCiProviderConfiguration(selected)
    if (validateOnly) {
      await configuration.assertSourceIntegrity()
      return
    }
    // Pass the admitted environment explicitly; arbitrary job env is never native auth.
    const { main: runE2E } = await import('./run-e2e.mjs')
    const previous = { ...process.env }
    try {
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(process.env, selected)
      const code = await runE2E({
        lane: 'real',
        realScope: scope,
        forwarded: evidence.forwarded,
        loadConfiguration: async () => configuration,
        runJob: (args, timeout, options) =>
          runCiE2EJob(args, timeout, { ...options, cwd: workspace, env: selected }),
      })
      await configuration.assertSourceIntegrity()
      await validateEvidence(evidence.path)
      // Playwright's ordinary assertion failure is still a completed execution.
      // A separate report gate decides core/full policy; supervisors or admission
      // errors never emit this marker and cannot be ignored as an extended failure.
      if (![0, 1].includes(code)) throw new Error('Real-provider runner did not complete normally')
      completedCode = code
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(process.env, previous)
    }
    await configuration.assertSourceIntegrity()
    await validateEvidence(evidence.path)
  } catch (error) {
    // oxlint-disable-next-line eslint/preserve-caught-error -- A raw cause can contain provider credentials; expose only the admitted redaction.
    throw new Error(
      configuration
        ? configuration.redact(error.message)
        : 'CI provider admission or execution failed',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  // Cleanup and both integrity checks must finish before the trusted marker exists.
  if (outputPath) await appendFile(outputPath, 'real_execution_completed=true\n')
  if (completedCode !== 0)
    throw new Error('Real-provider cases failed; inspect the sanitized report')
}

export async function main(args = process.argv.slice(2), source = process.env) {
  const env = ciEnvironment(source)
  const workspace = source.PACT_CI_WORKSPACE ?? root
  if (!isAbsolute(workspace)) throw new Error('CI workspace must be absolute')
  const [lane, ...forwarded] = args
  if (lane === 'quality') {
    if (forwarded.length) throw new Error('Quality lane has no extra arguments')
    for (const command of ['docs:check', 'format:check', 'lint', 'db:check', 'typecheck']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Required commands run in order and stop at the first failure.
      await pnpm([command], env, undefined, undefined, workspace)
    }
    // One worker avoids competing large-source fixtures; no deadline or assertion is relaxed.
    await pnpm(['exec', 'vitest', 'run', '--maxWorkers=1'], env, undefined, undefined, workspace)
  } else if (lane === 'infra') {
    const states = [],
      ownership = []
    let code,
      problem,
      failed = true
    try {
      code = await run(
        ['--test', '--test-concurrency=1', ...(await scriptTests(workspace))],
        20 * 60_000,
        {
          executable: process.execPath,
          cwd: workspace,
          env: { ...env, PACT_INFRA_POSIX_OWNED_GROUP_LIMIT: '3' },
          onState(state) {
            if (!['started', 'stopping', 'settled'].includes(state.kind)) return
            states.push(state)
            if (states.length > 8) states.shift()
          },
          onOwnership(observation) {
            ownership.push(observation)
            if (ownership.length > 8) ownership.shift()
          },
        },
      )
      if (code !== 0) throw new Error('Required script tests failed')
      failed = false
    } catch (error) {
      problem = error
    }
    try {
      if (source.PACT_CI_EVIDENCE_DIR) {
        const directory = source.PACT_CI_EVIDENCE_DIR
        if (!isAbsolute(directory)) throw new Error('CI diagnostic directory must be absolute')
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const bytes = JSON.stringify({
          lane,
          status: failed ? 'failed' : 'passed',
          exitCode: code ?? null,
          states,
          ownership,
        })
        if (Buffer.byteLength(bytes) > 768 * 1024)
          throw new Error('CI process evidence exceeds its bound')
        await writeFile(join(directory, 'infra-supervision.json'), bytes, {
          flag: 'wx',
          mode: 0o600,
        })
      }
    } catch (error) {
      problem ??= error
    }
    if (problem) throw problem
  } else if (lane === 'validate-provider') {
    if (forwarded.length) throw new Error('Provider validation has no extra arguments')
    await real(env, source, workspace, {}, true)
  } else if (lane === 'real') {
    if (forwarded.length > 1) throw new Error('Real lane accepts only core or full scope')
    const scope = requireRealScope(forwarded[0] ?? 'full')
    const evidence = await evidenceEnvironment(lane, env, source)
    await real(evidence.env, source, workspace, evidence, false, scope)
  } else if (['ui', 'deterministic'].includes(lane)) {
    const evidence = await evidenceEnvironment(lane, env, source)
    if (forwarded.some((value) => value.startsWith('--reporter')))
      throw new Error('CI evidence owns the test reporter')
    const { main: runE2E } = await import('./run-e2e.mjs')
    const code = await runE2E({
      lane,
      forwarded: [...forwarded, ...evidence.forwarded],
      runJob: (argumentsForJob, timeout, options) =>
        runCiE2EJob(argumentsForJob, timeout, { ...options, cwd: workspace, env: evidence.env }),
    })
    await validateEvidence(evidence.path)
    if (![0, 1].includes(code)) throw new Error('Electron runner did not complete normally')
    if (source.GITHUB_OUTPUT)
      await appendFile(source.GITHUB_OUTPUT, `${lane}_execution_completed=true\n`)
    if (code !== 0) throw new Error('Required Electron E2E lane failed')
  } else if (lane === 'native') {
    if (forwarded.length) throw new Error('Reported native execution owns its reporter arguments')
    const temporaryReport = !source.PACT_CI_NATIVE_REPORT_DIR
    const directory =
      source.PACT_CI_NATIVE_REPORT_DIR ?? (await mkdtemp(join(tmpdir(), 'pact-native-report-')))
    if (
      !isAbsolute(directory) ||
      Buffer.byteLength(directory) > 4096 ||
      /[\r\n\0]/u.test(directory)
    )
      throw new Error('Native reports require a bounded private directory')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Native reports cannot be redirected')
    const rawDirectory = await mkdtemp(join(directory, 'private-'))
    const rawPath = join(rawDirectory, 'execution.json')
    let code,
      problem,
      nativeState,
      reportPreserved = false
    try {
      code = await runCiE2EJob(
        ['test:native', '--reporter=verbose', '--reporter=json', '--outputFile', rawPath],
        20 * 60_000,
        {
          cwd: workspace,
          env,
          onState: (state) => {
            nativeState = state
          },
        },
      )
      if (code !== 0) problem = new Error('Required native protocol cases failed')
    } catch (error) {
      problem = error
    }
    try {
      const written = await writeNativeReport({
        rawPath,
        directory,
        workspace,
        completed: code === 0 || code === 1,
        exitCode: code,
        identityPath: source.PACT_CI_NATIVE_IDENTITY_FILE,
        identityKind: source.PACT_CI_NATIVE_IDENTITY_KIND ?? 'ci',
        artifactName: source.PACT_CI_NATIVE_ARTIFACT,
        summary: source.GITHUB_STEP_SUMMARY,
      })
      reportPreserved = true
      console.info('Safe native E2E report:', join(written.directory, 'native-summary.md'))
      if (written.report.status !== 'passed')
        problem ??= new Error('Required native execution evidence is incomplete or failed')
    } finally {
      // Unconfirmed process ownership retains its private recovery evidence.
      // Raw fixture output is never part of an upload pattern.
      const physicallyReleased =
        !nativeState ||
        (nativeState.kind === 'settled' &&
          nativeState.groupGone === true &&
          nativeState.ownedProcessCount === 0)
      if (physicallyReleased) await rm(rawDirectory, { recursive: true, force: true })
      if (temporaryReport && reportPreserved && physicallyReleased)
        await rm(directory, { recursive: true, force: true })
    }
    if (problem) throw problem
  } else if (['native', 'build'].includes(lane)) {
    const command = {
      native: 'test:native',
      build: 'build',
    }[lane]
    await pnpm([command, ...forwarded], env, 20 * 60_000, undefined, workspace)
  } else throw new Error('Unknown CI lane')
}

if (isScriptEntry(import.meta.url)) {
  main().catch(() => {
    console.error('Required CI lane failed; inspect its bounded, redacted command diagnostics.')
    process.exitCode = 1
  })
}
