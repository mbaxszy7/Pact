import assert from 'node:assert/strict'
import { test } from 'node:test'

import { candidateIdentity, requireCurrent, requireSha } from './ci-identity.mjs'
const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  candidate = 'c'.repeat(40)
const pr = {
  number: 1,
  state: 'open',
  user: { id: 31481964 },
  head: { sha: head },
  base: { sha: base, ref: 'main', repo: { id: 1416403312 } },
  merge_commit_sha: candidate,
}
void test('records the tested head, base and actual merge parents', () => {
  assert.equal(candidateIdentity(pr, [candidate, base, head]).candidateSha, candidate)
  assert.throws(() => candidateIdentity(pr, [candidate, head, base]), /exact current/)
  assert.throws(() => candidateIdentity(pr, [head]), /exact current/)
})
void test('rejects closed PRs and updated head, base or candidate', () => {
  const identity = candidateIdentity(pr, [candidate, base, head])
  requireCurrent(identity, pr)
  for (const changed of [
    { ...pr, state: 'closed' },
    { ...pr, head: { sha: base } },
    { ...pr, base: { ...pr.base, sha: head } },
    { ...pr, merge_commit_sha: head },
  ])
    assert.throws(() => requireCurrent(identity, changed), /obsolete/)
})
void test('never interpolates unknown refs as a commit identity', () => {
  assert.equal(requireSha(head), head)
  assert.throws(() => requireSha('main; injected'), /Invalid/)
})
