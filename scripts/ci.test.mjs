import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { prepareProviderEnvironment } from '../tests/e2e/provider-environment.ts'
import { collectNoCredentialDiagnostics } from './ci-ui-diagnostics.mjs'
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
    assert.equal(Object.hasOwn(prepared.env, 'PACT_E2E_OUTPUT_DIR'), false)
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

void test('lane output is private and independent while local execution without evidence remains unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-ci-lane-output-'))
  try {
    const env = { CI: 'true' }
    assert.deepEqual(await evidenceEnvironment('ui', env, {}), { env, forwarded: [] })
    const ui = await evidenceEnvironment('ui', env, { PACT_CI_EVIDENCE_DIR: directory })
    const deterministic = await evidenceEnvironment('deterministic', env, {
      PACT_CI_EVIDENCE_DIR: directory,
    })
    assert.equal(ui.env.PACT_E2E_OUTPUT_DIR, join(directory, 'ui/test-results'))
    assert.equal(
      deterministic.env.PACT_E2E_OUTPUT_DIR,
      join(directory, 'deterministic/test-results'),
    )
    assert.notEqual(ui.env.PACT_E2E_OUTPUT_DIR, deterministic.env.PACT_E2E_OUTPUT_DIR)
    await writeFile(join(directory, 'ui/recovery.txt'), 'retain incomplete lane')
    await assert.rejects(evidenceEnvironment('ui', env, { PACT_CI_EVIDENCE_DIR: directory }), {
      code: 'EEXIST',
    })
    assert.equal(
      await readFile(join(directory, 'ui/recovery.txt'), 'utf8'),
      'retain incomplete lane',
    )
    await assert.rejects(
      evidenceEnvironment('unknown', env, { PACT_CI_EVIDENCE_DIR: directory }),
      /explicit/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

void test('two genuinely failed Playwright invocations preserve the first lane context and trace after the second starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-ci-playwright-lanes-'))
  try {
    const evidence = join(root, 'evidence'),
      output = join(root, 'diagnostics')
    const config = join(root, 'playwright.config.mjs')
    await writeFile(
      config,
      `export default {testDir:'.',testMatch:'lanes.spec.mjs',outputDir:process.env.PACT_E2E_OUTPUT_DIR,retries:0,workers:1,projects:[{name:'ui',grep:/@ui\\b/},{name:'deterministic',grep:/@deterministic\\b/}]};\n`,
    )
    await writeFile(
      join(root, 'lanes.spec.mjs'),
      `import {test,expect} from ${JSON.stringify(import.meta.resolve('@playwright/test'))};
import {writeFile} from 'node:fs/promises';
for(const lane of ['ui','deterministic']) test('synthetic '+lane+' failure',{tag:'@'+lane},async({},info)=>{
await writeFile(info.outputPath('trace.zip'),Buffer.from([0x50,0x4b,lane==='ui'?1:2]));
expect(1).toBe(2);
});\n`,
    )
    const execute = promisify(execFile),
      cli = fileURLToPath(import.meta.resolve('@playwright/test/cli'))
    const env = ciEnvironment({ ...process.env, CI: 'true' })
    const ui = await evidenceEnvironment('ui', env, { PACT_CI_EVIDENCE_DIR: evidence })
    await assert.rejects(
      execute(
        process.execPath,
        [cli, 'test', '--config', config, '--project=ui', ...ui.forwarded],
        { cwd: root, env: ui.env, timeout: 20000, maxBuffer: 128 * 1024 },
      ),
      { code: 1 },
    )
    const cases = (await readdir(ui.env.PACT_E2E_OUTPUT_DIR, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory(),
    )
    assert.equal(cases.length, 1)
    const firstContext = join(ui.env.PACT_E2E_OUTPUT_DIR, cases[0].name, 'error-context.md')
    const firstText = await readFile(firstContext, 'utf8')
    assert.match(firstText, /synthetic ui failure/u)
    const deterministic = await evidenceEnvironment('deterministic', env, {
      PACT_CI_EVIDENCE_DIR: evidence,
    })
    await assert.rejects(
      execute(
        process.execPath,
        [cli, 'test', '--config', config, '--project=deterministic', ...deterministic.forwarded],
        { cwd: root, env: deterministic.env, timeout: 20000, maxBuffer: 128 * 1024 },
      ),
      { code: 1 },
    )
    assert.equal(await readFile(firstContext, 'utf8'), firstText)
    const collected = await collectNoCredentialDiagnostics(evidence, output)
    assert.equal(collected.complete, true)
    assert.equal(collected.totalFiles, 4)
    assert.deepEqual(
      collected.lanes.map((lane) => lane.lane),
      ['ui', 'deterministic'],
    )
    for (const lane of collected.lanes) {
      const context = lane.files.find((file) => file.path.endsWith('/error-context.md'))
      const trace = lane.files.find((file) => file.path.endsWith('/trace.zip'))
      assert(context && trace)
      // oxlint-disable-next-line no-await-in-loop -- Verify both independently collected lane files after both genuine Playwright processes ended.
      const text = await readFile(join(output, lane.lane, context.path), 'utf8')
      assert(text.includes(`synthetic ${lane.lane} failure`))
      if (lane.lane === 'ui') assert.equal(text, firstText)
      // oxlint-disable-next-line no-await-in-loop -- The first trace remains complete when the next lane's disposable output is initialized.
      const traceBytes = await readFile(join(output, lane.lane, trace.path))
      assert.deepEqual(traceBytes, Buffer.from([0x50, 0x4b, lane.lane === 'ui' ? 1 : 2]))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
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
