import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadProviderConfiguration, prepareProviderEnvironment } from './provider-environment.js'

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
})
