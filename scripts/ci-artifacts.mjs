import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import identities from '../apps/desktop/app-identities.json' with { type: 'json' }
import { isScriptEntry } from './script-entry.mjs'

const hashPattern = /^[a-f0-9]{64}$/u
const sourcePattern = /^[a-f0-9]{40}$/u
const targets = new Set(['darwin-arm64', 'win32-x64'])
const requireFact = (fact, message) => {
  if (!fact) throw new Error(message)
}

function positive(value) {
  const number = Number(value)
  requireFact(
    /^\d{1,16}$/u.test(String(value)) && Number.isSafeInteger(number) && number > 0,
    'Invalid execution number',
  )
  return number
}

export function artifactDigest(value) {
  requireFact(
    typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/u.test(value),
    'Missing artifact digest',
  )
  return value.replace(/^sha256:/u, '')
}

async function readJson(path, maximum = 256 * 1024) {
  const info = await lstat(path)
  requireFact(
    info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum,
    'Invalid bounded evidence file',
  )
  const handle = await open(
    path,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  )
  try {
    const opened = await handle.stat()
    requireFact(
      opened.isFile() &&
        opened.dev === info.dev &&
        opened.ino === info.ino &&
        opened.size === info.size,
      'Evidence file identity changed',
    )
    const buffer = Buffer.alloc(maximum + 1)
    let length = 0
    while (length < buffer.length) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One bounded evidence read completes before parsing.
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    requireFact(length === info.size, 'Evidence file changed or exceeded its bound')
    try {
      return JSON.parse(buffer.subarray(0, length).toString('utf8'))
    } catch {
      throw new Error('Evidence file is not valid JSON')
    }
  } finally {
    await handle.close()
  }
}

async function admittedFile(root, name, maximum = 2 * 1024 ** 3) {
  requireFact(
    typeof name === 'string' &&
      name.length <= 255 &&
      name === basename(name) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) &&
      !['.', '..'].includes(name),
    'Invalid artifact basename',
  )
  const path = join(root, name)
  const info = await lstat(path)
  requireFact(
    info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum,
    'Invalid artifact file',
  )
  const handle = await open(
    path,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  )
  const opened = await handle.stat()
  if (
    !opened.isFile() ||
    opened.dev !== info.dev ||
    opened.ino !== info.ino ||
    opened.size !== info.size
  ) {
    await handle.close()
    throw new Error('Artifact file identity changed')
  }
  const hash = createHash('sha256')
  const stream = handle.createReadStream({ autoClose: false })
  let bytes = 0
  const timer = setTimeout(
    () => stream.destroy(new Error('Artifact hashing deadline exceeded')),
    5 * 60_000,
  )
  try {
    for await (const chunk of stream) {
      bytes += chunk.byteLength
      requireFact(bytes <= info.size, 'Artifact changed or exceeded its bound')
      hash.update(chunk)
    }
    requireFact(bytes === info.size, 'Artifact byte count changed')
  } finally {
    clearTimeout(timer)
    stream.destroy()
    await handle.close()
  }
  return { path, name, bytes: info.size, sha256: hash.digest('hex') }
}

function manifestIdentity(manifest, expected) {
  const key = `${expected.platform}-${expected.arch}`
  const identity = identities[expected.channel === 'dev' ? 'development-ci' : 'production-ci']
  requireFact(
    targets.has(key) && ['dev', 'stable'].includes(expected.channel),
    'Unsupported distribution target',
  )
  requireFact(
    manifest.schemaVersion === 1 &&
      manifest.smokeProtocolVersion === 2 &&
      sourcePattern.test(manifest.sourceSha) &&
      manifest.sourceSha === expected.sourceSha &&
      manifest.sourceDirty === false,
    'Distribution source is dirty or differs',
  )
  requireFact(
    manifest.channel === expected.channel &&
      manifest.platform === expected.platform &&
      manifest.arch === expected.arch &&
      manifest.productName === identity.name &&
      manifest.appId === identity.appId &&
      manifest.profile === (expected.channel === 'dev' ? 'development-ci' : 'production-ci'),
    'Distribution product identity differs',
  )
  requireFact(
    typeof manifest.version === 'string' &&
      /^\d+\.\d+\.\d+(?:-dev\.\d+\.sha[a-f0-9]{12})?$/u.test(manifest.version) &&
      (expected.version === undefined || manifest.version === expected.version),
    'Distribution version differs',
  )
  requireFact(
    typeof manifest.productVersion === 'string' &&
      /^\d+\.\d+\.\d+$/u.test(manifest.productVersion) &&
      (expected.channel !== 'stable' || manifest.productVersion === manifest.version),
    'Invalid product version',
  )
  requireFact(
    hashPattern.test(manifest.application?.contentSha256) &&
      Array.isArray(manifest.application.entries) &&
      manifest.application.entries.length > 0 &&
      manifest.application.entries.length <= 16_384,
    'Application content evidence is missing',
  )
  const kinds = expected.platform === 'darwin' ? ['dmg', 'zip'] : ['nsis']
  requireFact(
    Array.isArray(manifest.artifacts) &&
      manifest.artifacts.length === kinds.length &&
      new Set(manifest.artifacts.map((item) => item.kind)).size === kinds.length &&
      manifest.artifacts.every(
        (item) =>
          kinds.includes(item.kind) &&
          hashPattern.test(item.sha256) &&
          Number.isSafeInteger(item.bytes) &&
          item.bytes > 0,
      ),
    'Every required installer must be present exactly once',
  )
  return key
}

function execution(kind, env = process.env) {
  requireFact(sourcePattern.test(env.GITHUB_SHA), 'Exact source SHA is required')
  requireFact(['dev', 'stable'].includes(env.PACT_CI_CHANNEL), 'Exact channel is required')
  const [platform, arch] = (env.PACT_CI_PLATFORM ?? '').split('-')
  requireFact(targets.has(`${platform}-${arch}`), 'Exact native target is required')
  return {
    schemaVersion: 1,
    kind,
    sourceSha: env.GITHUB_SHA,
    runId: positive(env.GITHUB_RUN_ID),
    producerAttempt: positive(env.GITHUB_RUN_ATTEMPT),
    platform,
    arch,
    channel: env.PACT_CI_CHANNEL,
  }
}

function contextIdentity(context, kind, expected) {
  requireFact(
    context.schemaVersion === 1 &&
      context.kind === kind &&
      context.sourceSha === expected.sourceSha &&
      context.runId === positive(expected.runId) &&
      context.platform === expected.platform &&
      context.arch === expected.arch &&
      context.channel === expected.channel,
    'Execution evidence differs from the selected source/run/target',
  )
  positive(context.producerAttempt)
}

export async function writePackageContext(root, env = process.env) {
  const context = execution('package', env)
  requireFact(
    context.platform === process.platform && context.arch === process.arch,
    'Package must be built on its native runner',
  )
  manifestIdentity(
    await readJson(join(root, 'distribution-manifest.json'), 4 * 1024 * 1024),
    context,
  )
  await writeFile(join(root, 'execution-context.json'), `${JSON.stringify(context, null, 2)}\n`, {
    flag: 'wx',
  })
  return context
}

function smokeIdentity(report, manifest, artifact) {
  requireFact(
    report.schemaVersion === 1 &&
      report.status === 'passed' &&
      ['sourceSha', 'version', 'channel', 'platform', 'arch', 'appId', 'productName'].every(
        (key) => report[key] === manifest[key],
      ),
    'Installed smoke identity differs or did not pass',
  )
  requireFact(
    report.appContentHash === manifest.application.contentSha256 &&
      report.installationVerified === true &&
      report.cleanupVerified === true &&
      report.defaultChannelPathsVerified === true &&
      report.productionDataRootVerified === true &&
      Array.isArray(report.phases) &&
      report.phases.length === 2 &&
      report.phases[0] === 'seed' &&
      report.phases[1] === 'verify' &&
      report.processOwnership ===
        (manifest.platform === 'darwin' ? 'verified-process-groups' : 'native-job'),
    'Installed runtime, restart, paths or cleanup evidence is incomplete',
  )
  const mode = { dmg: 'mounted-dmg-copy', zip: 'extracted-zip', nsis: 'installed-nsis' }[
    artifact.kind
  ]
  requireFact(
    report.verificationMode === mode &&
      Array.isArray(report.artifacts) &&
      report.artifacts.length === 1 &&
      ['path', 'sha256', 'bytes'].every((key) => report.artifacts[0][key] === artifact[key]),
    'Smoke did not consume the exact installer',
  )
}

/** Cross-platform admission is read-only; publisher never executes a downloaded package. */
export async function validateCandidate({
  packageRoot,
  smokeRoot,
  packageId,
  packageDigest,
  expected,
}) {
  const manifest = await readJson(join(packageRoot, 'distribution-manifest.json'), 4 * 1024 * 1024)
  const key = manifestIdentity(manifest, expected)
  const packageContext = await readJson(join(packageRoot, 'execution-context.json'))
  const smokeContext = await readJson(join(smokeRoot, 'execution-context.json'))
  contextIdentity(packageContext, 'package', expected)
  contextIdentity(smokeContext, 'installed-smoke', expected)
  requireFact(
    smokeContext.packageArtifactId === positive(packageId) &&
      artifactDigest(smokeContext.packageArtifactDigest) === artifactDigest(packageDigest) &&
      smokeContext.producerAttempt >= packageContext.producerAttempt,
    'Smoke consumed a different package or invalid attempt',
  )
  const files = [],
    installers = []
  for (const artifact of manifest.artifacts) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Hash one installer stream at a time.
    const actual = await admittedFile(packageRoot, artifact.path)
    requireFact(
      actual.sha256 === artifact.sha256 && actual.bytes === artifact.bytes,
      'Installer content differs from its manifest',
    )
    files.push(actual)
    installers.push(actual)
    const name =
      artifact.kind === 'zip' ? 'package-zip-smoke-report.json' : 'package-smoke-report.json'
    // oxlint-disable-next-line eslint/no-await-in-loop -- Admit one bounded native report per installer.
    smokeIdentity(await readJson(join(smokeRoot, name)), manifest, artifact)
  }
  for (const [directory, name, publicName, maximum] of [
    [
      packageRoot,
      'distribution-manifest.json',
      `${key}-distribution-manifest.json`,
      4 * 1024 * 1024,
    ],
    [packageRoot, 'execution-context.json', `${key}-package-execution.json`, 256 * 1024],
    [smokeRoot, 'execution-context.json', `${key}-smoke-execution.json`, 256 * 1024],
    [smokeRoot, 'package-smoke-report.json', `${key}-package-smoke-report.json`, 256 * 1024],
    ...(expected.platform === 'darwin'
      ? [
          [
            smokeRoot,
            'package-zip-smoke-report.json',
            `${key}-package-zip-smoke-report.json`,
            256 * 1024,
          ],
        ]
      : []),
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Evidence files have small individual byte limits.
    files.push({ ...(await admittedFile(directory, name, maximum)), name: publicName })
  }
  requireFact(
    new Set(files.map((file) => file.name)).size === files.length,
    'Distribution asset names collide',
  )
  return { manifest, installers, files, packageContext, smokeContext }
}

export async function runInstalledSmoke(
  packageRoot,
  smokeRoot,
  packageId,
  packageDigest,
  env = process.env,
  invoke,
) {
  const context = {
    ...execution('installed-smoke', env),
    packageArtifactId: positive(packageId),
    packageArtifactDigest: artifactDigest(packageDigest),
  }
  requireFact(
    context.platform === process.platform && context.arch === process.arch,
    'Installed smoke requires the native runner',
  )
  const manifest = await readJson(join(packageRoot, 'distribution-manifest.json'), 4 * 1024 * 1024)
  manifestIdentity(manifest, context)
  const packageContext = await readJson(join(packageRoot, 'execution-context.json'))
  contextIdentity(packageContext, 'package', context)
  requireFact(
    packageContext.producerAttempt <= context.producerAttempt,
    'Package comes from a future attempt',
  )
  await mkdir(smokeRoot, { recursive: true, mode: 0o700 })
  const smoke = invoke ?? (await import('./package-smoke.mjs')).main
  for (const artifact of manifest.artifacts) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Native install roots have exactly one owner at a time.
    await smoke({
      manifestPath: join(packageRoot, 'distribution-manifest.json'),
      artifactPath: join(packageRoot, artifact.path),
      productionPaths: true,
      reportPath: join(
        smokeRoot,
        artifact.kind === 'zip' ? 'package-zip-smoke-report.json' : 'package-smoke-report.json',
      ),
    })
  }
  await writeFile(
    join(smokeRoot, 'execution-context.json'),
    `${JSON.stringify(context, null, 2)}\n`,
    { flag: 'wx' },
  )
  await validateCandidate({ packageRoot, smokeRoot, packageId, packageDigest, expected: context })
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const [command, ...values] = args
  if (command === 'package-context' && values.length === 1)
    return writePackageContext(resolve(values[0]), env)
  if (command === 'smoke' && values.length === 4)
    return runInstalledSmoke(resolve(values[0]), resolve(values[1]), values[2], values[3], env)
  if (command === 'verify' && values.length === 4) {
    const expected = execution('installed-smoke', env)
    return validateCandidate({
      packageRoot: resolve(values[0]),
      smokeRoot: resolve(values[1]),
      packageId: values[2],
      packageDigest: values[3],
      expected,
    })
  }
  throw new Error(
    'Use package-context ROOT, smoke PACKAGE SMOKE ID DIGEST, or verify PACKAGE SMOKE ID DIGEST',
  )
}

if (isScriptEntry(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
