import { AgentExecutionError } from './agent-execution-error.js'

function loopbackProxyExclusions(value: string | undefined): string {
  if (value !== undefined && (typeof value !== 'string' || value.includes('\0')))
    throw new AgentExecutionError('runtime_incompatible', 'Invalid Codex proxy exclusions.', false)
  const original = value ?? ''
  if (Buffer.byteLength(original) > 8192)
    throw new AgentExecutionError(
      'runtime_incompatible',
      'Codex proxy exclusions exceed 8 KiB.',
      false,
    )
  const entries = original.split(',')
  if (entries.length > 256)
    throw new AgentExecutionError(
      'runtime_incompatible',
      'Codex proxy exclusions exceed 256 entries.',
      false,
    )
  const excluded = new Set(entries.map((entry) => entry.trim().toLowerCase()))
  const missing = ['127.0.0.1', 'localhost'].filter((host) => !excluded.has(host))
  const result = missing.length ? original + (original ? ',' : '') + missing.join(',') : original
  if (Buffer.byteLength(result) > 8192 || result.split(',').length > 256)
    throw new AgentExecutionError(
      'runtime_incompatible',
      'Codex loopback exclusions exceed their capacity.',
      false,
    )
  return result
}

/** Child-only loopback exclusions for Codex's environment-proxy transport. */
export function codexProcessEnvironment(
  storageRoot?: string,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...source,
    ...(storageRoot ? { CODEX_HOME: storageRoot } : {}),
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'pact',
  }
  if (platform === 'win32') {
    // Node passes the first lexicographically sorted key for case-insensitive Windows env.
    const keys = Object.keys(environment)
      .filter((key) => key.toUpperCase() === 'NO_PROXY')
      .toSorted()
    const prior = keys.length ? environment[keys[0]!] : undefined
    for (const key of keys) delete environment[key]
    environment.NO_PROXY = loopbackProxyExclusions(prior)
  } else {
    environment.NO_PROXY = loopbackProxyExclusions(source.NO_PROXY ?? source.no_proxy)
    environment.no_proxy = loopbackProxyExclusions(source.no_proxy ?? source.NO_PROXY)
  }
  return environment
}
