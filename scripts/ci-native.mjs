import { mkdir, writeFile, appendFile, realpath, lstat, open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

import { ciEnvironment } from './ci.mjs'
import { run } from './run-e2e.mjs'
import { isScriptEntry } from './script-entry.mjs'

const setupFailures = new WeakMap()
const safeErrorClasses = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'AggregateError',
])
const safeErrorCodes = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EEXIST',
  'ENOTDIR',
  'EISDIR',
  'ENOSPC',
  'EINVAL',
  'EBUSY',
  'ENAMETOOLONG',
])

/** Only bounded, fixed classifications may leave this setup's failure boundary. */
export function nativeSetupFailureFacts(error) {
  return setupFailures.get(error) ?? { stage: 'unknown', errorClass: 'unknown', code: 'unknown' }
}

function environmentFilePath(path) {
  return (
    typeof path === 'string' &&
    isAbsolute(path) &&
    Buffer.byteLength(path) <= 4096 &&
    !/[\r\n\0]/u.test(path)
  )
}

async function nativeManifest(path) {
  const descriptor = await open(path, 'r')
  try {
    const info = await descriptor.stat()
    if (!info.isFile() || info.size > 64 * 1024)
      throw new Error('Native package manifest must be a bounded regular file')
    const bytes = Buffer.alloc(64 * 1024 + 1)
    let offset = 0
    while (offset < bytes.length) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Complete bounded file admission.
      const { bytesRead } = await descriptor.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > 64 * 1024) throw new Error('Native package manifest exceeds 64 KiB')
    return JSON.parse(bytes.subarray(0, offset).toString('utf8'))
  } finally {
    await descriptor.close()
  }
}

/** Resolve from the pinned wrapper's own dependency context, including pnpm aliases. */
export async function windowsCodexEntry(directory, arch) {
  if (!environmentFilePath(directory) || !['x64', 'arm64'].includes(arch))
    throw new Error('Invalid Windows Codex package selection')
  const root = await realpath(directory)
  const packageRoot = await realpath(join(root, 'node_modules', '@openai', 'codex'))
  const manifest = await nativeManifest(join(packageRoot, 'package.json'))
  const alias = `@openai/codex-win32-${arch}`
  if (
    manifest.name !== '@openai/codex' ||
    manifest.version !== '0.159.2' ||
    manifest.optionalDependencies?.[alias] !== `npm:@openai/codex@0.159.2-win32-${arch}`
  )
    throw new Error('Windows Codex wrapper identity mismatch')
  const require = createRequire(join(packageRoot, 'package.json'))
  const binaryRoot = await realpath(dirname(require.resolve(`${alias}/package.json`)))
  for (const path of [packageRoot, binaryRoot]) {
    const child = relative(root, path)
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new Error('Windows Codex package escaped its private installation')
  }
  const binaryManifest = await nativeManifest(join(binaryRoot, 'package.json'))
  if (
    binaryManifest.name !== '@openai/codex' ||
    binaryManifest.version !== `0.159.2-win32-${arch}` ||
    JSON.stringify(binaryManifest.os) !== '["win32"]' ||
    JSON.stringify(binaryManifest.cpu) !== JSON.stringify([arch])
  )
    throw new Error('Windows Codex native package identity mismatch')
  const triple = arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc'
  const executable = join(binaryRoot, 'vendor', triple, 'bin', 'codex.exe')
  if ((await realpath(executable)) !== executable || !(await lstat(executable)).isFile())
    throw new Error('Windows Codex requires its exact regular native entry')
  const descriptor = await open(executable, 'r')
  try {
    const info = await descriptor.stat()
    const dos = Buffer.alloc(64)
    if (
      info.size < 88 ||
      info.size > 512 * 1024 * 1024 ||
      (await descriptor.read(dos, 0, 64, 0)).bytesRead !== 64 ||
      dos.toString('ascii', 0, 2) !== 'MZ'
    )
      throw new Error('Invalid Windows Codex image')
    const offset = dos.readUInt32LE(60),
      pe = Buffer.alloc(24)
    if (
      offset < 64 ||
      offset > info.size - 24 ||
      (await descriptor.read(pe, 0, 24, offset)).bytesRead !== 24 ||
      pe.readUInt32LE(0) !== 0x4550 ||
      pe.readUInt16LE(4) !== (arch === 'x64' ? 0x8664 : 0xaa64)
    )
      throw new Error('Windows Codex PE architecture mismatch')
  } finally {
    await descriptor.close()
  }
  return { executable, packageRoot }
}

/** pnpm/action-setup's .bin contains CMD shims; pnpm 12 supplies this sibling native entry. */
export async function windowsPnpmExecutable(source) {
  if (!environmentFilePath(source.PNPM_HOME))
    throw new Error('Windows native CI requires the explicit setup-pnpm directory')
  const executable = await realpath(join(source.PNPM_HOME, '..', 'pnpm', 'pnpm.exe'))
  if (
    !environmentFilePath(executable) ||
    basename(executable).toLowerCase() !== 'pnpm.exe' ||
    !(await lstat(executable)).isFile()
  )
    throw new Error('Windows native CI requires an installed pnpm executable')
  const descriptor = await open(join(dirname(executable), 'package.json'), 'r')
  let manifest
  try {
    const info = await descriptor.stat()
    if (!info.isFile() || info.size > 64 * 1024)
      throw new Error('Installed pnpm manifest must be a bounded regular file')
    const buffer = Buffer.alloc(64 * 1024 + 1)
    let length = 0
    while (length < buffer.length) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Read the entire bounded package manifest rather than a potentially partial prefix.
      const { bytesRead } = await descriptor.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > 64 * 1024) throw new Error('Installed pnpm manifest exceeds 64 KiB')
    manifest = JSON.parse(buffer.subarray(0, length).toString('utf8'))
  } finally {
    await descriptor.close()
  }
  if (
    manifest?.name !== 'pnpm' ||
    manifest.version !== '12.11.2' ||
    manifest.bin?.pnpm !== 'pnpm.exe'
  )
    throw new Error('Windows native CI requires the exact pnpm 12.11.2 native package')
  return executable
}

/** Shared toolchain setup owns PATH admission for every isolated Windows job. */
export async function publishWindowsPnpmPath(source = process.env) {
  if (!environmentFilePath(source.GITHUB_PATH))
    throw new Error('Windows CI needs an explicit Actions path file')
  const executable = await windowsPnpmExecutable(source)
  await appendFile(source.GITHUB_PATH, dirname(executable) + '\n')
}

export async function main(source = process.env) {
  let stage = 'source-validation'
  let commandFacts
  let commandStartedAt = performance.now()
  let phases = {}
  const onState = (state) => {
    // Only runner-owned scalar observations cross this boundary. Never retain
    // child output, invocation text, paths, control credentials or raw errors.
    if (
      [
        'preparing',
        'prepared',
        'bootstrapping',
        'initializing',
        'started',
        'stopping',
        'settled',
      ].includes(state.kind) &&
      phases[state.kind] === undefined
    )
      phases[state.kind] = Math.ceil(performance.now() - commandStartedAt)
    if (process.platform === 'win32' && ['preparing', 'prepared'].includes(state.kind))
      console.error(
        '[pact-windows-startup] ' + (state.kind === 'preparing' ? 'prepare-image' : 'image-ready'),
      )
    commandFacts = {
      phases: { ...phases },
      kind: [
        'preparing',
        'prepared',
        'bootstrapping',
        'initializing',
        'started',
        'buffered',
        'ownership',
        'stopping',
        'settled',
      ].includes(state.kind)
        ? state.kind
        : 'other',
      reason: [
        'startup-deadline',
        'deadline',
        'cancelled',
        'supervisor-error',
        'descendants-still-running',
        'control-closed',
        'control-error',
        'control-budget',
        'control-invalid',
        'control-authentication',
        'control-start-failed',
        'spawn-failed',
        'bootstrap-transfer-failed',
        'output-transfer-failed',
        'output-budget',
        'redacted-output-budget',
        'observer-failed',
        'interrupted-SIGINT',
        'interrupted-SIGTERM',
      ].includes(state.reason)
        ? state.reason
        : (commandFacts?.reason ?? null),
      groupGone: state.groupGone === true,
      ownedProcesses:
        Number.isSafeInteger(state.ownedProcessCount) &&
        state.ownedProcessCount >= 0 &&
        state.ownedProcessCount <= 256
          ? state.ownedProcessCount
          : null,
    }
  }
  try {
    if (!source.RUNNER_TEMP || !isAbsolute(source.RUNNER_TEMP))
      throw new Error('Native CI requires the runner-owned temporary directory')
    if (!environmentFilePath(source.GITHUB_ENV))
      throw new Error('Native CI needs an explicit Actions environment file')
    stage = 'pnpm-discovery'
    const pnpmExecutable =
      process.platform === 'win32' ? await windowsPnpmExecutable(source) : 'pnpm'
    stage = 'temporary-project'
    const directory = join(await realpath(source.RUNNER_TEMP), 'pact-native-cli')
    await mkdir(directory, { mode: 0o700 })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        private: true,
        dependencies: { '@openai/codex': '0.159.2', '@anthropic-ai/claude-code': '2.1.272' },
      }) + '\n',
      { flag: 'wx', mode: 0o600 },
    )
    // This private project pins every package; only Claude's native-binary installer needs a hook.
    // Never widen the repository's dependency build policy or suppress ignored-build failures.
    await writeFile(
      join(directory, 'pnpm-workspace.yaml'),
      "packages: []\nallowBuilds:\n  '@anthropic-ai/claude-code': true\n",
      { flag: 'wx', mode: 0o600 },
    )
    stage = 'lockfile'
    commandStartedAt = performance.now()
    phases = {}
    const resolved = await run(['install', '--lockfile-only', '--no-frozen-lockfile'], 5 * 60_000, {
      executable: pnpmExecutable,
      cwd: directory,
      env: { ...ciEnvironment(source), PACT_WINDOWS_STARTUP_DIAGNOSTIC: '1' },
      onState,
    })
    if (resolved !== 0) throw new Error('Pinned native CLI lockfile admission failed')
    stage = 'installation'
    commandFacts = undefined
    commandStartedAt = performance.now()
    phases = {}
    const installed = await run(['install', '--frozen-lockfile'], 5 * 60_000, {
      executable: pnpmExecutable,
      cwd: directory,
      env: { ...ciEnvironment(source), PACT_WINDOWS_STARTUP_DIAGNOSTIC: '1' },
      onState,
    })
    if (installed !== 0) throw new Error('Pinned native CLI installation failed')
    stage = 'native-entry-validation'
    const lines = []
    const nativeCodex =
      process.platform === 'win32' ? await windowsCodexEntry(directory, process.arch) : undefined
    for (const agent of ['claude', 'codex']) {
      // The pinned Claude installer supplies bin/claude.exe on every target OS.
      // Selecting that exact native entry preserves executable identity through
      // SDK spawning and owned-process interruption, unlike the pnpm shim.
      const path =
        agent === 'claude'
          ? join(directory, 'node_modules', '@anthropic-ai/claude-code', 'bin', 'claude.exe')
          : join(
              directory,
              'node_modules',
              '.bin',
              `codex${process.platform === 'win32' ? '.cmd' : ''}`,
            )
      // oxlint-disable-next-line eslint/no-await-in-loop -- Exactly two installed executable entries are checked before publishing either path.
      const info = await lstat(path)
      if (!info.isFile() && !info.isSymbolicLink())
        throw new Error('Pinned native CLI executable is missing')
      if (/[\r\n\0]/u.test(path))
        throw new Error('Native CLI path cannot enter an Actions environment file')
      for (const lane of ['NATIVE', 'E2E'])
        lines.push(
          `PACT_${lane}_${agent.toUpperCase()}_EXECUTABLE=${
            lane === 'NATIVE' && agent === 'codex' && nativeCodex ? nativeCodex.executable : path
          }`,
        )
    }
    if (nativeCodex) lines.push(`PACT_NATIVE_CODEX_PACKAGE_ROOT=${nativeCodex.packageRoot}`)
    stage = 'actions-environment-publication'
    await appendFile(source.GITHUB_ENV, lines.join('\n') + '\n')
  } catch (error) {
    const failure = new Error('Pinned native CLI setup failed.')
    setupFailures.set(
      failure,
      Object.freeze({
        stage,
        errorClass: safeErrorClasses.has(error?.name) ? error.name : 'unknown',
        code: safeErrorCodes.has(error?.code) ? error.code : 'unknown',
        ...(commandFacts ? { command: commandFacts } : {}),
      }),
    )
    throw failure
  }
}

if (isScriptEntry(import.meta.url))
  main().catch((error) => {
    console.error('Pinned native CLI setup failed.', JSON.stringify(nativeSetupFailureFacts(error)))
    process.exitCode = 1
  })
