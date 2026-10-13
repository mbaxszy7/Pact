import assert from 'node:assert/strict'
import { test } from 'node:test'

import { publicationLimits, publicationProblems, publicDocuments } from './check-publication.mjs'

function publicFiles() {
  const files = new Map([...publicDocuments].map((name) => [name, Buffer.from('English content')]))
  files.set('LICENSE', Buffer.from('Selected license'))
  files.set('apps/desktop/.impeccable/design.json', Buffer.from('{}'))
  for (const name of ['opaque-light', 'opaque-dark', 'translucent-light', 'translucent-dark'])
    files.set(`apps/desktop/design-references/main-workspace/${name}.png`, Buffer.alloc(0))
  return files
}

await test('publication retains development specifications, tool context and approved visual references', () => {
  assert.deepEqual(publicationProblems(publicFiles()), [])
})

await test('private inputs and historical documents fail even if forcibly staged', () => {
  for (const path of [
    '.codex/auth.json',
    'nested/private.key',
    'local.sqlite',
    'docs/plans/new.md',
    'tests/e2e/env/codex/auth.json',
    '.gitleaksignore',
  ]) {
    const files = publicFiles()
    files.set(path, Buffer.from('not a real secret'))
    assert.ok(publicationProblems(files).some((problem) => problem.startsWith(path)))
  }
})

await test('a missing specification, untranslated text or link to deleted plans blocks publication', () => {
  const files = publicFiles()
  files.delete('CONTEXT.md')
  files.set('README.md', Buffer.from('[Old plan](docs/plans/old.md)'))
  files.set('CONTRIBUTING.md', Buffer.from('\u4e2d\u6587'))
  const problems = publicationProblems(files)
  assert.ok(problems.some((problem) => problem.startsWith('CONTEXT.md')))
  assert.ok(problems.some((problem) => problem.includes('unavailable local link')))
  assert.ok(problems.some((problem) => problem.includes('must be English')))
})

await test('a same-length sibling repository cannot masquerade as an in-repository link', () => {
  const files = publicFiles()
  files.set('README.md', Buffer.from('[Sibling](../Pact-secret/README.md)'))
  assert.ok(
    publicationProblems(files).some((problem) => problem.includes('escapes the repository')),
  )
})

await test('path counts, path bytes and document residency fail closed at their limits', () => {
  assert.throws(
    () =>
      publicationProblems(
        new Map(
          Array.from({ length: publicationLimits.paths + 1 }, (_, n) => [
            `source-${n}.ts`,
            undefined,
          ]),
        ),
      ),
    /path count/u,
  )
  assert.throws(
    () =>
      publicationProblems(
        new Map([['x'.repeat(publicationLimits.singlePathBytes + 1), undefined]]),
      ),
    /path bytes/u,
  )
  assert.throws(
    () =>
      publicationProblems(
        new Map(Array.from({ length: 1100 }, (_, n) => [`${n}-${'x'.repeat(1000)}`, undefined])),
      ),
    /path bytes/u,
  )
  const oversized = publicFiles()
  oversized.set('README.md', Buffer.alloc(publicationLimits.documentBytes + 1))
  assert.throws(() => publicationProblems(oversized), /document bytes/u)
  const aggregate = publicFiles()
  for (const path of [...publicDocuments].slice(0, 5))
    aggregate.set(path, Buffer.alloc(publicationLimits.documentBytes, 65))
  assert.throws(() => publicationProblems(aggregate), /document bytes/u)
})
