import { execFile } from 'node:child_process'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { parse as parseToml } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildWindowsAgyApiKeyLauncherSource,
  DEFAULT_REAL_AGY_MODEL,
  loadProviderConfiguration,
  prepareProviderEnvironment,
  providerExecutableCandidates,
  runIsolatedKeylessProjectNode,
} from './provider-environment.js'

const execFileAsync = promisify(execFile)

const claudeKey = 'synthetic-claude-credential-123456'
const codexKey = 'synthetic-codex-credential-123456'
const defaultSettings = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  env: {
    ANTHROPIC_AUTH_TOKEN: claudeKey,
    ANTHROPIC_BASE_URL: 'https://claude.example.invalid',
    ANTHROPIC_MODEL: 'third-party/custom-model[1m]',
  },
  unknownNativeField: { retained: true },
}
const defaultToml = `# Preserve native comments and unknown settings.
model = "arbitrary-provider/model"
model_provider = "e2e"
cli_auth_credentials_store = "file"
unknown_native_setting = true

[model_providers.e2e]
name = "Native test provider"
base_url = "https://codex.example.invalid/v1"
wire_api = "responses"
requires_openai_auth = true

[model_providers.e2e.http_headers]
originator = "codex"
`

describe('E2E provider configuration boundary', () => {
  let root: string
  let configRoot: string
  let environment: NodeJS.ProcessEnv

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pact-provider-environment-test-'))
    configRoot = join(root, 'configuration')
    await mkdir(join(configRoot, 'claude'), { recursive: true })
    await mkdir(join(configRoot, 'codex'))
    await writeFile(
      join(configRoot, 'claude/settings.json'),
      JSON.stringify(defaultSettings, null, 2) + '\n',
    )
    await writeFile(join(configRoot, 'codex/config.toml'), defaultToml)
    await writeFile(
      join(configRoot, 'codex/auth.json'),
      JSON.stringify({ OPENAI_API_KEY: codexKey }) + '\n',
    )
    environment = {
      PACT_E2E_CLAUDE_EXECUTABLE: process.execPath,
      PACT_E2E_CODEX_EXECUTABLE: process.execPath,
      PATH: process.env['PATH'],
      HOME: '/synthetic-daily-home',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_AUTH_TOKEN: 'synthetic-daily-claude-key',
      OPENAI_API_KEY: 'synthetic-daily-codex-key',
      CODEX_HOME: '/synthetic-daily-codex',
      CLAUDE_CONFIG_DIR: '/synthetic-daily-claude',
      SSH_AUTH_SOCK: '/synthetic-daily-agent.sock',
      NODE_OPTIONS: '--synthetic-daily-option',
    }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.each(['absent', 'enabled', 'disabled'] as const)(
    'isolates optional Codex downloads while preserving all other native settings: %s',
    async (plugins) => {
      const original =
        'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n' +
        defaultToml +
        (plugins === 'absent'
          ? ''
          : `\n[features]\nplugins = ${plugins === 'enabled'}\nother_native_feature = true\n`)
      await writeFile(join(configRoot, 'codex/config.toml'), original)
      const config = await loadProviderConfiguration(configRoot, environment)
      const prepared = await prepareProviderEnvironment(join(root, 'scene'), config, environment, {
        disableCodexPlugins: true,
      })
      const expected = parseToml(original)
      expect(parseToml(await readFile(join(prepared.codexHome, 'config.toml'), 'utf8'))).toEqual({
        ...expected,
        features: {
          ...(plugins === 'absent' ? {} : { other_native_feature: true }),
          plugins: false,
        },
      })
      expect(await readFile(join(configRoot, 'codex/config.toml'), 'utf8')).toBe(original)
      const [claudeSource, claudeCopy, authSource, authCopy] = await Promise.all([
        readFile(join(configRoot, 'claude/settings.json')),
        readFile(join(prepared.claudeHome, 'settings.json')),
        readFile(join(configRoot, 'codex/auth.json')),
        readFile(join(prepared.codexHome, 'auth.json')),
      ])
      expect(claudeCopy).toEqual(claudeSource)
      expect(authCopy).toEqual(authSource)
      await expect(config.assertSourceIntegrity()).resolves.toBeUndefined()
    },
  )

  it.each(['true', '2026-11-10'])(
    'refuses to replace a non-table Codex features value: %s',
    async (value) => {
      const original = `features = ${value}\n${defaultToml}`
      await writeFile(join(configRoot, 'codex/config.toml'), original)
      const config = await loadProviderConfiguration(configRoot, environment)
      await expect(
        prepareProviderEnvironment(join(root, 'scene'), config, environment, {
          disableCodexPlugins: true,
        }),
      ).rejects.toThrow('Codex features must be a table')
      await expect(config.assertSourceIntegrity()).resolves.toBeUndefined()
    },
  )

  it('copies complete native bytes privately and keeps the sources unchanged', async () => {
    const originals = await Promise.all([
      readFile(join(configRoot, 'claude/settings.json')),
      readFile(join(configRoot, 'codex/config.toml')),
      readFile(join(configRoot, 'codex/auth.json')),
    ])
    const config = await loadProviderConfiguration(configRoot, environment)
    const prepared = await prepareProviderEnvironment(join(root, 'scene'), config, environment)
    const copies = await Promise.all([
      readFile(join(prepared.claudeHome, 'settings.json')),
      readFile(join(prepared.codexHome, 'config.toml')),
      readFile(join(prepared.codexHome, 'auth.json')),
    ])
    expect(copies).toEqual(originals)
    expect(config.models).toEqual({
      claude: 'third-party/custom-model[1m]',
      codex: 'arbitrary-provider/model',
    })
    expect(config.sourceHashes).toHaveLength(3)
    expect(config.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(config)).not.toContain(claudeKey)
    expect(JSON.stringify(config)).not.toContain(codexKey)
    await expect(config.assertSourceIntegrity()).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(join(prepared.claudeHome, '.claude.json'), 'utf8'))).toEqual({
      hasCompletedOnboarding: true,
    })
  })

  it.skipIf(process.platform === 'win32')(
    'sets private POSIX modes on owned directories and native copies',
    async () => {
      const config = await loadProviderConfiguration(configRoot, environment)
      const prepared = await prepareProviderEnvironment(join(root, 'scene'), config, environment)
      expect((await stat(join(prepared.claudeHome, 'settings.json'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(prepared.codexHome, 'auth.json'))).mode & 0o777).toBe(0o600)
      expect((await stat(prepared.home)).mode & 0o777).toBe(0o700)
    },
  )

  it.each(['ui', 'real'])(
    'uses only allowlisted host values and owned state paths in %s mode',
    async (mode) => {
      const config =
        mode === 'real' ? await loadProviderConfiguration(configRoot, environment) : undefined
      const prepared = await prepareProviderEnvironment(join(root, 'scene'), config, environment)
      expect(prepared.env['PATH']).toBe(environment['PATH'])
      expect(prepared.env['LANG']).toBe('en_US.UTF-8')
      expect(prepared.env['HOME']).toBe(prepared.home)
      expect(prepared.env['CODEX_HOME']).toBe(prepared.codexHome)
      expect(prepared.env['CLAUDE_CONFIG_DIR']).toBe(prepared.claudeHome)
      expect(prepared.env['TMPDIR']).toBe(prepared.temporaryDirectory)
      expect(prepared.env['XDG_DATA_HOME']).toBe(join(prepared.home, '.local/share'))
      expect(prepared.env['APPDATA']).toBe(join(prepared.home, 'AppData/Roaming'))
      for (const key of [
        'ANTHROPIC_AUTH_TOKEN',
        'OPENAI_API_KEY',
        'SSH_AUTH_SOCK',
        'NODE_OPTIONS',
      ]) {
        expect(prepared.env).not.toHaveProperty(key)
      }
      expect(prepared.env['GIT_CONFIG_NOSYSTEM']).toBe('1')
      expect(prepared.claudePath).toBe(config?.claudePath ?? null)
      expect(prepared.codexPath).toBe(config?.codexPath ?? null)
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'admits Windows host variable names without forwarding them into provider state',
    async () => {
      const host = { ...environment, 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }
      const config = await loadProviderConfiguration(configRoot, host)
      const prepared = await prepareProviderEnvironment(join(root, 'windows-scene'), config, host)
      expect(prepared.env).not.toHaveProperty('ProgramFiles(x86)')
      await config.assertSourceIntegrity()
    },
  )

  it('keeps provider variable names strict even when host variable names vary', async () => {
    await writeFile(
      join(configRoot, 'claude/settings.json'),
      JSON.stringify({
        ...defaultSettings,
        env: { ...defaultSettings.env, 'ProgramFiles(x86)': 'unsafe' },
      }),
    )
    await expect(loadProviderConfiguration(configRoot, environment)).rejects.toThrow(
      'invalid environment entry',
    )
  })

  it('finds the env directory from its explicit E2E selector', async () => {
    const config = await loadProviderConfiguration(undefined, {
      ...environment,
      PACT_E2E_ENV_DIR: configRoot,
    })
    expect(config.models.codex).toBe('arbitrary-provider/model')
  })

  it('rejects missing files before discovering or launching a CLI', async () => {
    await rm(join(configRoot, 'codex/auth.json'))
    await expect(loadProviderConfiguration(configRoot, {})).rejects.toThrow(
      'codex/auth.json cannot be read',
    )
  })

  it.each(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL'])(
    'rejects an unfilled %s without echoing configuration contents',
    async (key) => {
      const settings = structuredClone(defaultSettings)
      Object.assign(settings.env, { [key]: '<fill-this-in>' })
      await writeFile(join(configRoot, 'claude/settings.json'), JSON.stringify(settings))
      await expect(loadProviderConfiguration(configRoot, environment)).rejects.toThrow(
        /placeholder/,
      )
    },
  )

  it.each(['claude/settings.json', 'codex/config.toml', 'codex/auth.json'])(
    'rejects invalid syntax in %s without printing its secret text',
    async (file) => {
      await writeFile(join(configRoot, file), `invalid syntax ${claudeKey} {`)
      const error = await loadProviderConfiguration(configRoot, environment).catch(
        (cause: unknown) => cause,
      )
      expect(error).toBeInstanceOf(Error)
      const message = error instanceof Error ? error.message : 'missing-error'
      expect(message).not.toContain(claudeKey)
      expect(message).toMatch(/valid (?:JSON|TOML)/)
    },
  )

  it('rejects oversized files and input environments before parsing', async () => {
    await writeFile(join(configRoot, 'codex/auth.json'), Buffer.alloc(256 * 1024 + 1, 65))
    await expect(loadProviderConfiguration(configRoot, environment)).rejects.toThrow('256 KiB')
    const tooManyVariables = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`VAR_${index}`, 'value']),
    )
    await expect(loadProviderConfiguration(configRoot, tooManyVariables)).rejects.toThrow(
      '128 entries',
    )
    await expect(
      loadProviderConfiguration(configRoot, { BIG: 'x'.repeat(64 * 1024) }),
    ).rejects.toThrow('64 KiB')
  })

  it.each(['auto', 'keyring', undefined])('rejects Codex credential store %s', async (store) => {
    await writeFile(
      join(configRoot, 'codex/config.toml'),
      defaultToml.replace(
        'cli_auth_credentials_store = "file"\n',
        store ? `cli_auth_credentials_store = "${store}"\n` : '',
      ),
    )
    await expect(loadProviderConfiguration(configRoot, environment)).rejects.toThrow(
      /credential.*(?:file|storage)/,
    )
  })

  it.each([
    { env: { ...defaultSettings.env, CODEX_HOME: '/daily/codex' } },
    { env: { ...defaultSettings.env, ELECTRON_USER_DATA_DIR: 'daily' } },
    { env: { ...defaultSettings.env, PACT_TEST_DB_FILE: 'daily.sqlite' } },
    { env: { ...defaultSettings.env, NODE_OPTIONS: '--require=helper' } },
    { ...defaultSettings, skillsDirectory: '/daily/skills' },
    { ...defaultSettings, skillsDirectory: '${HOME}/skills' },
    { ...defaultSettings, skillsDirectory: '../skills' },
    { ...defaultSettings, credentials_file: '/daily/auth.json' },
    { ...defaultSettings, logDirectory: 'FILE:///daily/logs' },
    { ...defaultSettings, apiKeyHelper: 'node helper.js' },
    { ...defaultSettings, hooks: { SessionStart: [{ command: 'node helper.js' }] } },
    { ...defaultSettings, mcpServers: { helper: { command: 'node' } } },
  ])('rejects external configuration state or executable helpers %#', async (settings) => {
    await writeFile(join(configRoot, 'claude/settings.json'), JSON.stringify(settings))
    await expect(loadProviderConfiguration(configRoot, environment)).rejects.toThrow(
      /isolation|external|helper/,
    )
  })

  it('requires explicit env_key/header material and injects only referenced keys', async () => {
    await writeFile(
      join(configRoot, 'codex/config.toml'),
      defaultToml.replace(
        'requires_openai_auth = true',
        'env_key = "E2E_TOKEN"\nenv_http_headers = { Authorization = "E2E_HEADER" }',
      ),
    )
    await expect(
      loadProviderConfiguration(configRoot, {
        ...environment,
        E2E_TOKEN: codexKey,
        E2E_HEADER: 'daily-header-key',
      }),
    ).rejects.toThrow('explicit Codex authentication environment')
    const config = await loadProviderConfiguration(configRoot, environment, {
      E2E_TOKEN: 'synthetic-explicit-key',
      E2E_HEADER: 'Bearer synthetic-explicit-header',
      IGNORED: 'never-inherited',
    })
    const prepared = await prepareProviderEnvironment(join(root, 'scene'), config, environment)
    expect(prepared.env['E2E_TOKEN']).toBe('synthetic-explicit-key')
    expect(prepared.env['E2E_HEADER']).toBe('Bearer synthetic-explicit-header')
    expect(prepared.env).not.toHaveProperty('IGNORED')
    expect(config.redact('synthetic-explicit-key')).toBe('[REDACTED]')
  })

  it('rejects an env_key that would overwrite an isolation variable', async () => {
    await writeFile(
      join(configRoot, 'codex/config.toml'),
      defaultToml.replace('requires_openai_auth = true', 'env_key = "HOME"'),
    )
    await expect(
      loadProviderConfiguration(configRoot, environment, { HOME: claudeKey }),
    ).rejects.toThrow('override isolation')
  })

  it('limits discovery and requires explicit executables to be absolute', async () => {
    await expect(
      loadProviderConfiguration(configRoot, {
        ...environment,
        PACT_E2E_CLAUDE_EXECUTABLE: 'relative/claude',
      }),
    ).rejects.toThrow('absolute path')
    await expect(
      loadProviderConfiguration(configRoot, {
        ...environment,
        PATH: Array.from({ length: 129 }, () => '/bin').join(
          process.platform === 'win32' ? ';' : ':',
        ),
      }),
    ).rejects.toThrow('PATH exceeds 128 entries')
  })

  it('rejects source symlinks escaping the explicit configuration directory', async () => {
    const external = join(root, 'external-auth.json')
    await writeFile(external, JSON.stringify({ OPENAI_API_KEY: codexKey }))
    await rm(join(configRoot, 'codex/auth.json'))
    await symlink(external, join(configRoot, 'codex/auth.json'))
    await expect(loadProviderConfiguration(configRoot, environment)).rejects.toThrow(
      'outside its source directory',
    )
  })

  it('rejects a prepared directory symlink without creating state in its target', async () => {
    const scene = join(root, 'scene')
    const external = join(root, 'external')
    await mkdir(scene)
    await mkdir(external)
    await symlink(external, join(scene, 'home'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(prepareProviderEnvironment(scene, undefined, environment)).rejects.toThrow(
      'symlink',
    )
    await expect(stat(join(external, '.config'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detects a changed source before copying it into a scene', async () => {
    const config = await loadProviderConfiguration(configRoot, environment)
    await writeFile(
      join(configRoot, 'codex/auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'synthetic-new-key' }),
    )
    await expect(config.assertSourceIntegrity()).rejects.toThrow('changed during the test run')
    await expect(
      prepareProviderEnvironment(join(root, 'scene'), config, environment),
    ).rejects.toThrow('changed during the test run')
    await expect(readFile(join(root, 'scene/codex-home/auth.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('redacts actual credentials and authorization headers while retaining ordinary CLI diagnostics', async () => {
    const config = await loadProviderConfiguration(configRoot, environment)
    const result = config.redact(
      `originator: 'codex'; file storage; ${claudeKey}; ${codexKey}; Authorization: Bearer unknown-secret-token`,
    )
    expect(result).toContain("originator: 'codex'; file storage")
    expect(result).not.toContain(claudeKey)
    expect(result).not.toContain(codexKey)
    expect(result).not.toContain('unknown-secret-token')
  })

  it('does not overwrite source configuration or an existing scene', async () => {
    const config = await loadProviderConfiguration(configRoot, environment)
    await expect(prepareProviderEnvironment(configRoot, config, environment)).rejects.toThrow(
      'source configuration',
    )
    const prepared = await prepareProviderEnvironment(join(root, 'scene'), config, environment)
    await chmod(join(prepared.codexHome, 'auth.json'), 0o600)
    await expect(
      prepareProviderEnvironment(join(root, 'scene'), config, environment),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(config.assertSourceIntegrity()).resolves.toBeUndefined()
  })

  it('loads codex-agy profile without Claude, rejects external PRs before reading secrets, and isolates GEMINI_API_KEY inside an agy-only wrapper', async () => {
    const geminiKey = 'synthetic-gemini-credential-123456'
    const fakeAgyScript = join(root, 'fake-agy.mjs')
    let fakeAgyBin = fakeAgyScript
    await writeFile(
      fakeAgyScript,
      `#!${process.execPath}
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  hasKey: process.env.GEMINI_API_KEY === ${JSON.stringify(geminiKey)},
  geminiDir: process.env.ANTIGRAVITY_GEMINI_DIR ?? null,
}) + '\\n')
`,
      { mode: 0o755 },
    )
    await chmod(fakeAgyScript, 0o755)
    if (process.platform === 'win32') {
      fakeAgyBin = join(root, 'fake-agy.cmd')
      await writeFile(fakeAgyBin, `@echo off\r\n"${process.execPath}" "${fakeAgyScript}" %*\r\n`)
    }

    await rm(join(configRoot, 'claude'), { recursive: true, force: true })
    await mkdir(join(configRoot, 'agy'), { recursive: true })
    const envPath = join(configRoot, 'agy/.env')
    await writeFile(envPath, `GEMINI_API_KEY=${geminiKey}\nAGY_MODEL=gemini-4-neon\n`, {
      mode: 0o600,
    })

    // External PR env MUST reject before touching or reading missing files.
    await expect(
      loadProviderConfiguration(
        join(root, 'missing-dir'),
        { ...environment, GITHUB_EVENT_NAME: 'pull_request' },
        {},
        { profile: 'codex-agy' },
      ),
    ).rejects.toThrow('external pull requests')

    const agyOnlyEnv: NodeJS.ProcessEnv = {
      PATH: join(root, 'empty-path'),
      HOME: '/synthetic-daily-home',
      LANG: 'en_US.UTF-8',
      GEMINI_API_KEY: 'synthetic-host-daily-gemini-key',
      PACT_E2E_CODEX_EXECUTABLE: process.execPath,
      PACT_E2E_AGY_EXECUTABLE: fakeAgyBin,
    }
    const config = await loadProviderConfiguration(
      configRoot,
      agyOnlyEnv,
      {},
      { profile: 'codex-agy' },
    )
    expect(config.claudePath).toBeNull()
    expect(config.models).toEqual({
      claude: null,
      codex: 'arbitrary-provider/model',
      agy: 'gemini-4-neon',
    })
    expect(config.sourceHashes.map((item) => item.file).toSorted()).toEqual([
      'agy/.env',
      'codex/auth.json',
      'codex/config.toml',
    ])
    expect(config.redact(`leak ${geminiKey}`)).not.toContain(geminiKey)

    const prepared = await prepareProviderEnvironment(join(root, 'agy-scene'), config, agyOnlyEnv, {
      disableCodexPlugins: true,
    })
    expect(prepared.claudePath).toBeNull()
    expect(prepared.agyPath).toBeTruthy()
    expect(prepared.agyPath).not.toBe(fakeAgyBin)
    expect(prepared.env['ANTIGRAVITY_GEMINI_DIR']).toBe(prepared.geminiHome)
    expect(prepared.env['DISABLE_TELEMETRY']).toBe('1')
    expect(prepared.env['DISABLE_ERROR_REPORTING']).toBe('1')
    expect(prepared.env).not.toHaveProperty('GEMINI_API_KEY')
    expect(prepared.env).not.toHaveProperty('GOOGLE_API_KEY')
    await expect(stat(join(prepared.codexHome, '.env'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      JSON.parse(
        await readFile(join(prepared.geminiHome, 'antigravity-cli/settings.json'), 'utf8'),
      ),
    ).toEqual({ modelProvider: 'gemini' })
    expect(
      JSON.parse(
        await readFile(join(prepared.home, '.gemini/antigravity-cli/settings.json'), 'utf8'),
      ),
    ).toEqual({ modelProvider: 'gemini' })

    // Verify wrapped agy injects GEMINI_API_KEY only into agy child and forwards arguments.
    const wrapperResult = await execFileAsync(
      prepared.agyPath!,
      ['acp', '--arg-with-space', 'hello world'],
      { env: prepared.env, shell: false },
    )
    expect(JSON.parse(wrapperResult.stdout)).toEqual({
      argv: ['acp', '--arg-with-space', 'hello world'],
      hasKey: true,
      geminiDir: prepared.geminiHome,
    })

    // Detect agy/.env modification via assertSourceIntegrity.
    const changedKey = 'synthetic-changed-gemini-credential'
    await writeFile(envPath, `GEMINI_API_KEY=${changedKey}\n`, { mode: 0o600 })
    await expect(config.assertSourceIntegrity()).rejects.toThrow('changed during the test run')
  })

  it.skipIf(process.platform === 'win32')(
    'enforces 0600 mode on agy settings and rejects symlinked PACT_E2E_AGY_ENV_FILE on POSIX',
    async () => {
      await rm(join(configRoot, 'claude'), { recursive: true, force: true })
      await mkdir(join(configRoot, 'agy'), { recursive: true })
      const envPath = join(configRoot, 'agy/.env')
      await writeFile(envPath, `GEMINI_API_KEY=synthetic-gemini-credential-posix\n`, {
        mode: 0o600,
      })

      const posixEnv: NodeJS.ProcessEnv = {
        PATH: join(root, 'empty-path'),
        HOME: '/synthetic-daily-home',
        LANG: 'en_US.UTF-8',
        PACT_E2E_CODEX_EXECUTABLE: process.execPath,
        PACT_E2E_AGY_EXECUTABLE: process.execPath,
      }
      const config = await loadProviderConfiguration(
        configRoot,
        posixEnv,
        {},
        { profile: 'codex-agy' },
      )
      expect(config.models.agy).toBe(DEFAULT_REAL_AGY_MODEL)
      const prepared = await prepareProviderEnvironment(join(root, 'agy-posix'), config, posixEnv)
      expect(
        (await stat(join(prepared.geminiHome, 'antigravity-cli/settings.json'))).mode & 0o777,
      ).toBe(0o600)
      expect(
        (await stat(join(prepared.home, '.gemini/antigravity-cli/settings.json'))).mode & 0o777,
      ).toBe(0o600)

      const symlinkEnv = join(root, 'sym-agy.env')
      await symlink(envPath, symlinkEnv)
      await expect(
        loadProviderConfiguration(
          configRoot,
          { ...posixEnv, PACT_E2E_AGY_ENV_FILE: symlinkEnv },
          {},
          { profile: 'codex-agy' },
        ),
      ).rejects.toThrow('owned regular file')
    },
  )

  it('keeps HOME/.gemini as geminiHome for default/bare fixtures while isolating codex-agy', async () => {
    const defaultConfig = await loadProviderConfiguration(configRoot, environment)
    const defaultPrepared = await prepareProviderEnvironment(
      join(root, 'default-scene'),
      defaultConfig,
      environment,
    )
    expect(defaultPrepared.geminiHome).toBe(join(defaultPrepared.home, '.gemini'))
    expect(defaultPrepared.env['ANTIGRAVITY_GEMINI_DIR']).toBeUndefined()

    const barePrepared = await prepareProviderEnvironment(
      join(root, 'bare-scene'),
      undefined,
      environment,
    )
    expect(barePrepared.geminiHome).toBe(join(barePrepared.home, '.gemini'))
    expect(barePrepared.env['ANTIGRAVITY_GEMINI_DIR']).toBeUndefined()
  })

  it('isolates keyless project verification from fixture key files and credential sources', async () => {
    await rm(join(configRoot, 'claude'), { recursive: true, force: true })
    await mkdir(join(configRoot, 'agy'), { recursive: true })
    const syntheticKey = 'synthetic-isolated-verifier-key'
    const envPath = join(configRoot, 'agy/.env')
    await writeFile(envPath, `GEMINI_API_KEY=${syntheticKey}\n`, { mode: 0o600 })
    const agyOnlyEnv: NodeJS.ProcessEnv = {
      PATH: join(root, 'empty-path'),
      HOME: '/synthetic-daily-home',
      LANG: 'en_US.UTF-8',
      PACT_E2E_CODEX_EXECUTABLE: process.execPath,
      PACT_E2E_AGY_EXECUTABLE: process.execPath,
    }
    const config = await loadProviderConfiguration(
      configRoot,
      agyOnlyEnv,
      {},
      { profile: 'codex-agy' },
    )
    expect(config.models.agy).toBe(DEFAULT_REAL_AGY_MODEL)
    const fixtureDir = join(root, 'isolated-fixture')
    const prepared = await prepareProviderEnvironment(fixtureDir, config, agyOnlyEnv)
    const projectDir = join(fixtureDir, 'workspace')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'parse-port.mjs'),
      'export const parsePort = (v) => Number(v)\n',
    )
    await writeFile(
      join(projectDir, 'parse-port.test.mjs'),
      "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { parsePort } from './parse-port.mjs'\ntest('ok', () => assert.equal(parsePort('80'), 80))\n",
    )

    const forbidden = [fixtureDir, configRoot]
    const passRes = await runIsolatedKeylessProjectNode({
      projectDirectory: projectDir,
      entry: { kind: 'test', file: 'parse-port.test.mjs' },
      forbiddenPaths: forbidden,
    })
    expect(passRes.code).toBe(0)

    await writeFile(
      join(projectDir, 'bad.test.mjs'),
      "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('fail', () => assert.equal(1, 2))\n",
    )
    const failRes = await runIsolatedKeylessProjectNode({
      projectDirectory: projectDir,
      entry: { kind: 'test', file: 'bad.test.mjs' },
      forbiddenPaths: forbidden,
    })
    expect(failRes.code).toBe(1)

    const preparedKeyPath = join(dirname(prepared.agyPath!), 'gemini-key')
    const probeReadRes = await runIsolatedKeylessProjectNode({
      projectDirectory: projectDir,
      entry: {
        kind: 'eval',
        code: [
          "import { readFileSync } from 'node:fs';",
          'const blocked = (p) => { try { readFileSync(p, "utf8"); return false; } catch { return true; } };',
          `const a = blocked(${JSON.stringify(envPath)});`,
          `const b = blocked(${JSON.stringify(preparedKeyPath)});`,
          'if (!a || !b) process.exit(1);',
        ].join(' '),
      },
      forbiddenPaths: forbidden,
    })
    expect(probeReadRes.code).toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects short GEMINI_API_KEY, default/explicit agy/.env symlinks/hardlinks/FIFOs, and post-load replacement',
    async () => {
      await rm(join(configRoot, 'claude'), { recursive: true, force: true })
      await mkdir(join(configRoot, 'agy'), { recursive: true })
      const envPath = join(configRoot, 'agy/.env')
      const baseEnv: NodeJS.ProcessEnv = {
        PATH: join(root, 'empty-path'),
        HOME: '/synthetic-daily-home',
        LANG: 'en_US.UTF-8',
        PACT_E2E_CODEX_EXECUTABLE: process.execPath,
        PACT_E2E_AGY_EXECUTABLE: process.execPath,
      }

      // 1. Short GEMINI_API_KEY (< 8 chars) is rejected at load time.
      await writeFile(envPath, 'GEMINI_API_KEY=abc\n', { mode: 0o600 })
      await expect(
        loadProviderConfiguration(configRoot, baseEnv, {}, { profile: 'codex-agy' }),
      ).rejects.toThrow('at least 8')

      // 2. Default agy/.env hardlink (nlink > 1) and symlink are rejected.
      const validKey = 'synthetic-valid-gemini-credential'
      const validBody = `GEMINI_API_KEY=${validKey}\n`
      await rm(envPath)
      await writeFile(envPath, validBody, { mode: 0o600 })
      const extraLink = join(root, 'agy-hardlink.env')
      await link(envPath, extraLink)
      await expect(
        loadProviderConfiguration(configRoot, baseEnv, {}, { profile: 'codex-agy' }),
      ).rejects.toThrow('owned regular file')
      await rm(extraLink)

      const internalTarget = join(configRoot, 'agy/.real.env')
      await writeFile(internalTarget, validBody, { mode: 0o600 })
      await rm(envPath)
      await symlink(internalTarget, envPath)
      await expect(
        loadProviderConfiguration(configRoot, baseEnv, {}, { profile: 'codex-agy' }),
      ).rejects.toThrow('owned regular file')
      await rm(internalTarget)

      // 3. FIFO at agy/.env rejects cleanly without blocking.
      await rm(envPath)
      await promisify(execFile)('mkfifo', [envPath])
      await expect(
        loadProviderConfiguration(configRoot, baseEnv, {}, { profile: 'codex-agy' }),
      ).rejects.toThrow('owned regular file')

      // 4. Post-load replacement with symlink or FIFO fails integrity check without blocking.
      await rm(envPath)
      await writeFile(envPath, validBody, { mode: 0o600 })
      const config = await loadProviderConfiguration(
        configRoot,
        baseEnv,
        {},
        { profile: 'codex-agy' },
      )
      await rm(envPath)
      await writeFile(envPath, validBody, { mode: 0o600 })
      await expect(config.assertSourceIntegrity()).rejects.toThrow('changed during the test run')

      await rm(envPath)
      await promisify(execFile)('mkfifo', [envPath])
      await expect(config.assertSourceIntegrity()).rejects.toThrow('owned regular file')

      // 5. Generated Windows API-key launcher handles .exe vs .cmd safely and prefers .exe first.
      expect(providerExecutableCandidates('agy', 'win32')).toEqual(['agy.exe', 'agy.cmd', 'agy'])
      const cmdSource = buildWindowsAgyApiKeyLauncherSource(
        'C:\\tmp\\gemini-key',
        'C:\\Program Files\\agy\\agy.cmd',
      )
      expect(cmdSource).toContain('windowsVerbatimArguments: true')
      expect(cmdSource).toContain('lstatSync')
      const exeSource = buildWindowsAgyApiKeyLauncherSource(
        'C:\\tmp\\gemini-key',
        'C:\\Program Files\\agy\\agy.exe',
      )
      expect(exeSource).toContain('shell: false')
    },
  )
})
