import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { prepareProviderEnvironment } from '../tests/e2e/provider-environment.ts'
import {
  ciEnvironment,
  scriptTests,
  evidenceEnvironment,
  readCiProviderConfiguration,
  main,
} from './ci.mjs'

void test('trusted preflight rejects missing credentials and invalid indirect Codex auth before candidate hooks can run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-provider-preflight-'))
  const source = {
    RUNNER_TEMP: root,
    PATH: process.env.PATH,
    PACT_E2E_CLAUDE_EXECUTABLE: process.execPath,
    PACT_E2E_CODEX_EXECUTABLE: process.execPath,
    PACT_CLAUDE_SETTINGS_JSON: JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'synthetic-ci-claude-credential',
        ANTHROPIC_BASE_URL: 'https://claude.example.invalid',
      },
    }),
    PACT_CODEX_AUTH_JSON: JSON.stringify({ OPENAI_API_KEY: 'synthetic-ci-codex-credential' }),
    PACT_CODEX_CONFIG_TOML:
      'model_provider="fixture"\ncli_auth_credentials_store="file"\n[model_providers.fixture]\nname="Fixture"\nbase_url="https://codex.example.invalid/v1"\nwire_api="responses"\nenv_key="CI_NATIVE_TOKEN"\n',
    PACT_CODEX_PROVIDER_ENV_JSON: JSON.stringify({
      CI_NATIVE_TOKEN: 'explicit-nonfunctional-fixture',
    }),
  }
  try {
    await main(['validate-provider'], source)
    await assert.rejects(
      main(['validate-provider'], { ...source, PACT_CODEX_AUTH_JSON: '' }),
      /admission or execution failed/,
    )
    await assert.rejects(
      main(['validate-provider'], { ...source, PACT_CODEX_PROVIDER_ENV_JSON: '{}' }),
      /admission or execution failed/,
    )
    assert.deepEqual(await (await import('node:fs/promises')).readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('admits system paths without passing runner credentials or unrelated environment entries', () => {
  const unrelated = Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [`UNRELATED_${index}`, 'x']),
  )
  const env = ciEnvironment({
    ...unrelated,
    PATH: '/owned/bin',
    HOME: '/owned/home',
    CI: 'true',
    GITHUB_TOKEN: 'synthetic-ci-app-private-key',
    PACT_CI_APP_PRIVATE_KEY: 'synthetic-ci-app-private-key',
  })
  assert.deepEqual(env, { PATH: '/owned/bin', HOME: '/owned/home', CI: 'true' })
})

void test('does not raise the existing admitted environment byte bound', () => {
  assert.throws(() => ciEnvironment({ PATH: 'x'.repeat(65536) }), /64 KiB/)
  assert.throws(() => ciEnvironment({ PATH: 'bad\0path' }), /Invalid/)
})

void test('script inventory contains independent secret and platform runner tests', async () => {
  const files = await scriptTests()
  assert(files.includes('scripts/check-secrets.test.mjs'))
  assert(files.includes('scripts/run-e2e-windows.test.mjs'))
  assert(files.includes('scripts/package-smoke.test.mjs'))
})

void test(
  'the real infrastructure caller supervises tightened nested groups and rejects failures and cancellation',
  { skip: process.platform === 'win32', timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-ci-infra-primary-'))
    const scripts = join(root, 'scripts'),
      report = join(root, 'cancel-ready.json')
    const file = join(scripts, 'bounded.test.mjs')
    const source = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PACT_CI_WORKSPACE: root,
      PACT_INFRA_POSIX_OWNED_GROUP_LIMIT: '17',
    }
    const runnerUrl = new URL('./run-e2e.mjs', import.meta.url).href
    try {
      await mkdir(scripts)
      await writeFile(
        file,
        `import assert from 'node:assert/strict';
      import { test } from 'node:test';
      import { run } from ${JSON.stringify(runnerUrl)};
      await test('bounded actual nested subject', async () => {
        assert.equal(process.env.PACT_INFRA_POSIX_OWNED_GROUP_LIMIT, '3');
        const child = 'setTimeout(() => process.exit(0), 2300)';
        const parent = "import {spawn} from 'node:child_process';for(let i=0;i<2;i++)spawn(process.execPath,['-e',"+JSON.stringify(child)+"],{detached:true,stdio:'ignore',shell:false});setTimeout(()=>process.stdout.write('ready\\\\n'),1500);setTimeout(()=>process.exit(0),2800);";
        assert.equal(await run(['--input-type=module','-e',parent],10000,{executable:process.execPath,posixOwnedGroupLimit:3,write(){}}),0);
      });`,
      )
      await main(['infra'], source)
      await writeFile(
        file,
        "import {test} from 'node:test';import assert from 'node:assert/strict';test('controlled failure',()=>assert.fail('controlled assertion'));",
      )
      await assert.rejects(main(['infra'], source), /Required script tests failed/)
      await assert.rejects(
        main(['infra'], { ...source, PACT_CI_WORKSPACE: join(root, 'missing') }),
        /ENOENT/,
      )
      await writeFile(
        file,
        `import {test} from 'node:test';import {writeFileSync} from 'node:fs';
      await test('controlled cancellation',async()=>{writeFileSync(${JSON.stringify(report)},'{}');await new Promise(()=>setInterval(()=>{},1000));});`,
      )
      const pending = main(['infra'], source)
      const rejected = assert.rejects(pending, /Required script tests failed/)
      const until = performance.now() + 10_000
      let ready = false
      while (performance.now() < until) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- This owned marker is read under one fixed deadline before signalling the caller.
          await readFile(report)
          ready = true
          break
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        // oxlint-disable-next-line no-await-in-loop -- The readiness poll settles before its next bounded iteration.
        await delay(25)
      }
      assert.equal(ready, true)
      process.kill(process.pid, 'SIGINT')
      await rejected
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

void test('execution reports use a private explicit path and cannot overwrite old results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-ci-evidence-test-'))
  try {
    const prepared = await evidenceEnvironment(
      'real',
      { CI: 'true' },
      { PACT_CI_EVIDENCE_DIR: directory },
    )
    assert.deepEqual(prepared.forwarded, ['--reporter=line,json'])
    assert.equal(prepared.env.PLAYWRIGHT_JSON_OUTPUT_FILE, join(directory, 'real.json'))
    await writeFile(prepared.path, '{}', { flag: 'wx' })
    await assert.rejects(
      evidenceEnvironment('real', {}, { PACT_CI_EVIDENCE_DIR: directory }),
      /overwritten/,
    )
    await assert.rejects(
      evidenceEnvironment('real', {}, { PACT_CI_EVIDENCE_DIR: 'relative' }),
      /explicit/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

void test('Playwright-worker admission reads only the explicit private Codex env map and seals it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-ci-provider-test-')),
    directory = join(root, 'configuration')
  try {
    await mkdir(join(directory, 'claude'), { recursive: true, mode: 0o700 })
    await mkdir(join(directory, 'codex'), { mode: 0o700 })
    await writeFile(
      join(directory, 'claude/settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'synthetic-ci-claude-credential',
          ANTHROPIC_BASE_URL: 'https://claude.example.invalid',
        },
      }),
      { mode: 0o600 },
    )
    await writeFile(
      join(directory, 'codex/auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'synthetic-ci-codex-credential' }),
      { mode: 0o600 },
    )
    await writeFile(
      join(directory, 'codex/config.toml'),
      'model_provider="fixture"\ncli_auth_credentials_store="file"\n[model_providers.fixture]\nname="Fixture"\nbase_url="https://codex.example.invalid/v1"\nwire_api="responses"\nenv_key="CI_NATIVE_TOKEN"\n',
      { mode: 0o600 },
    )
    const file = join(directory, 'provider-environment.json')
    await writeFile(
      file,
      JSON.stringify({
        CI_NATIVE_TOKEN: 'explicit-nonfunctional-fixture',
        IGNORED: 'not-native-input',
      }),
      { flag: 'wx', mode: 0o600 },
    )
    const env = {
      PACT_E2E_ENV_DIR: directory,
      PACT_E2E_PROVIDER_ENV_FILE: file,
      PACT_E2E_CLAUDE_EXECUTABLE: process.execPath,
      PACT_E2E_CODEX_EXECUTABLE: process.execPath,
      PATH: process.env.PATH,
      CI_NATIVE_TOKEN: 'unrelated-daily-value',
    }
    const configuration = await readCiProviderConfiguration(env)
    const native = await prepareProviderEnvironment(join(root, 'scene'), configuration, env)
    assert.equal(native.env.CI_NATIVE_TOKEN, 'explicit-nonfunctional-fixture')
    assert.equal(native.env.IGNORED, undefined)
    assert.equal(configuration.redact('explicit-nonfunctional-fixture'), '[REDACTED]')
    await configuration.assertSourceIntegrity()
    await writeFile(file, '{}', { mode: 0o600 })
    await assert.rejects(configuration.assertSourceIntegrity(), /changed/)
    await assert.rejects(
      readCiProviderConfiguration({
        ...env,
        PACT_E2E_PROVIDER_ENV_FILE: join(directory, 'codex/auth.json'),
      }),
      /escapes/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
