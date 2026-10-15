/* oxlint-disable eslint/no-await-in-loop -- Each supervisor fixture owns its complete filesystem lifetime before the next scenario starts. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { main, recoverSoakSqlitePrefix, validateSoakObservation } from './run-soak.mjs'
import { completeSqliteObservation, sqlitePlanPagePayload } from './soak-statistics.mjs'

const manifest = {
  sourceSha: 'a'.repeat(40),
  version: '0.1.0',
  channel: 'stable',
  platform: process.platform,
  arch: process.arch,
}
const epoch = '00000000-0000-4000-8000-000000000001'
function frame() {
  const page = {
    observerEpoch: epoch,
    pageSequence: 1,
    firstRecordSequence: 1,
    lastRecordSequence: 1,
    operationWatermark: 1,
    recordWatermark: 1,
    records: [
      {
        recordSequence: 1,
        schemaVersion: 1,
        sqlSha256: 'b'.repeat(64),
        details: ['SCAN CONSTANT ROW'],
      },
    ],
  }
  return {
    schemaVersion: 1,
    ...manifest,
    observerPid: 41001,
    page: {
      ...page,
      payloadDigest: createHash('sha256')
        .update(JSON.stringify(sqlitePlanPagePayload(page)))
        .digest('hex'),
    },
  }
}
const name = `sqlite-page-${epoch}-1.json`

await test('a crashed driver retains a verified disk prefix without inventing ACKs or a final seal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-soak-prefix-'))
  try {
    assert.equal(await recoverSoakSqlitePrefix(root, manifest), null)
    await mkdir(join(root, 'fixture'), { mode: 0o700 })
    await writeFile(join(root, 'fixture', name), JSON.stringify(frame()), {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    })
    const recovered = await recoverSoakSqlitePrefix(root, manifest)
    assert.equal(recovered.status, 'unsealed-recovered-prefix')
    assert.equal(recovered.sqliteQueryPlanDictionary.length, 1)
    assert.equal(recovered.sqliteObservation.epochs[0].savedThrough, 1)
    assert.equal(recovered.sqliteObservation.epochs[0].acknowledgedThrough, 0)
    assert.equal(recovered.sqliteObservation.epochs[0].final, undefined)
    assert.equal(completeSqliteObservation(recovered), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('recovery rejects changed identity and an invalid page without deleting either file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-soak-bad-prefix-'))
  try {
    await mkdir(join(root, 'fixture'), { mode: 0o700 })
    const path = join(root, 'fixture', name)
    const bytes = JSON.stringify({ ...frame(), sourceSha: 'c'.repeat(40) })
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    await assert.rejects(recoverSoakSqlitePrefix(root, manifest))
    assert.equal(await readFile(path, 'utf8'), bytes)
    const bad = frame()
    bad.page.records[0].details = ['changed plan']
    await writeFile(path, JSON.stringify(bad))
    await assert.rejects(recoverSoakSqlitePrefix(root, manifest))
    assert.equal(await readFile(path, 'utf8'), JSON.stringify(bad))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('a redirected page or oversized file cannot be recovered or treated as a completed run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-soak-redirected-prefix-'))
  try {
    await mkdir(join(root, 'fixture'), { mode: 0o700 })
    const original = join(root, 'retained.json'),
      path = join(root, 'fixture', name)
    await writeFile(original, JSON.stringify(frame()), { flag: 'wx', mode: 0o600 })
    await symlink(original, path, process.platform === 'win32' ? 'file' : undefined)
    await assert.rejects(recoverSoakSqlitePrefix(root, manifest))
    assert.equal(await readFile(original, 'utf8'), JSON.stringify(frame()))
    await rm(path)
    await writeFile(path, 'x'.repeat(32 * 1024 + 1), { flag: 'wx', mode: 0o600 })
    await assert.rejects(recoverSoakSqlitePrefix(root, manifest))
    assert.equal((await readFile(path)).length, 32 * 1024 + 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function supervisorProbe(action, inspect) {
  const directory = await mkdtemp(join(tmpdir(), 'pact-soak-supervisor-'))
  const reportPath = join(directory, 'report.json')
  let root,
    disposed = false
  const product = {
    ...manifest,
    productName: 'Pact',
    application: { contentSha256: 'd'.repeat(64), entries: [] },
    artifacts: [],
  }
  try {
    await assert.rejects(
      main(
        [
          '--manifest',
          join(directory, 'manifest.json'),
          '--duration-ms',
          '1000',
          '--report',
          reportPath,
        ],
        { RUNNER_TEMP: directory },
        {
          readManifest: async () => product,
          prepare: async (options) => {
            root = options.root
            if (action === 'prepare-preserve')
              throw Object.assign(new Error('Private installer detail'), { preserveRoot: true })
            return {
              executable: process.execPath,
              applicationPath: root,
              installationVerified: true,
              verificationMode: 'installed-nsis',
              dispose: async () => {
                disposed = true
              },
            }
          },
          runDriver: async (args, _timeout, options) => {
            const settings = JSON.parse(await readFile(args.at(-1), 'utf8'))
            options.onState({
              groupGone: action !== 'process-owned',
              ownedProcessCount: action === 'process-owned' ? 1 : 0,
            })
            if (typeof action === 'function') await action(settings)
            return 1
          },
          inspectContent: async () => ({ sha256: product.application.contentSha256, entries: [] }),
        },
      ),
    )
    const reportBytes = await readFile(reportPath, 'utf8')
    const snapshots = await Promise.all(
      (await readdir(directory))
        .filter((entryName) => entryName.includes('.recovery-'))
        .map((entryName) => readFile(join(directory, entryName), 'utf8')),
    )
    await inspect({
      root,
      disposed,
      report: JSON.parse(reportBytes),
      exported: [reportBytes, ...snapshots].join('\n'),
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

await test('supervisor retains an installer recovery root even when preparation never returned', async () => {
  await supervisorProbe('prepare-preserve', async ({ root, disposed, report }) => {
    assert((await lstat(root)).isDirectory())
    assert.equal(disposed, false)
    assert.equal(report.recoveryEvidenceRetained, true)
    assert.equal(report.cleanupVerified, false)
    assert.equal(report.status, 'blocked')
  })
})

await test('supervisor never runs an uninstaller while the owned process group is unconfirmed', async () => {
  await supervisorProbe('process-owned', async ({ root, disposed, report }) => {
    assert((await lstat(root)).isDirectory())
    assert.equal(disposed, false)
    assert.equal(report.recoveryEvidenceRetained, true)
    assert.equal(report.status, 'blocked')
  })
})

await test('unknown top-level and nested report fields stay private, including on failure', async () => {
  for (const payload of [
    { durationMs: 1, nonce: 'PRIVATE_NONCE_SENTINEL' },
    { sqliteObservation: { schemaVersion: 1, epochs: [{ nonce: 'PRIVATE_NONCE_SENTINEL' }] } },
    { resourceSamples: [{ utility: { activeResources: { PRIVATE_NONCE_SENTINEL: 1 } } }] },
  ]) {
    await supervisorProbe(
      async (settings) => {
        await writeFile(settings.observation, JSON.stringify(payload), { flag: 'wx', mode: 0o600 })
      },
      async ({ root, report, exported }) => {
        assert((await lstat(root)).isDirectory())
        assert.equal(report.recoveryEvidenceRetained, true)
        assert.equal(report.status, 'blocked')
        assert(!exported.includes('PRIVATE_NONCE_SENTINEL'))
      },
    )
  }
})

await test('malformed and oversized observations retain their original recovery files', async () => {
  for (const bytes of ['{malformed', 'x'.repeat(768 * 1024 + 1)]) {
    await supervisorProbe(
      async (settings) => {
        await writeFile(settings.observation, bytes, { flag: 'wx', mode: 0o600 })
      },
      async ({ root, report }) => {
        assert.equal(await readFile(join(root, 'observations.json'), 'utf8'), bytes)
        assert.equal(report.recoveryEvidenceRetained, true)
      },
    )
  }
})

await test('a missing observation publishes its verified recovered prefix before private cleanup', async () => {
  await supervisorProbe(
    async (settings) => {
      await writeFile(join(settings.dataRoot, name), JSON.stringify(frame()), {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      })
    },
    async ({ root, disposed, report }) => {
      await assert.rejects(lstat(root), { code: 'ENOENT' })
      assert.equal(disposed, true)
      assert.equal(report.sqlitePlanRecovery.status, 'unsealed-recovered-prefix')
      assert.equal(report.sqlitePlanRecovery.sqliteObservation.epochs[0].acknowledgedThrough, 0)
      assert.equal(report.cleanupVerified, false)
      assert.equal(report.status, 'blocked')
    },
  )
})

await test('the export validator keeps measured failure counters and returns an isolated projection', () => {
  const value = {
    durationMs: 1,
    cleanupVerified: false,
    missingObservations: ['complete-ipc-traffic'],
    ipcTraffic: {
      observed: false,
      complete: false,
      issues: [
        'missing-ipc-owner',
        'uncovered:renderer-monaco-workers',
        'main-utility:counter-reset',
      ],
    },
  }
  const safe = validateSoakObservation(value)
  assert.deepEqual(safe, value)
  safe.missingObservations.push('other')
  assert.equal(value.missingObservations.length, 1)
})
