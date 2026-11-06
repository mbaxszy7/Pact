export const codexExecutionNativeFiles: readonly string[]
export const codexExecutionNativeCases: readonly string[]
export const windowsOwnerNativeFiles: readonly string[]
export const windowsOwnerNativeCases: readonly string[]
export const windowsOwnerHostCases: readonly string[]
export function nativeProfileSupports(
  profile: ReturnType<typeof nativeProfile>,
  platform?: string,
  arch?: string,
): boolean
export function nativeProfileSetupSupports(
  profile: ReturnType<typeof nativeProfile>,
  platform?: string,
  arch?: string,
): boolean
export function nativeProfile(name?: string): {
  name: 'legacy' | 'execution-codex' | 'windows-owner'
  command: 'test:native' | 'test:native:execution' | 'test:native:windows-owner'
  codexVersion: '0.159.2' | '0.163.0' | null
  claudeVersion?: null
  directory: 'pact-native-cli' | 'pact-codex-execution-cli' | 'pact-windows-owner-native'
  files: readonly string[] | null
  cases?: readonly string[]
}
