import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'

import { distributionBuilderArguments } from './build-distribution.mjs'

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
