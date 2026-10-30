import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { realCases } from './real-e2e-policy.mjs'
import { mainWithReports } from './run-e2e.mjs'

function reportFixture() {
  return {
    errors: [],
    config: { privateConfig: 'synthetic-nonfunctional-report-canary' },
    suites: [
      {
        specs: realCases
          .filter((item) => item.tier === 'core')
          .map((item) => ({
            title: item.title,
            file: item.path,
            tags: ['real', 'real-core'],
            tests: [
              {
                projectName: 'real',
                expectedStatus: 'passed',
                status: 'expected',
                results: [{ status: 'passed', duration: 1 }],
              },
            ],
          })),
      },
    ],
  }
}
async function saved(root) {
  const directory = join(root, '.pact-data', 'e2e-reports'),
    entries = await readdir(directory)
  assert.equal(entries.length, 1)
  return JSON.parse(await readFile(join(directory, entries[0], 'real-summary.json'), 'utf8'))
}

await test('local core execution keeps a safe immutable report, restores environment and removes raw data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-local-e2e-report-test-'))
  const previous = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE
  const before = process.env.PACT_E2E_OUTPUT_DIR
  let privateRoot,
    builds = 0,
    admitted = false
  try {
    const code = await mainWithReports({
      lane: 'real',
      realScope: 'core',
      reportWorkspace: root,
      loadConfiguration: async () => {
        admitted = true
        return { redact: (text) => text, assertSourceIntegrity: async () => {} }
      },
      runJob: async (args) => {
        assert.equal(admitted, true)
        privateRoot = process.env.PACT_E2E_OUTPUT_DIR
        if (args[0] === 'build') {
          builds++
          return 0
        }
        await writeFile(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify(reportFixture()))
        return 0
      },
    })
    assert.equal(code, 0)
    assert.equal(builds, 1)
    const report = await saved(root)
    assert.equal(report.gatePassed, true)
    assert.equal(report.tiers.core.passed, 1)
    assert.equal(JSON.stringify(report).includes('synthetic-nonfunctional-report-canary'), false)
    await assert.rejects(lstat(join(privateRoot, '..')), /ENOENT/)
    assert.equal(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, previous)
    assert.equal(process.env.PACT_E2E_OUTPUT_DIR, before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('configuration admission failure still reports every reviewed case without exposing its exception or spawning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-local-e2e-admission-test-'))
  try {
    await assert.rejects(
      mainWithReports({
        lane: 'real',
        realScope: 'core',
        reportWorkspace: root,
        loadConfiguration: async () => {
          throw new Error('synthetic-nonfunctional-private-exception')
        },
        runJob: async () => assert.fail('No discovery or build before admission'),
      }),
      /unsafe exception details/,
    )
    const report = await saved(root)
    assert.equal(report.cases.length, realCases.length)
    assert.deepEqual(
      report.cases.map(({ path, title }) => ({ path, title })),
      realCases.map(({ path, title }) => ({ path, title })),
    )
    assert.equal(report.gatePassed, false)
    assert.equal(report.tiers.core.notRun, 1)
    assert.equal(
      JSON.stringify(report).includes('synthetic-nonfunctional-private-exception'),
      false,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('core narrowed arguments cannot start a build and are reported as unavailable execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-local-e2e-narrowing-test-'))
  try {
    await assert.rejects(
      mainWithReports({
        lane: 'real',
        realScope: 'core',
        reportWorkspace: root,
        forwarded: ['--grep', 'selected'],
        runJob: async () => assert.fail('Must not run'),
      }),
      /narrowed/,
    )
    const report = await saved(root)
    assert.equal(report.gatePassed, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('a failed local deterministic lane preserves bounded traces beside its safe report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-local-e2e-diagnostics-test-'))
  let privateArtifacts
  try {
    const code = await mainWithReports({
      lane: 'deterministic',
      reportWorkspace: root,
      loadConfiguration: async () => ({
        redact: (text) => text,
        assertSourceIntegrity: async () => {},
      }),
      runJob: async (args) => {
        privateArtifacts = process.env.PACT_E2E_OUTPUT_DIR
        if (args[0] === 'build') return 0
        await writeFile(
          process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,
          JSON.stringify({ suites: [], config: { private: 'raw-execution-only-canary' } }),
        )
        if (args.includes('--list')) return 0
        const output = join(privateArtifacts, 'visibility-failed-deterministic')
        await mkdir(output, { recursive: true, mode: 0o700 })
        await writeFile(join(output, 'trace.zip'), 'owned-no-credential-trace')
        await writeFile(join(output, 'error-context.md'), 'owned fixture snapshot')
        return 1
      },
    })
    assert.equal(code, 1)
    const reports = join(root, '.pact-data', 'e2e-reports')
    const candidates = await Promise.all(
      (await readdir(reports)).map(async (entry) => {
        const candidate = join(reports, entry)
        return (await readdir(candidate)).includes('diagnostics.md') ? candidate : undefined
      }),
    )
    const evidence = candidates.find(Boolean)
    assert.ok(evidence)
    const artifacts = join(evidence, 'diagnostics')
    const inventory = JSON.parse(await readFile(join(artifacts, 'inventory.json'), 'utf8'))
    assert.equal(inventory.lane, 'deterministic')
    assert.equal(inventory.sourcePresent, true)
    assert.equal(inventory.files.length, 2)
    assert.equal(
      await readFile(join(artifacts, 'visibility-failed-deterministic', 'trace.zip'), 'utf8'),
      'owned-no-credential-trace',
    )
    assert.equal((await readdir(evidence)).includes('execution.json'), false)
    assert.equal(JSON.stringify(inventory).includes('raw-execution-only-canary'), false)
    await assert.rejects(lstat(join(privateArtifacts, '..')), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
