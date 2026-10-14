import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  candidateIdentity,
  readCurrent,
  requireCurrent,
  requireIdentity,
  requireSha,
} from './ci-identity.mjs'
const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  candidate = 'c'.repeat(40),
  tree = 'd'.repeat(40),
  alias = 'e'.repeat(40)
const pr = {
  number: 1,
  state: 'open',
  user: { id: 31481964 },
  head: { sha: head, repo: { id: 1416403312 } },
  base: { sha: base, ref: 'main', repo: { id: 1416403312 } },
  merge_commit_sha: candidate,
}
const commit = { sha: candidate, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] }
const identity = { ...candidateIdentity(pr, commit, base), channel: 'dev' }
void test('records tested execution SHA separately from immutable head/base/tree/policy', () => {
  assert.equal(identity.candidateSha, candidate)
  assert.equal(identity.treeSha, tree)
  assert.equal(identity.policySha, base)
  assert.equal(identity.headRepositoryId, 1416403312)
  assert.throws(
    () => candidateIdentity(pr, { ...commit, parents: [{ sha: head }, { sha: base }] }, base),
    /exact current/,
  )
  assert.throws(
    () => candidateIdentity(pr, { ...commit, parents: [{ sha: head }] }, base),
    /exact current/,
  )
  assert.throws(() => candidateIdentity(pr, { ...commit, sha: alias }, base), /exact current/)
  assert.throws(() => candidateIdentity(pr, commit, head), /Main changed/)
})
void test('a regenerated merge SHA is equivalent only with the exact ordered parents and tree', () => {
  requireCurrent(identity, pr, commit, base)
  const regenerated = { ...pr, merge_commit_sha: alias },
    equivalent = { ...commit, sha: alias }
  assert.equal(requireCurrent(identity, regenerated, equivalent, base).candidateSha, alias)
  assert.equal(identity.candidateSha, candidate, 'original execution receipt must remain unchanged')
  for (const changed of [
    { ...equivalent, tree: { sha: head } },
    { ...equivalent, parents: [{ sha: head }, { sha: base }] },
    { ...equivalent, parents: [{ sha: base }, { sha: head }, { sha: alias }] },
    { ...equivalent, tree: undefined },
  ])
    assert.throws(() => requireCurrent(identity, regenerated, changed, base))
  assert.throws(() => requireCurrent(identity, regenerated), /Invalid commit identity/)
})
void test('shared code cannot reuse another PR or author exemption, and changed head/base remains obsolete even with the same tree', () => {
  for (const changed of [
    { ...pr, state: 'closed' },
    { ...pr, number: 2 },
    { ...pr, user: { id: 342242262 } },
    { ...pr, head: { ...pr.head, repo: { id: 1 } } },
  ])
    assert.throws(() => requireCurrent(identity, changed, commit, base))
  assert.throws(
    () =>
      requireCurrent(
        identity,
        { ...pr, head: { ...pr.head, sha: alias } },
        { ...commit, parents: [{ sha: base }, { sha: alias }] },
        base,
      ),
    /obsolete/,
  )
  assert.throws(
    () =>
      requireCurrent(
        identity,
        { ...pr, base: { ...pr.base, sha: alias } },
        { ...commit, parents: [{ sha: alias }, { sha: head }] },
        alias,
      ),
    /obsolete/,
  )
  assert.throws(() => requireCurrent(identity, pr, commit, alias), /obsolete/)
  assert.throws(
    () => requireCurrent({ ...identity, policySha: head }, pr, commit, base),
    /Invalid CI PR identity/,
  )
})
void test('current proof reads actual merge content and the current main ref and rejects missing metadata', async () => {
  const calls = []
  const read = async (path) => {
    calls.push(path)
    if (path.endsWith('/pulls/1')) return { ...pr, merge_commit_sha: alias }
    if (path.endsWith(`/git/commits/${alias}`)) return { ...commit, sha: alias }
    if (path.endsWith('/git/ref/heads/main'))
      return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } }
    throw new Error('Unexpected fixture API request')
  }
  const facts = await readCurrent(identity, read)
  assert.equal(facts.current.treeSha, tree)
  assert.equal(facts.current.candidateSha, alias)
  assert.equal(calls.length, 3)
  await assert.rejects(
    readCurrent(identity, async (path) =>
      path.endsWith('/git/ref/heads/main')
        ? { ref: 'refs/heads/main', object: { type: 'commit', sha: head } }
        : read(path),
    ),
    /obsolete/,
  )
  await assert.rejects(
    readCurrent(identity, async (path) => (path.endsWith('/git/ref/heads/main') ? {} : read(path))),
    /unresolved/,
  )
})
void test('old or incomplete identity artifacts cannot supply admission evidence', () => {
  requireIdentity(identity)
  for (const changed of [
    { schemaVersion: 1 },
    { treeSha: undefined },
    { policySha: undefined },
    { headRepositoryId: undefined },
    { repositoryId: 1 },
    { authorId: 0 },
  ])
    assert.throws(() => requireIdentity({ ...identity, ...changed }))
})
void test('never interpolates unknown refs as a commit identity', () => {
  assert.equal(requireSha(head), head)
  assert.throws(() => requireSha('main; injected'), /Invalid/)
})
