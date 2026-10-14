import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { check } from './check-e2e-coverage.mjs'
import {
  realCases,
  coreRealGrep,
  evaluateRealReport,
  realReportMarkdown,
  realCaseRequired,
  realReportCases,
  writeRealReport,
  validateRealTags,
} from './real-e2e-policy.mjs'

const workspace = fileURLToPath(new URL('..', import.meta.url))
const compare = (left, right) => left.localeCompare(right)
const key = (item) => JSON.stringify([item.path, item.title])
function fixture(suite = 'full') {
  return {
    suites: [
      {
        specs: realCases
          .filter((item) => suite === 'full' || item.tier === 'core')
          .map((item) => ({
            file: item.path,
            title: item.title,
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
    errors: [],
  }
}
const first = (report, tier) =>
  report.suites[0].specs.find(
    (spec) =>
      realCases.find((item) => key(item) === JSON.stringify([spec.file, spec.title]))?.tier ===
      tier,
  ).tests[0]
const fail = (result, status = 'failed') => {
  result.status = 'unexpected'
  result.results[0].status = status
}

await test('actual Playwright discovery is completely classified and core selection selects exactly the reviewed cases', () => {
  const discover = (args) =>
    JSON.parse(
      execFileSync(
        'pnpm',
        ['exec', 'playwright', 'test', '--project=real', '--list', '--reporter=json', ...args],
        { cwd: workspace, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      ),
    )
  const listed = realReportCases(discover([]), workspace)
  validateRealTags(listed)
  assert.deepEqual([...listed.keys()].toSorted(compare), realCases.map(key).toSorted(compare))
  const core = realReportCases(discover(['--grep', coreRealGrep()]), workspace)
  assert.deepEqual(
    [...core.keys()].toSorted(compare),
    realCases
      .filter((item) => item.tier === 'core')
      .map(key)
      .toSorted(compare),
  )
  assert.equal(core.size, 29)
  assert.equal(listed.size - core.size, 32)
  assert.equal(
    realCases.find(
      (item) => item.title.includes('lost ACK') && item.title.includes('cold inspection'),
    ).tier,
    'core',
  )
})

await test('core success reports every deferred case without claiming a complete regression', () => {
  const report = evaluateRealReport(fixture('core'))
  assert.equal(report.gatePassed, true)
  assert.equal(report.fullSuitePassed, false)
  assert.deepEqual(report.tiers.core, {
    total: 29,
    passed: 29,
    failed: 0,
    skipped: 0,
    notRun: 0,
    notApplicable: 0,
  })
  assert.equal(report.tiers.extended.notRun + report.tiers.extended.notApplicable, 32)
  assert(
    report.cases
      .filter((item) => item.tier === 'extended')
      .every(
        (item) =>
          (item.reason.includes('Deferred') || item.status === 'not-applicable') && !item.required,
      ),
  )
})

await test('extended failure remains reported while ordinary PR core passes; release full gate fails', () => {
  const raw = fixture()
  fail(first(raw, 'extended'))
  const pr = evaluateRealReport(raw, { suite: 'full', gate: 'core' })
  assert.equal(pr.gatePassed, true)
  assert.equal(pr.fullSuitePassed, false)
  assert.equal(pr.tiers.extended.failed, 1)
  assert.equal(evaluateRealReport(raw, { suite: 'full', gate: 'full' }).gatePassed, false)
  assert.equal(evaluateRealReport(fixture(), { suite: 'full' }).fullSuitePassed, true)
})

for (const status of ['failed', 'timedOut', 'interrupted', 'skipped'])
  // oxlint-disable-next-line eslint/no-await-in-loop -- Independent gate proofs retain distinct case outcomes.
  await test(`a core ${status} result cannot pass`, () => {
    const raw = fixture('core')
    fail(first(raw, 'core'), status)
    assert.equal(evaluateRealReport(raw).gatePassed, false)
  })

await test('missing case, missing report, global error, preparation failure and retried success fail closed', () => {
  const raw = fixture('core')
  raw.suites[0].specs.pop()
  assert.equal(evaluateRealReport(raw).gatePassed, false)
  assert.equal(evaluateRealReport(null).gatePassed, false)
  assert.equal(evaluateRealReport({ ...fixture('core'), errors: [{}] }).gatePassed, false)
  assert.equal(evaluateRealReport(fixture('core'), { execution: 'unavailable' }).gatePassed, false)
  const retried = fixture('core')
  first(retried, 'core').results.push({ status: 'passed', duration: 1 })
  assert.equal(evaluateRealReport(retried).gatePassed, false)
})

await test('unknown, duplicate, unexpected-tier and malformed-duration evidence cannot pass', () => {
  const unknown = fixture('core')
  unknown.suites[0].specs[0].title = 'unreviewed test'
  assert.equal(evaluateRealReport(unknown).gatePassed, false)
  const duplicate = fixture('core')
  duplicate.suites[0].specs.push(duplicate.suites[0].specs[0])
  assert.equal(evaluateRealReport(duplicate).gatePassed, false)
  assert.equal(evaluateRealReport(fixture(), { suite: 'core' }).gatePassed, false)
  const invalid = fixture('core')
  first(invalid, 'core').results[0].duration = Infinity
  assert.equal(evaluateRealReport(invalid).gatePassed, false)
  assert.throws(
    () => evaluateRealReport(fixture('core'), { suite: 'core', gate: 'full' }),
    /Full gate/,
  )
  assert.throws(
    () => realCaseRequired({ path: 'new.spec.ts', title: 'new', project: 'real' }, 'core'),
    /no reviewed/,
  )
})

await test('published JSON and Markdown exclude raw model output, errors, traces, attachments and config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-real-policy-report-'))
  try {
    const raw = fixture('core')
    const secret = 'synthetic-nonfunctional-private-report-canary'
    raw.config = { metadata: { secret } }
    first(raw, 'core').results[0].error = { message: secret, stack: secret }
    first(raw, 'core').results[0].stdout = [{ text: secret }]
    first(raw, 'core').results[0].attachments = [{ path: secret, body: secret }]
    const report = evaluateRealReport(raw)
    await writeRealReport(report, directory)
    const text =
      (await readFile(join(directory, 'real-summary.json'), 'utf8')) +
      (await readFile(join(directory, 'real-summary.md'), 'utf8'))
    assert.equal(text.includes(secret), false)
    assert(realReportMarkdown(report).includes('not-run'))
    await assert.rejects(writeRealReport(report, directory), /EEXIST/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('immutable coverage keeps all assertions while requiring only selected real execution obligations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-real-policy-coverage-'))
  try {
    const listed = JSON.parse(
      execFileSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      }),
    )
    const results = structuredClone(listed)
    const scope = 'core'
    function visit(suite) {
      for (const spec of suite.specs ?? []) {
        spec.tests = spec.tests.filter((item) =>
          realCaseRequired(
            { path: `tests/e2e/${spec.file}`, title: spec.title, project: item.projectName },
            scope,
          ),
        )
        for (const item of spec.tests)
          Object.assign(item, {
            expectedStatus: 'passed',
            status: 'expected',
            results: [{ status: 'passed', duration: 1 }],
          })
      }
      for (const child of suite.suites ?? []) visit(child)
    }
    results.suites.forEach(visit)
    results.stats = { startTime: '2026-01-01T00:00:00Z' }
    results.errors = []
    const list = join(directory, 'list.json'),
      resultPath = join(directory, 'results.json')
    await writeFile(list, JSON.stringify(listed))
    await writeFile(resultPath, JSON.stringify(results))
    const configuration = {
      list,
      results: [resultPath],
      requireResults: true,
      sourceOnly: false,
      realScope: 'core',
    }
    const core = check(configuration)
    assert.deepEqual(core.problems, [])
    assert.equal(core.passedGate, true)
    assert.equal(core.baseline.caseCount, 54)
    assert.equal(core.baseline.assertionSiteCount, 631)
    assert(core.cases.some((item) => item.status === 'unverified'))
    const full = check({ ...configuration, realScope: 'full' })
    assert.equal(full.passedGate, false)
    assert(full.problems.some((item) => item.type === 'results-required'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('missing, dual and incorrectly reassigned Playwright tier tags cannot reduce the gate', () => {
  const core = realCases.find((item) => item.tier === 'core')
  for (const tags of [[], ['real-extended'], ['real-core', 'real-extended']])
    assert.throws(() => validateRealTags(new Map([[key(core), { tags }]])), /disagrees/)
})

await test('a macOS-only case is required on macOS and explicitly non-applicable on Windows', () => {
  const raw = fixture()
  const mac = realCases.find((item) => item.platforms)
  const executed = raw.suites[0].specs.find((item) => item.title === mac.title).tests[0]
  executed.results[0].status = 'skipped'
  executed.status = 'skipped'
  const windows = evaluateRealReport(raw, { suite: 'full', platform: 'win32' })
  assert.equal(windows.gatePassed, true)
  assert.equal(windows.tiers.extended.notApplicable, 1)
  assert.equal(windows.cases.find((item) => item.title === mac.title).status, 'not-applicable')
  assert.equal(realCaseRequired({ ...mac, project: 'real' }, 'full', 'win32'), false)
  assert.equal(realCaseRequired({ ...mac, project: 'real' }, 'full', 'darwin'), true)
  assert.equal(evaluateRealReport(raw, { suite: 'full', platform: 'darwin' }).gatePassed, false)
})

await test('validated identity extensions never enter published report JSON or Markdown', () => {
  const secret = 'synthetic-nonfunctional-private-identity-canary'
  const identity = {
    schemaVersion: 2,
    repository: 'mbaxszy7/Pact',
    repositoryId: 1416403312,
    pullRequest: 7,
    headRepositoryId: 1416403312,
    authorId: 31481964,
    channel: 'dev',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    candidateSha: 'c'.repeat(40),
    treeSha: 'd'.repeat(40),
    policySha: 'b'.repeat(40),
    privateConfig: { token: secret },
    secret,
  }
  const report = evaluateRealReport(fixture('core'), { identity })
  assert.equal(report.gatePassed, true)
  assert.equal(JSON.stringify(report).includes(secret), false)
  assert.equal(Object.hasOwn(report.identity, 'privateConfig'), false)
  assert.equal(realReportMarkdown(report).includes(secret), false)
  assert.equal(report.identity.headSha, identity.headSha)
})

await test('a branch identity does not export its unvalidated author field', () => {
  const secret = 'synthetic-nonfunctional-private-branch-canary'
  const head = 'a'.repeat(40)
  const identity = {
    schemaVersion: 2,
    repository: 'mbaxszy7/Pact',
    repositoryId: 1416403312,
    pullRequest: null,
    headRepositoryId: 1416403312,
    authorId: secret,
    channel: 'dev',
    headSha: head,
    baseSha: null,
    candidateSha: head,
    treeSha: 'd'.repeat(40),
    policySha: head,
  }
  const report = evaluateRealReport(fixture('core'), { identity })
  assert.equal(JSON.stringify(report).includes(secret), false)
})

await test('the reporting entry still lists all cases and fails when CI identity evidence is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-real-policy-missing-identity-'))
  try {
    await writeFile(join(directory, 'real.json'), JSON.stringify(fixture('core')))
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            'scripts/real-e2e-policy.mjs',
            'core',
            'core',
            directory,
            join(directory, 'missing-identity.json'),
          ],
          {
            cwd: workspace,
            env: { ...process.env, PACT_REAL_EXECUTION_COMPLETED: 'true', GITHUB_STEP_SUMMARY: '' },
            encoding: 'utf8',
            timeout: 10_000,
          },
        ),
      (error) => error.status === 1,
    )
    const report = JSON.parse(await readFile(join(directory, 'real-summary.json'), 'utf8'))
    assert.equal(report.cases.length, 61)
    assert.equal(report.gatePassed, false)
    assert(report.issues.includes('missing-or-invalid-ci-code-identity'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
