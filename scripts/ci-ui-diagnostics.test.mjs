import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { collectUiDiagnostics, diagnosticLimits, main } from './ci-ui-diagnostics.mjs'

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'pact-ui-diagnostics-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'test-results'),
    output = join(root, 'collected')
  await mkdir(source)
  const addCase = async (name = 'test-case') => {
    const path = join(source, name)
    await mkdir(path)
    return path
  }
  return { root, source, output, addCase }
}

await test('copies only exact no-credential diagnostic names with authentic byte hashes', async (context) => {
  const f = await fixture(context),
    directory = await f.addCase()
  const content = 'Synthetic read-only UI snapshot\n'
  await writeFile(join(directory, 'error-context.md'), content)
  await writeFile(join(directory, 'trace.zip'), Buffer.from([0x50, 0x4b, 0, 1]))
  await writeFile(join(directory, 'auth.json'), 'synthetic-ignored-auth')
  const report = await collectUiDiagnostics(f.source, f.output)
  assert.equal(report.sourcePresent, true)
  assert.equal(report.files.length, 2)
  assert.equal(report.totalBytes, Buffer.byteLength(content) + 4)
  assert.deepEqual(
    report.files.find((file) => file.path.endsWith('error-context.md')),
    {
      path: 'test-case/error-context.md',
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    },
  )
  assert.equal(await readFile(join(f.output, 'test-case/error-context.md'), 'utf8'), content)
  await assert.rejects(readFile(join(f.output, 'test-case/auth.json')), { code: 'ENOENT' })
  assert.deepEqual(JSON.parse(await readFile(join(f.output, 'inventory.json'), 'utf8')), report)
})

await test('keeps an explicit empty inventory when a prior build failed before Playwright existed', async (context) => {
  const f = await fixture(context)
  await rm(f.source, { recursive: true })
  assert.deepEqual(await collectUiDiagnostics(f.source, f.output), {
    files: [],
    sourcePresent: false,
  })
})

await test('preserves existing output and refuses contained output paths including two-dot names', async (context) => {
  const f = await fixture(context)
  await mkdir(f.output)
  await writeFile(join(f.output, 'recovery.txt'), 'preserve')
  await assert.rejects(collectUiDiagnostics(f.source, f.output), { code: 'EEXIST' })
  assert.equal(await readFile(join(f.output, 'recovery.txt'), 'utf8'), 'preserve')
  await assert.rejects(
    collectUiDiagnostics(f.source, join(f.source, '..notes')),
    /separate explicit/,
  )
  await assert.rejects(collectUiDiagnostics(f.source, f.root), /separate explicit/)
  await assert.rejects(collectUiDiagnostics('relative/test-results', f.output), /separate explicit/)
})

await test('refuses linked cases and linked files while retaining the source and outside data', async (context) => {
  const f = await fixture(context)
  const outside = join(f.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'error-context.md'), 'preserve outside')
  await symlink(outside, join(f.source, 'linked-case'), 'dir')
  await assert.rejects(collectUiDiagnostics(f.source, f.output), /symlinks/)
  assert.equal(await readFile(join(outside, 'error-context.md'), 'utf8'), 'preserve outside')
  await assert.rejects(readFile(join(f.output, 'inventory.json')), { code: 'ENOENT' })
  await rm(join(f.source, 'linked-case'))
  const directory = await f.addCase()
  await symlink(join(outside, 'error-context.md'), join(directory, 'error-context.md'), 'file')
  await assert.rejects(collectUiDiagnostics(f.source, f.output), /non-file/)
  assert.equal(await readFile(join(outside, 'error-context.md'), 'utf8'), 'preserve outside')
})

await test('does not upload oversized context or trace files and removes its incomplete collection', async (context) => {
  const f = await fixture(context),
    directory = await f.addCase()
  const path = join(directory, 'trace.zip')
  await writeFile(path, '')
  await truncate(path, diagnosticLimits.traceBytes + 1)
  await assert.rejects(collectUiDiagnostics(f.source, f.output), /bounded regular file/)
  await assert.rejects(readFile(join(f.output, 'inventory.json')), { code: 'ENOENT' })
  await rm(path)
  await writeFile(
    join(directory, 'error-context.md'),
    'x'.repeat(diagnosticLimits.contextBytes + 1),
  )
  await assert.rejects(collectUiDiagnostics(f.source, f.output), /bounded regular file/)
})

await test('retains a fixed total byte bound across cases without truncating the final trace', async (context) => {
  const f = await fixture(context)
  for (let index = 0; index < 3; index++) {
    // oxlint-disable-next-line no-await-in-loop -- Establish three independent owned case files before the one collector call.
    const directory = await f.addCase(`test-${index}`)
    const path = join(directory, 'trace.zip')
    // oxlint-disable-next-line no-await-in-loop -- Create the explicit sparse file before setting its physical size.
    await writeFile(path, '')
    // oxlint-disable-next-line no-await-in-loop -- Each source remains within its individual bound but the group exceeds the total.
    await truncate(path, diagnosticLimits.traceBytes)
  }
  await assert.rejects(collectUiDiagnostics(f.source, f.output), /bounded regular file/)
  await assert.rejects(readFile(join(f.output, 'inventory.json')), { code: 'ENOENT' })
})

await test('bounds case enumeration even when unrelated files would otherwise be ignored', async (context) => {
  const f = await fixture(context),
    directory = await f.addCase()
  await Promise.all(
    Array.from({ length: 9 }, (_, index) => writeFile(join(directory, `ignored-${index}`), '')),
  )
  await assert.rejects(collectUiDiagnostics(f.source, f.output), /entry bound/)
})

await test('CLI admission requires an explicitly uncredentialed GitHub lane', async () => {
  await assert.rejects(
    main(['--source', '/tmp/test-results', '--output', '/tmp/output'], {}),
    /no-credential/,
  )
  await assert.rejects(
    main(['--source', '/tmp/test-results', '--output', '/tmp/output'], {
      GITHUB_ACTIONS: 'true',
      PACT_CI_DIAGNOSTIC_LANE: 'real',
    }),
    /no-credential/,
  )
})
