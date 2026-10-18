import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  artifactDigest,
  runInstalledSmoke,
  validateCandidate,
  writePackageContext,
} from './ci-artifacts.mjs'

const sourceSha = 'a'.repeat(40)
const packageDigest = 'b'.repeat(64)
const contentSha256 = 'c'.repeat(64)
const env = (platform, arch, attempt = 2) => ({
  GITHUB_SHA: sourceSha,
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: String(attempt),
  PACT_CI_PLATFORM: `${platform}-${arch}`,
  PACT_CI_CHANNEL: 'stable',
})
const json = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`)

function smokeReport(manifest, artifact) {
  return {
    schemaVersion: 1,
    status: 'passed',
    ...Object.fromEntries(
      ['sourceSha', 'version', 'channel', 'platform', 'arch', 'appId', 'productName'].map((key) => [
        key,
        manifest[key],
      ]),
    ),
    appContentHash: contentSha256,
    artifacts: [artifact],
    installationVerified: true,
    cleanupVerified: true,
    defaultChannelPathsVerified: true,
    productionDataRootVerified: true,
    verificationMode: { dmg: 'mounted-dmg-copy', zip: 'extracted-zip', nsis: 'installed-nsis' }[
      artifact.kind
    ],
    phases: ['seed', 'verify'],
    processOwnership: manifest.platform === 'darwin' ? 'verified-process-groups' : 'native-job',
  }
}

async function fixture(t, platform = 'darwin', arch = 'arm64') {
  const root = await mkdtemp(join(tmpdir(), 'pact-artifact-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'package'),
    smokeRoot = join(root, 'smoke')
  await Promise.all([mkdir(packageRoot), mkdir(smokeRoot)])
  const artifacts = []
  for (const kind of platform === 'darwin' ? ['dmg', 'zip'] : ['nsis']) {
    const extension = kind === 'nsis' ? 'exe' : kind
    const bytes = Buffer.from(`Native installer ${platform}-${kind}`)
    const artifact = {
      kind,
      path: `Pact-0.1.0-${platform}-${arch}.${extension}`,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    artifacts.push(artifact)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Small isolated native payload fixtures.
    await writeFile(join(packageRoot, artifact.path), bytes)
  }
  const manifest = {
    schemaVersion: 1,
    smokeProtocolVersion: 2,
    profile: 'production-ci',
    sourceSha,
    sourceDirty: false,
    version: '0.1.0',
    productVersion: '0.1.0',
    channel: 'stable',
    platform,
    arch,
    productName: 'Pact',
    appId: 'com.pact.desktop',
    application: {
      contentSha256,
      entries: [{ path: 'app', type: 'file', bytes: 1, sha256: contentSha256 }],
    },
    artifacts,
  }
  const packageContext = {
    schemaVersion: 1,
    kind: 'package',
    sourceSha,
    runId: 123,
    producerAttempt: 1,
    platform,
    arch,
    channel: 'stable',
  }
  const smokeContext = {
    ...packageContext,
    kind: 'installed-smoke',
    producerAttempt: 2,
    packageArtifactId: 456,
    packageArtifactDigest: packageDigest,
  }
  await Promise.all([
    json(join(packageRoot, 'distribution-manifest.json'), manifest),
    json(join(packageRoot, 'execution-context.json'), packageContext),
    json(join(smokeRoot, 'execution-context.json'), smokeContext),
  ])
  for (const artifact of artifacts)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each installer has its own runtime report.
    await json(
      join(
        smokeRoot,
        artifact.kind === 'zip' ? 'package-zip-smoke-report.json' : 'package-smoke-report.json',
      ),
      smokeReport(manifest, artifact),
    )
  const options = {
    packageRoot,
    smokeRoot,
    packageId: 456,
    packageDigest,
    expected: { sourceSha, runId: 123, version: '0.1.0', platform, arch, channel: 'stable' },
  }
  return { root, manifest, packageContext, smokeContext, options }
}

void test('native candidates admit exact bytes and earlier successful producer attempts', async (t) => {
  for (const [platform, arch] of [
    ['darwin', 'arm64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Verify disjoint native evidence fixtures sequentially.
    const candidate = await fixture(t, platform, arch)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each bounded validation streams only its own installer.
    const result = await validateCandidate(candidate.options)
    assert.equal(result.packageContext.producerAttempt, 1)
    assert.equal(result.smokeContext.producerAttempt, 2)
    assert.equal(result.files.length, platform === 'darwin' ? 7 : 5)
    assert.deepEqual(
      result.installers.map(({ name, bytes, sha256 }) => ({ path: name, bytes, sha256 })),
      candidate.manifest.artifacts.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    )
    assert.equal(new Set(result.files.map((file) => file.name)).size, result.files.length)
    assert.equal(result.manifest.sourceSha, sourceSha)
  }
})

void test('Windows arm64 evidence cannot reuse x64 package or smoke execution context', async (t) => {
  const { options, packageContext, smokeContext } = await fixture(t, 'win32', 'arm64')
  await validateCandidate(options)
  const packagePath = join(options.packageRoot, 'execution-context.json')
  await json(packagePath, { ...packageContext, arch: 'x64' })
  await assert.rejects(validateCandidate(options), /Execution evidence differs/u)
  await json(packagePath, packageContext)
  await json(join(options.smokeRoot, 'execution-context.json'), { ...smokeContext, arch: 'x64' })
  await assert.rejects(validateCandidate(options), /Execution evidence differs/u)
})

void test('same-name installer changes cannot reuse passing installed smoke', async (t) => {
  const { manifest, options } = await fixture(t)
  await writeFile(join(options.packageRoot, manifest.artifacts[0].path), 'different installer')
  await assert.rejects(validateCandidate(options), /Installer content differs/u)
})

void test('a different artifact ID or digest cannot reuse matching installed bytes', async (t) => {
  const { options } = await fixture(t)
  await assert.rejects(
    validateCandidate({ ...options, packageId: 789 }),
    /Smoke consumed a different package/u,
  )
  await assert.rejects(
    validateCandidate({ ...options, packageDigest: 'd'.repeat(64) }),
    /Smoke consumed a different package/u,
  )
  assert.equal(artifactDigest(`sha256:${packageDigest}`), packageDigest)
  assert.throws(() => artifactDigest('missing'), /digest/u)
})

void test('source, run, product, format and clean-source obligations fail closed', async (t) => {
  const { manifest, options, packageContext } = await fixture(t)
  await assert.rejects(
    validateCandidate({ ...options, expected: { ...options.expected, sourceSha: 'e'.repeat(40) } }),
    /source/u,
  )
  await assert.rejects(
    validateCandidate({ ...options, expected: { ...options.expected, runId: 999 } }),
    /Execution evidence/u,
  )
  await assert.rejects(
    validateCandidate({ ...options, expected: { ...options.expected, version: '0.2.0' } }),
    /version/u,
  )
  await json(join(options.packageRoot, 'execution-context.json'), {
    ...packageContext,
    producerAttempt: 3,
  })
  await assert.rejects(validateCandidate(options), /invalid attempt/u)
  await json(join(options.packageRoot, 'execution-context.json'), packageContext)
  for (const bad of [
    { ...manifest, sourceDirty: true },
    { ...manifest, productName: 'Pact Dev' },
    { ...manifest, artifacts: [manifest.artifacts[0]] },
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Exercise each genuine admission invariant independently.
    await json(join(options.packageRoot, 'distribution-manifest.json'), bad)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Do not run parallel writes against this fixture manifest.
    await assert.rejects(validateCandidate(options), /dirty|identity|installer/u)
  }
})

void test('installation, restart, normal data roots, cleanup and runtime content are mandatory', async (t) => {
  const { manifest, options } = await fixture(t)
  const path = join(options.smokeRoot, 'package-smoke-report.json')
  const original = smokeReport(manifest, manifest.artifacts[0])
  for (const change of [
    { cleanupVerified: false },
    { productionDataRootVerified: false },
    { defaultChannelPathsVerified: false },
    { installationVerified: false },
    { appContentHash: 'd'.repeat(64) },
    { phases: ['seed'] },
    { processOwnership: 'unknown' },
    { artifacts: [{ ...manifest.artifacts[0], sha256: 'd'.repeat(64) }] },
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each runtime fact must independently reject the candidate.
    await json(path, { ...original, ...change })
    // oxlint-disable-next-line eslint/no-await-in-loop -- Verify through the publishing admission interface.
    await assert.rejects(validateCandidate(options), /incomplete|exact installer/u)
  }
})

void test('package context records actual native source/run and cannot overwrite evidence', async (t) => {
  const { options } = await fixture(t, process.platform, process.arch)
  await rm(join(options.packageRoot, 'execution-context.json'))
  const context = await writePackageContext(
    options.packageRoot,
    env(process.platform, process.arch, 1),
  )
  assert.equal(context.runId, 123)
  assert.equal(context.producerAttempt, 1)
  await assert.rejects(
    writePackageContext(options.packageRoot, env(process.platform, process.arch, 1)),
    { code: 'EEXIST' },
  )
  await assert.rejects(
    writePackageContext(options.packageRoot, {
      ...env(process.platform, process.arch),
      GITHUB_SHA: 'bad',
    }),
    /source SHA/u,
  )
})

void test('smoke owner passes each exact downloaded installer to the production-path verifier', async (t) => {
  const { manifest, options } = await fixture(t, process.platform, process.arch)
  const output = join(await mkdtemp(join(tmpdir(), 'pact-smoke-contract-')), 'reports')
  t.after(() => rm(join(output, '..'), { recursive: true, force: true }))
  const invocations = []
  await runInstalledSmoke(
    options.packageRoot,
    output,
    456,
    packageDigest,
    env(process.platform, process.arch),
    async (invocation) => {
      invocations.push(invocation)
      const artifact = manifest.artifacts.find(
        (item) => join(options.packageRoot, item.path) === invocation.artifactPath,
      )
      assert.ok(artifact)
      assert.equal(invocation.productionPaths, true)
      await json(invocation.reportPath, smokeReport(manifest, artifact))
    },
  )
  assert.equal(invocations.length, manifest.artifacts.length)
  const context = JSON.parse(await readFile(join(output, 'execution-context.json'), 'utf8'))
  assert.equal(context.packageArtifactId, 456)
  assert.equal(context.packageArtifactDigest, packageDigest)
})
