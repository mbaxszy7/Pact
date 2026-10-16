import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { test } from 'node:test'

import { applicationContent, hashFile } from './build-distribution.mjs'
import {
  main,
  packageSmokeFailureReport,
  packagedRuntimeFailureFacts,
  applicationContentDifference,
  verifyApplication,
  prepareApplication,
} from './package-smoke.mjs'

await test('malformed comparison metadata cannot replace the original exact-content rejection', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pact-content-diagnostic-admission-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'Pact.exe'), 'owned fixture')
  await assert.rejects(
    verifyApplication(
      root,
      {
        platform: 'win32',
        application: { contentSha256: '0'.repeat(64), entries: [null], executable: 'Pact.exe' },
      },
      false,
    ),
    (error) => {
      assert.equal(
        error.message,
        'Installed application content differs from the exact manifest payload.',
      )
      assert.equal(error.applicationContentMismatch, true)
      assert.equal(error.applicationContentDifference, undefined)
      return true
    },
  )
})

await test('content mismatches retain bounded hashes and counts without paths or optional fields', () => {
  const before = {
    contentSha256: 'a'.repeat(64),
    entries: Array.from({ length: 10 }, (_, i) => ({
      path: `synthetic-private-root-${i}`,
      type: 'file',
      sha256: 'b'.repeat(64),
    })),
  }
  const after = {
    sha256: 'c'.repeat(64),
    entries: before.entries.slice(1).map((entry) => ({
      path: entry.path,
      type: entry.type,
      sha256: 'd'.repeat(64),
    })),
  }
  after.entries.push({ path: 'synthetic-new-private-file', type: 'file', sha256: 'e'.repeat(64) })
  const difference = applicationContentDifference(before, after)
  assert.equal(difference.changed, 9)
  assert.equal(difference.missing, 1)
  assert.equal(difference.additional, 1)
  assert.equal(difference.samples.length, 8)
  const report = packageSmokeFailureReport({
    phase: 'installation',
    processes: [],
    applicationContentDifference: { ...difference, privatePath: before.entries[0].path },
  })
  assert.deepEqual(report.applicationContentDifference, difference)
  assert.equal(JSON.stringify(report).includes('synthetic-private'), false)
  assert.equal(JSON.stringify(report).includes('privatePath'), false)
})

await test('runtime failure reports retain fixed categories and result facts without application output', () => {
  const privateOutput =
    'PACT_PACKAGE_IDENTITY:{"privatePath":"synthetic-private-path"}\n' +
    'PACT_PACKAGE_SMOKE:FAIL Error: Cannot find module synthetic-private-path\n'
  const facts = packagedRuntimeFailureFacts(-1073741515, privateOutput)
  assert.deepEqual(facts, {
    runtimeFailure: 'NATIVE_DEPENDENCY',
    observedExitCode: -1073741515,
    runtimeIdentityMarkerReceived: true,
    runtimePassMarkerReceived: false,
  })
  const report = packageSmokeFailureReport({
    processes: [],
    phase: 'seed',
    runtimeFailureFacts: { ...facts, output: privateOutput },
  })
  assert.equal(report.runtimeFailure, 'NATIVE_DEPENDENCY')
  assert.equal(report.observedExitCode, -1073741515)
  assert.equal(JSON.stringify(report).includes('synthetic-private-path'), false)
  assert.deepEqual(packagedRuntimeFailureFacts(null, 'unknown private failure'), {
    runtimeFailure: 'UNCLASSIFIED',
    runtimeIdentityMarkerReceived: false,
    runtimePassMarkerReceived: false,
  })
  const rolled = packagedRuntimeFailureFacts(1, 'x'.repeat(20_000), {
    identity: true,
    passed: true,
  })
  assert.equal(rolled.runtimeIdentityMarkerReceived, true)
  assert.equal(rolled.runtimePassMarkerReceived, true)
})

/** Native process-boundary doubles only; these cases install no software and start no application. */
async function nsisFixture(context, behavior = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pact-nsis-preparation-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const payload = join(root, 'payload'),
    owned = join(root, 'owned'),
    artifact = join(root, 'Pact Dev.exe')
  await mkdir(payload)
  await mkdir(owned)
  await writeFile(join(payload, 'Pact Dev.exe'), 'synthetic application bytes', { mode: 0o700 })
  await writeFile(artifact, 'synthetic installer bytes', { mode: 0o700 })
  const content = await applicationContent(payload, 'win32')
  const manifest = {
    productName: 'Pact Dev',
    platform: 'win32',
    application: {
      executable: 'Pact Dev.exe',
      contentSha256: content.sha256,
      entries: content.entries,
    },
    artifacts: [
      {
        path: 'Pact Dev.exe',
        kind: 'nsis',
        bytes: (await stat(artifact)).size,
        sha256: await hashFile(artifact),
      },
    ],
  }
  const facts = { processes: [], installationCleanupVerified: false },
    calls = []
  const uninstaller = join(owned, 'installed', 'Uninstall Pact Dev.exe')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  context.after(() => Object.defineProperty(process, 'platform', platform))
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_TEMP: root,
  })) {
    const original = process.env[key]
    process.env[key] = value
    context.after(() => {
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    })
  }
  const runProcess = async (args, timeout, options) => {
    calls.push({ args, timeout, options })
    assert.equal(options.windowsArgumentMode, 'nsis')
    assert.equal(timeout, 120_000)
    if (calls.length === 1) {
      await writeFile(
        join(owned, 'installed', 'Pact Dev.exe'),
        behavior.corrupt ? 'changed payload' : 'synthetic application bytes',
        { mode: 0o700 },
      )
      if (!behavior.missingUninstaller)
        await writeFile(uninstaller, 'synthetic uninstaller', { mode: 0o700 })
      if (!behavior.installUnconfirmed)
        options.onState({ kind: 'settled', groupGone: true, ownedProcessCount: 0 })
    } else {
      assert.equal(options.cwd, owned)
      assert.deepEqual(args, ['/S'])
      if (!behavior.uninstallUnconfirmed) {
        if (behavior.uninstallerOnly) await rm(uninstaller)
        else await rm(join(owned, 'installed'), { recursive: true })
        options.onState({ kind: 'settled', groupGone: true, ownedProcessCount: 0 })
      }
    }
    return 0
  }
  return {
    owned,
    uninstaller,
    facts,
    calls,
    prepare: () =>
      prepareApplication({
        manifest,
        manifestPath: join(root, 'distribution-manifest.json'),
        root: owned,
        environment: {},
        facts,
        runProcess,
      }),
  }
}

await test('owned NSIS preparation validates actual installed content then uninstalls from outside its payload', async (context) => {
  const fixture = await nsisFixture(context)
  const application = await fixture.prepare()
  assert.equal(application.installationVerified, true)
  assert.equal(application.verificationMode, 'installed-nsis')
  assert.deepEqual(fixture.calls[0].args, ['/S', `/D=${join(fixture.owned, 'installed')}`])
  await application.dispose()
  await application.dispose()
  assert.equal(fixture.facts.installationCleanupVerified, true)
  assert.equal(fixture.calls.length, 2)
  assert.ok(fixture.facts.processes.every((item) => item.releaseVerified))
})

await test('installer code zero without a physical receipt retains the installation and never starts uninstall', async (context) => {
  const fixture = await nsisFixture(context, { installUnconfirmed: true })
  await assert.rejects(fixture.prepare(), { preserveRoot: true })
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.facts.installationFailureStage, 'installer-run')
  assert.equal(fixture.facts.processes[0].releaseVerified, false)
  assert.equal((await stat(fixture.uninstaller)).isFile(), true)
})

await test('a partial installation without its own uninstaller retains recovery after confirmed installer exit', async (context) => {
  const fixture = await nsisFixture(context, { missingUninstaller: true })
  await assert.rejects(fixture.prepare(), { preserveRoot: true })
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.facts.installationFailureStage, 'uninstaller-check')
  assert.equal(fixture.facts.installationCleanupFailureStage, 'uninstaller-check')
  assert.equal(fixture.facts.processes[0].releaseVerified, true)
  assert.equal((await stat(join(fixture.owned, 'installed', 'Pact Dev.exe'))).isFile(), true)
})

await test('content verification failure still proves genuine uninstall before releasing the fixture', async (context) => {
  const fixture = await nsisFixture(context, { corrupt: true })
  await assert.rejects(fixture.prepare(), /content differs from the exact manifest payload/u)
  assert.equal(fixture.facts.installationFailureStage, 'application-content')
  assert.equal(fixture.facts.installationCleanupVerified, true)
  assert.equal(fixture.calls.length, 2)
})

await test('uninstaller code zero without physical release remains blocked and retains recovery files', async (context) => {
  const fixture = await nsisFixture(context, { uninstallUnconfirmed: true })
  const application = await fixture.prepare()
  await assert.rejects(application.dispose(), { preserveRoot: true })
  assert.equal(fixture.facts.installationCleanupVerified, false)
  assert.equal(fixture.facts.installationCleanupFailureStage, 'uninstall-run')
  assert.equal(fixture.facts.processes[1].releaseVerified, false)
  assert.equal((await stat(fixture.uninstaller)).isFile(), true)
})

await test('a released uninstaller that removes only itself cannot certify payload cleanup', async (context) => {
  const fixture = await nsisFixture(context, { uninstallerOnly: true })
  const application = await fixture.prepare()
  await assert.rejects(application.dispose(), { preserveRoot: true })
  assert.equal(fixture.facts.installationCleanupVerified, false)
  assert.equal((await stat(join(fixture.owned, 'installed', 'Pact Dev.exe'))).isFile(), true)
  assert.equal(fixture.facts.processes[1].releaseVerified, true)
})

await test('verification failure and a later unconfirmed uninstall retain both fixed stages and release failures', async (context) => {
  const fixture = await nsisFixture(context, { corrupt: true, uninstallUnconfirmed: true })
  await assert.rejects(fixture.prepare(), { preserveRoot: true })
  const report = packageSmokeFailureReport({
    ...fixture.facts,
    phase: 'installation',
    recoveryPreserved: true,
  })
  assert.equal(report.installationFailureStage, 'application-content')
  assert.equal(report.installationCleanupFailureStage, 'uninstall-run')
  assert.equal(report.processReleaseVerified, false)
  assert.equal(report.cleanupVerified, false)
  assert.equal(report.recoveryPreserved, true)
  assert.deepEqual(
    report.processes.map((process) => [process.operation, process.releaseVerified]),
    [
      ['install', true],
      ['uninstall', false],
    ],
  )
  assert.equal(JSON.stringify(report).includes(fixture.owned), false)
})

const sourceEnvironment = {
  HOME: '/synthetic-daily-home',
  PATH: '/usr/bin',
  LANG: 'en_US.UTF-8',
  ANTHROPIC_AUTH_TOKEN: 'synthetic-daily-claude-key',
  OPENAI_API_KEY: 'synthetic-daily-codex-key',
  CODEX_HOME: '/synthetic-daily-codex',
  CLAUDE_CONFIG_DIR: '/synthetic-daily-claude',
  ELECTRON_RENDERER_URL: 'https://daily.example.invalid',
  NODE_OPTIONS: '--synthetic-daily-option',
}

/** Process-boundary double only: these tests never launch Electron, CLI or a model. */
function simulatedSpawn(
  calls,
  { pass = true, startupError = false, inspect, interrupt = false } = {},
) {
  return (executable, args, options) => {
    calls.push({ executable, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.kill = (signal) => {
      child.signalCode = signal
      queueMicrotask(() => child.emit('close', null, signal))
      return true
    }
    const complete = () => {
      if (startupError)
        child.emit('error', Object.assign(new Error('Synthetic spawn error'), { code: 'ENOENT' }))
      if (pass) child.stdout.emit('data', Buffer.from('PACT_PACKAGE_SMOKE:PASS\n'))
      child.exitCode = startupError ? null : 0
      child.emit('close', child.exitCode, null)
    }
    queueMicrotask(() => {
      if (interrupt) process.emit('SIGINT')
      else if (!inspect) complete()
      else
        void Promise.resolve()
          .then(() => inspect(options))
          .then(complete, (error) => {
            child.emit('error', error)
            child.exitCode = 1
            child.emit('close', 1, null)
          })
    })
    return child
  }
}

function assertOwnedEnvironment(environment) {
  const root = environment.PACT_E2E_ROOT
  assert.ok(isAbsolute(root))
  for (const key of [
    'HOME',
    'USERPROFILE',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'TMPDIR',
    'TMP',
    'TEMP',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
    'GIT_CONFIG_GLOBAL',
    'SQLITE_TMPDIR',
  ]) {
    const remainder = relative(root, environment[key])
    assert.ok(remainder && !remainder.startsWith('..') && !isAbsolute(remainder), key)
  }
  for (const key of [
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'ELECTRON_RENDERER_URL',
    'NODE_OPTIONS',
  ]) {
    assert.equal(environment[key], undefined, key)
  }
  return root
}

await test('UI packaged smoke needs no model files, isolates both phases and removes its root', async (context) => {
  context.mock.method(console, 'log', () => {})
  const calls = []
  const previousInterrupts = process.listenerCount('SIGINT')
  const previousTerminates = process.listenerCount('SIGTERM')
  await main({
    executable: '/synthetic/Pact',
    sourceEnvironment,
    spawnProcess: simulatedSpawn(calls),
  })
  assert.equal(calls.length, 2)
  const root = assertOwnedEnvironment(calls[0].options.env)
  assert.equal(calls[1].options.env.PACT_E2E_ROOT, root)
  assert.equal(calls[0].options.env.PACT_PACKAGE_SMOKE_PHASE, 'seed')
  assert.equal(calls[1].options.env.PACT_PACKAGE_SMOKE_PHASE, 'verify')
  for (const call of calls) {
    assert.deepEqual(call.args, [])
    assert.equal(call.options.shell, false)
    assert.equal(call.options.env.PACT_PACKAGE_SMOKE, '1')
    assert.equal(call.options.env.PACT_PACKAGE_SMOKE_USER_DATA, join(root, 'electron-profile'))
    assert.equal(call.options.env.NODE_ENV, undefined)
  }
  assert.equal(process.listenerCount('SIGINT'), previousInterrupts)
  assert.equal(process.listenerCount('SIGTERM'), previousTerminates)
  await assert.rejects(stat(root), { code: 'ENOENT' })
})

await test('default smoke admission projects a busy runner host before enforcing the isolated environment bound', async (context) => {
  context.mock.method(console, 'log', () => {})
  const original = process.env
  const calls = []
  try {
    process.env = {
      ...original,
      ...Object.fromEntries(
        Array.from({ length: 129 }, (_, index) => [
          `PACT_UNRELATED_RUNNER_${index}`,
          'synthetic-host-only',
        ]),
      ),
      ANTHROPIC_AUTH_TOKEN: 'synthetic-host-auth-canary',
    }
    await main({ executable: '/synthetic/Pact', spawnProcess: simulatedSpawn(calls) })
    assert.equal(calls.length, 2)
    for (const call of calls) {
      assert.equal(call.options.env.ANTHROPIC_AUTH_TOKEN, undefined)
      assert(
        Object.keys(call.options.env).every((key) => !key.startsWith('PACT_UNRELATED_RUNNER_')),
      )
    }
  } finally {
    process.env = original
  }
})

await test('an explicitly oversized environment still fails closed and exports only its fixed category', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-smoke-env-report-'))
  const reportPath = join(directory, 'failure.json')
  const secret = 'synthetic-unpublished-runner-secret'
  try {
    await assert.rejects(
      main({
        executable: '/synthetic/Pact',
        reportPath,
        sourceEnvironment: Object.fromEntries(
          Array.from({ length: 129 }, (_, index) => [`EXPLICIT_${index}`, secret]),
        ),
        spawnProcess: simulatedSpawn([]),
      }),
      /input environment exceeds/,
    )
    const bytes = await readFile(reportPath, 'utf8')
    const report = JSON.parse(bytes)
    assert.equal(report.status, 'blocked')
    assert.equal(report.environmentFailure, 'HOST_ENVIRONMENT_BOUNDS')
    assert.equal(report.failurePhase, 'environment')
    assert.equal(report.processes.length, 0)
    assert(!bytes.includes(secret))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('a zero exit without the package PASS marker fails and does not start verify', async () => {
  const calls = []
  await assert.rejects(
    main({
      executable: '/synthetic/Pact',
      sourceEnvironment,
      spawnProcess: simulatedSpawn(calls, { pass: false }),
    }),
    /Packaged smoke exited with code 0/,
  )
  assert.equal(calls.length, 1)
  await assert.rejects(stat(calls[0].options.env.PACT_E2E_ROOT), { code: 'ENOENT' })
})

await test('spawn failure removes its private root and releases signal listeners', async () => {
  const calls = []
  const listeners = process.listenerCount('SIGINT')
  await assert.rejects(
    main({
      executable: '/synthetic/Pact',
      sourceEnvironment,
      spawnProcess: simulatedSpawn(calls, { startupError: true }),
    }),
    /failed to start \(ENOENT\)/,
  )
  await assert.rejects(stat(calls[0].options.env.PACT_E2E_ROOT), { code: 'ENOENT' })
  assert.equal(process.listenerCount('SIGINT'), listeners)
})

await test('cancelling smoke closes its owned process and removes the root', async () => {
  const calls = []
  const listeners = process.listenerCount('SIGINT')
  await assert.rejects(
    main({
      executable: '/synthetic/Pact',
      sourceEnvironment,
      spawnProcess: simulatedSpawn(calls, { interrupt: true }),
    }),
    /Packaged smoke cancelled/,
  )
  assert.equal(calls.length, 1)
  await assert.rejects(stat(calls[0].options.env.PACT_E2E_ROOT), { code: 'ENOENT' })
  assert.equal(process.listenerCount('SIGINT'), listeners)
})

await test('real packaged core rejects missing configuration before spawning anything', async () => {
  const calls = []
  await assert.rejects(
    main({
      executable: '/synthetic/Pact',
      realCore: true,
      sourceEnvironment: {
        ...sourceEnvironment,
        PACT_E2E_ENV_DIR: '/synthetic/missing-configuration',
      },
      spawnProcess: simulatedSpawn(calls),
    }),
    /configuration directory does not exist/,
  )
  assert.equal(calls.length, 0)
})

await test('real core copies synthetic native files, launches normal UI twice and keeps restart state owned', async (context) => {
  context.mock.method(console, 'log', () => {})
  const sourceRoot = await mkdtemp(join(tmpdir(), 'pact-package-source-test-'))
  try {
    await mkdir(join(sourceRoot, 'claude'))
    await mkdir(join(sourceRoot, 'codex'))
    const settings = JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'synthetic-package-claude-key' },
    })
    const config = 'model = "synthetic-model"\ncli_auth_credentials_store = "file"\n'
    const auth = JSON.stringify({ OPENAI_API_KEY: 'synthetic-package-codex-key' })
    await writeFile(join(sourceRoot, 'claude/settings.json'), settings)
    await writeFile(join(sourceRoot, 'codex/config.toml'), config)
    await writeFile(join(sourceRoot, 'codex/auth.json'), auth)
    const calls = []
    const spawnProcess = simulatedSpawn(calls, {
      inspect: async ({ env }) => {
        assert.equal(await readFile(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'), settings)
        assert.equal(await readFile(join(env.CODEX_HOME, 'config.toml'), 'utf8'), config)
        assert.equal(await readFile(join(env.CODEX_HOME, 'auth.json'), 'utf8'), auth)
        assert.equal((await stat(join(env.PACT_E2E_ROOT, 'logs/production'))).isDirectory(), true)
        assert.equal((await stat(join(env.PACT_E2E_ROOT, 'project'))).isDirectory(), true)
      },
    })
    await main({
      executable: '/synthetic/Pact',
      realCore: true,
      sourceEnvironment: {
        ...sourceEnvironment,
        PACT_E2E_ENV_DIR: sourceRoot,
        PACT_E2E_CLAUDE_EXECUTABLE: process.execPath,
        PACT_E2E_CODEX_EXECUTABLE: process.execPath,
      },
      spawnProcess: (executable, args, options) => {
        assertOwnedEnvironment(options.env)
        assert.equal(options.env.PACT_PACKAGE_SMOKE, undefined)
        assert.equal(options.env.PACT_PACKAGE_SMOKE_PHASE, undefined)
        assert.equal(options.env.PACT_PACKAGE_SMOKE_USER_DATA, undefined)
        return spawnProcess(executable, args, options)
      },
    })
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].options.env, calls[1].options.env)
    assert.equal(await readFile(join(sourceRoot, 'claude/settings.json'), 'utf8'), settings)
    assert.equal(await readFile(join(sourceRoot, 'codex/config.toml'), 'utf8'), config)
    assert.equal(await readFile(join(sourceRoot, 'codex/auth.json'), 'utf8'), auth)
    await assert.rejects(stat(calls[0].options.env.PACT_E2E_ROOT), { code: 'ENOENT' })
  } finally {
    await rm(sourceRoot, { recursive: true, force: true })
  }
})

await test('configuration and invalid-manifest failures write bounded safe admission reports before any process starts', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-smoke-report-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const missing = join(directory, 'private-provider-configuration'),
    configurationReport = join(directory, 'configuration.json'),
    manifestReport = join(directory, 'manifest-failure.json'),
    manifest = join(directory, 'invalid-manifest.json'),
    secret = 'synthetic-private-manifest-extension',
    calls = []
  await assert.rejects(
    main({
      realCore: true,
      sourceEnvironment: { ...sourceEnvironment, PACT_E2E_ENV_DIR: missing },
      spawnProcess: simulatedSpawn(calls),
      reportPath: configurationReport,
    }),
  )
  await writeFile(manifest, JSON.stringify({ secret }))
  await assert.rejects(
    main({
      manifestPath: manifest,
      sourceEnvironment,
      spawnProcess: simulatedSpawn(calls),
      reportPath: manifestReport,
    }),
  )
  assert.equal(calls.length, 0)
  for (const [path, phase] of [
    [configurationReport, 'configuration'],
    [manifestReport, 'manifest'],
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Compare the two independent immutable admission-failure records.
    const bytes = await readFile(path, 'utf8'),
      report = JSON.parse(bytes)
    assert.equal(report.status, 'blocked')
    assert.equal(report.failurePhase, phase)
    assert.equal(report.manifestIdentityVerified, false)
    assert.equal(report.privateRootCreated, false)
    assert.equal(report.cleanupVerified, true)
    assert.equal(bytes.includes(missing) || bytes.includes(secret), false)
  }
})

await test('seed, verify and cancellation failures retain their stage without inventing process release', async (context) => {
  context.mock.method(console, 'log', () => {})
  const directory = await mkdtemp(join(tmpdir(), 'pact-smoke-process-report-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  for (const phase of ['seed', 'verify', 'cancel']) {
    const calls = [],
      reportPath = join(directory, `${phase}.json`)
    const spawnProcess = (executable, args, options) =>
      simulatedSpawn(calls, {
        pass: phase === 'verify' && calls.length === 0,
        interrupt: phase === 'cancel',
      })(executable, args, options)
    // oxlint-disable-next-line no-await-in-loop -- Each process-boundary double owns a distinct fixture/report and completes cleanup before the next case.
    await assert.rejects(
      main({ executable: '/synthetic/Pact', sourceEnvironment, spawnProcess, reportPath }),
    )
    // oxlint-disable-next-line no-await-in-loop -- Read the immutable safe projection after the failed owner has completed its cleanup attempt.
    const text = await readFile(reportPath, 'utf8'),
      report = JSON.parse(text)
    assert.equal(report.status, 'blocked')
    assert.equal(report.failurePhase, phase === 'cancel' ? 'seed' : phase)
    assert.equal(report.processReleaseVerified, false)
    assert.equal(report.cleanupVerified, false)
    assert.equal(report.privateRootCleanupVerified, true)
    assert.equal(
      report.failureCode,
      phase === 'cancel' ? 'EXECUTION_INTERRUPTED' : 'VERIFICATION_FAILED',
    )
    assert.equal(text.includes(calls[0].options.env.PACT_E2E_ROOT), false)
    // oxlint-disable-next-line no-await-in-loop -- Confirm the owned double's private root was removed without interpreting that as physical child proof.
    await assert.rejects(stat(calls[0].options.env.PACT_E2E_ROOT), { code: 'ENOENT' })
  }
})

await test('existing reports stop admission and cleanup failures remain explicitly blocked with recovery retained', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-smoke-report-guard-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const reportPath = join(directory, 'report.json'),
    calls = []
  await writeFile(reportPath, 'existing recovery evidence')
  await assert.rejects(
    main({
      executable: '/synthetic/Pact',
      sourceEnvironment,
      spawnProcess: simulatedSpawn(calls),
      reportPath,
    }),
    { code: 'EEXIST' },
  )
  assert.equal(calls.length, 0)
  assert.equal(await readFile(reportPath, 'utf8'), 'existing recovery evidence')
  const secret = 'synthetic-private-output',
    report = packageSmokeFailureReport({
      phase: 'verify',
      failurePhase: 'verify',
      cleanupFailed: true,
      processes: [{ phase: 'verify', releaseVerified: false, error: secret, pid: 42 }],
      privateRootCreated: true,
      privateRootCleanupVerified: false,
      installationCleanupVerified: false,
      providerCopiesCleanupVerified: true,
      recoveryPreserved: true,
      error: { message: secret },
      privateRoot: secret,
    })
  assert.equal(report.failureCode, 'CLEANUP_UNCONFIRMED')
  assert.equal(report.cleanupVerified, false)
  assert.equal(report.recoveryPreserved, true)
  assert.equal(JSON.stringify(report).includes(secret), false)
  assert.equal(Object.hasOwn(report.processes[0], 'pid'), false)
})

await test('a parsed manifest contributes only validated distribution identity to a pre-launch failure report', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-smoke-identity-report-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const manifestPath = join(directory, 'distribution-manifest.json'),
    reportPath = join(directory, 'failure.json'),
    secret = 'synthetic-private-package-extension',
    calls = []
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      channel: 'dev',
      platform: process.platform,
      arch: process.arch,
      productName: 'Pact Dev',
      appId: 'com.pact.desktop.dev',
      version: '0.1.0',
      sourceSha: 'a'.repeat(40),
      buildNumber: '1',
      application: {
        path: 'unpacked',
        executable: 'Pact',
        contentSha256: 'b'.repeat(64),
        entries: [],
        secret,
      },
      artifacts: [],
      extensions: secret,
    }),
  )
  await assert.rejects(
    main({ manifestPath, reportPath, sourceEnvironment, spawnProcess: simulatedSpawn(calls) }),
    /genuine owned process/,
  )
  const text = await readFile(reportPath, 'utf8'),
    report = JSON.parse(text)
  assert.equal(report.failurePhase, 'admission')
  assert.equal(report.manifestIdentityVerified, true)
  assert.equal(report.applicationContentVerified, false)
  assert.equal(report.runtimeIdentityVerified, false)
  assert.equal(report.sourceSha, 'a'.repeat(40))
  assert.equal(report.appContentHash, 'b'.repeat(64))
  assert.equal(report.cleanupVerified, true)
  assert.equal(text.includes(secret) || text.includes(directory), false)
  assert.equal(calls.length, 0)
})
