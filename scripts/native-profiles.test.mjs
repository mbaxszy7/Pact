import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import {
  claudeDecisionNativeCases,
  claudeDecisionNativeFiles,
  decisionNativeFiles,
  nativeProfile,
  nativeProfileSetupSupports,
  nativeProfileSupports,
  windowsOwnerHostCases,
  windowsOwnerNativeCases,
  windowsOwnerNativeFiles,
} from './native-profiles.mjs'

await test('the old native contract retains its pin while the fixed decision inventory is separate', async () => {
  const original = nativeProfile()
  assert.deepEqual(original, {
    name: 'legacy',
    command: 'test:native',
    codexVersion: '0.159.2',
    directory: 'pact-native-cli',
    files: null,
  })
  const decision = nativeProfile('decision-codex')
  assert.equal(decision.codexVersion, '0.163.0')
  assert.equal(decision.command, 'test:native:decision')
  assert.equal(decision.files, decisionNativeFiles)
  assert.equal(decisionNativeFiles.length, 5)
  assert.equal(new Set(decisionNativeFiles).size, 5)
  assert(Object.isFrozen(decisionNativeFiles))
  const sources = await Promise.all(
    decisionNativeFiles.map((file) => readFile(new URL('../' + file, import.meta.url), 'utf8')),
  )
  assert(sources.every((source) => source.length > 0))
  assert.throws(() => nativeProfile('0.164.0'), /Unknown fixed native profile/u)
  assert.throws(
    () => nativeProfile('decision-codex --grep passed'),
    /Unknown fixed native profile/u,
  )
})
await test('both native configs consume one inventory and never permit a platform skip to satisfy the decision profile', async () => {
  const { default: legacy } = await import('../vitest.native.config.ts')
  const decision = await readFile(
    new URL('../vitest.native-decision.config.ts', import.meta.url),
    'utf8',
  )
  assert.deepEqual(legacy.test.exclude, [
    ...decisionNativeFiles,
    ...claudeDecisionNativeFiles,
    ...windowsOwnerNativeFiles,
    'tests/native/claude-decision-windows.test.ts',
  ])
  assert.match(decision, /include:\s*\[\.\.\.decisionNativeFiles\]/u)
  assert.match(decision, /!nativeProfileSupports\(nativeProfile\('decision-codex'\)\)/u)
  assert.match(decision, /throw new Error/u)
  const scripts = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ).scripts
  assert.equal(scripts['test:native'], 'vitest run --config vitest.native.config.ts')
  assert.equal(
    scripts['test:native:decision'],
    'vitest run --config vitest.native-decision.config.ts',
  )
})

await test('Windows decision CLI setup is explicit without admitting Darwin-only execution or reports', () => {
  const decision = nativeProfile('decision-codex')
  for (const arch of ['x64', 'arm64']) {
    assert(nativeProfileSetupSupports(decision, 'win32', arch))
    assert(!nativeProfileSupports(decision, 'win32', arch))
  }
  assert(nativeProfileSetupSupports(decision, 'darwin', 'arm64'))
  assert(nativeProfileSupports(decision, 'darwin', 'arm64'))
  for (const [platform, arch] of [
    ['win32', 'ia32'],
    ['darwin', 'x64'],
    ['linux', 'x64'],
  ]) {
    assert(!nativeProfileSetupSupports(decision, platform, arch))
    assert(!nativeProfileSupports(decision, platform, arch))
  }
  for (const name of ['legacy', 'windows-owner']) {
    const profile = nativeProfile(name)
    for (const platform of ['darwin', 'win32', 'linux'])
      for (const arch of ['x64', 'arm64', 'ia32'])
        assert.equal(
          nativeProfileSetupSupports(profile, platform, arch),
          nativeProfileSupports(profile, platform, arch),
        )
  }
})

await test('Claude decision and Windows owner inventories keep exact obligations and separate native platform gates', async () => {
  const claude = nativeProfile('decision-claude')
  assert.equal(claude.claudeVersion, '2.1.272')
  assert.equal(claude.codexVersion, null)
  assert.equal(claude.files, claudeDecisionNativeFiles)
  assert.equal(claude.cases, claudeDecisionNativeCases)
  assert.equal(claude.cases.length, 6)
  const source = await readFile(new URL('../' + claude.files[0], import.meta.url), 'utf8')
  for (const title of claude.cases) assert(source.includes(`it('${title}'`))
  const windows = nativeProfile('windows-owner')
  assert.equal(windows.files, windowsOwnerNativeFiles)
  assert.equal(windowsOwnerNativeCases.length, 13)
  assert.equal(windowsOwnerHostCases.length, 5)
  assert.equal(new Set(windows.cases).size, 18)
  for (const arch of ['x64', 'arm64']) {
    assert(nativeProfileSupports(windows, 'win32', arch))
    assert(nativeProfileSetupSupports(claude, 'win32', arch))
    assert(!nativeProfileSupports(claude, 'win32', arch))
  }
  assert(!nativeProfileSupports(windows, 'darwin', 'arm64'))
  assert(!nativeProfileSupports(windows, 'win32', 'ia32'))
  assert(!nativeProfileSupports(claude, 'linux', 'x64'))
  assert(nativeProfileSupports(claude, 'darwin', 'arm64'))
  assert(!nativeProfileSupports(claude, 'darwin', 'x64'))
  const scripts = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).scripts
  assert.equal(
    scripts[claude.command],
    'vitest run --config vitest.native-claude-decision.config.ts',
  )
  assert.equal(
    scripts[windows.command],
    'node scripts/build-owned-process-group-win32.mjs && vitest run --config vitest.native-windows-owner.config.ts',
  )
})
