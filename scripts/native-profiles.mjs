/** Fixed protocol inventories; no caller-selected version or fallback CLI. */
export const decisionNativeFiles = Object.freeze([
  'tests/native/codex-decision-runtime.test.ts',
  'tests/native/decision-inline-provider.test.ts',
  'tests/native/decision-physical-witness.test.ts',
  'tests/native/decision-response-guard.test.ts',
  'tests/native/decision-response-upgrade.test.ts',
])

export const claudeDecisionNativeFiles = Object.freeze([
  'tests/native/claude-decision-runtime.test.ts',
])
export const claudeDecisionNativeCases = Object.freeze([
  'Claude decision inspects the actual catalog without substituting Haiku 4.5 or dispatching inference',
  'Claude decision completes one actual native text turn through the production guard with owned synthetic catalog and global instructions',
  'Claude decision preserves same-message thinking and text frames through the production guard',
  'Claude production guard blocks a preauthorized native Bash response after a positive two-request tool canary',
  'Claude production guard preserves native helper refresh for one complete 401 with identical semantic input',
  'Claude production runtime rejects executable credential helpers without upstream requests or native mutations',
])
export const windowsOwnerNativeFiles = Object.freeze([
  'tests/native/owned-process-group-win32.test.ts',
])
export const windowsOwnerHostCases = Object.freeze(
  [
    'keeps one recovery flight and its lease until a timed-out helper and the already-started file close both finish',
    ...['lstat-deadline', 'open-deadline', 'open-cancel'].map(
      (mode) =>
        `joins delayed ${mode} I/O and never starts a helper after that operation becomes obsolete`,
    ),
    'withholds an unconfirmed retirement result until delayed physical close and consumes the same absolute batch deadline',
  ].map((title) => `Windows receipt helper physical completion contract ${title}`),
)
export const windowsOwnerNativeCases = Object.freeze(
  [
    'persists allocated and contained phases before the first native instruction and forwards the real root identity',
    'retains release while the root has exited and a grandchild is live, then proves both retained descendant handles exited before fixture cleanup',
    'retires a cancelled pre-launch allocation only after confirmed release and refuses a mismatched file identity or outside path',
    ...['sdk-kill', 'owner-abort', 'spawn-abort'].map(
      (mode) => `routes ${mode} through product control and joins the bridge`,
    ),
    'uses the original fifteen-second deadline and one cleanup window for a silent native root',
    'preserves stdout backpressure and complete bytes before physical closure',
    'keeps decision bridge and receipt verification independent from the fully reserved business pool',
    'inherits only standard target handles, and completes 100 bounded physical lifecycles without retained receipts or working reservations',
    ...['suspended', 'resumed'].map(
      (phase) =>
        `recovers an exact flushed receipt after the Utility exits while ${phase}, rejects altered births and hardlinks, and retires only after commit`,
    ),
    'keeps cleanup unconfirmed when the bridge crashes before its empty receipt even after independent handles show kernel cleanup',
  ].map((title) => `Windows product OwnedProcessGroup ${title}`),
)

export function nativeProfileSupports(profile, platform = process.platform, arch = process.arch) {
  if (profile.name === 'legacy') return true
  if (profile.name === 'decision-codex') return platform === 'darwin' && arch === 'arm64'
  if (profile.name === 'windows-owner')
    return platform === 'win32' && ['x64', 'arm64'].includes(arch)
  return profile.name === 'decision-claude' && platform === 'darwin' && arch === 'arm64'
}

/** Installing an exact CLI is separate from admitting its native test inventory.
 * Windows decision execution remains closed until its platform cases are implemented. */
export function nativeProfileSetupSupports(
  profile,
  platform = process.platform,
  arch = process.arch,
) {
  return (
    nativeProfileSupports(profile, platform, arch) ||
    (['decision-codex', 'decision-claude'].includes(profile.name) &&
      platform === 'win32' &&
      ['x64', 'arm64'].includes(arch))
  )
}

export function nativeProfile(name = 'legacy') {
  if (name === 'legacy')
    return {
      name,
      command: 'test:native',
      codexVersion: '0.159.2',
      directory: 'pact-native-cli',
      files: null,
    }
  if (name === 'decision-codex')
    return {
      name,
      command: 'test:native:decision',
      codexVersion: '0.163.0',
      directory: 'pact-decision-native-cli',
      files: decisionNativeFiles,
    }
  if (name === 'decision-claude')
    return {
      name,
      command: 'test:native:claude-decision',
      codexVersion: null,
      claudeVersion: '2.1.272',
      directory: 'pact-claude-decision-native-cli',
      files: claudeDecisionNativeFiles,
      cases: claudeDecisionNativeCases,
    }
  if (name === 'windows-owner')
    return {
      name,
      command: 'test:native:windows-owner',
      codexVersion: null,
      claudeVersion: null,
      directory: 'pact-windows-owner-native',
      files: windowsOwnerNativeFiles,
      cases: [...windowsOwnerHostCases, ...windowsOwnerNativeCases],
    }
  throw new Error('Unknown fixed native profile')
}
