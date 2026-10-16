import type { ProviderConfiguration } from '../tests/e2e/provider-environment.js'

export function readCiProviderConfiguration(
  source?: NodeJS.ProcessEnv,
): Promise<ProviderConfiguration>
export function main(args?: string[], source?: NodeJS.ProcessEnv): Promise<void>
