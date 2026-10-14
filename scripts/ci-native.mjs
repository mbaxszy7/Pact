import { mkdir, writeFile, appendFile, realpath, lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { ciEnvironment } from './ci.mjs'
import { run } from './run-e2e.mjs'
import { isScriptEntry } from './script-entry.mjs'

export async function main(source = process.env) {
  if (!source.RUNNER_TEMP || !isAbsolute(source.RUNNER_TEMP))
    throw new Error('Native CI requires the runner-owned temporary directory')
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
  const resolved = await run(['install', '--lockfile-only', '--no-frozen-lockfile'], 5 * 60_000, {
    cwd: directory,
    env: ciEnvironment(source),
  })
  if (resolved !== 0) throw new Error('Pinned native CLI lockfile admission failed')
  const installed = await run(['install', '--frozen-lockfile'], 5 * 60_000, {
    cwd: directory,
    env: ciEnvironment(source),
  })
  if (installed !== 0) throw new Error('Pinned native CLI installation failed')
  const lines = []
  for (const agent of ['claude', 'codex']) {
    const path = join(
      directory,
      'node_modules',
      '.bin',
      `${agent}${process.platform === 'win32' ? '.cmd' : ''}`,
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
  if (!source.GITHUB_ENV || !isAbsolute(source.GITHUB_ENV))
    throw new Error('Native CI needs an explicit Actions environment file')
  await appendFile(source.GITHUB_ENV, lines.join('\n') + '\n')
}

if (isScriptEntry(import.meta.url))
  main().catch(() => {
    console.error('Pinned native CLI setup failed.')
    process.exitCode = 1
  })
