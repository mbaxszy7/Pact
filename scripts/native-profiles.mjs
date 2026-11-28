/** Fixed protocol inventories; no caller-selected version or fallback CLI. */
export const codexExecutionNativeFiles = Object.freeze([
  'tests/native/codex-reexecution.test.ts',
  'tests/native/codex-inline-provider.test.ts',
  'tests/native/relay-historical-owner.test.ts',
])
export const codexExecutionNativeCases = Object.freeze([
  'real Codex preserves one executor and exact frozen settings across one physically unsent replacement of an existing Session',
  'real Codex withholds a fresh unmaterialized Thread replacement after native resume rejection without a second executor or model call',
  'resolves a thread-local provider without writing the original owned config',
  'keeps a live old owner and an orphaned native group occupied, then recovers only exact stored identity after actual process release without replay',
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
    'deletes an allocated zero-byte receipt via abort-allocated on pre-witness failure and rejects non-empty, mismatched, or junction paths',
    'notifies whenReleased() and frees working memory once after a tight close deadline converges late on Windows',
  ].map((title) => `Windows product OwnedProcessGroup ${title}`),
)
export const agyNativeFiles = Object.freeze(['tests/native/agy-native.test.ts'])
export const agyNativeCases = Object.freeze([
  'completes ACP initialize (clientInfo), zero-Turn session/new + session/load + session/close, and non-empty TrajectorySummary SQLite creation without model calls',
  'verifies production AgyAgentAdapter zero-Turn Rebuild seed and cold-load verification receipt (negative and positive)',
  'prepares and executes an execution_id-closed SQLite Fork boundary with cold session/load verification and post-cut exclusion',
  'enforces explicit PACT_E2E_AGY_AUTH_DIR isolation without reading host HOME and rejects unsafe Windows .cmd paths',
])

export function nativeProfileSupports(profile, platform = process.platform, arch = process.arch) {
  if (profile.name === 'legacy') return true
  if (profile.name === 'execution-codex') return platform === 'darwin' && arch === 'arm64'
  if (profile.name === 'windows-owner')
    return platform === 'win32' && ['x64', 'arm64'].includes(arch)
  if (profile.name === 'agy')
    return ['darwin', 'win32', 'linux'].includes(platform) && ['x64', 'arm64'].includes(arch)
  return false
}

/** CLI setup does not admit the macOS process-group evidence inventory on Windows. */
export function nativeProfileSetupSupports(
  profile,
  platform = process.platform,
  arch = process.arch,
) {
  return (
    nativeProfileSupports(profile, platform, arch) ||
    (profile.name === 'execution-codex' && platform === 'win32' && ['x64', 'arm64'].includes(arch))
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
  if (name === 'execution-codex')
    return {
      name,
      command: 'test:native:execution',
      codexVersion: '0.163.0',
      directory: 'pact-codex-execution-cli',
      files: codexExecutionNativeFiles,
      cases: codexExecutionNativeCases,
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
  if (name === 'agy')
    return {
      name,
      command: 'test:native:agy',
      codexVersion: null,
      claudeVersion: null,
      directory: 'pact-agy-native-cli',
      files: agyNativeFiles,
      cases: agyNativeCases,
    }
  throw new Error('Unknown fixed native profile')
}
