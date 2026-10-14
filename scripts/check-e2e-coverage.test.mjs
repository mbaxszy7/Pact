import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

import { compareAssertions, sourceEvidence } from './check-e2e-coverage.mjs'

const evidence = (expression) =>
  sourceEvidence('fixture', `test('same', async () => {\n${expression}\n})`)
const helperEvidence = (name, assertions) =>
  sourceEvidence('fixture', `async function ${name}() {\n${assertions}\n}`)
const original = evidence("expect(composer).toHaveValue('Keep my draft')")

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
