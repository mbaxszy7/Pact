import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  collectUiDiagnostics,
  collectNoCredentialDiagnostics,
  diagnosticLimits,
  evaluateUiReport,
  main,
  uiReportMarkdown,
  writeUiReports,
} from './ci-ui-diagnostics.mjs'

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

await test('two lanes share the original total byte cap and preserve a completed first collection when the second exceeds it', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-two-lane-cap-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const evidence = join(root, 'evidence'),
    output = join(root, 'output')
  await mkdir(join(evidence, 'ui/test-results/first'), { recursive: true })
  await mkdir(join(evidence, 'deterministic/test-results/second'), { recursive: true })
  const first = join(evidence, 'ui/test-results/first/trace.zip')
  const second = join(evidence, 'deterministic/test-results/second/trace.zip')
  await writeFile(first, '')
  await truncate(first, diagnosticLimits.traceBytes)
  await writeFile(second, '')
  await truncate(second, diagnosticLimits.traceBytes)
  await writeFile(
    join(evidence, 'deterministic/test-results/second/error-context.md'),
    'over total cap',
  )
  await assert.rejects(collectNoCredentialDiagnostics(evidence, output), /bounded regular file/)
  assert.equal(
    (await readFile(join(output, 'ui/first/trace.zip'))).length,
    diagnosticLimits.traceBytes,
  )
  const inventory = JSON.parse(await readFile(join(output, 'inventory.json'), 'utf8'))
  assert.equal(inventory.complete, false)
  assert.equal(inventory.failedLane, 'deterministic')
  assert.equal(inventory.totalBytes, diagnosticLimits.traceBytes)
  assert.equal(inventory.lanes[0].lane, 'ui')
  assert.equal((await readFile(first)).length, diagnosticLimits.traceBytes)
  assert.equal((await readFile(second)).length, diagnosticLimits.traceBytes)
})

await test('accepts exactly 32 MiB across two complete traces without truncation or per-lane budget doubling', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-two-lane-exact-cap-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const evidence = join(root, 'evidence'),
    output = join(root, 'output')
  for (const lane of ['ui', 'deterministic']) {
    const directory = join(evidence, lane, 'test-results/only-case')
    // oxlint-disable-next-line no-await-in-loop -- Create both independently scoped explicit no-credential lane roots.
    await mkdir(directory, { recursive: true })
    // oxlint-disable-next-line no-await-in-loop -- Keep a complete fixed-size source for descriptor-bound copying.
    await writeFile(join(directory, 'trace.zip'), '')
    // oxlint-disable-next-line no-await-in-loop -- Each complete trace is within the unchanged individual 16 MiB limit.
    await truncate(join(directory, 'trace.zip'), diagnosticLimits.traceBytes)
  }
  const inventory = await collectNoCredentialDiagnostics(evidence, output)
  assert.equal(inventory.complete, true)
  assert.equal(inventory.totalBytes, diagnosticLimits.totalBytes)
  assert.equal(inventory.totalFiles, 2)
  for (const lane of ['ui', 'deterministic']) {
    // oxlint-disable-next-line no-await-in-loop -- Verify no trace was truncated to satisfy the cross-lane total.
    const trace = await readFile(join(output, lane, 'only-case/trace.zip'))
    assert.equal(trace.length, diagnosticLimits.traceBytes)
  }
})

await test('aggregation refuses real/unknown directories, symlinked lanes and capacity inflation before copying', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-diagnostic-lane-guard-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const evidence = join(root, 'evidence'),
    output = join(root, 'output')
  await mkdir(join(evidence, 'real'), { recursive: true })
  await assert.rejects(collectNoCredentialDiagnostics(evidence, output), /explicit no-credential/)
  await rm(join(evidence, 'real'), { recursive: true })
  await writeFile(join(evidence, 'real.json'), '{}')
  await assert.rejects(collectNoCredentialDiagnostics(evidence, output), /explicit no-credential/)
  await rm(join(evidence, 'real.json'))
  await mkdir(join(evidence, 'unknown'))
  await assert.rejects(collectNoCredentialDiagnostics(evidence, output), /explicit no-credential/)
  await rm(join(evidence, 'unknown'), { recursive: true })
  const outside = join(root, 'outside')
  await mkdir(outside)
  await symlink(outside, join(evidence, 'ui'), 'dir')
  await assert.rejects(collectNoCredentialDiagnostics(evidence, output), /regular contained/)
  await assert.rejects(
    collectUiDiagnostics(join(root, 'test-results'), output, { lane: 'real' }),
    /no-credential/,
  )
  await assert.rejects(
    collectUiDiagnostics(join(root, 'test-results'), output, {
      remainingBytes: diagnosticLimits.totalBytes + 1,
    }),
    /bounded/,
  )
  await assert.rejects(
    main(['--evidence', evidence, '--output', output], {
      GITHUB_ACTIONS: 'true',
      PACT_CI_DIAGNOSTIC_LANE: 'real',
    }),
    /no-credential/,
  )
})

await test('two lanes also share the existing case/path capacity and cannot overwrite an old collection', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-two-lane-case-cap-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const evidence = join(root, 'evidence'),
    output = join(root, 'output')
  await mkdir(join(evidence, 'ui/test-results'), { recursive: true })
  await mkdir(join(evidence, 'deterministic/test-results/overflow-case'), { recursive: true })
  await Promise.all(
    Array.from({ length: diagnosticLimits.cases }, (_, index) =>
      mkdir(join(evidence, 'ui/test-results', `case-${index}`)),
    ),
  )
  await assert.rejects(collectNoCredentialDiagnostics(evidence, output), /case bound/)
  const inventory = JSON.parse(await readFile(join(output, 'inventory.json'), 'utf8'))
  assert.equal(inventory.totalCases, diagnosticLimits.cases)
  assert.equal(inventory.complete, false)
  await writeFile(join(output, 'recovery.txt'), 'retain first collection')
  await assert.rejects(collectNoCredentialDiagnostics(evidence, output), { code: 'EEXIST' })
  assert.equal(await readFile(join(output, 'recovery.txt'), 'utf8'), 'retain first collection')
})

const reportFixture = (lane = 'ui') => ({
  suites: [
    {
      specs: [
        {
          file: 'native-ui.spec.ts',
          title: 'opens the controlled native window',
          tests: [
            {
              projectName: lane,
              expectedStatus: 'passed',
              status: 'expected',
              results: [{ status: 'passed', duration: 12 }],
            },
          ],
        },
      ],
    },
  ],
  errors: [],
})
const reportIdentity = {
  schemaVersion: 3,
  repository: 'mbaxszy7/Pact',
  repositoryId: 1416403312,
  pullRequest: 3,
  headRepositoryId: 1416403312,
  authorId: 31481964,
  channel: 'dev',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  candidateSha: 'c'.repeat(40),
  treeSha: 'd'.repeat(40),
  policySha: 'b'.repeat(40),
  sourceKind: 'main',
  controllerSha: 'b'.repeat(40),
  controllerRef: 'refs/heads/main',
  product: {
    before: { version: '0.1.0', candidateVersion: '0.1.0-unreleased' },
    after: { version: '0.1.0', candidateVersion: '0.1.0-unreleased' },
  },
}
const reportOptions = {
  lane: 'ui',
  inventory: reportFixture(),
  workspace: '/workspace/Pact',
  identity: reportIdentity,
  execution: 'completed',
  platform: 'darwin',
  architecture: 'arm64',
}

await test('no-credential reports show actual failure status and fixed categories without raw output or attachments', () => {
  const raw = reportFixture(),
    secret = 'synthetic-private-report-output'
  const result = raw.suites[0].specs[0].tests[0]
  Object.assign(result.results[0], {
    status: 'timedOut',
    error: { message: secret, stack: secret },
    stdout: [{ text: secret }],
    attachments: [{ path: secret }],
  })
  raw.config = { secret }
  const report = evaluateUiReport(raw, reportOptions)
  assert.equal(report.informational, true)
  assert.equal(Object.hasOwn(report, 'gatePassed'), false)
  assert.equal(report.cases[0].status, 'timedOut')
  assert.equal(report.cases[0].durationMs, 12)
  assert.equal(report.cases[0].failureCategory, 'case-timeout')
  assert.equal((JSON.stringify(report) + uiReportMarkdown(report)).includes(secret), false)
  assert.equal(report.identity.treeSha, reportIdentity.treeSha)
})

await test('missing and cancelled executions retain every discovered case and never invent a passing outcome', () => {
  const report = evaluateUiReport(null, { ...reportOptions, execution: 'unavailable' })
  assert.equal(report.cases.length, 1)
  assert.equal(report.cases[0].status, 'not-run')
  assert(report.issues.includes('runner-or-preparation-failed'))
  assert(report.issues.includes('missing-or-invalid-execution-evidence'))
  assert.equal(report.counts.passed, 0)
  const repeated = reportFixture()
  repeated.suites[0].specs[0].tests[0].results.push({ status: 'passed', duration: 1 })
  assert(evaluateUiReport(repeated, reportOptions).issues.includes('missing-result-or-retries'))
})

await test('candidate-controlled unknown titles and identity extensions cannot enter public report text', () => {
  const secret = 'synthetic-untrusted-case-title',
    raw = reportFixture()
  raw.suites[0].specs[0].title = secret
  const report = evaluateUiReport(raw, {
    ...reportOptions,
    identity: { ...reportIdentity, extra: secret },
  })
  assert(report.issues.includes('case-absent-from-discovery-inventory'))
  assert.equal(report.cases[0].status, 'not-run')
  assert.equal(report.cases[1].title, 'Unclassified case 1')
  assert.equal((JSON.stringify(report) + uiReportMarkdown(report)).includes(secret), false)
})

await test('native Windows-only appearance is declared non-applicable on macOS without treating another skip as success', () => {
  const raw = reportFixture()
  raw.suites[0].specs[0].file = 'appearance.spec.ts'
  raw.suites[0].specs[0].title =
    'Windows keeps page Alpha and native controls while Solid remains opaque'
  raw.suites[0].specs[0].tests[0].results[0].status = 'skipped'
  const report = evaluateUiReport(raw, { ...reportOptions, inventory: structuredClone(raw) })
  assert.equal(report.cases[0].status, 'not-applicable')
  assert.equal(report.cases[0].required, false)
  const windows = evaluateUiReport(raw, {
    ...reportOptions,
    inventory: structuredClone(raw),
    platform: 'win32',
    architecture: 'x64',
  })
  assert.equal(windows.cases[0].status, 'skipped')
  assert.equal(windows.cases[0].required, true)
})

await test('both native lane reports persist even when the second lane did not start, and Actions summary points to reports and diagnostics', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-ui-reports-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const evidence = join(root, 'evidence'),
    identityPath = join(root, 'identity.json'),
    inventoryPath = join(root, 'inventory.json'),
    summary = join(root, 'summary.md')
  await mkdir(evidence)
  const inventory = {
    suites: [...reportFixture('ui').suites, ...reportFixture('deterministic').suites],
  }
  await writeFile(identityPath, JSON.stringify(reportIdentity))
  await writeFile(inventoryPath, JSON.stringify(inventory))
  await writeFile(join(evidence, 'ui.json'), JSON.stringify(reportFixture()))
  const reports = await writeUiReports({
    evidence,
    workspace: root,
    identityPath,
    inventoryPath,
    summary,
    execution: { ui: 'completed' },
    platform: 'darwin',
    architecture: 'arm64',
  })
  assert.equal(reports.length, 2)
  assert.equal(reports[1].report.cases[0].status, 'not-run')
  const text = await readFile(summary, 'utf8')
  assert(text.includes('ui-summary.md'))
  assert(text.includes('deterministic-summary.md'))
  assert(text.includes('ui-diagnostics-'))
  assert(text.includes('directory `ui/`'))
  assert(text.includes('directory `deterministic/`'))
  assert(text.includes('retained for 14 days'))
  for (const report of reports) {
    assert.equal(
      // oxlint-disable-next-line no-await-in-loop -- Confirm both independent persisted results after their single writer completed.
      (await readFile(join(report.directory, report.report.reportFiles.markdown), 'utf8')).includes(
        report.report.reportFiles.localDirectory,
      ),
      true,
    )
  }
})

await test('release summaries keep signed identity private and list skipped lanes in distinct release artifacts', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-release-ui-reports-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const evidence = join(root, 'evidence'),
    identityPath = join(root, 'identity.json'),
    inventoryPath = join(root, 'inventory.json'),
    summary = join(root, 'summary.md'),
    secret = 'synthetic-private-signed-release-state'
  const identity = {
    schemaVersion: 1,
    repository: 'mbaxszy7/Pact',
    releasePR: 14,
    version: '0.1.0',
    sourceSha: 'a'.repeat(40),
    tag: 'v0.1.0',
    releaseId: 1234,
    signature: secret,
    staging: { key: secret },
    extensions: secret,
  }
  await mkdir(evidence)
  await writeFile(identityPath, JSON.stringify(identity))
  await writeFile(
    inventoryPath,
    JSON.stringify({
      suites: [...reportFixture('ui').suites, ...reportFixture('deterministic').suites],
    }),
  )
  await writeFile(join(evidence, 'ui.json'), JSON.stringify(reportFixture()))
  const reports = await writeUiReports({
    evidence,
    workspace: root,
    identityPath,
    inventoryPath,
    summary,
    execution: { ui: 'completed' },
    platform: 'darwin',
    architecture: 'arm64',
    identityKind: 'release',
    runAttempt: 2,
  })
  assert.equal(reports[0].report.identityKind, 'release')
  assert.equal(reports[0].report.identity.releaseId, 1234)
  assert.equal(reports[1].report.cases[0].status, 'not-run')
  assert.equal(reports[0].report.reportFiles.artifactName, 'release-e2e-darwin-arm64-a2')
  assert.equal(reports[0].report.diagnosticArtifact, 'release-ui-diagnostics-darwin-arm64-a2')
  const text = await readFile(summary, 'utf8')
  assert(text.includes('Release PR: #14'))
  assert(text.includes('v0.1.0'))
  assert(text.includes('Release ID: 1234'))
  assert(text.includes('does not replace signed release-state'))
  assert.equal(text.includes('PR: undefined'), false)
  assert.equal(text.includes(secret) || JSON.stringify(reports).includes(secret), false)
  assert.equal(Object.hasOwn(reports[0].report.identity, 'candidateSha'), false)
  const invalid = evaluateUiReport(null, {
    ...reportOptions,
    identityKind: 'release',
    identity: { ...identity, releaseId: null },
  })
  assert(invalid.issues.includes('missing-or-invalid-release-identity'))
  assert.equal(invalid.identity, null)
})

await test('trusted controller discovery and tested source use distinct absolute roots without losing case identities', () => {
  const inventory = reportFixture(),
    raw = reportFixture(),
    local = inventory.suites[0].specs[0].file
  inventory.suites[0].specs[0].file = `/workspace/control/tests/e2e/${local}`
  raw.suites[0].specs[0].file = `/workspace/source/tests/e2e/${local}`
  const report = evaluateUiReport(raw, {
    ...reportOptions,
    inventory,
    workspace: '/workspace/source',
    inventoryWorkspace: '/workspace/control',
  })
  assert.equal(report.cases[0].status, 'passed')
  assert.equal(report.issues.includes('missing-or-invalid-discovery-inventory'), false)
  assert.equal(report.issues.includes('case-absent-from-discovery-inventory'), false)
})
