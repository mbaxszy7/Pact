import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import beforePack from '../apps/desktop/build/before-pack.mjs'
import {
  inspectWindowsOwnedProcessResource,
  validateWindowsOwnedProcessManifest,
} from '../apps/desktop/build/windows-owned-process-resource.mjs'
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
const { FileMatcher } = builderRequire('app-builder-lib/out/fileMatcher.js')
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

async function helperFixture(context, arch) {
  const app = await mkdtemp(join(tmpdir(), 'pact-helper-packaging-'))
  context.after(() => rm(app, { recursive: true, force: true }))
  const directory = join(app, 'resources/native')
  await mkdir(directory, { recursive: true })
  // PE/header and manifest admission only. These bytes are never executed as Windows proof.
  const pe = Buffer.alloc(128)
  pe.write('MZ')
  pe.writeUInt32LE(64, 60)
  pe.writeUInt32LE(0x4550, 64)
  pe.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 68)
  const executable = join(directory, `owned-process-group-win32-${arch}.exe`)
  const metadata = {
    version: 1,
    platform: 'win32',
    architecture: arch,
    protocolVersion: 1,
    sourceSha256: 'c'.repeat(64),
    executableSha256: createHash('sha256').update(pe).digest('hex'),
    executableBytes: pe.length,
  }
  await writeFile(executable, pe)
  await writeFile(`${executable}.json`, JSON.stringify(metadata))
  return { app, directory, executable, metadata, pe }
}

for (const arch of ['x64', 'arm64']) {
  void test(`Windows ${arch} helper packaging binds exact PE bytes, protocol/source identity and both resource entries`, async (context) => {
    const fixture = await helperFixture(context, arch)
    const record = await inspectWindowsOwnedProcessResource(
      fixture.directory,
      arch,
      fixture.metadata.sourceSha256,
    )
    const content = await applicationContent(fixture.app, 'win32')
    const manifest = {
      platform: 'win32',
      arch,
      windowsOwnedProcess: record,
      application: { entries: content.entries },
    }
    assert.deepEqual(validateWindowsOwnedProcessManifest(manifest), record)
    assert.throws(
      () => validateWindowsOwnedProcessManifest({ ...manifest, windowsOwnedProcess: null }),
      /identity or inventory/u,
    )
    assert.throws(
      () => validateWindowsOwnedProcessManifest({ ...manifest, platform: 'darwin' }),
      /non-Windows/u,
    )
    assert.throws(
      () =>
        validateWindowsOwnedProcessManifest({
          ...manifest,
          windowsOwnedProcess: { ...record, protocolVersion: 2 },
        }),
      /identity or inventory/u,
    )
    assert.throws(
      () =>
        validateWindowsOwnedProcessManifest({
          ...manifest,
          application: {
            entries: [
              ...content.entries,
              { path: 'resources/native/owned-process-group-win32-other.exe', type: 'file' },
            ],
          },
        }),
      /inventory/u,
    )
    await assert.rejects(
      inspectWindowsOwnedProcessResource(fixture.directory, arch, 'd'.repeat(64)),
      /target\/source\/protocol/u,
    )
    fixture.pe.writeUInt16LE(arch === 'arm64' ? 0x8664 : 0xaa64, 68)
    await writeFile(fixture.executable, fixture.pe)
    await assert.rejects(
      inspectWindowsOwnedProcessResource(fixture.directory, arch, fixture.metadata.sourceSha256),
      /PE architecture/u,
    )
  })
}

void test('helper resources reject changed bytes and oversized metadata, while macOS packaging needs no Windows toolchain', async (context) => {
  const fixture = await helperFixture(context, 'x64')
  fixture.pe[100] = 1
  await writeFile(fixture.executable, fixture.pe)
  await assert.rejects(
    inspectWindowsOwnedProcessResource(fixture.directory, 'x64', fixture.metadata.sourceSha256),
    /recorded digest/u,
  )
  await writeFile(`${fixture.executable}.json`, ' '.repeat(4097))
  await assert.rejects(
    inspectWindowsOwnedProcessResource(fixture.directory, 'x64', fixture.metadata.sourceSha256),
    /byte bound/u,
  )
  assert.equal(
    validateWindowsOwnedProcessManifest({ platform: 'darwin', application: { entries: [] } }),
    null,
  )
  await beforePack({ electronPlatformName: 'darwin', arch: 3 })
  assert.equal(base.beforePack, 'build/before-pack.mjs')
  assert.equal(base.afterPack, 'build/after-pack.mjs')
  assert.equal(base.asar, true)
  assert(base.files.includes('!out/native/**'))
  assert.deepEqual(
    base.win.extraResources.map((item) => item.to),
    [
      'native/owned-process-group-win32-${arch}.exe',
      'native/owned-process-group-win32-${arch}.exe.json',
    ],
  )
  assert.equal(base.win.signExecutable, false)
})

void test('the actual builder matcher excludes every Windows helper from ASAR and expands only the requested resource architecture', async () => {
  const source = join(tmpdir(), 'pact-builder-matcher-source')
  const destination = join(tmpdir(), 'pact-builder-matcher-destination')
  const filter = new FileMatcher(source, destination, (value) => value, base.files).createFilter()
  const stat = { isDirectory: () => false }
  assert(filter(join(source, 'out/main/index.js'), stat))
  for (const arch of ['x64', 'arm64']) {
    const filename = `owned-process-group-win32-${arch}.exe`
    assert.equal(filter(join(source, 'out/native', filename), stat), false)
    assert.equal(filter(join(source, 'out/native', `${filename}.json`), stat), false)
    for (const resource of base.win.extraResources) {
      const matcher = new FileMatcher(
        join(source, resource.from),
        join(destination, resource.to),
        (value) => value.replaceAll('${arch}', arch),
      )
      assert(matcher.from.endsWith(filename) || matcher.from.endsWith(`${filename}.json`))
      assert(matcher.to.endsWith(filename) || matcher.to.endsWith(`${filename}.json`))
    }
  }
  const preview = builderRequire('js-yaml').load(
    await readFile(
      new URL('../apps/desktop/electron-builder.win-preview.yml', import.meta.url),
      'utf8',
    ),
  )
  assert.equal(preview.extends, './electron-builder.yml')
  const inherited = deepAssign({}, base, preview)
  assert.equal(inherited.beforePack, base.beforePack)
  assert.deepEqual(inherited.win.extraResources, base.win.extraResources)
})
