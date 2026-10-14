import { mkdir, writeFile, appendFile, realpath, lstat, open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

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

export async function main(source = process.env) {
  let stage = 'source-validation'
  try {
    if (!source.RUNNER_TEMP || !isAbsolute(source.RUNNER_TEMP))
      throw new Error('Native CI requires the runner-owned temporary directory')
    if (!environmentFilePath(source.GITHUB_ENV))
      throw new Error('Native CI needs an explicit Actions environment file')
    if (process.platform === 'win32' && !environmentFilePath(source.GITHUB_PATH))
      throw new Error('Windows native CI needs an explicit Actions path file')
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
    const resolved = await run(['install', '--lockfile-only', '--no-frozen-lockfile'], 5 * 60_000, {
      executable: pnpmExecutable,
      cwd: directory,
      env: ciEnvironment(source),
    })
    if (resolved !== 0) throw new Error('Pinned native CLI lockfile admission failed')
    stage = 'installation'
    const installed = await run(['install', '--frozen-lockfile'], 5 * 60_000, {
      executable: pnpmExecutable,
      cwd: directory,
      env: ciEnvironment(source),
    })
    if (installed !== 0) throw new Error('Pinned native CLI installation failed')
    stage = 'native-entry-validation'
    const lines = []
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
        lines.push(`PACT_${lane}_${agent.toUpperCase()}_EXECUTABLE=${path}`)
    }
    stage = 'actions-path-publication'
    await appendFile(source.GITHUB_ENV, lines.join('\n') + '\n')
    // runWindows later resolves pnpm.exe from each absolute PATH directory. Publish
    // the verified package directory, where that exact native filename lives.
    if (process.platform === 'win32')
      await appendFile(source.GITHUB_PATH, dirname(pnpmExecutable) + '\n')
  } catch (error) {
    const failure = new Error('Pinned native CLI setup failed.')
    setupFailures.set(
      failure,
      Object.freeze({
        stage,
        errorClass: safeErrorClasses.has(error?.name) ? error.name : 'unknown',
        code: safeErrorCodes.has(error?.code) ? error.code : 'unknown',
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
