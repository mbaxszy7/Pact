import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import {
  agyNativeCases,
  agyNativeFiles,
  codexExecutionNativeCases,
  codexExecutionNativeFiles,
  nativeProfile,
  nativeProfileSetupSupports,
  nativeProfileSupports,
  windowsOwnerHostCases,
  windowsOwnerNativeCases,
  windowsOwnerNativeFiles,
} from './native-profiles.mjs'

await test('the old native contract retains its pin while the fixed execution inventory is separate', async () => {
  const legacy = nativeProfile()
  assert.equal(legacy.command, 'test:native')
  assert.deepEqual(
    { codexVersion: legacy.codexVersion, directory: legacy.directory },
    {
      codexVersion: '0.159.2',
      directory: 'pact-native-cli',
    },
  )
  const execution = nativeProfile('execution-codex')
  assert.equal(execution.codexVersion, '0.163.0')
  assert.equal(execution.command, 'test:native:execution')
  assert.equal(execution.directory, 'pact-codex-execution-cli')
  assert.equal(execution.files, codexExecutionNativeFiles)
  assert.equal(execution.cases, codexExecutionNativeCases)
  assert.equal(codexExecutionNativeFiles.length, 3)
  assert.equal(new Set(codexExecutionNativeFiles).size, 3)
  assert(Object.isFrozen(codexExecutionNativeFiles))
  assert(Object.isFrozen(codexExecutionNativeCases))
  const sources = await Promise.all(
    codexExecutionNativeFiles.map((file) =>
      readFile(new URL('../' + file, import.meta.url), 'utf8'),
    ),
  )
  const actual = sources.join('\n')
  for (const title of codexExecutionNativeCases) assert(actual.includes(`'${title}'`))
  for (const name of ['0.164.0', 'decision-codex', 'decision-claude'])
    assert.throws(() => nativeProfile(name), /Unknown fixed native profile/u)
  assert.throws(
    () => nativeProfile('execution-codex --grep passed'),
    /Unknown fixed native profile/u,
  )
})

await test('both native configs consume one inventory and never permit a platform skip to satisfy the execution profile', async () => {
  const { default: legacy } = await import('../vitest.native.config.ts')
  const execution = await readFile(
    new URL('../vitest.native-execution.config.ts', import.meta.url),
    'utf8',
  )
  const agyConfig = await readFile(
    new URL('../vitest.agy.native.config.ts', import.meta.url),
    'utf8',
  )
  assert.deepEqual(legacy.test.exclude, [
    ...codexExecutionNativeFiles,
    ...windowsOwnerNativeFiles,
    ...agyNativeFiles,
  ])
  assert.match(execution, /include:\s*\[\.\.\.codexExecutionNativeFiles\]/u)
  assert.match(execution, /!nativeProfileSupports\(nativeProfile\('execution-codex'\)\)/u)
  assert.match(execution, /throw new Error/u)
  assert.match(agyConfig, /include:\s*\[\.\.\.agyNativeFiles\]/u)
  assert.match(agyConfig, /!nativeProfileSupports\(nativeProfile\('agy'\)\)/u)
  assert.match(agyConfig, /throw new Error/u)
  const scripts = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ).scripts
  assert.equal(scripts['test:native'], 'vitest run --config vitest.native.config.ts')
  assert.equal(scripts['test:native:agy'], 'vitest run --config vitest.agy.native.config.ts')
  assert.equal(
    scripts['test:native:execution'],
    'vitest run --config vitest.native-execution.config.ts',
  )
})

await test('Windows execution CLI setup is explicit without admitting Darwin-only execution or reports', () => {
  const execution = nativeProfile('execution-codex')
  for (const arch of ['x64', 'arm64']) {
    assert(nativeProfileSetupSupports(execution, 'win32', arch))
    assert(!nativeProfileSupports(execution, 'win32', arch))
  }
  assert(nativeProfileSetupSupports(execution, 'darwin', 'arm64'))
  assert(nativeProfileSupports(execution, 'darwin', 'arm64'))
  for (const [platform, arch] of [
    ['win32', 'ia32'],
    ['darwin', 'x64'],
    ['linux', 'x64'],
  ]) {
    assert(!nativeProfileSetupSupports(execution, platform, arch))
    assert(!nativeProfileSupports(execution, platform, arch))
  }
  for (const name of ['legacy', 'windows-owner', 'agy']) {
    const profile = nativeProfile(name)
    for (const platform of ['darwin', 'win32', 'linux'])
      for (const arch of ['x64', 'arm64', 'ia32'])
        assert.equal(
          nativeProfileSetupSupports(profile, platform, arch),
          nativeProfileSupports(profile, platform, arch),
        )
  }
})

await test('Antigravity native profile isolates its dedicated CLI inventory from the npm-pinned legacy profile', async () => {
  const agy = nativeProfile('agy')
  assert.equal(agy.command, 'test:native:agy')
  assert.equal(agy.codexVersion, null)
  assert.equal(agy.claudeVersion, null)
  assert.equal(agy.directory, 'pact-agy-native-cli')
  assert.equal(agy.files, agyNativeFiles)
  assert.equal(agy.cases, agyNativeCases)
  assert.deepEqual(agyNativeFiles, ['tests/native/agy-native.test.ts'])
  assert(Object.isFrozen(agyNativeFiles))
  assert(Object.isFrozen(agyNativeCases))
  assert.equal(agyNativeCases.length, 4)
  assert.equal(new Set(agyNativeCases).size, 4)
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert(nativeProfileSupports(agy, platform, 'arm64'))
    assert(nativeProfileSupports(agy, platform, 'x64'))
    assert(!nativeProfileSupports(agy, platform, 'ia32'))
  }
  const source = await readFile(
    new URL('../tests/native/agy-native.test.ts', import.meta.url),
    'utf8',
  )
  for (const title of agyNativeCases) assert(source.includes(`'${title}'`))
})

await test('Windows owner inventory keeps exact obligations and a separate native platform gate', async () => {
  const windows = nativeProfile('windows-owner')
  assert.equal(windows.files, windowsOwnerNativeFiles)
  assert.equal(windowsOwnerNativeCases.length, 13)
  assert.equal(windowsOwnerHostCases.length, 5)
  assert.equal(new Set(windows.cases).size, 18)
  for (const arch of ['x64', 'arm64']) {
    assert(nativeProfileSupports(windows, 'win32', arch))
    assert(nativeProfileSetupSupports(windows, 'win32', arch))
  }
  assert(!nativeProfileSupports(windows, 'darwin', 'arm64'))
  assert(!nativeProfileSupports(windows, 'win32', 'ia32'))
  const scripts = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).scripts
  assert.equal(
    scripts[windows.command],
    'node scripts/build-owned-process-group-win32.mjs && vitest run --config vitest.native-windows-owner.config.ts',
  )
})
