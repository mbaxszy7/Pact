import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')

export function checkSecrets(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['--staged', '--history'].includes(args[0]))
    throw new Error('Choose --staged or --history for secret scanning')
  const executable = process.env.PACT_GITLEAKS_EXECUTABLE ?? 'gitleaks'
  if (executable !== 'gitleaks' && !isAbsolute(executable))
    throw new Error('PACT_GITLEAKS_EXECUTABLE must be an absolute executable path')
  const version = spawnSync(executable, ['version'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4096,
    shell: false,
    windowsHide: true,
  })
  if (version.error || version.status !== 0 || version.stdout.trim() !== '8.30.1')
    throw new Error('Install Gitleaks 8.30.1; secret scanning refuses missing or unpinned scanners')
  const directory = mkdtempSync(join(tmpdir(), 'pact-secret-scan-'))
  const ignorePath = join(directory, 'empty-ignore')
  writeFileSync(ignorePath, '')
  try {
    const result = spawnSync(
      executable,
      [
        'git',
        root,
        ...(args[0] === '--staged'
          ? ['--pre-commit', '--staged']
          : ['--log-opts=--all --full-history']),
        '--config',
        resolve(root, '.gitleaks.toml'),
        '--gitleaks-ignore-path',
        ignorePath,
        '--ignore-gitleaks-allow',
        '--redact=100',
        '--no-banner',
        '--no-color',
        '--timeout=120',
      ],
      { cwd: root, stdio: 'inherit', timeout: 130_000, shell: false, windowsHide: true },
    )
    if (result.error) throw new Error('Secret scanner failed or exceeded its deadline')
    return result.status ?? 1
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  try {
    process.exitCode = checkSecrets()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
