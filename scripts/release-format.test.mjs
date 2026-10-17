import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import configuration from '../oxfmt.config.ts'

const formatter = fileURLToPath(new URL('../node_modules/oxfmt/bin/oxfmt', import.meta.url))
const generatedPaths = ['CHANGELOG.md', '.release-please-manifest.json']

// Exact Release Please 17.3.0 output captured from the first version PR (#13).
const firstChangelog = `# Changelog

## 0.1.0 (2026-10-17)


### Features

* integrate Mac and Windows native CI and releases ([#12](https://github.com/mbaxszy7/Pact/issues/12)) ([6f475ee](https://github.com/mbaxszy7/Pact/commit/6f475ee4ddd1d47095b2fddd96998f8b814d4646))


### Bug Fixes

* **ci:** stabilize fixture readiness and platform reruns ([#10](https://github.com/mbaxszy7/Pact/issues/10)) ([c7285da](https://github.com/mbaxszy7/Pact/commit/c7285da5595c91eee6bd16efbe5696acf30bb731))
* **desktop:** install Electron binary before rebuilding native dependencies ([1ec52ea](https://github.com/mbaxszy7/Pact/commit/1ec52ea5d3e087e9122fb36b79ceed9cf0414c00))
* **e2e:** locate project by its current accessible name ([acc77c1](https://github.com/mbaxszy7/Pact/commit/acc77c197f8846e052a10c7053f05b0a5483cb33))

## Changelog

Release Please records user-facing changes here when it prepares a release pull request.
`

// Same pinned template on a later release, retaining the previous history.
// This proves format compatibility, not a future live publication cycle.
const nextChangelog = firstChangelog.replace(
  '# Changelog\n\n',
  `# Changelog

## [0.2.0](https://github.com/mbaxszy7/Pact/compare/v0.1.0...v0.2.0) (2026-10-18)


### Features

* a subsequent release ([#20](https://github.com/mbaxszy7/Pact/issues/20))

`,
)

function invoke(root, args) {
  const result = spawnSync(
    process.execPath,
    [formatter, '--config', join(root, 'oxfmt.json'), '--threads', '1', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: Object.fromEntries(
        ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      ),
    },
  )
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

async function fixture(t, changelog = firstChangelog, version = '0.1.0') {
  // Oxfmt resolves file paths before matching config-rooted ignores; macOS /var is a symlink.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-release-format-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'oxfmt.json'), `${JSON.stringify(configuration, null, 2)}\n`)
  const setup = invoke(root, ['--write', 'oxfmt.json'])
  assert.equal(setup.status, 0, setup.output)
  const generated = {
    'CHANGELOG.md': changelog,
    '.release-please-manifest.json': `${JSON.stringify({ '.': version })}\n`,
  }
  await Promise.all(
    Object.entries({ ...generated, 'source.ts': 'export const value = 1\n' }).map(
      ([path, content]) => writeFile(join(root, path), content),
    ),
  )
  return { root, generated }
}

for (const [name, changelog, version] of [
  ['first', firstChangelog, '0.1.0'],
  ['subsequent', nextChangelog, '0.2.0'],
]) {
  void test(`${name} generated release passes directory and explicit-file checks without rewriting vendor bytes`, async (t) => {
    const { root, generated } = await fixture(t, changelog, version)
    for (const args of [
      ['--check', '.'],
      ['--check', '--no-error-on-unmatched-pattern', ...generatedPaths],
      ['--write', '.'],
      ['--write', '--no-error-on-unmatched-pattern', ...generatedPaths],
    ]) {
      const result = invoke(root, args)
      assert.equal(result.status, 0, result.output)
    }
    const contents = await Promise.all(
      generatedPaths.map((path) => readFile(join(root, path), 'utf8')),
    )
    assert.deepEqual(
      contents,
      generatedPaths.map((path) => generated[path]),
    )
  })
}

for (const [path, content] of [
  ['source.ts', 'export const value=1\n'],
  ['version.json', '{"version":"0.2.0"}\n'],
  ['release-please-config.json', '{"release-type":"node","initial-version":"0.1.0"}\n'],
  ['docs/CHANGELOG.md', nextChangelog],
]) {
  void test(`authored ${path} remains subject to Oxfmt`, async (t) => {
    const { root } = await fixture(t)
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
    const result = invoke(root, ['--check', '.'])
    assert.equal(result.status, 1, result.output)
    assert.ok(result.output.replaceAll('\\', '/').includes(path), result.output)
  })
}
