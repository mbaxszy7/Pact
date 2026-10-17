import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  ciReportIdentity,
  publicReportIdentity,
  readE2EJson,
  reportIdentityMarkdown,
  writeCiReportMetadata,
  writeE2EReport,
} from './e2e-report.mjs'

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

const ciEnvironment = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'mbaxszy7/Pact',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_REF: 'refs/pull/12/merge',
}

await test('native source/run metadata has one public schema and excludes arbitrary extensions', () => {
  const identity = ciReportIdentity(ciEnvironment)
  assert.deepEqual(identity, {
    schemaVersion: 1,
    kind: 'ci',
    repository: 'mbaxszy7/Pact',
    sourceSha: 'a'.repeat(40),
    runId: 12345,
    runAttempt: 2,
    eventName: 'pull_request',
    ref: 'refs/pull/12/merge',
  })
  const secret = 'synthetic-private-report-extension'
  const projected = publicReportIdentity({ ...identity, secret, config: { secret } })
  assert.deepEqual(projected, identity)
  assert.deepEqual(publicReportIdentity(projected), projected)
  assert(!reportIdentityMarkdown(projected).includes(secret))
  assert(reportIdentityMarkdown(projected).includes('Actions run: 12345, attempt 2'))
  for (const changes of [
    { schemaVersion: 3 },
    { kind: 'release' },
    { repository: 'another/Pact' },
    { sourceSha: 'bad' },
    { runId: '12345' },
    { runId: 0 },
    { runAttempt: 0 },
    { runAttempt: 1.5 },
    { eventName: 'pull_request_target' },
    { ref: 'refs/heads/main\nsecret' },
    { ref: 'x'.repeat(1025) },
  ])
    assert.throws(() => publicReportIdentity({ ...identity, ...changes }), /identity/)
  for (const changes of [
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_RUN_ID: '01' },
    { GITHUB_RUN_ID: '9007199254740992' },
    { GITHUB_RUN_ATTEMPT: '' },
    { GITHUB_SHA: '' },
    { GITHUB_REPOSITORY: '' },
  ])
    assert.throws(() => ciReportIdentity({ ...ciEnvironment, ...changes }), /identity|metadata/)
})

await test('local source metadata is explicit and never invents an Actions run', () => {
  const identity = publicReportIdentity({
    schemaVersion: 1,
    kind: 'local',
    repository: 'mbaxszy7/Pact',
    sourceSha: 'b'.repeat(40),
    secret: 'private-extension',
  })
  assert.equal(identity.kind, 'local')
  assert.equal(Object.hasOwn(identity, 'runId'), false)
  assert(reportIdentityMarkdown(identity).includes('this is not a CI run'))
  assert.equal(publicReportIdentity(null), null)
  assert(reportIdentityMarkdown(null).includes('unavailable'))
  assert.throws(() => publicReportIdentity({ ...identity, sourceSha: null }), /identity/)
})

await test('metadata CLI writes exact native run projection once and rejects missing or malformed evidence', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-ci-metadata-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'metadata.json')
  execFileSync(process.execPath, ['scripts/e2e-report.mjs', '--ci-metadata', file], {
    env: { ...process.env, ...ciEnvironment },
    timeout: 5000,
  })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), ciReportIdentity(ciEnvironment))
  await assert.rejects(writeCiReportMetadata(file, ciEnvironment), { code: 'EEXIST' })
  await assert.rejects(writeCiReportMetadata('relative.json', ciEnvironment), /bounded/)
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ['scripts/e2e-report.mjs', '--ci-metadata', join(root, 'invalid.json')],
        {
          env: { ...process.env, ...ciEnvironment, GITHUB_RUN_ATTEMPT: '0' },
          timeout: 5000,
          stdio: 'pipe',
        },
      ),
    (error) => error.status === 1,
  )
  assert.deepEqual(await readdir(root), ['metadata.json'])
})
