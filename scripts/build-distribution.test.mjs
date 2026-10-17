import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  applicationContent,
  distributionBuilderArguments,
  distributionArguments,
  inspectPackagedWindowsSharp,
  inspectWindowsSharpSource,
} from './build-distribution.mjs'

const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'))
const { createYargs, configureBuildCommand, normalizeOptions } = desktopRequire(
  'electron-builder/out/builder.js',
)
const { Platform } = builderRequire('app-builder-lib')
const { Arch, deepAssign } = builderRequire('builder-util')
const { computeArchToTargetNamesMap } = builderRequire(
  'app-builder-lib/out/targets/targetFactory.js',
)
const base = builderRequire('js-yaml').load(
  await readFile(new URL('../apps/desktop/electron-builder.yml', import.meta.url), 'utf8'),
)

await test(
  'local Production profile stays distinct and cannot claim the CI Dev channel',
  { skip: !['darwin', 'win32'].includes(process.platform) },
  () => {
    const args = ['--profile', 'production-local', '--channel', 'stable', '--build-number', '1']
    assert.equal(distributionArguments(args).profile, 'production-local')
    assert.throws(
      () => distributionArguments(['--profile', 'production-local', '--channel', 'dev']),
      /profile and channel differ/u,
    )
    assert.throws(
      () => distributionArguments(['--profile', 'unregistered', '--channel', 'stable']),
      /Unsupported distribution profile/u,
    )
  },
)

function graph(args, options) {
  const platform = options.platform === 'darwin' ? Platform.MAC : Platform.WINDOWS
  const key = options.platform === 'darwin' ? 'mac' : 'win'
  const config = deepAssign({}, base, {
    [key]: {
      target: [
        {
          target: options.directoryOnly ? 'dir' : key === 'mac' ? 'dmg' : 'nsis',
          arch: [options.arch],
        },
      ],
    },
  })
  const parsed = normalizeOptions(
    configureBuildCommand(createYargs()).exitProcess(false).parseSync(args),
  )
  const raw = parsed.targets.get(platform)
  return [
    ...computeArchToTargetNamesMap(raw, { platformSpecificBuildOptions: config[key] }, platform),
  ].map(([arch, targets]) => ({ arch: Arch[arch], targets }))
}

async function sharpFixture(context, arch = 'x64') {
  const root = await mkdtemp(join(tmpdir(), 'pact-sharp-payload-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const target = `@img/sharp-win32-${arch}`
  const packagePath = join(root, 'package.json')
  const moduleRoot = join(root, 'node_modules')
  const library = join(moduleRoot, target, 'lib')
  await mkdir(join(moduleRoot, 'sharp/dist'), { recursive: true })
  await mkdir(library, { recursive: true })
  await writeFile(
    packagePath,
    JSON.stringify({
      dependencies: { sharp: '0.35.5' },
      optionalDependencies: { [target]: '0.35.5' },
    }),
  )
  await writeFile(
    join(moduleRoot, 'sharp/package.json'),
    JSON.stringify({ name: 'sharp', version: '0.35.5', exports: { '.': './dist/index.cjs' } }),
  )
  await writeFile(join(moduleRoot, 'sharp/dist/index.cjs'), '')
  await writeFile(
    join(moduleRoot, target, 'package.json'),
    JSON.stringify({ exports: { './sharp.node': './index.cjs' } }),
  )
  await writeFile(join(moduleRoot, target, 'index.cjs'), '')
  const pe = Buffer.alloc(134)
  pe.write('MZ')
  pe.writeUInt32LE(128, 60)
  pe.writeUInt32LE(0x00004550, 128)
  pe.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 132)
  const nativePath = join(library, `sharp-win32-${arch}-0.35.5.node`)
  await writeFile(nativePath, pe)
  await writeFile(join(library, 'libvips-42.dll'), 'fixture-dll-bytes')
  return { root, target, library, nativePath, packagePath, pe }
}

for (const arch of ['x64', 'arm64']) {
  void test(`Windows ${arch} dependency inspection checks actual native machine and final unpacked bytes`, async (context) => {
    const fixture = await sharpFixture(context, arch)
    const source = await inspectWindowsSharpSource(fixture.packagePath, arch)
    assert.ok(Object.values(source.facts).every(Boolean))
    const appPath = join(fixture.root, 'app')
    const library = join(appPath, 'resources/app.asar.unpacked/node_modules', fixture.target, 'lib')
    await mkdir(library, { recursive: true })
    await writeFile(join(library, `sharp-win32-${arch}-0.35.5.node`), fixture.pe)
    await writeFile(join(library, 'libvips-42.dll'), 'fixture-dll-bytes')
    const content = await applicationContent(appPath, 'win32')
    assert.deepEqual(await inspectPackagedWindowsSharp(appPath, content, arch, source), {
      packagedTargetNativePresent: true,
      packagedTargetNativeUnpacked: true,
      packagedTargetPayloadMatchesSource: true,
    })
    // An otherwise valid app snapshot like the failed fc7 payload must be rejected.
    const missing = await inspectPackagedWindowsSharp(appPath, { entries: [] }, arch, source)
    assert.equal(missing.packagedTargetNativePresent, false)
    assert.equal(missing.packagedTargetPayloadMatchesSource, false)
    await writeFile(join(library, 'libvips-42.dll'), 'different-dll-bytes')
    const changed = await applicationContent(appPath, 'win32')
    assert.equal(
      (await inspectPackagedWindowsSharp(appPath, changed, arch, source))
        .packagedTargetPayloadMatchesSource,
      false,
    )
  })
}

for (const defect of [
  'missing-package',
  'export-js-only',
  'wrong-machine',
  'missing-dll',
  'undeclared-target',
]) {
  void test(`Windows Sharp source admission rejects ${defect}`, async (context) => {
    const fixture = await sharpFixture(context)
    if (defect === 'missing-package')
      await rm(join(fixture.root, 'node_modules', fixture.target), { recursive: true })
    if (defect === 'export-js-only') await rm(fixture.nativePath)
    if (defect === 'wrong-machine') {
      fixture.pe.writeUInt16LE(0xaa64, 132)
      await writeFile(fixture.nativePath, fixture.pe)
    }
    if (defect === 'missing-dll') await rm(join(fixture.library, 'libvips-42.dll'))
    if (defect === 'undeclared-target')
      await writeFile(fixture.packagePath, JSON.stringify({ dependencies: { sharp: '0.35.5' } }))
    const { facts } = await inspectWindowsSharpSource(fixture.packagePath, 'x64')
    const key = {
      'missing-package': 'targetExportResolvableFromSharp',
      'export-js-only': 'targetNativeFilePresent',
      'wrong-machine': 'targetNativeMachineMatches',
      'missing-dll': 'targetDllPayloadPresent',
      'undeclared-target': 'targetDeclaredOptional',
    }[defect]
    assert.equal(facts[key], false)
    assert.equal(Object.values(facts).every(Boolean), false)
  })
}

void test('the pinned builder reproduces inherited arm64 inclusion with the former empty Windows target', () => {
  assert.equal(desktopRequire('electron-builder/package.json').version, '26.15.3')
  const actual = graph(['--win', '--x64', '--publish', 'never'], {
    platform: 'win32',
    arch: 'x64',
    directoryOnly: false,
  })
  assert.deepEqual(
    actual.map((row) => row.arch).toSorted((a, b) => a.localeCompare(b)),
    ['arm64', 'x64'],
  )
})

for (const [platform, arch] of [
  ['win32', 'x64'],
  ['win32', 'arm64'],
  ['darwin', 'arm64'],
]) {
  for (const directoryOnly of [false, true]) {
    void test(`the actual builder resolves only ${platform}/${arch} ${directoryOnly ? 'directory' : 'installers'}`, () => {
      const options = { platform, arch, directoryOnly }
      const args = distributionBuilderArguments(options, 'builder.js', 'temporary.cjs')
      const actual = graph(args.slice(1), options)
      assert.deepEqual(actual, [
        {
          arch,
          targets: directoryOnly ? ['dir'] : platform === 'darwin' ? ['dmg', 'zip'] : ['nsis'],
        },
      ])
      assert.equal(args.at(-1), directoryOnly ? '--dir' : 'never')
      assert.equal(args[args.indexOf('--publish') + 1], 'never')
    })
  }
}
