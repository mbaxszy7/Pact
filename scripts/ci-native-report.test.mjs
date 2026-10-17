import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  nativeReport,
  nativeMarkdown,
  writeNativeReport,
  ensureUnexecutedNativeReport,
} from './ci-native-report.mjs'

const fixture = (status = 'passed', success = status === 'passed') => ({
  success,
  numTotalTests: 1,
  testResults: [
    {
      assertionResults: [
        {
          fullName: 'Actual protocol ownership',
          status,
          duration: 17,
          failureMessages: ['secret-provider-output-cookie-token'],
        },
      ],
    },
  ],
})
await test('requires actual completion and every native case, including hook failures', () => {
  assert.equal(nativeReport(fixture(), { completed: true, exitCode: 0 }).status, 'passed')
  for (const options of [
    { completed: false, exitCode: 0 },
    { completed: true, exitCode: 1 },
  ])
    assert.notEqual(nativeReport(fixture(), options).status, 'passed')
  assert.equal(
    nativeReport(fixture('pending'), { completed: true, exitCode: 1 }).counts.unexecuted,
    1,
  )
  assert.equal(
    nativeReport(fixture('passed', false), { completed: true, exitCode: 1 }).status,
    'failed',
  )
  assert.equal(
    nativeReport(
      { success: true, numTotalTests: 0, testResults: [] },
      { completed: true, exitCode: 0 },
    ).status,
    'failed',
  )
  assert.equal(
    nativeReport({ ...fixture(), numTotalTests: 2 }, { completed: true, exitCode: 0 }).status,
    'blocked',
  )
  const duplicate = fixture()
  duplicate.numTotalTests = 2
  duplicate.testResults[0].assertionResults.push(duplicate.testResults[0].assertionResults[0])
  assert.equal(nativeReport(duplicate, { completed: true, exitCode: 0 }).status, 'blocked')
})
await test('withholds raw failure output and bounds the reported inventory', () => {
  const report = nativeReport(fixture('failed'), { completed: true, exitCode: 1 })
  assert.equal(report.cases[0].failureCategory, 'protocol-or-fixture')
  assert(!JSON.stringify(report).includes('secret-provider-output'))
  assert(!nativeMarkdown(report).includes('secret-provider-output'))
  const raw = fixture()
  raw.testResults[0].assertionResults = Array(257).fill(raw.testResults[0].assertionResults[0])
  assert.equal(nativeReport(raw, { completed: true, exitCode: 0 }).status, 'blocked')
})
await test('missing execution leaves immutable local JSON and Markdown instead of a passing receipt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pact-native-report-'))
  try {
    const directory = join(workspace, 'evidence'),
      rawPath = join(workspace, 'missing.json')
    const output = await writeNativeReport({
      rawPath,
      directory,
      workspace,
      completed: false,
      artifactName: 'native-e2e-darwin-arm64-a1',
    })
    assert.equal(output.report.status, 'blocked')
    assert.equal(
      JSON.parse(await readFile(join(directory, 'native-summary.json'))).status,
      'blocked',
    )
    assert(
      (await readFile(join(output.directory, 'native-summary.md'), 'utf8')).includes('blocked'),
    )
    await assert.rejects(
      writeNativeReport({ rawPath, directory, workspace, completed: true, exitCode: 0 }),
      /cannot be overwritten/,
    )
    const rawDirectory = join(workspace, 'raw')
    await mkdir(rawDirectory)
    await writeFile(join(rawDirectory, 'run.json'), JSON.stringify(fixture('failed')))
    const failed = await writeNativeReport({
      rawPath: join(rawDirectory, 'run.json'),
      directory: join(workspace, 'failed'),
      workspace,
      completed: true,
      exitCode: 1,
    })
    assert.equal(failed.report.status, 'failed')
    assert(!JSON.stringify(failed.report).includes('secret-provider-output'))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

await test('setup failure leaves a blocked report and never overwrites completed execution evidence', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pact-native-unexecuted-'))
  try {
    const options = {
      directory: join(workspace, 'evidence'),
      workspace,
      identityPath: join(workspace, 'missing-identity.json'),
      artifactName: 'native-e2e-darwin-arm64-a1',
    }
    const written = await ensureUnexecutedNativeReport(options)
    assert.equal(written.report.status, 'blocked')
    assert.equal(written.report.executionCompleted, false)
    assert.equal(written.report.counts, null)
    assert.equal(written.report.identity, null)
    const before = await readFile(join(options.directory, 'native-summary.json'), 'utf8')
    assert.equal((await ensureUnexecutedNativeReport(options)).status, 'blocked')
    assert.equal(await readFile(join(options.directory, 'native-summary.json'), 'utf8'), before)
    await assert.rejects(
      ensureUnexecutedNativeReport({ ...options, artifactName: 'wrong-artifact' }),
      /unexpected identity/,
    )
    const rawPath = join(workspace, 'actual.json')
    await writeFile(rawPath, JSON.stringify(fixture()))
    const completeOptions = {
      ...options,
      directory: join(workspace, 'complete'),
      identityPath: undefined,
    }
    await writeNativeReport({ ...completeOptions, rawPath, completed: true, exitCode: 0 })
    const actualBefore = await readFile(
      join(completeOptions.directory, 'native-summary.json'),
      'utf8',
    )
    assert.equal((await ensureUnexecutedNativeReport(completeOptions)).status, 'passed')
    assert.equal(
      await readFile(join(completeOptions.directory, 'native-summary.json'), 'utf8'),
      actualBefore,
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

await test('native report recovery binds the same source and run instead of accepting another execution', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-native-run-metadata-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const rawPath = join(root, 'native.json'),
    identityPath = join(root, 'metadata.json')
  const identity = {
    schemaVersion: 1,
    kind: 'ci',
    repository: 'mbaxszy7/Pact',
    sourceSha: 'a'.repeat(40),
    runId: 1234,
    runAttempt: 2,
    eventName: 'push',
    ref: 'refs/heads/dev',
  }
  await writeFile(rawPath, JSON.stringify(fixture()))
  await writeFile(identityPath, JSON.stringify({ ...identity, secret: 'private-extension' }))
  const options = {
    rawPath,
    directory: join(root, 'reports'),
    workspace: root,
    identityPath,
    artifactName: 'native-e2e-darwin-arm64-a2',
    completed: true,
    exitCode: 0,
  }
  const written = await writeNativeReport(options)
  assert.deepEqual(written.report.identity, identity)
  assert(nativeMarkdown(written.report).includes('Actions run: 1234, attempt 2'))
  assert.equal((await ensureUnexecutedNativeReport(options)).status, 'passed')
  for (const changes of [{ sourceSha: 'b'.repeat(40) }, { runId: 1235 }, { runAttempt: 3 }]) {
    // oxlint-disable-next-line no-await-in-loop -- Each change probes the same immutable evidence against a different native run.
    await writeFile(identityPath, JSON.stringify({ ...identity, ...changes }))
    // oxlint-disable-next-line no-await-in-loop -- No probe may replace or accept the retained report.
    await assert.rejects(ensureUnexecutedNativeReport(options), /unexpected identity/)
  }
  assert.deepEqual(
    JSON.parse(await readFile(join(options.directory, 'native-summary.json'))).identity,
    identity,
  )
  await writeFile(identityPath, JSON.stringify({ ...identity, runAttempt: 0 }))
  await assert.rejects(
    writeNativeReport({ ...options, directory: join(root, 'invalid') }),
    /identity/,
  )
})
