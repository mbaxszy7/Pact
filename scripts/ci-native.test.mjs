import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  main,
  nativeSetupFailureFacts,
  windowsPnpmExecutable,
  publishWindowsPnpmPath,
  windowsCodexEntry,
} from './ci-native.mjs'

const pinnedManifest = { name: 'pnpm', version: '12.11.2', bin: { pnpm: 'pnpm.exe' } }

async function installedCodex(root, arch, version = '0.159.2') {
  const packageRoot = join(root, 'node_modules', '@openai', 'codex')
  const alias = `@openai/codex-win32-${arch}`
  const binaryRoot = join(packageRoot, 'node_modules', alias)
  const triple = arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc'
  const executable = join(binaryRoot, 'vendor', triple, 'bin', 'codex.exe')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@openai/codex',
      version,
      optionalDependencies: { [alias]: `npm:@openai/codex@${version}-win32-${arch}` },
    }),
  )
  await writeFile(
    join(binaryRoot, 'package.json'),
    JSON.stringify({
      name: '@openai/codex',
      version: `${version}-win32-${arch}`,
      os: ['win32'],
      cpu: [arch],
    }),
  )
  // Header admission fixture only; this never executes or certifies a Windows App.
  const bytes = Buffer.alloc(128)
  bytes.write('MZ')
  bytes.writeUInt32LE(64, 60)
  bytes.writeUInt32LE(0x4550, 64)
  bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 68)
  await writeFile(executable, bytes)
  return { packageRoot, binaryRoot, executable, bytes }
}

for (const arch of ['x64', 'arm64']) {
  void test(`resolves pinned ${arch} Codex from its alias context and rejects the other PE architecture`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-ci-codex-entry-'))
    try {
      const entry = await installedCodex(await realpath(root), arch)
      assert.deepEqual(await windowsCodexEntry(root, arch), {
        executable: entry.executable,
        packageRoot: entry.packageRoot,
      })
      entry.bytes.writeUInt16LE(arch === 'x64' ? 0xaa64 : 0x8664, 68)
      await writeFile(entry.executable, entry.bytes)
      await assert.rejects(windowsCodexEntry(root, arch), /PE architecture mismatch/)
      await writeFile(entry.executable, Buffer.alloc(128))
      await assert.rejects(windowsCodexEntry(root, arch), /Invalid Windows Codex image/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  void test(`admits only exact decision 0.163.0 ${arch} wrapper, alias and PE while retaining legacy 0.159.2`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-ci-decision-entry-'))
    try {
      const entry = await installedCodex(await realpath(root), arch, '0.163.0')
      assert.deepEqual(await windowsCodexEntry(root, arch, 'decision-codex'), {
        executable: entry.executable,
        packageRoot: entry.packageRoot,
      })
      await assert.rejects(windowsCodexEntry(root, arch), /wrapper identity mismatch/)
      await assert.rejects(windowsCodexEntry(root, arch, '0.163.0'), /Unknown fixed native profile/)
      for (const profile of ['decision-claude', 'windows-owner'])
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each non-Codex profile is refused before filesystem admission.
        await assert.rejects(
          windowsCodexEntry(root, arch, profile),
          /does not select a Codex package/,
        )
      const wrapper = join(entry.packageRoot, 'package.json')
      const metadata = JSON.parse(await readFile(wrapper, 'utf8'))
      metadata.optionalDependencies[`@openai/codex-win32-${arch}`] =
        `npm:@openai/codex@0.159.2-win32-${arch}`
      await writeFile(wrapper, JSON.stringify(metadata))
      await assert.rejects(
        windowsCodexEntry(root, arch, 'decision-codex'),
        /wrapper identity mismatch/,
      )
      await installedCodex(await realpath(root), arch, '0.163.0')
      const binary = join(entry.binaryRoot, 'package.json')
      const nativeMetadata = JSON.parse(await readFile(binary, 'utf8'))
      nativeMetadata.version = `0.159.2-win32-${arch}`
      await writeFile(binary, JSON.stringify(nativeMetadata))
      await assert.rejects(
        windowsCodexEntry(root, arch, 'decision-codex'),
        /native package identity mismatch/,
      )
      await installedCodex(await realpath(root), arch)
      await assert.rejects(
        windowsCodexEntry(root, arch, 'decision-codex'),
        /wrapper identity mismatch/,
      )
      assert.deepEqual(await windowsCodexEntry(root, arch), {
        executable: entry.executable,
        packageRoot: entry.packageRoot,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

void test('rejects wrapper/package drift and missing or oversized native metadata without a shim fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-ci-codex-reject-'))
  try {
    const entry = await installedCodex(await realpath(root), 'arm64')
    const manifest = join(entry.binaryRoot, 'package.json')
    await writeFile(
      manifest,
      JSON.stringify({
        name: '@openai/codex',
        version: '0.159.2-win32-x64',
        os: ['win32'],
        cpu: ['x64'],
      }),
    )
    await assert.rejects(windowsCodexEntry(root, 'arm64'), /native package identity mismatch/)
    await writeFile(manifest, ' '.repeat(65537))
    await assert.rejects(windowsCodexEntry(root, 'arm64'), /bounded regular file/)
    await rm(manifest)
    await assert.rejects(windowsCodexEntry(root, 'arm64'))
    await writeFile(
      join(entry.packageRoot, 'package.json'),
      JSON.stringify({ name: '@openai/codex', version: '0.159.3' }),
    )
    await assert.rejects(windowsCodexEntry(root, 'arm64'), /wrapper identity mismatch/)
    await assert.rejects(windowsCodexEntry(root, 'ia32'), /Invalid Windows Codex/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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
    const pathFile = join(root, 'actions-path')
    await publishWindowsPnpmPath({ PNPM_HOME: home, GITHUB_PATH: pathFile })
    assert.equal(await readFile(pathFile, 'utf8'), dirname(executable) + '\n')
    await assert.rejects(publishWindowsPnpmPath({ PNPM_HOME: home }), /explicit Actions path/)
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

void test(
  'records bounded command phases on an actual failed setup without admitting credentials',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-ci-native-stage-'))
    try {
      const bin = join(root, 'bin')
      await mkdir(bin)
      await writeFile(
        join(bin, 'pnpm'),
        '#!/bin/sh\nif [ -n "${PACT_CI_APP_PRIVATE_KEY-}" ]; then : > "$RUNNER_TEMP/credential-present"; fi\nexit 1\n',
        { mode: 0o700 },
      )
      await assert.rejects(
        main({
          RUNNER_TEMP: root,
          GITHUB_ENV: join(root, 'env'),
          PATH: bin + ':/usr/bin:/bin',
          PACT_CI_APP_PRIVATE_KEY: 'synthetic-not-admitted',
        }),
        (error) => {
          const facts = nativeSetupFailureFacts(error)
          assert.equal(facts.stage, 'lockfile')
          assert(facts.command.phases.started >= 0)
          assert(facts.command.phases.settled >= facts.command.phases.started)
          assert(Object.keys(facts.command.phases).length <= 5)
          assert(!JSON.stringify(facts).includes('synthetic-not-admitted'))
          return true
        },
      )
      await assert.rejects(readFile(join(root, 'credential-present')), { code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

void test('fixed decision setup refuses unknown profiles and preserves an existing private installation without replacing the legacy home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-decision-setup-'))
  try {
    const source = { ...process.env, RUNNER_TEMP: root, GITHUB_ENV: join(root, 'actions.env') }
    await assert.rejects(main(source, '0.164.0'), /Pinned native CLI setup failed/u)
    assert.equal((await readdir(root)).length, 0)
    await mkdir(join(root, 'pact-decision-native-cli'))
    await writeFile(join(root, 'pact-decision-native-cli', 'keep'), 'owned-original')
    await assert.rejects(main(source, 'decision-codex'), /Pinned native CLI setup failed/u)
    assert.equal(
      await readFile(join(root, 'pact-decision-native-cli', 'keep'), 'utf8'),
      'owned-original',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test(
  'decision setup verifies its private CLI before publishing only the separate executable namespace',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64' },
  async () => {
    for (const version of ['0.163.0', '0.159.2']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each setup outcome owns a distinct private installation.
      const root = await mkdtemp(join(tmpdir(), 'pact-decision-private-setup-'))
      try {
        const bin = join(root, 'bin')
        // oxlint-disable-next-line eslint/no-await-in-loop -- One isolated process boundary is exercised to completion before the next.
        await mkdir(bin)
        const executable =
          '#!/usr/bin/env node\nprocess.stdout.write(' +
          JSON.stringify(`codex-cli ${version}\n`) +
          ')\n'
        const shim = '#!/usr/bin/env node\nprocess.exit(9)\n'
        // This controlled installer never contacts a package registry or Provider.
        // It exercises main's real preparation, version process and publication boundary.
        // oxlint-disable-next-line eslint/no-await-in-loop -- The fixture installer is fully prepared before main starts it.
        await writeFile(
          join(bin, 'pnpm'),
          `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] !== 'install') process.exit(3);
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (JSON.stringify(manifest.dependencies) !== '{"@openai/codex":"0.163.0"}') process.exit(4);
fs.mkdirSync('node_modules/.bin', {recursive:true});
fs.mkdirSync('node_modules/@openai/codex/bin', {recursive:true});
fs.writeFileSync('node_modules/.bin/codex', ${JSON.stringify(shim)}, {mode:0o700});
fs.writeFileSync('node_modules/@openai/codex/bin/codex.js', ${JSON.stringify(executable)}, {mode:0o700});
fs.writeFileSync('pnpm-lock.yaml', ${JSON.stringify('owned-installation-fixture\n')});
`,
          { mode: 0o700 },
        )
        const environment = join(root, 'actions.env')
        const legacy =
          'PACT_NATIVE_CODEX_EXECUTABLE=/owned/legacy\nPACT_NATIVE_CODEX_PACKAGE_ROOT=/owned/legacy-package\n'
        // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve pre-existing environment publication through the actual append.
        await writeFile(environment, legacy)
        const source = {
          RUNNER_TEMP: root,
          GITHUB_ENV: environment,
          PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        }
        if (version === '0.163.0') {
          // oxlint-disable-next-line eslint/no-await-in-loop -- No next installation starts before the real setup process settles.
          await main(source, 'decision-codex')
          // oxlint-disable-next-line eslint/no-await-in-loop -- Match the canonical installation selected by main.
          const directory = await realpath(join(root, 'pact-decision-native-cli'))
          assert.equal(
            // oxlint-disable-next-line eslint/no-await-in-loop -- Read the actual publication after all setup/version work joins.
            await readFile(environment, 'utf8'),
            legacy +
              `PACT_NATIVE_DECISION_CODEX_EXECUTABLE=${join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')}\n` +
              'PACT_NATIVE_DECISION_CODEX_VERSION=0.163.0\n',
          )
        } else {
          // oxlint-disable-next-line eslint/no-await-in-loop -- A mismatched version must complete with no environment mutation.
          await assert.rejects(main(source, 'decision-codex'), (error) => {
            assert.equal(nativeSetupFailureFacts(error).stage, 'native-version-validation')
            return true
          })
          // oxlint-disable-next-line eslint/no-await-in-loop -- The failure boundary preserves the complete prior publication.
          assert.equal(await readFile(environment, 'utf8'), legacy)
        }
      } finally {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Remove only the fixture created for this iteration.
        await rm(root, { recursive: true, force: true })
      }
    }
  },
)

void test('Claude decision setup owns a distinct fixed installation and never replaces an existing directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-claude-decision-setup-'))
  try {
    const directory = join(root, 'pact-claude-decision-native-cli')
    await mkdir(directory)
    await writeFile(join(directory, 'keep'), 'owned-original')
    await assert.rejects(
      main(
        { ...process.env, RUNNER_TEMP: root, GITHUB_ENV: join(root, 'actions.env') },
        'decision-claude',
      ),
      /Pinned native CLI setup failed/u,
    )
    assert.equal(await readFile(join(directory, 'keep'), 'utf8'), 'owned-original')
    assert.deepEqual(await readdir(root), ['pact-claude-decision-native-cli'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
