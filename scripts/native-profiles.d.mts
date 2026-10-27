export const decisionNativeFiles: readonly string[]
export const claudeDecisionNativeFiles: readonly string[]
export const claudeDecisionNativeCases: readonly string[]
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
  name: 'legacy' | 'decision-codex' | 'decision-claude' | 'windows-owner'
  command:
    | 'test:native'
    | 'test:native:decision'
    | 'test:native:claude-decision'
    | 'test:native:windows-owner'
  codexVersion: '0.159.2' | '0.163.0' | null
  claudeVersion?: '2.1.272' | null
  directory:
    | 'pact-native-cli'
    | 'pact-decision-native-cli'
    | 'pact-claude-decision-native-cli'
    | 'pact-windows-owner-native'
  files: readonly string[] | null
  cases?: readonly string[]
}
