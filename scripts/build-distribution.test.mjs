import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  agySqliteFileFilename,
  agySqliteFileResourcePrefix,
  agySqliteFileSourceHash,
  computeMachoPreSignatureSha256,
  inspectAgySqliteFileResource,
  validateAgySqliteFileManifest,
} from '../apps/desktop/build/agy-sqlite-file-resource.mjs'
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
    base.mac.extraResources.map((item) => item.to),
    [
      'native/agy-sqlite-file-darwin-${arch}.node',
      'native/agy-sqlite-file-darwin-${arch}.node.json',
      'native/terminal-darwin-${arch}',
      'native/terminal-darwin-${arch}.json',
    ],
  )
  assert.deepEqual(
    base.win.extraResources.map((item) => item.to),
    [
      'native/owned-process-group-win32-${arch}.exe',
      'native/owned-process-group-win32-${arch}.exe.json',
      'native/agy-sqlite-file-win32-${arch}.node',
      'native/agy-sqlite-file-win32-${arch}.node.json',
      'native/terminal-win32-${arch}.exe',
      'native/terminal-win32-${arch}.exe.json',
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
    const agyFilename = `agy-sqlite-file-win32-${arch}.node`
    const terminalFilename = `terminal-win32-${arch}.exe`
    assert.equal(filter(join(source, 'out/native', filename), stat), false)
    assert.equal(filter(join(source, 'out/native', `${filename}.json`), stat), false)
    assert.equal(filter(join(source, 'out/native', agyFilename), stat), false)
    assert.equal(filter(join(source, 'out/native', `${agyFilename}.json`), stat), false)
    assert.equal(filter(join(source, 'out/native', terminalFilename), stat), false)
    assert.equal(filter(join(source, 'out/native', `${terminalFilename}.json`), stat), false)
    for (const resource of base.win.extraResources) {
      const matcher = new FileMatcher(
        join(source, resource.from),
        join(destination, resource.to),
        (value) => value.replaceAll('${arch}', arch),
      )
      assert(
        matcher.from.endsWith(filename) ||
          matcher.from.endsWith(`${filename}.json`) ||
          matcher.from.endsWith(agyFilename) ||
          matcher.from.endsWith(`${agyFilename}.json`) ||
          matcher.from.endsWith(terminalFilename) ||
          matcher.from.endsWith(`${terminalFilename}.json`),
      )
      assert(
        matcher.to.endsWith(filename) ||
          matcher.to.endsWith(`${filename}.json`) ||
          matcher.to.endsWith(agyFilename) ||
          matcher.to.endsWith(`${agyFilename}.json`) ||
          matcher.to.endsWith(terminalFilename) ||
          matcher.to.endsWith(`${terminalFilename}.json`),
      )
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

function makeSyntheticPe32PlusCfgDll(arch, overrides = {}) {
  // Valid PE32+ DLL header + 1 .rdata section + 160-byte IMAGE_LOAD_CONFIG_DIRECTORY64 with CFG.
  const peOffset = 64
  const optOffset = peOffset + 24
  const sizeOfOptionalHeader = 240
  const sectionTableOffset = optOffset + sizeOfOptionalHeader // 328
  const rawSectionOffset = 512
  const rawSectionSize = 256
  const loadConfigRva = 0x2000
  const loadConfigSize = 160
  const bin = Buffer.alloc(rawSectionOffset + rawSectionSize)
  bin.write('MZ', 0, 'ascii')
  bin.writeUInt32LE(peOffset, 60)
  // COFF header
  bin.writeUInt32LE(0x4550, peOffset)
  bin.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, peOffset + 4)
  bin.writeUInt16LE(1, peOffset + 6) // NumberOfSections
  bin.writeUInt16LE(sizeOfOptionalHeader, peOffset + 20)
  bin.writeUInt16LE(overrides.characteristics ?? 0x2022, peOffset + 22) // IMAGE_FILE_DLL | EXECUTABLE
  // Optional header PE32+
  bin.writeUInt16LE(overrides.optionalMagic ?? 0x020b, optOffset)
  bin.writeBigUInt64LE(overrides.imageBase ?? 0x180000000n, optOffset + 24)
  bin.writeUInt16LE(overrides.dllCharacteristics ?? 0x4160, optOffset + 70) // GUARD_CF | NX | DYNAMIC_BASE
  bin.writeUInt32LE(16, optOffset + 108) // NumberOfRvaAndSizes
  // DataDirectory[10] = Load Config
  bin.writeUInt32LE(overrides.loadConfigRva ?? loadConfigRva, optOffset + 112 + 10 * 8)
  bin.writeUInt32LE(overrides.loadConfigSize ?? loadConfigSize, optOffset + 112 + 10 * 8 + 4)
  // Section[0] (.rdata)
  bin.write('.rdata\0\0', sectionTableOffset, 'ascii')
  bin.writeUInt32LE(rawSectionSize, sectionTableOffset + 8) // VirtualSize
  bin.writeUInt32LE(loadConfigRva, sectionTableOffset + 12) // VirtualAddress
  bin.writeUInt32LE(overrides.sectionRawSize ?? rawSectionSize, sectionTableOffset + 16) // SizeOfRawData
  bin.writeUInt32LE(rawSectionOffset, sectionTableOffset + 20) // PointerToRawData
  // IMAGE_LOAD_CONFIG_DIRECTORY64 at rawSectionOffset
  bin.writeUInt32LE(overrides.loadConfigStructSize ?? loadConfigSize, rawSectionOffset)
  if (overrides.guardCfFunctionTableVa !== undefined) {
    bin.writeBigUInt64LE(overrides.guardCfFunctionTableVa, rawSectionOffset + 128)
  }
  if (overrides.guardCfFunctionCount !== undefined) {
    bin.writeBigUInt64LE(overrides.guardCfFunctionCount, rawSectionOffset + 136)
  }
  bin.writeUInt32LE(overrides.guardFlags ?? 0x00000100, rawSectionOffset + 144) // IMAGE_GUARD_CF_INSTRUMENTED
  return bin
}

void test('agy-sqlite-file resource inspection binds Mach-O/PE bytes, metadata and real host loadability', async (context) => {
  await Promise.all(
    [
      ['darwin', 'arm64'],
      ['win32', 'x64'],
      ['win32', 'arm64'],
    ].map(async ([platform, arch]) => {
      const app = await mkdtemp(join(tmpdir(), `pact-agy-file-pkg-${platform}-${arch}-`))
      context.after(() => rm(app, { recursive: true, force: true }))
      const prefix = agySqliteFileResourcePrefix(platform)
      const dir = join(app, prefix)
      await mkdir(dir, { recursive: true })
      const filename = agySqliteFileFilename(platform, arch)
      let bin
      if (platform === 'darwin') {
        bin = Buffer.alloc(128)
        bin.writeUInt32LE(0xfeedfacf, 0)
        bin.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
      } else {
        bin = makeSyntheticPe32PlusCfgDll(arch, {
          guardCfFunctionTableVa: 0x1800020a0n,
          guardCfFunctionCount: 8n,
        })
      }
      const sourceSha256 = 'e'.repeat(64)
      const meta = {
        version: 1,
        platform,
        architecture: arch,
        sourceSha256,
        binarySha256: createHash('sha256').update(bin).digest('hex'),
        binaryBytes: bin.length,
      }
      const binaryPath = join(dir, filename)
      await writeFile(binaryPath, bin)
      await writeFile(`${binaryPath}.json`, JSON.stringify(meta))
      const record = await inspectAgySqliteFileResource(dir, platform, arch, sourceSha256)
      const content = await applicationContent(app, platform)
      const manifest = {
        platform,
        arch,
        agySqliteFile: record,
        application: { entries: content.entries },
      }
      assert.deepEqual(validateAgySqliteFileManifest(manifest), record)
      assert.throws(
        () => validateAgySqliteFileManifest({ ...manifest, agySqliteFile: null }),
        /identity or inventory/u,
      )
      bin[bin.length - 1] ^= 0x7f
      await writeFile(binaryPath, bin)
      await assert.rejects(
        inspectAgySqliteFileResource(dir, platform, arch, sourceSha256),
        /recorded digest/u,
      )
    }),
  )

  // Negative PE32+/CFG tests: reject missing DLL flag, non-PE32+, missing GUARD_CF, missing CFG Load Config, or out-of-bounds RVA.
  await Promise.all(
    [
      {
        label: 'missing IMAGE_FILE_DLL',
        overrides: { characteristics: 0x0022 },
        pattern: /IMAGE_FILE_DLL/u,
      },
      {
        label: 'non-PE32+ optional magic',
        overrides: { optionalMagic: 0x010b },
        pattern: /PE32\+/u,
      },
      {
        label: 'missing GUARD_CF DllCharacteristics',
        overrides: { dllCharacteristics: 0x0160 },
        pattern: /GUARD_CF/u,
      },
      {
        label: 'missing IMAGE_GUARD_CF_INSTRUMENTED',
        overrides: { guardFlags: 0 },
        pattern: /IMAGE_GUARD_CF_INSTRUMENTED/u,
      },
      {
        label: 'out-of-bounds Load Config RVA',
        overrides: { loadConfigRva: 0x9000 },
        pattern: /out of section\/file bounds/u,
      },
      {
        label: 'truncated Load Config section',
        overrides: { sectionRawSize: 64 },
        pattern: /out of section\/file bounds/u,
      },
      {
        label: 'Load Config directory size exceeding section bounds despite smaller structSize',
        overrides: { loadConfigSize: 512, loadConfigStructSize: 160 },
        pattern: /struct size is invalid or truncated/u,
      },
      {
        label: 'CFG function table VA below ImageBase',
        overrides: {
          guardCfFunctionTableVa: 0x1000n,
          guardCfFunctionCount: 2n,
        },
        pattern: /lies below ImageBase/u,
      },
      {
        label: 'CFG function table exceeding section bounds',
        overrides: {
          guardCfFunctionTableVa: 0x1800020a0n,
          guardCfFunctionCount: 64n,
        },
        pattern: /GuardCFFunctionTable exceeds section or file bounds/u,
      },
    ].map(async ({ label, overrides, pattern }) => {
      const app = await mkdtemp(join(tmpdir(), 'pact-agy-pe-neg-'))
      context.after(() => rm(app, { recursive: true, force: true }))
      const dir = join(app, agySqliteFileResourcePrefix('win32'))
      await mkdir(dir, { recursive: true })
      const filename = agySqliteFileFilename('win32', 'x64')
      const badPe = makeSyntheticPe32PlusCfgDll('x64', overrides)
      const sourceSha256 = 'e'.repeat(64)
      const meta = {
        version: 1,
        platform: 'win32',
        architecture: 'x64',
        sourceSha256,
        binarySha256: createHash('sha256').update(badPe).digest('hex'),
        binaryBytes: badPe.length,
      }
      const binaryPath = join(dir, filename)
      await writeFile(binaryPath, badPe)
      await writeFile(`${binaryPath}.json`, JSON.stringify(meta))
      await assert.rejects(
        inspectAgySqliteFileResource(dir, 'win32', 'x64', sourceSha256),
        pattern,
        `Expected Win32 PE inspection to reject ${label}`,
      )
    }),
  )

  // Verify the actual compiled host module in apps/desktop/out/native loads and matches source SHA-256.
  if (['darwin', 'win32'].includes(process.platform)) {
    const outNative = fileURLToPath(new URL('../apps/desktop/out/native', import.meta.url))
    const sourceSha256 = await agySqliteFileSourceHash()
    const observed = await inspectAgySqliteFileResource(
      outNative,
      process.platform,
      process.arch,
      sourceSha256,
      { verifyLoad: true },
    )
    assert.equal(observed.platform, process.platform)
    assert.equal(observed.architecture, process.arch)

    if (process.platform === 'darwin') {
      const signedApp = await mkdtemp(join(tmpdir(), 'pact-agy-signed-node-'))
      context.after(() => rm(signedApp, { recursive: true, force: true }))
      const nativeDir = join(signedApp, agySqliteFileResourcePrefix('darwin'))
      await mkdir(nativeDir, { recursive: true })
      const filename = agySqliteFileFilename('darwin', process.arch)
      const copiedBin = join(nativeDir, filename)
      await copyFile(join(outNative, filename), copiedBin)
      await copyFile(join(outNative, `${filename}.json`), `${copiedBin}.json`)
      const preSignMeta = JSON.parse(await readFile(`${copiedBin}.json`, 'utf8'))
      assert.match(preSignMeta.machoPreSigSha256, /^[a-f0-9]{64}$/u)
      await promisify(execFile)(
        '/usr/bin/codesign',
        ['--force', '--sign', '-', '--options', 'runtime', copiedBin],
        { shell: false, timeout: 10_000, maxBuffer: 64 * 1024 },
      )
      assert.equal(
        computeMachoPreSignatureSha256(await readFile(copiedBin), process.arch),
        preSignMeta.machoPreSigSha256,
      )
      await assert.rejects(
        inspectAgySqliteFileResource(nativeDir, 'darwin', process.arch, sourceSha256),
        /changed size|recorded digest/u,
      )
      const signedRecord = await inspectAgySqliteFileResource(
        nativeDir,
        'darwin',
        process.arch,
        sourceSha256,
        { verifyLoad: true, allowSignedBinary: true },
      )
      const signedContent = await applicationContent(signedApp, 'darwin')
      assert.deepEqual(
        validateAgySqliteFileManifest({
          platform: 'darwin',
          arch: process.arch,
          agySqliteFile: signedRecord,
          application: { entries: signedContent.entries },
        }),
        signedRecord,
      )
      // Tamper code bytes and re-sign with a valid ad-hoc signature: MUST be rejected by pre-sig hash BEFORE codesign/dlopen!
      const swapped = await readFile(copiedBin)
      swapped[Math.min(4096, swapped.length - 1)] ^= 0xff
      await writeFile(copiedBin, swapped)
      await promisify(execFile)(
        '/usr/bin/codesign',
        ['--force', '--sign', '-', '--options', 'runtime', copiedBin],
        { shell: false, timeout: 10_000, maxBuffer: 64 * 1024 },
      )
      await assert.rejects(
        inspectAgySqliteFileResource(nativeDir, 'darwin', process.arch, sourceSha256, {
          verifyLoad: true,
          allowSignedBinary: true,
        }),
        /pre-signature digest/u,
      )
    }
  }
})
