import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

/* oxlint-disable eslint/no-await-in-loop -- Bounded reads, ordered executable discovery and ancestor checks settle before advancing; owned files are prepared before any process starts. */

const defaultConfigurationRoot = resolve(import.meta.dirname, 'env')
const fileLimit = 256 * 1024
const agyEnvLimit = 8 * 1024
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
  'ANTIGRAVITY_GEMINI_DIR',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
])

interface ConfigurationSource {
  path: string
  originalPath: string
  destination: 'claude/settings.json' | 'codex/config.toml' | 'codex/auth.json' | 'agy/.env'
  bytes: Buffer
  sha256: string
  dev: number
  ino: number
}

export type ProviderConfigurationProfile = 'default' | 'codex-agy'

export const DEFAULT_REAL_AGY_MODEL = 'gemini-3.8-flash'

export interface LoadProviderConfigurationOptions {
  profile?: ProviderConfigurationProfile
}

export interface BaseProviderConfiguration {
  claudePath: string | null
  codexPath: string
  agyPath?: string
  models: { claude: string | null; codex: string | null; agy?: string | null }
  configurationFingerprint: string
  sourceHashes: ReadonlyArray<{ file: ConfigurationSource['destination']; sha256: string }>
  redact(text: string): string
  assertSourceIntegrity(): Promise<void>
}

/** Holds three bounded source files for one run; dispose the owning fixture to release it. */
export interface ProviderConfiguration extends BaseProviderConfiguration {
  claudePath: string
}

export interface CodexAgyProviderConfiguration extends BaseProviderConfiguration {
  claudePath: null
  agyPath: string
  models: { claude: null; codex: string | null; agy: string | null }
}

export type AnyProviderConfiguration = ProviderConfiguration | CodexAgyProviderConfiguration

export interface ProviderEnvironment {
  env: Record<string, string>
  home: string
  claudeHome: string
  codexHome: string
  geminiHome: string
  temporaryDirectory: string
  userDataDirectory: string
  sessionDataDirectory: string
  claudePath: string | null
  codexPath: string | null
  agyPath?: string | null
}

// Weak ownership avoids a process-wide credential cache; contents live only with a run's config.
const configurationContents = new WeakMap<
  AnyProviderConfiguration,
  {
    profile: ProviderConfigurationProfile
    sourceRoot: string
    sources: ConfigurationSource[]
    providerEnvironment: Record<string, string>
    agyGeminiApiKey?: string
  }
>()

export function isExternalPullRequestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (
    env['GITHUB_EVENT_NAME'] === 'pull_request' ||
    env['GITHUB_EVENT_NAME'] === 'pull_request_target'
  ) {
    return true
  }
  if (
    Boolean(env['CI']) &&
    Boolean(env['GITHUB_HEAD_REF']) &&
    Boolean(env['GITHUB_HEAD_REPOSITORY']) &&
    env['GITHUB_REPOSITORY'] !== env['GITHUB_HEAD_REPOSITORY']
  ) {
    return true
  }
  return false
}

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

async function readBoundedFileWithIdentity(
  filePath: string,
  label: string,
  options: { requireOwnedSingleLink?: boolean; nonEmpty?: boolean } = {},
): Promise<{ bytes: Buffer; dev: number; ino: number }> {
  const limit = label === 'agy/.env' ? agyEnvLimit : fileLimit
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const before = await lstat(filePath)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > limit ||
      (options.nonEmpty && before.size < 1) ||
      (options.requireOwnedSingleLink &&
        (before.nlink !== 1 || (process.platform !== 'win32' && before.uid !== process.getuid?.())))
    ) {
      fail(
        options.requireOwnedSingleLink
          ? `${label} must be an owned regular file of 1 to 8192 bytes`
          : `${label} must be a regular file of at most ${limit === agyEnvLimit ? '8 KiB' : '256 KiB'}`,
      )
    }
    const openFlags =
      constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0))
    handle = await open(filePath, openFlags)
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.size > limit ||
      (options.requireOwnedSingleLink && opened.nlink !== 1)
    ) {
      fail(`${label} changed while opening`)
    }
    const buffer = Buffer.allocUnsafe(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length !== before.size || length > limit || (options.nonEmpty && length < 1)) {
      fail(`${label} could not be read cleanly`)
    }
    return { bytes: buffer.subarray(0, length), dev: opened.dev, ino: opened.ino }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readOwnedAgyEnvFile(
  filePath: string,
  options: { root?: string; explicit?: boolean } = {},
): Promise<ConfigurationSource> {
  if (!isAbsolute(filePath) || filePath.length > 4096 || /[\r\n\0]/u.test(filePath)) {
    fail(
      options.explicit
        ? 'PACT_E2E_AGY_ENV_FILE must be a safe absolute path'
        : 'agy/.env must have a safe path',
    )
  }
  try {
    if (options.root) {
      const parentStat = await lstat(dirname(filePath))
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        fail('agy/.env parent directory must not be a symlink')
      }
    }
    const read = await readBoundedFileWithIdentity(filePath, 'agy/.env', {
      requireOwnedSingleLink: true,
      nonEmpty: true,
    })
    const canonicalPath = await realpath(filePath)
    if (options.root && !isWithin(options.root, canonicalPath)) {
      fail('configuration file resolves outside its source directory')
    }
    return {
      path: canonicalPath,
      originalPath: filePath,
      destination: 'agy/.env',
      bytes: read.bytes,
      sha256: hash(read.bytes),
      dev: read.dev,
      ino: read.ino,
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('E2E provider configuration:')) {
      throw error
    }
    if (options.explicit) {
      return fail('PACT_E2E_AGY_ENV_FILE must be an owned regular file of 1 to 8192 bytes')
    }
    return fail('agy/.env cannot be read; provide an owned agy/.env containing GEMINI_API_KEY')
  }
}

async function readSource(
  root: string,
  destination: ConfigurationSource['destination'],
): Promise<ConfigurationSource> {
  const path = join(root, destination)
  if (destination === 'agy/.env') {
    return readOwnedAgyEnvFile(path, { root })
  }
  try {
    const canonicalPath = await realpath(path)
    if (!isWithin(root, canonicalPath))
      fail('configuration file resolves outside its source directory')
    const read = await readBoundedFileWithIdentity(path, destination)
    return {
      path: canonicalPath,
      originalPath: path,
      destination,
      bytes: read.bytes,
      sha256: hash(read.bytes),
      dev: read.dev,
      ino: read.ino,
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('E2E provider configuration:'))
      throw error
    return fail(`${destination} cannot be read; provide all three native configuration files`)
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

export function providerExecutableCandidates(
  agent: 'claude' | 'codex' | 'agy',
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return platform === 'win32' ? [`${agent}.exe`, `${agent}.cmd`, agent] : [agent]
}

async function findExecutable(
  agent: 'claude' | 'codex' | 'agy',
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const explicit = environment[`PACT_E2E_${agent.toUpperCase()}_EXECUTABLE`]
  if (explicit && !isAbsolute(explicit)) fail(`${agent} executable must be an absolute path`)
  const directories = (environment['PATH'] ?? '').split(delimiter).filter(Boolean)
  if (directories.length > pathEntryLimit) fail('PATH exceeds 128 entries')
  const names = providerExecutableCandidates(agent, process.platform)
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

function validateExplicitAgyExecutablePath(explicit: string): string {
  const trimmed = explicit.trim()
  if (
    !trimmed ||
    !isAbsolute(trimmed) ||
    /[\r\n\0]/u.test(trimmed) ||
    (process.platform === 'win32' && /\.cmd$/iu.test(trimmed) && /[&|<>^%!"\r\n\0]/u.test(trimmed))
  ) {
    fail('agy executable must be a safe absolute path')
  }
  return trimmed
}

async function resolveExplicitAgyExecutable(explicit: string): Promise<string> {
  const trimmed = validateExplicitAgyExecutablePath(explicit)
  try {
    const path = await realpath(trimmed)
    const info = await stat(path)
    if (!info.isFile()) fail('agy executable must be a regular file')
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return path
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('E2E provider configuration:')) {
      throw error
    }
    return fail('agy CLI was not found at its explicit E2E executable path')
  }
}

async function findOptionalAgyExecutable(
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const explicit = environment['PACT_E2E_AGY_EXECUTABLE']
  if (explicit === undefined) return undefined
  return resolveExplicitAgyExecutable(explicit)
}

async function resolveRequiredAgyExecutable(environment: NodeJS.ProcessEnv): Promise<string> {
  const explicit = environment['PACT_E2E_AGY_EXECUTABLE']
  if (explicit !== undefined) return resolveExplicitAgyExecutable(explicit)
  return findExecutable('agy', environment)
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

function parseAndValidateCodex(
  codexSource: ConfigurationSource,
  authSource: ConfigurationSource,
  providerEnvironment: Record<string, string>,
  secrets: Set<string>,
): { codexModel: string | null; injectedEnvironment: Record<string, string> } {
  const auth = parseJson(authSource)
  let codex: Record<string, unknown>
  try {
    codex = requireRecord(parseToml(codexSource.bytes.toString('utf8')), 'codex/config.toml')
  } catch {
    fail('codex/config.toml is not valid TOML')
  }
  for (const configuration of [codex, auth]) inspectConfiguration(configuration, secrets)
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
  const codexModel =
    codex['model'] === undefined ? null : requireSetting(codex['model'], 'Codex model')
  return { codexModel, injectedEnvironment }
}

function buildProviderRedactor(secrets: Set<string>): (text: string) => string {
  const secretValues = [...secrets]
    .filter((value) => value.length >= 4)
    .toSorted((a, b) => b.length - a.length)
  return (text: string) => {
    let result = text
    for (const secret of secretValues) {
      result = result.replaceAll(secret, '[REDACTED]')
      const encoded = JSON.stringify(secret).slice(1, -1)
      if (encoded !== secret) result = result.replaceAll(encoded, '[REDACTED]')
    }
    return result
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [REDACTED]')
      .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
      .replace(
        /(\b(?:authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)["']?\s*[:=]\s*["']?)[^\s,"'\r\n}]+/gi,
        '$1[REDACTED]',
      )
  }
}

function buildAssertSourceIntegrity(sources: readonly ConfigurationSource[]): () => Promise<void> {
  return async () => {
    for (const source of sources) {
      try {
        if (source.destination === 'agy/.env') {
          const fresh = await readOwnedAgyEnvFile(source.originalPath)
          if (
            fresh.sha256 !== source.sha256 ||
            (source.ino !== 0 && (fresh.dev !== source.dev || fresh.ino !== source.ino))
          ) {
            fail(`${source.destination} changed during the test run`)
          }
        } else {
          const fresh = await readBoundedFileWithIdentity(source.originalPath, source.destination)
          if (
            hash(fresh.bytes) !== source.sha256 ||
            (source.ino !== 0 && (fresh.dev !== source.dev || fresh.ino !== source.ino))
          ) {
            fail(`${source.destination} changed during the test run`)
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('E2E provider configuration:'))
          throw error
        fail(`${source.destination} is no longer available`)
      }
    }
  }
}

async function loadWindowsNodeLauncher(): Promise<
  (directory: string, name: string, prefix: string[]) => Promise<string>
> {
  try {
    const mod = await import('./windows-cli-launcher.js')
    return mod.writeWindowsNodeLauncher
  } catch {
    const launcherUrl = new URL('./windows-cli-launcher.ts', import.meta.url).href
    const mod: unknown = await import(launcherUrl)
    const fn = isRecord(mod) ? mod['writeWindowsNodeLauncher'] : undefined
    if (typeof fn !== 'function') {
      fail('Windows node launcher helper is unavailable')
    }
    return async (directory, name, prefix) => {
      const result: unknown = await Reflect.apply(fn, undefined, [directory, name, prefix])
      if (typeof result !== 'string') {
        fail('Windows node launcher did not return an executable path')
      }
      return result
    }
  }
}

export function buildWindowsAgyApiKeyLauncherSource(keyFile: string, realAgyPath: string): string {
  return [
    "import { spawnSync } from 'node:child_process'",
    "import { lstatSync, readFileSync, realpathSync } from 'node:fs'",
    "import { win32 } from 'node:path'",
    `const apiKey = readFileSync(${JSON.stringify(keyFile)}, 'utf8').replace(/\\r?\\n$/u, '')`,
    `const realAgyPath = ${JSON.stringify(realAgyPath)}`,
    'const args = process.argv.slice(2)',
    'const env = { ...process.env, GEMINI_API_KEY: apiKey }',
    'let result',
    'if (/\\.cmd$/iu.test(realAgyPath)) {',
    '  const unsafe = /[&|<>^%!"\\r\\n\\0]/u',
    '  if ([realAgyPath, ...args].some((v) => unsafe.test(v))) process.exit(1)',
    '  const systemRoot = process.env.SystemRoot || process.env.WINDIR',
    '  if (!systemRoot || !/^[A-Za-z]:\\\\(?:[^\\\\/:*?"<>|]+\\\\)*[^\\\\/:*?"<>|]*$/u.test(systemRoot)) process.exit(1)',
    "  const cmdExe = win32.resolve(systemRoot, 'System32', 'cmd.exe')",
    '  try {',
    '    const rootSt = lstatSync(systemRoot)',
    '    const sys32St = lstatSync(win32.dirname(cmdExe))',
    '    const cmdSt = lstatSync(cmdExe)',
    '    if (!rootSt.isDirectory() || rootSt.isSymbolicLink() || !sys32St.isDirectory() || sys32St.isSymbolicLink() || !cmdSt.isFile() || cmdSt.isSymbolicLink() || realpathSync(cmdExe).toLowerCase() !== cmdExe.toLowerCase()) process.exit(1)',
    '  } catch { process.exit(1) }',
    "  const rendered = '\"\"' + realAgyPath + '\"' + (args.length ? ' ' + args.map((v) => '\"' + v + '\"').join(' ') : '') + '\"'",
    "  result = spawnSync(cmdExe, ['/d', '/s', '/c', rendered], { stdio: 'inherit', env, shell: false, windowsHide: true, windowsVerbatimArguments: true })",
    '} else {',
    "  result = spawnSync(realAgyPath, args, { stdio: 'inherit', env, shell: false, windowsHide: true })",
    '}',
    'if (result.error) throw result.error',
    'process.exitCode = result.status ?? 1',
    '',
  ].join('\n')
}

export interface IsolatedKeylessNodeOptions {
  projectDirectory: string
  entry: { kind: 'test'; file: string } | { kind: 'eval'; code: string }
  forbiddenPaths?: readonly string[]
  timeoutMs?: number
}

const KEYLESS_MAX_FILES = 64
const KEYLESS_MAX_TOTAL_BYTES = 1024 * 1024
const KEYLESS_MAX_DEPTH = 8
const execFilePromise = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
): Promise<{ code: number | null; combined: string }> =>
  new Promise((done) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      const code =
        error === null
          ? 0
          : isRecord(error) && typeof error['code'] === 'number'
            ? error['code']
            : null
      done({ code, combined: `${stdout}\n${stderr}` })
    })
  })

async function copyWorkspaceTreeForKeylessVerifier(
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  const queue: Array<{ src: string; dst: string; depth: number }> = [
    { src: sourceRoot, dst: destinationRoot, depth: 0 },
  ]
  let totalFiles = 0
  let totalBytes = 0
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth > KEYLESS_MAX_DEPTH) {
      fail('keyless verifier workspace exceeds directory depth limit')
    }
    const entries = await readdir(current.src, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const srcPath = join(current.src, entry.name)
      const dstPath = join(current.dst, entry.name)
      const info = await lstat(srcPath)
      if (info.isSymbolicLink()) {
        fail('keyless verifier project must not contain symbolic links')
      }
      if (info.isDirectory()) {
        await mkdir(dstPath, { mode: 0o700 })
        await chmod(dstPath, 0o700)
        queue.push({ src: srcPath, dst: dstPath, depth: current.depth + 1 })
      } else if (info.isFile()) {
        totalFiles += 1
        totalBytes += info.size
        if (
          totalFiles > KEYLESS_MAX_FILES ||
          info.size > fileLimit ||
          totalBytes > KEYLESS_MAX_TOTAL_BYTES
        ) {
          fail('keyless verifier project exceeds copy bounds')
        }
        await copyFile(srcPath, dstPath)
        await chmod(dstPath, 0o600)
      }
    }
  }
}

function escapeSandboxProfileString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export async function runIsolatedKeylessProjectNode(
  input: IsolatedKeylessNodeOptions,
): Promise<{ code: number | null; combined: string }> {
  const canonicalProject = await realpath(resolve(input.projectDirectory))
  if (input.entry.kind === 'test') {
    if (
      !input.entry.file ||
      isAbsolute(input.entry.file) ||
      input.entry.file.split(/[/\\]/u).some((seg) => seg === '..') ||
      /[\r\n\0]/u.test(input.entry.file)
    ) {
      fail('keyless verifier test entry must be a safe relative path')
    }
  }

  const rawVerifyRoot = await mkdtemp(join(tmpdir(), 'pact-keyless-verify-'))
  let canonicalVerifyRoot: string
  try {
    await chmod(rawVerifyRoot, 0o700)
    canonicalVerifyRoot = await realpath(rawVerifyRoot)
    const canonicalExecDir = await realpath(dirname(process.execPath))
    const canonicalForbidden: string[] = []
    for (const rawForbidden of input.forbiddenPaths ?? []) {
      const resolvedForbidden = await canonicalFutureDirectory(resolve(rawForbidden))
      if (
        isWithin(resolvedForbidden, canonicalVerifyRoot) ||
        isWithin(canonicalVerifyRoot, resolvedForbidden)
      ) {
        fail('keyless verifier sandbox root must not overlap forbidden credential directories')
      }
      if (!isWithin(resolvedForbidden, canonicalExecDir) && resolvedForbidden !== '/') {
        canonicalForbidden.push(resolvedForbidden)
      }
    }

    await copyWorkspaceTreeForKeylessVerifier(canonicalProject, canonicalVerifyRoot)

    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: dirname(process.execPath),
      HOME: canonicalVerifyRoot,
      USERPROFILE: canonicalVerifyRoot,
      TMPDIR: canonicalVerifyRoot,
      TEMP: canonicalVerifyRoot,
      TMP: canonicalVerifyRoot,
      LANG: 'en_US.UTF-8',
      ...(process.platform === 'win32'
        ? {
            ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
            ...(process.env['SYSTEMROOT'] ? { SYSTEMROOT: process.env['SYSTEMROOT'] } : {}),
          }
        : {}),
    }
    if ('GEMINI_API_KEY' in cleanEnv || 'OPENAI_API_KEY' in cleanEnv) {
      fail('Keyless verifier environment must not contain provider credentials')
    }

    const nodeArgs = [
      '--permission',
      `--allow-fs-read=${canonicalVerifyRoot}/*`,
      ...(input.entry.kind === 'test'
        ? ['--test', '--experimental-test-isolation=none', input.entry.file]
        : ['--input-type=module', '-e', input.entry.code]),
    ]

    let command = process.execPath
    let args = nodeArgs
    if (process.platform === 'darwin' && canonicalForbidden.length > 0) {
      let sandboxAvailable = false
      try {
        const sbStat = lstatSync('/usr/bin/sandbox-exec')
        if (
          sbStat.isFile() &&
          !sbStat.isSymbolicLink() &&
          realpathSync('/usr/bin/sandbox-exec') === '/usr/bin/sandbox-exec'
        ) {
          sandboxAvailable = true
        }
      } catch {
        sandboxAvailable = false
      }
      if (sandboxAvailable) {
        const denyReadClauses = canonicalForbidden
          .map((p) => `(deny file-read* (subpath "${escapeSandboxProfileString(p)}"))`)
          .join(' ')
        const profile = `(version 1) (allow default) (deny network*) ${denyReadClauses}`
        command = '/usr/bin/sandbox-exec'
        args = ['-p', profile, process.execPath, ...nodeArgs]
      }
    }

    return await execFilePromise(command, args, {
      cwd: canonicalVerifyRoot,
      env: cleanEnv,
      timeout: input.timeoutMs ?? 10_000,
      maxBuffer: 64 * 1024,
    })
  } finally {
    await rm(rawVerifyRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function loadProviderConfiguration(
  configRoot?: string,
  sourceEnvironment?: NodeJS.ProcessEnv,
  providerEnvironment?: Record<string, string>,
  options?: { profile?: 'default' },
): Promise<ProviderConfiguration>
export async function loadProviderConfiguration(
  configRoot: string | undefined,
  sourceEnvironment: NodeJS.ProcessEnv | undefined,
  providerEnvironment: Record<string, string> | undefined,
  options: { profile: 'codex-agy' },
): Promise<CodexAgyProviderConfiguration>
export async function loadProviderConfiguration(
  configRoot?: string,
  sourceEnvironment?: NodeJS.ProcessEnv,
  providerEnvironment?: Record<string, string>,
  options?: LoadProviderConfigurationOptions,
): Promise<AnyProviderConfiguration>
export async function loadProviderConfiguration(
  configRoot?: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  providerEnvironment: Record<string, string> = {},
  options: LoadProviderConfigurationOptions = {},
): Promise<AnyProviderConfiguration> {
  const profile = options.profile ?? 'default'
  assertEnvironmentBounds(sourceEnvironment, 'input environment', true)
  assertEnvironmentBounds(providerEnvironment, 'explicit provider environment')
  if (profile === 'codex-agy' && isExternalPullRequestEnvironment(sourceEnvironment)) {
    fail('paid real Antigravity E2E cannot be authorized on external pull requests')
  }
  const requestedRoot =
    configRoot ?? sourceEnvironment['PACT_E2E_ENV_DIR'] ?? defaultConfigurationRoot
  let root: string
  try {
    root = await realpath(resolve(requestedRoot))
  } catch {
    fail('configuration directory does not exist')
  }

  if (profile === 'codex-agy') {
    const explicitAgyEnvFile = sourceEnvironment['PACT_E2E_AGY_ENV_FILE']
    const [codexSource, authSource, agySource] = await Promise.all([
      readSource(root, 'codex/config.toml'),
      readSource(root, 'codex/auth.json'),
      explicitAgyEnvFile !== undefined
        ? readOwnedAgyEnvFile(explicitAgyEnvFile, { explicit: true })
        : readSource(root, 'agy/.env'),
    ])
    const sources: ConfigurationSource[] = [codexSource, authSource, agySource]
    if (
      sources.reduce((bytes, source) => bytes + source.bytes.byteLength, 0) > configurationLimit
    ) {
      fail('configuration files exceed 768 KiB in total')
    }
    const secrets = new Set<string>()
    const { codexModel, injectedEnvironment } = parseAndValidateCodex(
      codexSource,
      authSource,
      providerEnvironment,
      secrets,
    )
    const parsedAgyEnv = parseEnv(agySource.bytes.toString('utf8'))
    for (const [key, value] of Object.entries(parsedAgyEnv)) {
      if (value !== undefined && isSecretKey(key) && value.trim()) secrets.add(value)
    }
    const geminiApiKey = requireSetting(
      parsedAgyEnv['GEMINI_API_KEY'],
      'Antigravity GEMINI_API_KEY',
    )
    if (geminiApiKey.length < 8 || /\s/u.test(geminiApiKey) || !/^[!-~]+$/u.test(geminiApiKey)) {
      fail(
        'Antigravity GEMINI_API_KEY must be at least 8 printable non-whitespace ASCII characters',
      )
    }
    secrets.add(geminiApiKey)
    const agyModel =
      parsedAgyEnv['AGY_MODEL'] === undefined
        ? DEFAULT_REAL_AGY_MODEL
        : requireSetting(parsedAgyEnv['AGY_MODEL'], 'Antigravity model')
    const [codexPath, agyPath] = await Promise.all([
      findExecutable('codex', sourceEnvironment),
      resolveRequiredAgyExecutable(sourceEnvironment),
    ])
    const configuration: CodexAgyProviderConfiguration = {
      claudePath: null,
      codexPath,
      agyPath,
      models: { claude: null, codex: codexModel, agy: agyModel },
      configurationFingerprint: hash(
        sources.map((source) => `${source.destination}:${source.sha256}`).join('\n') +
          JSON.stringify(
            Object.entries(injectedEnvironment).toSorted(([a], [b]) => a.localeCompare(b)),
          ),
      ),
      sourceHashes: sources.map((source) => ({ file: source.destination, sha256: source.sha256 })),
      redact: buildProviderRedactor(secrets),
      assertSourceIntegrity: buildAssertSourceIntegrity(sources),
    }
    configurationContents.set(configuration, {
      profile: 'codex-agy',
      sourceRoot: root,
      sources,
      providerEnvironment: injectedEnvironment,
      agyGeminiApiKey: geminiApiKey,
    })
    return configuration
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
  const secrets = new Set<string>()
  inspectConfiguration(claude, secrets)
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
  const { codexModel, injectedEnvironment } = parseAndValidateCodex(
    codexSource,
    authSource,
    providerEnvironment,
    secrets,
  )
  const models = {
    claude:
      claudeEnvironment['ANTHROPIC_MODEL'] === undefined
        ? null
        : requireSetting(claudeEnvironment['ANTHROPIC_MODEL'], 'Claude model'),
    codex: codexModel,
  }
  const [claudePath, codexPath, agyPath] = await Promise.all([
    findExecutable('claude', sourceEnvironment),
    findExecutable('codex', sourceEnvironment),
    findOptionalAgyExecutable(sourceEnvironment),
  ])
  const configuration: ProviderConfiguration = {
    claudePath,
    codexPath,
    ...(agyPath ? { agyPath } : {}),
    models,
    configurationFingerprint: hash(
      sources.map((source) => `${source.destination}:${source.sha256}`).join('\n') +
        JSON.stringify(
          Object.entries(injectedEnvironment).toSorted(([a], [b]) => a.localeCompare(b)),
        ),
    ),
    sourceHashes: sources.map((source) => ({ file: source.destination, sha256: source.sha256 })),
    redact: buildProviderRedactor(secrets),
    assertSourceIntegrity: buildAssertSourceIntegrity(sources),
  }
  configurationContents.set(configuration, {
    profile: 'default',
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

function assertSafeWrapperPath(value: string, label: string): void {
  if (
    !value ||
    /['"\r\n\0$`&|<>^%!]/u.test(value) ||
    (process.platform !== 'win32' && value.includes('\\'))
  ) {
    fail(`${label} contains unsafe wrapper path characters`)
  }
}

/** The fixture owns and removes root; restarting a scene reuses this prepared environment. */
export async function prepareProviderEnvironment(
  root: string,
  config?: AnyProviderConfiguration,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  options: { disableCodexPlugins?: boolean } = {},
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
    (isWithin(directory, contents.sourceRoot) ||
      isWithin(contents.sourceRoot, directory) ||
      contents.sources.some((source) => isWithin(directory, source.path)))
  ) {
    fail('owned root must not contain source configuration files')
  }
  await mkdir(requestedDirectory, { recursive: true, mode: 0o700 })
  if (!(await lstat(requestedDirectory)).isDirectory()) fail('owned root must not be a symlink')
  await privateDirectory(directory, directory)
  const useIsolatedGeminiHome = contents?.profile === 'codex-agy'
  const home = join(directory, 'home')
  const claudeHome = join(directory, 'claude-home')
  const codexHome = join(directory, 'codex-home')
  const geminiHome = useIsolatedGeminiHome ? join(directory, 'gemini-home') : join(home, '.gemini')
  const temporaryDirectory = join(directory, 'tmp')
  const userDataDirectory = join(directory, 'electron-profile')
  const sessionDataDirectory = join(directory, 'electron-session')
  const ownedDirectories = [
    home,
    claudeHome,
    codexHome,
    ...(useIsolatedGeminiHome ? [geminiHome] : []),
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
    join(home, '.gemini'),
    join(home, '.gemini/antigravity-cli'),
    join(home, '.gemini/antigravity-cli/conversations'),
    join(home, '.gemini/antigravity-cli/brain'),
    join(claudeHome, 'projects'),
    join(codexHome, 'sessions'),
    ...(useIsolatedGeminiHome
      ? [
          join(geminiHome, 'antigravity-cli'),
          join(geminiHome, 'antigravity-cli/conversations'),
          join(geminiHome, 'antigravity-cli/brain'),
        ]
      : []),
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
    ...(useIsolatedGeminiHome ? { ANTIGRAVITY_GEMINI_DIR: geminiHome } : {}),
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
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
  let preparedAgyPath = config?.agyPath ?? null
  if (contents && config) {
    await config.assertSourceIntegrity()
    for (const source of contents.sources) {
      if (source.destination === 'agy/.env') continue
      let copy = source.bytes
      if (options.disableCodexPlugins && source.destination === 'codex/config.toml') {
        // Real business fixtures do not exercise optional marketplace downloads.
        // Keep the source bytes untouched and preserve every other native setting.
        const parsed = parseToml(source.bytes.toString('utf8'))
        if (
          parsed.features !== undefined &&
          (!isRecord(parsed.features) || parsed.features instanceof Date)
        )
          fail('Codex features must be a table')
        parsed.features = { ...parsed.features, plugins: false }
        copy = Buffer.from(stringifyToml(parsed))
        if (copy.length > fileLimit) fail('isolated Codex configuration exceeds its byte bound')
      }
      const destination = join(
        source.destination.startsWith('claude/') ? claudeHome : codexHome,
        source.destination.slice(source.destination.indexOf('/') + 1),
      )
      await writeFile(destination, copy, { mode: 0o600, flag: 'wx' })
      await chmod(destination, 0o600)
      if (hash(await readFile(destination)) !== hash(copy))
        fail('native configuration copy failed integrity check')
    }
    if (contents.agyGeminiApiKey !== undefined) {
      const realAgyPath = config.agyPath
      if (!realAgyPath) fail('Antigravity executable is required for API-key wrapper isolation')
      const providerSettings = JSON.stringify({ modelProvider: 'gemini' }) + '\n'
      const agySettingsPath = join(geminiHome, 'antigravity-cli', 'settings.json')
      const homeAgySettingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json')
      for (const settingsPath of new Set([agySettingsPath, homeAgySettingsPath])) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Seed strict 0600 settings files sequentially across isolated roots.
        await writeFile(settingsPath, providerSettings, {
          mode: 0o600,
          flag: 'wx',
        })
        // oxlint-disable-next-line eslint/no-await-in-loop -- Ensure restrictive permissions on each newly created settings file.
        await chmod(settingsPath, 0o600)
      }

      const agyAuthBin = join(directory, 'agy-auth-bin')
      await privateDirectory(agyAuthBin, directory)
      const keyFile = join(agyAuthBin, 'gemini-key')
      assertSafeWrapperPath(keyFile, 'Antigravity key file')
      assertSafeWrapperPath(realAgyPath, 'Antigravity executable')
      await writeFile(keyFile, Buffer.from(`${contents.agyGeminiApiKey}\n`, 'utf8'), {
        mode: 0o600,
        flag: 'wx',
      })
      await chmod(keyFile, 0o600)

      if (process.platform === 'win32') {
        const launcherScriptPath = join(agyAuthBin, 'agy-launch.mjs')
        const launcherScript = buildWindowsAgyApiKeyLauncherSource(keyFile, realAgyPath)
        await writeFile(launcherScriptPath, launcherScript, { mode: 0o600, flag: 'wx' })
        await chmod(launcherScriptPath, 0o600)
        const writeLauncher = await loadWindowsNodeLauncher()
        preparedAgyPath = await writeLauncher(agyAuthBin, 'agy', [launcherScriptPath])
      } else {
        const wrappedBin = join(agyAuthBin, 'agy')
        const script = `#!/bin/sh\nset -eu\nIFS= read -r GEMINI_API_KEY < '${keyFile}'\nexport GEMINI_API_KEY\nexec '${realAgyPath}' "$@"\n`
        await writeFile(wrappedBin, script, { mode: 0o700, flag: 'wx' })
        await chmod(wrappedBin, 0o700)
        preparedAgyPath = wrappedBin
      }
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
    geminiHome,
    temporaryDirectory,
    userDataDirectory,
    sessionDataDirectory,
    claudePath: config?.claudePath ?? null,
    codexPath: config?.codexPath ?? null,
    agyPath: preparedAgyPath,
  }
}
