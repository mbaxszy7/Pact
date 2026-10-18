import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { compareAssertions, discoveryEnvironment, sourceEvidence } from './check-e2e-coverage.mjs'

const evidence = (expression) =>
  sourceEvidence('fixture', `test('same', async () => {\n${expression}\n})`)
const helperEvidence = (name, assertions) =>
  sourceEvidence('fixture', `async function ${name}() {\n${assertions}\n}`)
const original = evidence("expect(composer).toHaveValue('Keep my draft')")

await test('native same-checkout coverage rejects an added body skip without changing baseline evidence', () => {
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { resolve } from 'node:path'
    const target = resolve('tests/e2e/real-context.spec.ts')
    const read = fs.readFileSync.bind(fs)
    fs.readFileSync = (path, ...args) => {
      const value = read(path, ...args)
      return String(path) === target && typeof value === 'string'
        ? value.replace('    test.setTimeout(caseDeadlineMs)', "    test.skip(true, 'new unapproved body skip')\\n    test.setTimeout(caseDeadlineMs)")
        : value
    }
    syncBuiltinESMExports()
    const { check } = await import('./scripts/check-e2e-coverage.mjs')
    const report = check({ sourceOnly: true, results: [], realScope: 'full' })
    console.log(JSON.stringify(report.problems))
  `,
    ],
    {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PACT_CI_WORKSPACE: resolve(import.meta.dirname, '..') },
    },
  )
  assert.ok(
    JSON.parse(result).some(
      (problem) =>
        problem.type === 'source-skip' && problem.path === 'tests/e2e/real-context.spec.ts',
    ),
  )
})

await test('contenteditable migration retains exact locator, expected string and equality', () => {
  assert.deepEqual(
    compareAssertions(
      'fixture',
      original,
      evidence("expect.poll(() => composer.textContent()).toBe('Keep my draft')"),
    ),
    [],
  )
})

for (const [name, expression] of [
  ['changed draft', "expect.poll(() => composer.textContent()).toBe('different')"],
  ['changed locator', "expect.poll(() => other.textContent()).toBe('Keep my draft')"],
  ['partial comparison', "expect.poll(() => composer.textContent()).toContain('Keep my draft')"],
  ['negated equality', "expect.poll(() => composer.textContent()).not.toBe('Keep my draft')"],
  [
    'side effect',
    "expect.poll(() => { mutate(); return composer.textContent() }).toBe('Keep my draft')",
  ],
  ['non-string result', 'expect.poll(() => composer.textContent()).toBe(0)'],
  [
    'different polling contract',
    "expect.poll(() => composer.textContent(), {timeout:1}).toBe('Keep my draft')",
  ],
])
  // oxlint-disable-next-line eslint/no-await-in-loop -- Register each independent rejection proof after its Node test settles.
  await test(`rejects ${name}`, () => {
    assert.equal(compareAssertions('fixture', original, evidence(expression)).length, 1)
  })

await test('a removed assertion is still a failure', () => {
  assert.equal(compareAssertions('fixture', original, evidence('')).length, 1)
})

await test('only the registered recovery sites accept the exact renamed button', () => {
  const path = 'tests/e2e/agent-lifecycle.spec.ts'
  const old = sourceEvidence(
    path,
    '\n'.repeat(256) +
      "expect(window.getByRole('button', {name:'Retry',exact:true})).toBeVisible()",
    { baseline: true },
  )
  const current = sourceEvidence(
    path,
    "expect(window.getByRole('button', {name:'Check session',exact:true})).toBeVisible()",
  )
  assert.deepEqual(compareAssertions(path, old, current), [])
  assert.equal(
    compareAssertions(
      path,
      old,
      sourceEvidence(
        path,
        "expect(window.getByRole('button', {name:'Check session',exact:true})).toHaveCount(0)",
      ),
    ).length,
    1,
  )
  const unrelated = sourceEvidence(
    path,
    "expect(window.getByRole('button', {name:'Retry',exact:true})).toBeVisible()",
    { baseline: true },
  )
  assert.equal(compareAssertions(path, unrelated, current).length, 1)
})

const quota = evidence('expect(drafts).toHaveCount(10)')
const update = {
  originalLine: 2,
  reason: 'Accepted Comment contract; check creation and cold restart.',
  replacementAssertions: ['expect(drafts).toHaveCount(11)', 'expect(drafts).toHaveCount(11)'],
}

await test('an explicit shared-helper revision retains helper identity and every exact replacement', () => {
  const helperBaseline = sourceEvidence(
    'fixture',
    `async function addProject() { expect(project).toBeVisible() }`,
  )
  const replacements = [
    'expect(renamedProject).toBeVisible()',
    'expect(renamedProject).toHaveText("project")',
  ]
  const revision = {
    originalLine: 1,
    reason: 'The same Project exposes its rename action; retain visible display text.',
    replacementAssertions: replacements,
  }
  const current = sourceEvidence(
    'fixture',
    `async function addProject() { ${replacements.join('; ')} }`,
  )
  assert.deepEqual(compareAssertions('fixture', helperBaseline, current, [revision]), [])
  for (const source of [
    `async function differentHelper() { ${replacements.join('; ')} }`,
    `async function addProject() { ${replacements[0]} }`,
    `async function addProject() { expect(renamedProject).toBeVisible(); expect(renamedProject).toHaveText("other") }`,
  ])
    assert.equal(
      compareAssertions('fixture', helperBaseline, sourceEvidence('fixture', source), [revision])
        .length,
      1,
    )
  assert.throws(
    () =>
      compareAssertions(
        'fixture',
        sourceEvidence('fixture', 'expect(project).toBeVisible()'),
        current,
        [revision],
      ),
    /exact test or named helper owner/u,
  )
})
await test('a contract revision requires both exact replacement assertions', () => {
  assert.deepEqual(
    compareAssertions(
      'fixture',
      quota,
      evidence('expect(drafts).toHaveCount(11)\nexpect(drafts).toHaveCount(11)'),
      [update],
    ),
    [],
  )
  assert.equal(
    compareAssertions('fixture', quota, evidence('expect(drafts).toHaveCount(11)'), [update])
      .length,
    1,
  )
  assert.equal(
    compareAssertions(
      'fixture',
      quota,
      evidence('expect(drafts).toHaveCount(11)\nexpect(drafts).toHaveCount(12)'),
      [update],
    ).length,
    1,
  )
  assert.equal(compareAssertions('fixture', quota, quota, [update]).length, 1)
})

await test('replacement registrations cannot refer to unknown sites or waive all assertions', () => {
  assert.throws(
    () => compareAssertions('fixture', quota, quota, [{ ...update, originalLine: 999 }]),
    /Invalid assertion/,
  )
  assert.throws(
    () => compareAssertions('fixture', quota, quota, [{ ...update, replacementAssertions: [] }]),
    /Invalid assertion/,
  )
  assert.throws(
    () => compareAssertions('fixture', quota, quota, [update, update]),
    /Invalid assertion/,
  )
})

await test('a named helper contract keeps its exact owner and every replacement obligation', () => {
  const originalHelper = helperEvidence('addProject', "expect(project).toHaveText('Project')")
  const contract = {
    originalLine: 2,
    reason: 'Preserve Project identity while checking its explicit accessible action.',
    replacementAssertions: [
      'expect(project).toBeVisible()',
      "expect(project).toHaveText('Project')",
    ],
  }
  const replacements = contract.replacementAssertions.join('\n')
  assert.deepEqual(
    compareAssertions('fixture', originalHelper, helperEvidence('addProject', replacements), [
      contract,
    ]),
    [],
  )
  for (const current of [
    helperEvidence('otherHelper', replacements),
    helperEvidence('addProject', contract.replacementAssertions[0]),
    helperEvidence('addProject', replacements.replace("'Project'", "'Other'")),
  ])
    assert.equal(compareAssertions('fixture', originalHelper, current, [contract]).length, 1)
})

await test('revised case identity preserves the immutable original owner only for its exact mapping', () => {
  const path = 'tests/e2e/anchored-comments.spec.ts'
  const old = sourceEvidence(
    path,
    "test('keeps a ten-Comment bundle intact and reports the eleventh attempt as a warning', async () => {expect(drafts).toHaveCount(10)})",
  )
  const revised = sourceEvidence(
    path,
    "test('preserves an eleven-Comment draft bundle across restart without the retired ten-item limit', async () => {expect(drafts).toHaveCount(10)})",
  )
  assert.deepEqual(compareAssertions(path, old, revised), [])
  assert.equal(
    compareAssertions(
      'other',
      sourceEvidence('other', "test('old',()=>{expect(drafts).toHaveCount(10)})"),
      sourceEvidence('other', "test('new',()=>{expect(drafts).toHaveCount(10)})"),
    ).length,
    1,
  )
})

await test('skips remain visible and missing execution evidence cannot pass the results gate', () => {
  assert.deepEqual(sourceEvidence('fixture', "test.skip('unverified',()=>{})").skipSites, [1])
  let output
  try {
    execFileSync(
      process.execPath,
      ['scripts/check-e2e-coverage.mjs', '--require-results', '--json'],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
    )
    assert.fail('The results gate must reject absent reports')
  } catch (error) {
    assert.equal(error.status, 1)
    output = error.stdout
  }
  const report = JSON.parse(output)
  assert.equal(report.passedGate, false)
  assert.equal(report.resultsSupplied, false)
  assert.ok(report.problems.some((item) => item.type === 'results-required'))
  assert.equal(
    report.problems.some((item) => item.type === 'original-assertion-changed-or-removed'),
    false,
  )
})

await test('candidate discovery receives only bounded system environment values', () => {
  assert.deepEqual(
    discoveryEnvironment({
      PATH: 'system-path',
      HOME: 'isolated-home',
      CI: 'true',
      GITHUB_TOKEN: 'synthetic-github-credential',
      PACT_CODEX_AUTH_JSON: 'synthetic-provider-configuration',
      PACT_E2E_ENV_DIR: 'private-provider-directory',
      PACT_E2E_CODEX_EXECUTABLE: 'selected-provider-cli',
      NODE_OPTIONS: '--inspect',
      NODE_PATH: 'controller-dependencies',
      PLAYWRIGHT_JSON_OUTPUT_FILE: 'unexpected-report-path',
      PLAYWRIGHT_JSON_OUTPUT_DIR: 'unexpected-report-directory',
    }),
    { PATH: 'system-path', HOME: 'isolated-home', CI: 'true' },
  )
})

await test('source-only audits immutable obligations without candidate dependencies or discovery', async () => {
  const controller = resolve(import.meta.dirname, '..')
  const directory = await mkdtemp(join(tmpdir(), 'pact-source-coverage-'))
  const candidate = join(directory, 'candidate')
  const specs = join(candidate, 'tests/e2e')
  const environment = { ...discoveryEnvironment(process.env), PACT_CI_WORKSPACE: candidate }
  const invoke = (args) =>
    spawnSync(process.execPath, [join(controller, 'scripts/check-e2e-coverage.mjs'), ...args], {
      cwd: directory,
      env: environment,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    })
  try {
    await mkdir(specs, { recursive: true })
    const entries = (await readdir(join(controller, 'tests/e2e'))).filter(
      (name) => name.endsWith('.spec.ts') || name === 'baseline.json',
    )
    await Promise.all(
      entries.map((name) => cp(join(controller, 'tests/e2e', name), join(specs, name))),
    )
    await writeFile(join(candidate, 'package.json'), '{"private":true,"type":"module"}\n')
    const marker = join(directory, 'discovery-started')
    const guard = join(directory, 'discovery-guard.mjs')
    await writeFile(
      guard,
      `import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { writeFileSync } from 'node:fs'
childProcess.execFileSync = () => {
  writeFileSync(${JSON.stringify(marker)}, 'unexpected discovery')
  throw Error('Source-only must not launch discovery')
}
syncBuiltinESMExports()
`,
    )
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(guard).href,
        join(controller, 'scripts/check-e2e-coverage.mjs'),
        '--source-only',
        '--json',
      ],
      {
        cwd: directory,
        env: environment,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    )
    assert.equal(result.status, 0, result.stderr)
    await assert.rejects(lstat(marker), { code: 'ENOENT' })
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.baseline, {
      revision: '6fade3636a7d77060ec4b35a50cdd764e3726228',
      specCount: 21,
      caseCount: 54,
      assertionSiteCount: 631,
    })
    assert.equal(report.discoveryChecked, false)
    assert.equal(report.registeredCaseCount, null)
    assert.equal(report.resultsSupplied, false)
    assert.equal(report.passedGate, false)
    assert.deepEqual(report.problems, [])
    assert.ok(report.cases.every((item) => item.status === 'unverified'))
    assert.ok(
      report.cases.flatMap((item) => item.targets).every((item) => item.status === 'unverified'),
    )
    assert.ok(report.additionalBusinessCases.every((item) => item.status === 'unverified'))
    for (const args of [
      ['--require-results'],
      ['--list-json', 'absent-list.json'],
      ['--results-json', 'absent-results.json'],
    ]) {
      const rejected = invoke(['--source-only', ...args])
      assert.equal(rejected.status, 1)
      assert.match(rejected.stderr, /Source-only coverage cannot accept/)
    }
    const missingDependencies = invoke(['--json'])
    assert.equal(missingDependencies.status, 1)
    await symlink(join(controller, 'node_modules'), join(candidate, 'node_modules'), 'junction')
    const controllerFallback = invoke(['--json'])
    assert.equal(controllerFallback.status, 1)
    assert.match(
      controllerFallback.stderr,
      /Candidate Playwright must be installed in its own workspace/,
    )
    await rm(join(candidate, 'node_modules'))
    const target = join(specs, 'real-peer-assistance.spec.ts')
    const source = await readFile(target, 'utf8')
    await writeFile(target, `${source}\ntest.skip(true, 'candidate skips every peer journey')\n`)
    const skipped = invoke(['--source-only', '--json'])
    assert.equal(skipped.status, 1)
    assert.ok(JSON.parse(skipped.stdout).problems.some((item) => item.type === 'source-skip'))
    await writeFile(target, source)
    await writeFile(join(specs, 'coverage-manifest.ts'), 'export const e2eMigrationCases = []\n')
    const unchangedAuthority = invoke(['--source-only', '--json'])
    assert.equal(unchangedAuthority.status, 0, unchangedAuthority.stderr)
    assert.equal(JSON.parse(unchangedAuthority.stdout).cases.length, 54)
    await writeFile(
      join(specs, 'baseline.json'),
      `${await readFile(join(specs, 'baseline.json'), 'utf8')} `,
    )
    const changedBaseline = invoke(['--source-only', '--json'])
    assert.equal(changedBaseline.status, 1)
    assert.match(changedBaseline.stderr, /Immutable E2E baseline integrity check failed/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
