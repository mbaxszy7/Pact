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
    extra: { secret },
  }
  const projected = publicReportIdentity(identity)
  assert.equal(JSON.stringify(projected).includes(secret), false)
  assert.equal(projected.candidateSha, head)
  assert.throws(() => publicReportIdentity({ ...identity, treeSha: secret }), /commit identity/)
})
