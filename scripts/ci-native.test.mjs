import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { main, nativeSetupFailureFacts, windowsPnpmExecutable } from './ci-native.mjs'

const pinnedManifest = { name: 'pnpm', version: '12.11.2', bin: { pnpm: 'pnpm.exe' } }

async function installedPnpm(root, manifest = pinnedManifest) {
  const home = join(root, 'setup-pnpm', 'node_modules', '.bin')
  const packageDirectory = join(home, '..', 'pnpm')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(packageDirectory, { mode: 0o700 })
  // This data fixture tests admission only; it never claims to execute a Windows binary.
  await writeFile(join(packageDirectory, 'pnpm.exe'), 'synthetic-native-entry', { mode: 0o600 })
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify(manifest), { mode: 0o600 })
  return { home, packageDirectory }
}

void test('admits the exact native sibling of setup-pnpm shims for owned Windows execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-ci-native-entry-'))
  try {
    const { home, packageDirectory } = await installedPnpm(root)
    await writeFile(join(home, 'pnpm.cmd'), 'synthetic-command-shim')
    const executable = await windowsPnpmExecutable({ PNPM_HOME: home })
    assert.equal(executable, await realpath(join(packageDirectory, 'pnpm.exe')))
    // Subsequent runWindows discovery appends pnpm.exe to the published absolute directory.
    assert.equal(join(dirname(executable), 'pnpm.exe'), executable)
    assert.equal(await readFile(executable, 'utf8'), 'synthetic-native-entry')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('canonicalizes setup package links without selecting a CMD shim or a different filename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-ci-native-link-'))
  try {
    const { home, packageDirectory } = await installedPnpm(root)
    const linkedHome = join(root, 'linked-bin')
    // PNPM_HOME is always .bin; link its parent to the existing complete node_modules identity.
    await symlink(dirname(home), linkedHome, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(
      await windowsPnpmExecutable({ PNPM_HOME: join(linkedHome, '.bin') }),
      await realpath(join(packageDirectory, 'pnpm.exe')),
    )
    await rm(join(packageDirectory, 'pnpm.exe'))
    await writeFile(join(packageDirectory, 'other.exe'), 'wrong-name')
    await symlink(
      join(packageDirectory, 'other.exe'),
      join(packageDirectory, 'pnpm.exe'),
      process.platform === 'win32' ? 'file' : undefined,
    )
    await assert.rejects(windowsPnpmExecutable({ PNPM_HOME: home }), /installed pnpm executable/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('fails closed for a different package version, package name, or shim entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-ci-native-manifest-'))
  try {
    const { home, packageDirectory } = await installedPnpm(root)
    for (const manifest of [
      { ...pinnedManifest, version: '12.11.1' },
      { ...pinnedManifest, name: '@pnpm/exe' },
      { ...pinnedManifest, bin: { pnpm: 'bin/pnpm.cjs' } },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Exercise each rejected identity against the same bounded fixture.
      await writeFile(join(packageDirectory, 'package.json'), JSON.stringify(manifest))
      // oxlint-disable-next-line eslint/no-await-in-loop -- No process or installation starts after an identity mismatch.
      await assert.rejects(windowsPnpmExecutable({ PNPM_HOME: home }), /exact pnpm 12\.11\.2/)
    }
    await rm(join(packageDirectory, 'pnpm.exe'))
    await writeFile(join(home, 'pnpm.cmd'), 'shim-only')
    await assert.rejects(windowsPnpmExecutable({ PNPM_HOME: home }), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('rejects invalid setup directories and oversized manifests before execution', async () => {
  for (const home of [undefined, 'relative', '/bad\nentry', '/bad\0entry', '/' + 'x'.repeat(4096)])
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each admission failure has no side effects.
    await assert.rejects(windowsPnpmExecutable({ PNPM_HOME: home }), /explicit setup-pnpm/)
  const root = await mkdtemp(join(tmpdir(), 'pact-ci-native-bound-'))
  try {
    const { home, packageDirectory } = await installedPnpm(root)
    await writeFile(join(packageDirectory, 'package.json'), ' '.repeat(64 * 1024 + 1))
    await assert.rejects(windowsPnpmExecutable({ PNPM_HOME: home }), /bounded regular file/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('setup failure preserves existing temporary contents and reports fixed stage and errno only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-ci-native-collision-'))
  try {
    const { home } = await installedPnpm(root)
    const directory = join(root, 'pact-native-cli')
    await mkdir(directory)
    await writeFile(join(directory, 'keep.txt'), 'existing-content')
    await assert.rejects(
      main({
        RUNNER_TEMP: root,
        GITHUB_ENV: join(root, 'env'),
        GITHUB_PATH: join(root, 'path'),
        PNPM_HOME: home,
      }),
      (error) => {
        assert.equal(error.message, 'Pinned native CLI setup failed.')
        assert.deepEqual(nativeSetupFailureFacts(error), {
          stage: 'temporary-project',
          errorClass: 'Error',
          code: 'EEXIST',
        })
        assert.equal(error.cause, undefined)
        return true
      },
    )
    assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'existing-content')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('CLI entrypoint emits safe setup classifications without secret values or raw errors', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./ci-native.mjs', import.meta.url))],
    {
      env: { PATH: process.env.PATH, PACT_CI_APP_PRIVATE_KEY: 'synthetic-not-for-output' },
      encoding: 'utf8',
      shell: false,
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    },
  )
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(
    result.stderr.trim(),
    'Pinned native CLI setup failed. {"stage":"source-validation","errorClass":"Error","code":"unknown"}',
  )
  assert.equal(result.stderr.includes('synthetic-not-for-output'), false)
  assert.deepEqual(nativeSetupFailureFacts(new Error('untrusted error text')), {
    stage: 'unknown',
    errorClass: 'unknown',
    code: 'unknown',
  })
})
