import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'

/* oxlint-disable eslint/no-await-in-loop -- Bounded reads, ordered executable discovery and ancestor checks settle before advancing; owned files are prepared before any process starts. */

const defaultConfigurationRoot = resolve(import.meta.dirname, 'env')
const fileLimit = 256 * 1024
const configurationLimit = 768 * 1024
const environmentEntryLimit = 128
const environmentByteLimit = 64 * 1024
const pathEntryLimit = 128
const objectNodeLimit = 16_384
const objectDepthLimit = 32

const systemEnvironmentKeys = [
  'PATH',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'TERM',
  'COLORTERM',
  'TZ',
] as const

const ownedEnvironmentKeys = new Set([
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
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
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_TEMPLATE_DIR',
  'SQLITE_TMPDIR',
  'PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
])

interface ConfigurationSource {
  path: string
  destination: 'claude/settings.json' | 'codex/config.toml' | 'codex/auth.json'
  bytes: Buffer
  sha256: string
}

/** Holds three bounded source files for one run; dispose the owning fixture to release it. */
export interface ProviderConfiguration {
  claudePath: string
  codexPath: string
  models: { claude: string | null; codex: string | null }
  configurationFingerprint: string
  sourceHashes: ReadonlyArray<{ file: ConfigurationSource['destination']; sha256: string }>
  redact(text: string): string
  assertSourceIntegrity(): Promise<void>
}

export interface ProviderEnvironment {
  env: Record<string, string>
  home: string
  claudeHome: string
  codexHome: string
  temporaryDirectory: string
  userDataDirectory: string
  sessionDataDirectory: string
  claudePath: string | null
  codexPath: string | null
}

// Weak ownership avoids a process-wide credential cache; contents live only with a run's config.
const configurationContents = new WeakMap<
  ProviderConfiguration,
  {
    sourceRoot: string
    sources: ConfigurationSource[]
    providerEnvironment: Record<string, string>
  }
>()

function fail(reason: string): never {
  throw new Error(`E2E provider configuration: ${reason}`)
}

function hash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`)
  return value
}

function isPlaceholder(value: string): boolean {
  return (
    /^\s*<[^>]+>\s*$/.test(value) ||
    /^(?:your[\s_-]*(?:api[\s_-]*key|token|model|url)|replace[\s_-]*me|change[\s_-]*me|sk-xxx+)$/i.test(
      value.trim(),
    ) ||
    /^\s*(?:第三方服务地址|测试专用 API Key|模型名称|服务地址|接口地址)\s*$/.test(value)
  )
}

function requireSetting(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || isPlaceholder(value)) {
    fail(`${label} is missing or is a placeholder`)
  }
  if (value.length > 4096) {
    fail(`${label} is invalid or exceeds its limit`)
  }
  for (const character of value) {
    if (character.charCodeAt(0) < 32) fail(`${label} contains an invalid control character`)
  }
  return value
}

function isSecretKey(key: string): boolean {
  if (key === 'env_key' || key === 'env_http_headers' || key === 'cli_auth_credentials_store')
    return false
  return /token|password|secret|authorization|cookie|credential|api[\s_-]?key/i.test(key)
}

function assertEnvironmentBounds(
  environment: Record<string, unknown>,
  label: string,
  hostEnvironment = false,
): void {
  const entries = Object.entries(environment).filter((entry) => entry[1] !== undefined)
  let bytes = 0
  for (const [key, value] of entries) {
    if (
      !(hostEnvironment && process.platform === 'win32'
        ? key.length > 0 && !/[=\0\r\n]/u.test(key)
        : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) ||
      typeof value !== 'string' ||
      value.includes('\0')
    ) {
      fail(`${label} contains an invalid environment entry`)
    }
    bytes += Buffer.byteLength(key + value)
  }
  if (entries.length > environmentEntryLimit || bytes > environmentByteLimit) {
    fail(`${label} exceeds 128 entries or 64 KiB`)
  }
}

function assertProviderEnvironmentKey(key: string): void {
  const upper = key.toUpperCase()
  if (
    ownedEnvironmentKeys.has(upper) ||
    upper.startsWith('XDG_') ||
    upper.startsWith('PACT_') ||
    upper.startsWith('ELECTRON_') ||
    upper.startsWith('GIT_CONFIG_') ||
    upper.includes('SQLITE') ||
    /^(?:AWS_PROFILE|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|GOOGLE_APPLICATION_CREDENTIALS)$/.test(
      upper,
    )
  ) {
    fail('provider environment attempts to override isolation or load external state')
  }
}

function isExternalPath(value: string): boolean {
  // URLs belong to the configured provider, while filesystem and expandable paths do not.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return /^file:/i.test(value)
  return (
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\') ||
    /^(?:~|\.\.[\\/])/.test(value) ||
    /\$\{|\$[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%/.test(value) ||
    /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)
  )
}

/** Unknown native fields survive; unprovable executable/external-state references fail explicitly. */
function inspectConfiguration(value: unknown, secrets: Set<string>): void {
  const pending: Array<{
    value: unknown
    key: string
    depth: number
    environmentReference?: boolean
  }> = [{ value, key: '', depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const entry = pending.pop()!
    nodes += 1
    if (nodes > objectNodeLimit || entry.depth > objectDepthLimit) {
      fail('configuration structure exceeds its node or depth limit')
    }
    if (typeof entry.value === 'string') {
      if (/(?:file|path|directory|_dir)$/i.test(entry.key) && isExternalPath(entry.value)) {
        fail('configuration references an external credential or state file')
      }
      if (isSecretKey(entry.key) && !entry.environmentReference) {
        requireSetting(entry.value, 'credential')
        secrets.add(entry.value)
      } else {
        if (isPlaceholder(entry.value)) fail('configuration contains an unfilled placeholder')
        if (isExternalPath(entry.value)) {
          fail('configuration references an external or dynamic filesystem path')
        }
        if (/^https?:\/\//i.test(entry.value)) {
          try {
            const url = new URL(entry.value)
            if (url.password) secrets.add(decodeURIComponent(url.password))
            for (const [key, parameter] of url.searchParams) {
              if (isSecretKey(key)) secrets.add(parameter)
            }
          } catch {
            fail('configuration contains an invalid provider URL')
          }
        }
      }
      continue
    }
    if (Array.isArray(entry.value)) {
      for (const child of entry.value) {
        pending.push({
          value: child,
          key: entry.key,
          depth: entry.depth + 1,
          environmentReference: entry.environmentReference ?? false,
        })
      }
      continue
    }
    if (!isRecord(entry.value)) continue
    for (const [key, child] of Object.entries(entry.value)) {
      if (key !== '$schema' && isExternalPath(key)) {
        fail('configuration references an external filesystem scope')
      }
      if (
        /^(?:hooks|notify|apiKeyHelper|awsAuthRefresh|awsCredentialExport|otelHeadersHelper|statusLine|command|startup_command)$/i.test(
          key,
        ) &&
        child !== null &&
        (!isRecord(child) || Object.keys(child).length > 0) &&
        (!Array.isArray(child) || child.length > 0)
      ) {
        fail('configuration contains a helper, Hook or command whose isolation cannot be proven')
      }
      if (key === 'cli_auth_credentials_store' && child !== 'file') {
        fail('Codex credential storage must use file, never auto or keyring')
      }
      pending.push({
        value: child,
        key,
        depth: entry.depth + 1,
        environmentReference: entry.key === 'env_http_headers',
      })
    }
  }
}

async function readSource(
  root: string,
  destination: ConfigurationSource['destination'],
): Promise<ConfigurationSource> {
  const path = join(root, destination)
  try {
    const canonicalPath = await realpath(path)
    if (!isWithin(root, canonicalPath))
      fail('configuration file resolves outside its source directory')
    const bytes = await readBoundedFile(canonicalPath, destination)
    return { path: canonicalPath, destination, bytes, sha256: hash(bytes) }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('E2E provider configuration:'))
      throw error
    return fail(`${destination} cannot be read; provide all three native configuration files`)
  }
}

async function readBoundedFile(path: string, label: string): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > fileLimit) {
      fail(`${label} must be a regular file of at most 256 KiB`)
    }
    const buffer = Buffer.alloc(fileLimit + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > fileLimit) fail(`${label} exceeds 256 KiB`)
    return buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
}

function parseJson(source: ConfigurationSource): Record<string, unknown> {
  try {
    return requireRecord(JSON.parse(source.bytes.toString('utf8')), source.destination)
  } catch {
    return fail(`${source.destination} is not a valid JSON object`)
  }
}

function isWithin(root: string, path: string): boolean {
  const remainder = relative(root, path)
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))
}

async function findExecutable(
  agent: 'claude' | 'codex',
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const explicit = environment[`PACT_E2E_${agent.toUpperCase()}_EXECUTABLE`]
  if (explicit && !isAbsolute(explicit)) fail(`${agent} executable must be an absolute path`)
  const directories = (environment['PATH'] ?? '').split(delimiter).filter(Boolean)
  if (directories.length > pathEntryLimit) fail('PATH exceeds 128 entries')
  const names = process.platform === 'win32' ? [`${agent}.exe`, `${agent}.cmd`, agent] : [agent]
  const candidates = explicit
    ? [explicit]
    : directories
        .filter(isAbsolute)
        .flatMap((directory) => names.map((name) => join(directory, name)))
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate)
      const info = await stat(path)
      if (!info.isFile()) continue
      await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return path
    } catch {
      // Discovery never runs candidates and never exposes filesystem errors or credentials.
    }
  }
  return fail(
    `${agent} CLI was not found; install it separately or set its explicit E2E executable path`,
  )
}

function referencedEnvironment(config: Record<string, unknown>): Set<string> {
  const keys = new Set<string>()
  const pending: unknown[] = [config]
  while (pending.length) {
    const current = pending.pop()
    if (Array.isArray(current)) pending.push(...current)
    else if (isRecord(current)) {
      for (const [key, value] of Object.entries(current)) {
        if (key === 'env_key') keys.add(requireSetting(value, 'Codex env_key'))
        else if (key === 'env_http_headers') {
          for (const variable of Object.values(requireRecord(value, 'Codex env_http_headers'))) {
            keys.add(requireSetting(variable, 'Codex header environment variable'))
          }
        } else pending.push(value)
      }
    }
  }
  return keys
}

export async function loadProviderConfiguration(
  configRoot?: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  providerEnvironment: Record<string, string> = {},
): Promise<ProviderConfiguration> {
  assertEnvironmentBounds(sourceEnvironment, 'input environment', true)
  assertEnvironmentBounds(providerEnvironment, 'explicit provider environment')
  const requestedRoot =
    configRoot ?? sourceEnvironment['PACT_E2E_ENV_DIR'] ?? defaultConfigurationRoot
  let root: string
  try {
    root = await realpath(resolve(requestedRoot))
  } catch {
    fail('configuration directory does not exist')
  }
  const sources = await Promise.all([
    readSource(root, 'claude/settings.json'),
    readSource(root, 'codex/config.toml'),
    readSource(root, 'codex/auth.json'),
  ])
  if (sources.reduce((bytes, source) => bytes + source.bytes.byteLength, 0) > configurationLimit) {
    fail('configuration files exceed 768 KiB in total')
  }
  const [claudeSource, codexSource, authSource] = sources
  const claude = parseJson(claudeSource)
  const auth = parseJson(authSource)
  let codex: Record<string, unknown>
  try {
    codex = requireRecord(parseToml(codexSource.bytes.toString('utf8')), 'codex/config.toml')
  } catch {
    fail('codex/config.toml is not valid TOML')
  }
  const secrets = new Set<string>()
  for (const configuration of [claude, codex, auth]) inspectConfiguration(configuration, secrets)
  const claudeEnvironment = requireRecord(claude['env'], 'Claude settings env')
  assertEnvironmentBounds(claudeEnvironment, 'Claude settings env')
  for (const [key, value] of Object.entries(claudeEnvironment)) {
    assertProviderEnvironmentKey(key)
    if (typeof value !== 'string') fail('Claude settings env must contain strings')
  }
  requireSetting(
    claudeEnvironment['ANTHROPIC_AUTH_TOKEN'] ?? claudeEnvironment['ANTHROPIC_API_KEY'],
    'Claude API credential',
  )
  if (claudeEnvironment['ANTHROPIC_BASE_URL'] !== undefined) {
    requireSetting(claudeEnvironment['ANTHROPIC_BASE_URL'], 'Claude API address')
  }
  if (codex['cli_auth_credentials_store'] !== 'file') {
    fail('config.toml must explicitly set cli_auth_credentials_store = "file"')
  }
  const tokens = isRecord(auth['tokens']) ? auth['tokens'] : {}
  requireSetting(auth['OPENAI_API_KEY'] ?? tokens['access_token'], 'Codex auth.json credential')
  const injectedEnvironment: Record<string, string> = {}
  for (const key of referencedEnvironment(codex)) {
    assertProviderEnvironmentKey(key)
    const value = requireSetting(
      providerEnvironment[key],
      'explicit Codex authentication environment',
    )
    injectedEnvironment[key] = value
    secrets.add(value)
  }
  const models = {
    claude:
      claudeEnvironment['ANTHROPIC_MODEL'] === undefined
        ? null
        : requireSetting(claudeEnvironment['ANTHROPIC_MODEL'], 'Claude model'),
    codex: codex['model'] === undefined ? null : requireSetting(codex['model'], 'Codex model'),
  }
  const [claudePath, codexPath] = await Promise.all([
    findExecutable('claude', sourceEnvironment),
    findExecutable('codex', sourceEnvironment),
  ])
  const secretValues = [...secrets]
    .filter((value) => value.length >= 4)
    .toSorted((a, b) => b.length - a.length)
  const configuration: ProviderConfiguration = {
    claudePath,
    codexPath,
    models,
    configurationFingerprint: hash(
      sources.map((source) => `${source.destination}:${source.sha256}`).join('\n') +
        JSON.stringify(
          Object.entries(injectedEnvironment).toSorted(([a], [b]) => a.localeCompare(b)),
        ),
    ),
    sourceHashes: sources.map((source) => ({ file: source.destination, sha256: source.sha256 })),
    redact(text) {
      let result = text
      for (const secret of secretValues) {
        result = result.replaceAll(secret, '[REDACTED]')
        const encoded = JSON.stringify(secret).slice(1, -1)
        if (encoded !== secret) result = result.replaceAll(encoded, '[REDACTED]')
      }
      return result
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [REDACTED]')
        .replace(
          /(\b(?:authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)["']?\s*[:=]\s*["']?)[^\s,"'\r\n}]+/gi,
          '$1[REDACTED]',
        )
    },
    async assertSourceIntegrity() {
      for (const source of sources) {
        try {
          if (hash(await readBoundedFile(source.path, source.destination)) !== source.sha256) {
            fail(`${source.destination} changed during the test run`)
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('E2E provider configuration:'))
            throw error
          fail(`${source.destination} is no longer available`)
        }
      }
    },
  }
  configurationContents.set(configuration, {
    sourceRoot: root,
    sources,
    providerEnvironment: injectedEnvironment,
  })
  return configuration
}

async function privateDirectory(path: string, root: string): Promise<void> {
  if (!isWithin(root, path)) fail('owned directory escapes the test root')
  let current = root
  const components = relative(root, path).split(/[\\/]/).filter(Boolean)
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = join(current, components[index]!)
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || (await realpath(current)) !== current) {
        fail('owned directory resolves through a symlink or is not a directory')
      }
    } catch (error) {
      if (!isRecord(error) || error['code'] !== 'ENOENT') throw error
      await mkdir(current, { mode: 0o700 })
    }
    await chmod(current, 0o700)
  }
}

async function canonicalFutureDirectory(path: string): Promise<string> {
  let existing = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      return join(await realpath(existing), ...missing)
    } catch (error) {
      if (!isRecord(error) || error['code'] !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      missing.unshift(basename(existing))
      existing = parent
    }
  }
}

/** The fixture owns and removes root; restarting a scene reuses this prepared environment. */
export async function prepareProviderEnvironment(
  root: string,
  config?: ProviderConfiguration,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<ProviderEnvironment> {
  assertEnvironmentBounds(sourceEnvironment, 'input environment', true)
  const requestedDirectory = resolve(root)
  const directory = await canonicalFutureDirectory(requestedDirectory)
  if (
    directory === (await canonicalFutureDirectory(sourceEnvironment['HOME'] ?? '/')) ||
    directory === (await canonicalFutureDirectory(sourceEnvironment['USERPROFILE'] ?? '/'))
  ) {
    fail('owned root must not be the host home directory')
  }
  const contents = config ? configurationContents.get(config) : undefined
  if (config && !contents) fail('configuration was not created by the provider loader')
  if (
    contents &&
    (isWithin(directory, contents.sourceRoot) || isWithin(contents.sourceRoot, directory))
  ) {
    fail('owned root must not contain source configuration files')
  }
  await mkdir(requestedDirectory, { recursive: true, mode: 0o700 })
  if (!(await lstat(requestedDirectory)).isDirectory()) fail('owned root must not be a symlink')
  await privateDirectory(directory, directory)
  const home = join(directory, 'home')
  const claudeHome = join(directory, 'claude-home')
  const codexHome = join(directory, 'codex-home')
  const temporaryDirectory = join(directory, 'tmp')
  const userDataDirectory = join(directory, 'electron-profile')
  const sessionDataDirectory = join(directory, 'electron-session')
  const ownedDirectories = [
    home,
    claudeHome,
    codexHome,
    temporaryDirectory,
    userDataDirectory,
    sessionDataDirectory,
    join(home, '.config'),
    join(home, '.cache'),
    join(home, '.local/share'),
    join(home, '.local/state'),
    join(home, '.local/run'),
    join(home, 'AppData/Roaming'),
    join(home, 'AppData/Local'),
    join(home, 'git-template'),
    join(claudeHome, 'projects'),
    join(codexHome, 'sessions'),
  ]
  for (const path of ownedDirectories) await privateDirectory(path, directory)
  const env: Record<string, string> = {}
  for (const key of systemEnvironmentKeys) {
    const value = sourceEnvironment[key]
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    APPDATA: join(home, 'AppData/Roaming'),
    LOCALAPPDATA: join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_RUNTIME_DIR: join(home, '.local/run'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TEMPLATE_DIR: join(home, 'git-template'),
    SQLITE_TMPDIR: temporaryDirectory,
    ...contents?.providerEnvironment,
  })
  if (process.platform === 'win32') {
    env['HOMEDRIVE'] = directory.slice(0, 2)
    env['HOMEPATH'] = home.slice(2)
  }
  if (contents && config) {
    await config.assertSourceIntegrity()
    for (const source of contents.sources) {
      const destination = join(
        source.destination.startsWith('claude/') ? claudeHome : codexHome,
        source.destination.slice(source.destination.indexOf('/') + 1),
      )
      await writeFile(destination, source.bytes, { mode: 0o600, flag: 'wx' })
      await chmod(destination, 0o600)
      if (hash(await readFile(destination)) !== source.sha256)
        fail('native configuration copy failed integrity check')
    }
  }
  const onboarding = JSON.stringify({ hasCompletedOnboarding: true }) + '\n'
  await writeFile(join(claudeHome, '.claude.json'), onboarding, { mode: 0o600, flag: 'wx' })
  await writeFile(join(home, '.claude.json'), onboarding, { mode: 0o600, flag: 'wx' })
  await writeFile(join(home, '.gitconfig'), '', { mode: 0o600, flag: 'wx' })
  assertEnvironmentBounds(env, 'prepared environment')
  return {
    env,
    home,
    claudeHome,
    codexHome,
    temporaryDirectory,
    userDataDirectory,
    sessionDataDirectory,
    claudePath: config?.claudePath ?? null,
    codexPath: config?.codexPath ?? null,
  }
}
