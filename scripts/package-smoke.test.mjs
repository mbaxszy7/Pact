import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { test } from 'node:test'

import { main } from './package-smoke.mjs'

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
