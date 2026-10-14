import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { publicReportIdentity, readE2EJson, writeE2EReport } from './e2e-report.mjs'

await test('bounded report reads reject links, excessive bytes and incomplete JSON without changing recovery evidence', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-e2e-read-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'report.json'),
    link = join(root, 'link.json')
  await writeFile(file, '{"suites":[]}')
  await symlink(file, link)
  assert.deepEqual(await readE2EJson(file), { suites: [] })
  await assert.rejects(readE2EJson(link), /bounded/)
  await assert.rejects(readE2EJson(file, 2), /bounded/)
  assert.equal(await readFile(file, 'utf8'), '{"suites":[]}')
  await writeFile(file, '{"suites":[')
  await assert.rejects(readE2EJson(file), SyntaxError)
})

await test('report pairs survive outside Playwright cleanup, never overwrite and use unique persistent run directories', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-e2e-persistent-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const summary = join(root, 'actions-summary.md')
  const write = (directory) =>
    writeE2EReport(
      { lane: 'ui', cases: [{ status: 'failed' }] },
      {
        directory,
        basename: 'ui-summary',
        workspace: root,
        summary,
        artifactName: 'e2e-darwin-arm64',
        markdown: (report) => `# UI failure\n${report.reportFiles.localDirectory}\n`,
      },
    )
  const first = await write(join(root, 'test-results'))
  await rm(join(root, 'test-results'), { recursive: true })
  const second = await write(join(root, 'test-results'))
  assert.notEqual(first.directory, second.directory)
  assert.deepEqual(
    JSON.parse(await readFile(join(first.directory, 'ui-summary.json'), 'utf8')).cases,
    [{ status: 'failed' }],
  )
  const original = await readFile(join(second.directory, 'ui-summary.json'), 'utf8')
  await assert.rejects(write(join(root, 'test-results')), { code: 'EEXIST' })
  assert.equal(await readFile(join(second.directory, 'ui-summary.json'), 'utf8'), original)
  assert.equal((await readdir(join(root, '.pact-data/e2e-reports'))).length, 2)
  assert((await readFile(summary, 'utf8')).includes(first.report.reportFiles.localDirectory))
  assert.equal(first.report.reportFiles.artifactRetentionDays, 14)
})

await test('linked local report parents and linked artifact directories cannot redirect writes', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-e2e-write-link-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const outside = join(root, 'outside'),
    workspace = join(root, 'workspace')
  await mkdir(outside)
  await mkdir(workspace)
  await writeFile(join(outside, 'keep.txt'), 'preserve')
  await symlink(outside, join(workspace, '.pact-data'), 'dir')
  const options = {
    directory: join(root, 'evidence'),
    basename: 'real-summary',
    workspace,
    markdown: () => 'safe',
  }
  await assert.rejects(writeE2EReport({}, options), /redirected/)
  assert.deepEqual(await readdir(outside), ['keep.txt'])
  const redirect = join(root, 'redirect')
  await symlink(outside, redirect, 'dir')
  await assert.rejects(
    writeE2EReport({}, { ...options, directory: redirect, workspace: undefined }),
    /redirected/,
  )
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'preserve')
})

await test('code identity projection never publishes extensions or the unvalidated author of a branch push', () => {
  const head = 'a'.repeat(40),
    secret = 'synthetic-private-identity-extension'
  const identity = {
    schemaVersion: 3,
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
    sourceKind: 'branch',
    controllerSha: head,
    controllerRef: null,
    product: null,
    extra: { secret },
  }
  const projected = publicReportIdentity(identity)
  assert.equal(JSON.stringify(projected).includes(secret), false)
  assert.equal(projected.candidateSha, head)
  assert.deepEqual(publicReportIdentity(projected), projected)
  for (const sourceKind of ['main', 'bootstrap']) {
    const prIdentity = {
      ...identity,
      sourceKind,
      pullRequest: 7,
      authorId: 31481964,
      baseSha: 'b'.repeat(40),
      controllerSha: sourceKind === 'main' ? 'b'.repeat(40) : head,
      controllerRef:
        sourceKind === 'main'
          ? 'refs/heads/main'
          : `refs/heads/codex/pact-ci-bootstrap-${head.slice(0, 12)}`,
      policySha: sourceKind === 'main' ? 'b'.repeat(40) : head,
      product: {
        before: { version: '0.1.0', candidateVersion: '0.1.0-unreleased' },
        after: { version: '0.1.0', candidateVersion: '0.1.0-unreleased' },
      },
    }
    const projectedPr = publicReportIdentity(prIdentity)
    assert.equal(projectedPr.controllerRef, prIdentity.controllerRef)
    assert.deepEqual(publicReportIdentity(projectedPr), projectedPr)
    assert.equal(JSON.stringify(projectedPr).includes(secret), false)
  }
  assert.throws(() => publicReportIdentity({ ...identity, treeSha: secret }), /commit identity/)
})

await test('release reports whitelist fixed release identity and never export signed state or extensions', () => {
  const secret = 'synthetic-private-release-signature',
    identity = {
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
  const projected = publicReportIdentity(identity, 'release')
  assert.deepEqual(Object.keys(projected), [
    'schemaVersion',
    'repository',
    'releasePR',
    'version',
    'sourceSha',
    'tag',
    'releaseId',
  ])
  assert.equal(JSON.stringify(projected).includes(secret), false)
  for (const changes of [
    { tag: 'v0.2.0' },
    { releaseId: null },
    { releasePR: 0 },
    { repository: 'another/Pact' },
    { sourceSha: secret },
    { version: '0.0.0', tag: 'v0.0.0' },
  ])
    assert.throws(() => publicReportIdentity({ ...identity, ...changes }, 'release'), /identity/)
  assert.throws(() => publicReportIdentity(identity, 'ci'), /identity/)
})
