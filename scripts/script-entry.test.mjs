import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

await test('a CLI launched through a directory alias executes, while importing it preserves API-only behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-entry-'))
  try {
    const actual = join(root, 'actual'),
      alias = join(root, 'alias')
    await mkdir(actual)
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const source = `import {isScriptEntry} from ${JSON.stringify(new URL('./script-entry.mjs', import.meta.url).href)}; if(isScriptEntry(import.meta.url)) process.stdout.write('executed'); export const value=42;`
    await writeFile(join(actual, 'entry.mjs'), source)
    assert.equal(
      execFileSync(process.execPath, [join(alias, 'entry.mjs')], {
        encoding: 'utf8',
        timeout: 5000,
      }),
      'executed',
    )
    await writeFile(
      join(actual, 'importer.mjs'),
      "import './entry.mjs';process.stdout.write('imported')",
    )
    assert.equal(
      execFileSync(process.execPath, [join(alias, 'importer.mjs')], {
        encoding: 'utf8',
        timeout: 5000,
      }),
      'imported',
    )
    assert.equal(
      execFileSync(process.execPath, ['--input-type=module', '-'], {
        input: `import ${JSON.stringify(pathToFileURL(join(alias, 'entry.mjs')).href)};process.stdout.write('imported')`,
        encoding: 'utf8',
        timeout: 5000,
      }),
      'imported',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
