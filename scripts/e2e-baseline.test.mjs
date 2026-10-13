import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { readE2EBaseline } from './e2e-baseline.mjs'

await test('the public snapshot retains the original source files and revision without old Git objects', () => {
  const baseline = readE2EBaseline()
  assert.equal(baseline.revision, '6fade3636a7d77060ec4b35a50cdd764e3726228')
  assert.equal(Object.keys(baseline.files).length, 21)
  assert.match(baseline.files['tests/e2e/anchored-comments.spec.ts'], /test\(/u)
})

await test('missing, changed and oversized baseline data cannot silently establish new obligations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-baseline-'))
  const path = join(directory, 'baseline.json')
  try {
    assert.throws(() => readE2EBaseline(path))
    const bytes = await readFile(new URL('../tests/e2e/baseline.json', import.meta.url))
    await writeFile(path, Buffer.concat([bytes, Buffer.from(' ')]))
    assert.throws(() => readE2EBaseline(path), /integrity/u)
    await writeFile(path, Buffer.alloc(1024 * 1024 + 1))
    assert.throws(() => readE2EBaseline(path), /byte bound/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
