import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises'
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
    assert.equal(report.tiers.core.passed, 29)
    assert.equal(JSON.stringify(report).includes('synthetic-nonfunctional-report-canary'), false)
    await assert.rejects(lstat(join(privateRoot, '..')), /ENOENT/)
    assert.equal(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, previous)
    assert.equal(process.env.PACT_E2E_OUTPUT_DIR, before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('configuration admission failure still gets 61 case statuses without exposing its exception or spawning', async () => {
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
    assert.equal(report.cases.length, 61)
    assert.equal(report.gatePassed, false)
    assert.equal(report.tiers.core.notRun, 29)
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
