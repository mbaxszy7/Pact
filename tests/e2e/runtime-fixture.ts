import { _electron as electron, test as baseTest, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { codexProcessEnvironment } from '../../apps/desktop/src/utility/conversation/codex-process-environment.js'
import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import { PactDatabase } from '../../packages/persistence/src/index.js'
import { readCiProviderConfiguration } from '../../scripts/ci.mjs'
import { NativeRpc, within } from '../native/native-harness.js'
import {
  writeNativeTransportFault,
  type NativeTransportFault,
  type NativeTransportFaultFiles,
} from './native-transport-fault.js'
import {
  loadProviderConfiguration,
  prepareProviderEnvironment,
  type ProviderConfiguration,
} from './provider-environment.js'
import {
  writeWindowsNodeLauncher,
  writeWindowsObservedLauncher,
  type WindowsLaunchOwner,
} from './windows-cli-launcher.js'
import { windowsFixtureRenameSource } from './windows-fixture-rename.js'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const desktopRoot = resolve(repositoryRoot, 'apps/desktop')
const migrationsFolder = resolve(repositoryRoot, 'packages/persistence/drizzle')
const requireFromDesktop = createRequire(resolve(desktopRoot, 'package.json'))

const ownedFixtures = new Set<() => Promise<void>>()
const creatingFixtures = new Map<
  Promise<void>,
  { dispose?: () => Promise<void>; cancel: () => void }
>()
let fixtureReservations = 0
let fixtureAdmissionClosed = false

/** Every imported journey gets teardown even when launch fails before its own try/finally. */
export const test = baseTest.extend<{ runtimeOwnership: void }>({
  runtimeOwnership: [
    async ({ browserName: _browserName }, use) => {
      fixtureAdmissionClosed = false
      try {
        await use()
      } finally {
        fixtureAdmissionClosed = true
        for (const pending of creatingFixtures.values()) pending.cancel()
        let creationFailed = false
        try {
          await within(
            Promise.all(creatingFixtures.keys()),
            30_000,
            'Fixture construction did not settle before teardown',
          )
        } catch {
          creationFailed = true
        }
        const pending = new Set([...creatingFixtures.values()].map((creation) => creation.dispose))
        const results = await Promise.allSettled(
          [...ownedFixtures].filter((dispose) => !pending.has(dispose)).map((dispose) => dispose()),
        )
        const failure = results.find((result) => result.status === 'rejected')
        if (creationFailed)
          // oxlint-disable-next-line eslint/no-unsafe-finally -- Report pending construction while still releasing independently settled fixtures.
          throw new Error(
            `Fixture construction did not settle before teardown${failure?.status === 'rejected' ? '; completed fixture cleanup also failed' : ''}`,
          )
        // oxlint-disable-next-line eslint/no-unsafe-finally -- Cleanup failure must fail the test rather than silently leak an owned process.
        if (failure?.status === 'rejected') throw failure.reason
      }
    },
    { auto: true },
  ],
})

type ProbeState = 'ready' | 'authentication_required' | 'cannot_verify' | 'startup_failed'

export interface RuntimeFixtureOptions {
  mode?: 'ui' | 'real' | 'deterministic'
  configuration?: ProviderConfiguration
  transportFault?: NativeTransportFault
  firstUse?: boolean
  sessionTitles?: boolean
  claude?: ProbeState
  codex?: ProbeState
  claudeConversation?:
    | 'complete'
    | 'failure_once'
    | 'fork_complete'
    | 'fork_settings_once'
    | 'collaboration'
  claudeResolvedModel?: string
  codexSkills?: Array<{
    name: string
    description: string
    path: string
    scope: string
    enabled: boolean
  }>
  codexAppServer?:
    | 'complete'
    | 'complete_title_silent'
    | 'lost_ack_recovered'
    | 'lost_ack_absent_then_retry'
    | 'retry_progress'
    | 'retry_inspection_silent'
    | 'shutdown_pending_delta'
    | 'background_stream'
    | 'controlled_stop'
    | 'handoff_echo'
    | 'context_limit'
    | 'native_context_recovery'
    | 'session_permission_scope'
    | 'fork_complete'
    | 'writer_rejected_once'
    | 'native_title'
    | 'collaboration'
}

export interface RuntimeFixture {
  mode: 'ui' | 'real' | 'deterministic'
  directory: string
  configurationFingerprint: string | null
  redactDiagnostic(text: string): string
  controlTransportFault(action: 'arm' | 'release' | 'cancel'): Promise<void>
  readTransportFacts(): Promise<TransportFacts[]>
  openCodexClient(originator?: 'pact' | 'Codex Desktop'): Promise<NativeRpc>
  runNativeCommand(
    agentId: 'claude' | 'codex',
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>
  readConfigurationModels(): { claude: string | null; codex: string | null }
  databaseFile: string
  claudeHome: string
  codexHome: string
  createProjectDirectory(name: string, git?: boolean): Promise<string>
  launch(extraEnvironment?: Record<string, string>): Promise<ElectronApplication>
  dispose(): Promise<void>
  readCodexFacts(): Promise<{
    fixtureError?: string
    methods: string[]
    modelStarts: string[]
    threadStarts: number
    permissionDecisions?: string[]
    skillInputs?: Array<Array<{ name: string; path: string }>>
    threads?: Record<string, { name?: string }>
  }>
  readClaudeFacts(): Promise<{
    fixtureError?: string
    count: number
    settingsReads?: number
    resumes?: string[]
    metadataReads?: number
  }>
}

export interface TransportFacts {
  relayPid: number
  actualChildPid: number | null
  actualExecutable: string
  actualVersion?: string
  appServer: boolean
  closed: boolean
  exitCode: number | null
  faultPhase: string
  forwardedTurns: number
  droppedAcks: number
  candidateNativeSessionId?: string
  evictedEntries: number
  entries: Array<{
    at: number
    kind: string
    method?: string
    event?: string
    nativeSessionId?: string
    successful?: boolean
  }>
}

async function readTransportFacts(files: NativeTransportFaultFiles): Promise<TransportFacts[]> {
  const names = (await readdir(files.factsPath)).filter((name) => /^\d+\.json$/u.test(name))
  if (names.length > 64) throw new Error('Transport fact invocation capacity exceeded')
  let bytes = 0
  const facts = await Promise.all(
    names.map(async (name) => {
      const path = join(files.factsPath, name)
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
        throw new Error('Unsafe transport fact file')
      bytes += stat.size
      if (bytes > 1024 * 1024) throw new Error('Transport fact byte capacity exceeded')
      const value: TransportFacts = JSON.parse(await readFile(path, 'utf8'))
      if (
        !Number.isSafeInteger(value.relayPid) ||
        typeof value.closed !== 'boolean' ||
        !Array.isArray(value.entries) ||
        value.entries.length > 512 ||
        !Number.isSafeInteger(value.forwardedTurns)
      )
        throw new Error(
          `Invalid transport fact record: ${JSON.stringify({ pidType: typeof value.relayPid, pidInteger: Number.isSafeInteger(value.relayPid), closedType: typeof value.closed, entriesArray: Array.isArray(value.entries), entriesCount: Array.isArray(value.entries) ? value.entries.length : null, turnsType: typeof value.forwardedTurns, turnsInteger: Number.isSafeInteger(value.forwardedTurns) })}`,
        )
      return value
    }),
  )
  return facts
}

/** Unpublished candidates are diagnostic evidence, never closure or protocol receipts. */
async function readUnpublishedTransportFacts(
  files: NativeTransportFaultFiles,
): Promise<Array<{ source: string; state: 'unpublished'; fact: unknown }>> {
  const names = (await readdir(files.factsPath)).filter((name) =>
    /^\d+\.json(?:\.tmp)?$/u.test(name),
  )
  if (new Set(names.map((name) => name.split('.')[0])).size > 64)
    throw new Error('Transport observation invocation capacity exceeded')
  let bytes = 0
  const unpublished: Array<{ source: string; state: 'unpublished'; fact: unknown }> = []
  for (const name of names) {
    const path = join(files.factsPath, name)
    // oxlint-disable-next-line no-await-in-loop -- Count the complete published/unpublished byte budget before cleanup.
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024)
      throw new Error('Unsafe transport observation file')
    bytes += info.size
    if (bytes > 1024 * 1024) throw new Error('Transport observation byte capacity exceeded')
    if (name.endsWith('.tmp')) {
      // oxlint-disable-next-line no-await-in-loop -- Processes are confirmed released; read each bounded candidate once.
      const raw = await readFile(path, 'utf8')
      if (Buffer.byteLength(raw) > 64 * 1024)
        throw new Error('Unpublished transport observation grew beyond its bound')
      const fact: unknown = JSON.parse(raw)
      unpublished.push({ source: name, state: 'unpublished', fact })
    }
  }
  return unpublished
}

function probeExitCode(state: ProbeState): number {
  if (state === 'ready') return 0
  if (state === 'authentication_required') return 1
  return 2
}

/** A continuous soak owns these files itself; this does not extend an E2E fixture's deadline. */
export async function prepareDeterministicSoakEnvironment(
  directory: string,
  sourceEnvironment: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof prepareProviderEnvironment>>> {
  const environment = await prepareProviderEnvironment(directory, undefined, sourceEnvironment)
  const appServer = await writeCodexAppServer(
    directory,
    'complete',
    [],
    false,
    join(directory, 'soak-native-terminals.jsonl'),
  )
  const [claudePath, codexPath] = await Promise.all([
    writeCli(directory, 'claude', 'ready'),
    writeCli(directory, 'codex', 'ready', appServer),
  ])
  return { ...environment, claudePath, codexPath }
}

async function writeCli(
  directory: string,
  agentId: 'claude' | 'codex',
  state: ProbeState,
  appServerPath?: string,
  sdkPath?: string,
): Promise<string> {
  if (agentId === 'claude' && sdkPath && process.platform === 'win32') {
    const entry = join(directory, 'claude-fixture-entry.mjs')
    await writeFile(
      entry,
      `const args=process.argv.slice(2);if(args[0]==='--version'){console.log('2.1.272 (Claude Code)');process.exit(${state === 'startup_failed' ? 2 : 0})}else if(args[0]==='auth'&&args[1]==='status')process.exit(${probeExitCode(state)});else await import(${JSON.stringify(pathToFileURL(sdkPath).href)});\n`,
      { flag: 'wx', mode: 0o600 },
    )
    return writeWindowsNodeLauncher(directory, 'claude-fixture', [entry])
  }
  const extension =
    sdkPath && agentId === 'claude' && process.platform !== 'win32'
      ? '.mjs'
      : process.platform === 'win32'
        ? '.cmd'
        : ''
  const executablePath = join(directory, `${agentId}-fixture${extension}`)
  const version = agentId === 'claude' ? '2.1.272 (Claude Code)' : 'codex-cli 0.146.0'
  const authCommand = agentId === 'claude' ? 'auth' : 'login'
  const versionExit = state === 'startup_failed' ? 2 : 0
  const authExit = probeExitCode(state)
  // UI/protocol fixtures model an older shell-only runtime. Real mode always
  // uses the configured executable and its actual capability inventory.
  const windowsFeatures =
    agentId === 'codex'
      ? 'if "%1"=="features" if "%2"=="list" (\r\n  echo shell_tool stable true\r\n  exit /b 0\r\n)\r\n'
      : ''
  const posixFeatures =
    agentId === 'codex'
      ? 'if [ "$1" = "features" ] && [ "$2" = "list" ]; then\n  echo shell_tool stable true\n  exit 0\nfi\n'
      : ''
  if (agentId === 'claude' && sdkPath && process.platform !== 'win32') {
    // SDK runs non-native executables through Node; use executable JavaScript,
    // not the shell shim used for readiness-only fixtures.
    await writeFile(
      executablePath,
      `#!${process.execPath}\nconst args = process.argv.slice(2)\nif (args[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(${versionExit}) }\nelse if (args[0] === '${authCommand}' && args[1] === 'status') process.exit(${authExit})\nelse import(${JSON.stringify(sdkPath)}).catch((error) => { console.error(error); process.exit(1) })\n`,
      { mode: 0o755 },
    )
    await chmod(executablePath, 0o755)
    return executablePath
  }
  const source =
    process.platform === 'win32'
      ? `@echo off\r\nif "%1"=="--version" (\r\n  echo ${version.replace(/[()]/gu, '^$&')}\r\n  exit /b ${versionExit}\r\n)\r\nif "%1"=="${authCommand}" if "%2"=="status" exit /b ${authExit}\r\n${windowsFeatures}${appServerPath ? `if "%1"=="app-server" goto app_server\r\n` : ''}${sdkPath ? `"${process.execPath}" "${sdkPath}" %*\r\nexit /b %errorlevel%\r\n` : 'exit /b 2\r\n'}${appServerPath ? `:app_server\r\n"${process.execPath}" "${appServerPath}"\r\nexit /b %errorlevel%\r\n` : ''}`
      : `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo '${version}'\n  exit ${versionExit}\nfi\nif [ "$1" = "${authCommand}" ] && [ "$2" = "status" ]; then\n  exit ${authExit}\nfi\n${posixFeatures}${appServerPath ? `if [ "$1" = "app-server" ]; then\n  exec '${process.execPath}' '${appServerPath}'\nfi\n` : ''}${sdkPath ? `exec '${process.execPath}' '${sdkPath}' "$@"\n` : 'exit 2\n'}`
  await writeFile(executablePath, source, { mode: 0o755 })
  if (process.platform !== 'win32') await chmod(executablePath, 0o755)
  return executablePath
}

function remainingStartupTime(deadline: number): number {
  const remaining = Math.ceil(deadline - performance.now())
  if (remaining <= 0) throw new Error('Windows launch exceeded its caller startup deadline')
  return remaining
}

function boundedCommand(
  executable: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  redact: (text: string) => string,
  deadline?: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const isWindowsCommand = process.platform === 'win32' && /\.cmd$/iu.test(executable)
    if (isWindowsCommand && [executable, ...args].some((value) => /[&|<>^%!"\r\n]/u.test(value)))
      throw new Error('Unsafe Windows native probe arguments')
    execFile(
      isWindowsCommand ? (env['COMSPEC'] ?? process.env.ComSpec ?? 'cmd.exe') : executable,
      isWindowsCommand
        ? ['/d', '/s', '/c', `""${executable}" ${args.map((arg) => `"${arg}"`).join(' ')}"`]
        : args,
      {
        cwd,
        env,
        timeout: deadline === undefined ? 15_000 : remainingStartupTime(deadline),
        maxBuffer: 64 * 1024,
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: isWindowsCommand,
      },
      (error, stdout, stderr) =>
        done({
          exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: redact(stdout),
          stderr: redact(stderr),
        }),
    )
  })
}

export async function createRuntimeFixture(
  options: RuntimeFixtureOptions = {},
): Promise<RuntimeFixture> {
  if (fixtureAdmissionClosed) throw new Error('Fixture admission is closed during teardown')
  if (fixtureReservations >= 8) throw new Error('A test owns at most eight fixtures')
  fixtureReservations++
  let reserved = true,
    registered = false,
    creationCancelled = false
  const releaseFixtureSlot = (): void => {
    if (reserved) {
      reserved = false
      fixtureReservations--
    }
  }
  let finishCreation!: () => void
  const creation = new Promise<void>((done) => {
    finishCreation = done
  })
  const construction: { dispose?: () => Promise<void>; cancel: () => void } = {
    cancel: () => {
      creationCancelled = true
    },
  }
  creatingFixtures.set(creation, construction)
  try {
    const mode =
      options.mode ??
      (options.codexAppServer || options.claudeConversation ? 'deterministic' : 'ui')
    if (options.transportFault && mode !== 'real')
      throw new Error('A native traffic fault requires a real CLI fixture')
    if (
      mode === 'real' &&
      (options.codexAppServer ||
        options.codexSkills ||
        options.claudeConversation ||
        options.claude ||
        options.codex)
    ) {
      throw new Error('A real E2E fixture cannot select synthetic CLI or protocol behavior.')
    }
    if (
      options.codexSkills &&
      (!options.codexAppServer ||
        options.codexSkills.length > 8 ||
        Buffer.byteLength(JSON.stringify(options.codexSkills)) > 32 * 1024)
    )
      throw new Error('Synthetic Skills require one bounded protocol fixture catalog.')
    // Missing credentials fail before creating an app, a CLI process or a Native Session.
    const configuration =
      mode === 'real'
        ? (options.configuration ??
          (process.env['PACT_E2E_PROVIDER_ENV_FILE']
            ? await readCiProviderConfiguration()
            : await loadProviderConfiguration()))
        : undefined
    if (creationCancelled) throw new Error('E2E fixture construction was cancelled')
    const directory = await mkdtemp(join(tmpdir(), 'pact-runtime-e2e-'))
    const databaseFile = join(directory, 'pact.sqlite')
    const apps = new Set<ElectronApplication>()
    const failedAppClosures = new Set<ElectronApplication>()
    const nativeClients = new Set<NativeRpc>()
    const launchOwners = new Set<WindowsLaunchOwner>()
    const unlaunchedOwners = new Set<WindowsLaunchOwner>()
    const commandLaunchOwners = new Set<WindowsLaunchOwner>()
    const releasingOwners = new Map<WindowsLaunchOwner, Promise<void>>()
    const preparingOwners = new Set<Promise<WindowsLaunchOwner>>()
    const pendingOperations = new Set<Promise<unknown>>()
    let launchingApp = false
    let lateAppCloseFailed = false
    let appOwner: WindowsLaunchOwner | undefined
    let releasedLaunches = 0
    let commandOwners = 0
    let launchCount = 0
    let disposed = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let environment: Awaited<ReturnType<typeof prepareProviderEnvironment>>
    let claudePath: string
    let codexPath: string
    let transport: NativeTransportFaultFiles | undefined
    let controlGeneration = 0
    const redact = (text: string): string => configuration?.redact(text) ?? text
    const releaseLaunch = (owner: WindowsLaunchOwner): Promise<void> => {
      if (!launchOwners.has(owner)) return Promise.resolve()
      const existing = releasingOwners.get(owner)
      if (existing) return existing
      const releasing = (async () => {
        let deadline: ReturnType<typeof setTimeout> | undefined
        try {
          if (!unlaunchedOwners.has(owner)) {
            const receipt = await Promise.race([
              owner.empty,
              new Promise<never>((_done, reject) => {
                deadline = setTimeout(
                  () => reject(new Error('Windows fixture Job release exceeded five seconds')),
                  5000,
                )
              }),
            ])
            if (receipt.generation !== owner.generation || receipt.active !== 0)
              throw new Error('Windows fixture Job release identity changed')
          }
          await owner.disposeControl()
          await rm(owner.directory, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 250,
          })
          launchOwners.delete(owner)
          if (!unlaunchedOwners.delete(owner)) releasedLaunches++
          if (commandLaunchOwners.delete(owner)) commandOwners--
        } catch (error) {
          owner.cancel()
          await owner.disposeControl()
          throw error
        } finally {
          clearTimeout(deadline)
        }
      })()
      releasingOwners.set(owner, releasing)
      void releasing.then(
        () => releasingOwners.delete(owner),
        () => undefined,
      )
      return releasing
    }
    const prepareLaunch = async (
      executable: string,
      lifetime: number,
      command = false,
    ): Promise<WindowsLaunchOwner> => {
      const preparation = writeWindowsObservedLauncher(directory, executable, lifetime).then(
        (owner) => {
          launchOwners.add(owner)
          unlaunchedOwners.add(owner)
          if (command) commandLaunchOwners.add(owner)
          return owner
        },
      )
      preparingOwners.add(preparation)
      try {
        return await preparation
      } finally {
        preparingOwners.delete(preparation)
      }
    }
    const trackOperation = <T>(start: () => Promise<T>): Promise<T> => {
      if (disposed) return Promise.reject(new Error('E2E fixture is disposed'))
      if (pendingOperations.size >= 3)
        return Promise.reject(new Error('Fixture operation capacity exceeded'))
      const operation = start()
      pendingOperations.add(operation)
      const settled = (): void => {
        pendingOperations.delete(operation)
      }
      void operation.then(settled, settled)
      return operation
    }
    let disposal: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      disposal ??= (async () => {
        disposed = true
        const windowsJobProof = process.platform === 'win32'
        clearTimeout(timeout)
        const failures: string[] = []
        if (windowsJobProof) {
          try {
            await within(
              Promise.allSettled(preparingOwners),
              15_000,
              'Windows launcher preparation did not settle',
            )
          } catch {
            failures.push('Windows launcher preparation did not settle')
          }
        }
        for (const client of nativeClients) {
          try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Release owned Native writers before disposing the next owner.
            await client.close()
            nativeClients.delete(client)
          } catch {
            failures.push(
              `Owned Native client did not close; lifecycle=${JSON.stringify(client.cleanupFacts())}`,
            )
          }
        }
        const attemptedApps = new Set<ElectronApplication>()
        for (const app of apps) {
          attemptedApps.add(app)
          if (failedAppClosures.has(app)) {
            failures.push('Electron did not acknowledge shutdown')
            appOwner?.cancel()
            continue
          }
          try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Each app shutdown must settle its Utility and native children first.
            await within(app.close(), 30_000, 'Electron shutdown did not settle')
            apps.delete(app)
          } catch {
            failedAppClosures.add(app)
            failures.push('Electron did not acknowledge shutdown')
            appOwner?.cancel()
          }
        }
        if (windowsJobProof) {
          for (const owner of launchOwners) owner.cancel()
        }
        try {
          await within(
            Promise.allSettled(pendingOperations),
            30_000,
            'Fixture operations did not settle',
          )
        } catch {
          failures.push('Fixture operations did not settle')
        }
        if (lateAppCloseFailed) failures.push('Late Electron launch did not acknowledge shutdown')
        for (const app of apps) {
          if (attemptedApps.has(app) || failedAppClosures.has(app)) continue
          try {
            // oxlint-disable-next-line no-await-in-loop -- A late launch is a new owner, never a retry of failed shutdown.
            await within(app.close(), 30_000, 'Late Electron shutdown did not settle')
            apps.delete(app)
          } catch {
            failedAppClosures.add(app)
            failures.push('Late Electron launch did not acknowledge shutdown')
          }
        }
        for (const owner of launchOwners) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- Each generation needs its own authenticated empty receipt.
            await releaseLaunch(owner)
          } catch (error) {
            failures.push(
              `Windows fixture Job did not confirm complete process release: ${redact(error instanceof Error ? error.message : 'unknown control failure').slice(0, 1000)}; control=${JSON.stringify(owner.diagnostic())}`,
            )
          }
        }
        let transportUnconfirmed = false
        if (transport) {
          if (windowsJobProof) {
            try {
              const facts = await readTransportFacts(transport)
              const incomplete = facts.filter((fact) => !fact.closed)
              const unpublished = await readUnpublishedTransportFacts(transport)
              if (!facts.length || incomplete.length || unpublished.length) {
                if (!releasedLaunches || launchOwners.size) {
                  transportUnconfirmed = true
                  failures.push('Actual Native transport child did not close before cleanup')
                } else {
                  const info = baseTest.info()
                  const path = info.outputPath(`incomplete-transport-${basename(directory)}.json`)
                  const evidence = redact(
                    JSON.stringify({
                      physicalRelease: 'authenticated-fixture-jobs-empty',
                      facts: incomplete,
                      unpublished,
                    }),
                  )
                  if (Buffer.byteLength(evidence) > 1024 * 1024)
                    throw new Error('Retained transport evidence exceeds one MiB')
                  await writeFile(path, evidence)
                  await info.attach('incomplete-transport-observations', {
                    path,
                    contentType: 'application/json',
                  })
                }
              }
            } catch {
              transportUnconfirmed = true
              failures.push('Actual Native transport closure facts could not be read or retained')
            }
          } else {
            const deadline = Date.now() + 5_000
            let closed = false
            try {
              do {
                // oxlint-disable-next-line no-await-in-loop -- Verify actual child closure before deleting its credential/storage directory.
                const facts = await readTransportFacts(transport)
                // oxlint-disable-next-line no-await-in-loop -- A partial publication is never a terminal receipt.
                const unpublished = await readUnpublishedTransportFacts(transport)
                closed =
                  facts.length > 0 && facts.every((fact) => fact.closed) && unpublished.length === 0
                if (!closed) {
                  // oxlint-disable-next-line no-await-in-loop -- The bounded relay owns TERM/KILL settlement; allow its next close event.
                  await new Promise<void>((done) => setTimeout(done, 100))
                }
              } while (!closed && Date.now() < deadline)
            } catch {
              failures.push('Actual Native transport closure facts could not be read')
            }
            if (!closed) {
              transportUnconfirmed = true
              failures.push('Actual Native transport child did not close before cleanup')
            }
          }
        }
        const releaseUnconfirmed =
          nativeClients.size > 0 ||
          apps.size > 0 ||
          launchOwners.size > 0 ||
          preparingOwners.size > 0 ||
          pendingOperations.size > 0 ||
          transportUnconfirmed
        try {
          await configuration?.assertSourceIntegrity()
        } catch {
          failures.push('An original provider configuration changed during the test')
        }
        if (releaseUnconfirmed)
          throw new Error(`${failures.join('; ')}; owned fixture retained at ${directory}`)
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
        ownedFixtures.delete(dispose)
        releaseFixtureSlot()
        if (failures.length) throw new Error(failures.join('; '))
      })()
      return disposal
    }
    ownedFixtures.add(dispose)
    construction.dispose = dispose
    registered = true
    try {
      if (creationCancelled) throw new Error('E2E fixture construction was cancelled')
      environment = await prepareProviderEnvironment(directory, configuration)
      if (creationCancelled) throw new Error('E2E fixture construction was cancelled')
      environment.env.NODE_ENV = 'test'
      environment.env.PACT_TEST_DB_FILE = databaseFile
      environment.env.PACT_E2E_ROOT = directory
      const codexAppServerPath = options.codexAppServer
        ? await writeCodexAppServer(
            directory,
            options.codexAppServer,
            options.codexSkills ?? [],
            options.sessionTitles,
          )
        : undefined
      const claudeSdkPath = options.claudeConversation
        ? await writeClaudeSdkFixture(
            directory,
            options.claudeConversation,
            options.claudeResolvedModel,
            options.sessionTitles,
          )
        : undefined
      if (mode === 'real') {
        claudePath = configuration!.claudePath
        codexPath = configuration!.codexPath
        if (options.transportFault) {
          transport = await writeNativeTransportFault(directory, codexPath, options.transportFault)
          codexPath = transport.executablePath
        }
      } else {
        ;[claudePath, codexPath] = await Promise.all([
          writeCli(directory, 'claude', options.claude ?? 'ready', undefined, claudeSdkPath),
          writeCli(directory, 'codex', options.codex ?? 'ready', codexAppServerPath),
        ])
      }
      const database = await PactDatabase.open({ filePath: databaseFile, migrationsFolder })
      try {
        database.runtimePreparationRepository.saveSelectedExecutablePath('claude', claudePath)
        database.runtimePreparationRepository.saveSelectedExecutablePath('codex', codexPath)
        if (options.firstUse !== true) {
          database.defaultSessionSettingsRepository.save({
            primaryAgentId: 'codex',
            agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
            maxDiscussionRounds: 6,
            runningMessagePolicy: 'immediate_safe_point',
            maxReviewCycles: 3,
            maxRepairAttempts: 3,
          })
        }
      } finally {
        database.close()
      }
      // An owner deadline limits leaked fixtures even if a caller never reaches its finally.
      timeout = setTimeout(() => {
        void dispose().catch(() => undefined)
      }, 15 * 60_000)
      timeout.unref()
      if (creationCancelled) throw new Error('E2E fixture construction was cancelled')
      return {
        mode,
        directory,
        databaseFile,
        claudeHome: environment.claudeHome,
        codexHome: environment.codexHome,
        configurationFingerprint: configuration?.configurationFingerprint ?? null,
        redactDiagnostic: redact,
        readTransportFacts: () => {
          if (!transport || disposed)
            throw new Error('No live transport instrumentation belongs to this fixture')
          return readTransportFacts(transport)
        },
        controlTransportFault: async (action) => {
          if (!transport || disposed)
            throw new Error('No live transport instrumentation belongs to this fixture')
          const path = transport.controlPath + '.next'
          await writeFile(
            path,
            JSON.stringify({
              armed: action === 'arm',
              action: action === 'arm' ? 'hold' : action,
              generation: ++controlGeneration,
            }),
            { mode: 0o600 },
          )
          await rename(path, transport.controlPath)
        },
        openCodexClient: (originator = 'pact') =>
          trackOperation(async () => {
            if (mode !== 'real' || disposed)
              throw new Error('Owned native clients require a live real fixture')
            if (nativeClients.size >= 2)
              throw new Error('A real fixture owns at most two auxiliary Native clients')
            const client = new NativeRpc(
              configuration!.codexPath,
              directory,
              {
                ...codexProcessEnvironment(undefined, environment.env),
                CODEX_INTERNAL_ORIGINATOR_OVERRIDE: originator,
              },
              new OwnedProcessGroup({ startupObservationMs: 2_000 }),
              () => nativeClients.delete(client),
            )
            nativeClients.add(client)
            await client.initialize()
            if (disposed) throw new Error('E2E fixture is disposed')
            return client
          }),
        readConfigurationModels: () => configuration?.models ?? { claude: null, codex: null },
        runNativeCommand: (agentId, args) =>
          trackOperation(async () => {
            if (disposed) throw new Error('E2E fixture is disposed')
            if (args.length > 16 || args.some((arg) => arg.length > 4096))
              throw new Error('Native probe arguments exceed their bound')
            const executable = agentId === 'claude' ? claudePath : codexPath
            if (process.platform === 'win32') {
              if (commandOwners >= 2 || launchCount >= 64)
                throw new Error('Windows command ownership capacity exceeded')
              commandOwners++
              launchCount++
              let owner: WindowsLaunchOwner | undefined
              try {
                owner = await prepareLaunch(executable, 15_000, true)
                if (disposed) {
                  await releaseLaunch(owner)
                  throw new Error('E2E fixture is disposed')
                }
                const deadline = performance.now() + 15_000
                owner.armStartup(deadline)
                unlaunchedOwners.delete(owner)
                const result = await boundedCommand(
                  owner.executablePath,
                  args,
                  directory,
                  environment.env,
                  redact,
                  deadline,
                )
                await releaseLaunch(owner)
                return result
              } finally {
                if (!owner) commandOwners--
              }
            }
            return boundedCommand(executable, args, directory, environment.env, redact)
          }),
        createProjectDirectory: (name, git = true) =>
          trackOperation(async () => {
            if (disposed) throw new Error('E2E fixture is disposed')
            const projectDirectory = resolve(directory, name)
            const local = relative(directory, projectDirectory)
            if (!local || local.startsWith('..') || isAbsolute(local))
              throw new Error('Project must belong to the fixture')
            await mkdir(projectDirectory, { recursive: true, mode: 0o700 })
            if (git) {
              const result = await boundedCommand(
                'git',
                ['init', '--quiet', projectDirectory],
                directory,
                environment.env,
                redact,
              )
              if (result.exitCode !== 0)
                throw new Error(`Owned Git initialization failed: ${result.stderr}`)
            }
            return await realpath(projectDirectory)
          }),
        launch: (extraEnvironment = {}) =>
          trackOperation(async () => {
            if (disposed) throw new Error('E2E fixture is disposed')
            if (apps.size > 0 || launchingApp)
              throw new Error('One fixture owns at most one live Electron app')
            launchingApp = true
            try {
              if (appOwner) {
                await releaseLaunch(appOwner)
                appOwner = undefined
              }
              const permitted = new Set([
                'PACT_TEST_APPEARANCE_WRITE_FAILURE',
                'PACT_TEST_DIRECTORY_READ_DELAY',
                'PACT_TEST_DIRECTORY_FAIL_ONCE',
                ...(mode !== 'real' ? ['PACT_TEST_RECOVERY_RUN_ID'] : []),
              ])
              for (const key of Object.keys(extraEnvironment)) {
                if (permitted.has(key)) continue
                if (!['CLAUDE_CONFIG_DIR', 'CODEX_HOME'].includes(key))
                  throw new Error('Test environment cannot override provider or isolation state')
                if (extraEnvironment[key] === environment.env[key]) continue
                // oxlint-disable-next-line eslint/no-await-in-loop -- Validate each alias before any app launches; both path reads run together.
                const aliases = await Promise.all([
                  realpath(extraEnvironment[key]!),
                  realpath(environment.env[key]!),
                ])
                if (aliases[0] !== aliases[1])
                  throw new Error('Test environment cannot change native storage roots')
              }
              // Test discovery imports this fixture without needing an Electron installation.
              const electronModule: unknown = requireFromDesktop('electron')
              if (typeof electronModule !== 'string')
                throw new TypeError('The Electron package did not return an executable path')
              const electronExecutable = electronModule
              if (process.platform === 'win32') {
                if (launchCount >= 64) throw new Error('Windows fixture launch capacity exceeded')
                launchCount++
                appOwner = await prepareLaunch(electronExecutable, 15 * 60_000)
              }
              const currentOwner = appOwner
              if (disposed) {
                if (currentOwner) await releaseLaunch(currentOwner)
                throw new Error('E2E fixture is disposed')
              }
              const startupDeadline = performance.now() + 30_000
              currentOwner?.armStartup(startupDeadline)
              if (currentOwner) unlaunchedOwners.delete(currentOwner)
              const app = await electron
                .launch({
                  executablePath: currentOwner?.executablePath ?? electronExecutable,
                  args: [resolve(desktopRoot, 'out/main/index.js')],
                  cwd: desktopRoot,
                  env: { ...environment.env, ...extraEnvironment },
                  timeout: currentOwner ? remainingStartupTime(startupDeadline) : 30_000,
                })
                .catch((error: unknown) => {
                  // Preserve sanitized launch and bounded control facts without a raw cause.
                  throw new Error(
                    redact(
                      `${error instanceof Error ? error.message : 'Electron launch failed'}${currentOwner ? `; job control=${JSON.stringify(currentOwner.diagnostic())}` : ''}`,
                    ),
                  )
                })
              apps.add(app)
              app.once('close', () => {
                apps.delete(app)
                failedAppClosures.delete(app)
              })
              try {
                if (disposed) throw new Error('E2E fixture is disposed')
                if (currentOwner) {
                  const receipt = await within(
                    currentOwner.started,
                    remainingStartupTime(startupDeadline),
                    'Windows Job start receipt exceeded caller deadline',
                  )
                  const identityRequest = app.evaluate(() => process.pid)
                  // Dispatch can itself cross the deadline; closing the app must still settle this request.
                  void identityRequest.catch(() => undefined)
                  const mainPid = await within(
                    identityRequest,
                    remainingStartupTime(startupDeadline),
                    'Electron Main identity exceeded caller deadline',
                  )
                  if (receipt.generation !== currentOwner.generation || receipt.pid !== mainPid)
                    throw new Error('Electron Main does not match its authenticated Job generation')
                }
                await app.firstWindow({ timeout: 15_000 })
                const paths = await app.evaluate(({ app: runningApp }) => ({
                  userData: runningApp.getPath('userData'),
                  sessionData: runningApp.getPath('sessionData'),
                  temp: runningApp.getPath('temp'),
                }))
                for (const [actual, expected] of [
                  [paths.userData, environment.userDataDirectory],
                  [paths.sessionData, environment.sessionDataDirectory],
                  [paths.temp, environment.temporaryDirectory],
                ]) {
                  // macOS canonicalizes /var to /private/var; compare real paths below.
                  // oxlint-disable-next-line eslint/no-await-in-loop -- Each actual process path is validated before returning the app.
                  if ((await realpath(actual!)) !== (await realpath(expected!)))
                    throw new Error('Electron escaped its owned data profile')
                }
                await app.evaluate(({ BrowserWindow, screen }) => {
                  const secondary = screen
                    .getAllDisplays()
                    .find((display) => display.id !== screen.getPrimaryDisplay().id)
                  const window = BrowserWindow.getAllWindows()[0]
                  if (!secondary || !window) return
                  const bounds = window.getBounds(),
                    area = secondary.workArea
                  const width = Math.min(bounds.width, area.width),
                    height = Math.min(bounds.height, area.height)
                  window.setBounds({
                    width,
                    height,
                    x: area.x + Math.max(0, Math.floor((area.width - width) / 2)),
                    y: area.y + Math.max(0, Math.floor((area.height - height) / 2)),
                  })
                })
                return app
              } catch (error) {
                await app.close().catch(() => {
                  failedAppClosures.add(app)
                  if (disposed) lateAppCloseFailed = true
                })
                // oxlint-disable-next-line eslint/preserve-caught-error -- A raw nested launch error may contain credentials; expose only the sanitized message.
                throw new Error(
                  redact(error instanceof Error ? error.message : 'Isolated app launch failed'),
                )
              }
            } finally {
              launchingApp = false
            }
          }),
        dispose,
        readCodexFacts: async () => {
          if (mode === 'real')
            throw new Error('Synthetic protocol counters are not real CLI evidence')
          return JSON.parse(await readFile(join(directory, 'codex-app-server-state.json'), 'utf8'))
        },
        readClaudeFacts: async () => {
          if (mode === 'real')
            throw new Error('Synthetic protocol counters are not real CLI evidence')
          return JSON.parse(await readFile(join(directory, 'claude-sdk-state.json'), 'utf8'))
        },
      }
    } catch (error) {
      try {
        await dispose()
      } catch (cleanup) {
        // oxlint-disable-next-line eslint/preserve-caught-error -- Both messages are redacted; no raw credential-bearing cause escapes.
        throw new Error(
          redact(
            `${error instanceof Error ? error.message : 'Fixture creation failed'}; cleanup: ${cleanup instanceof Error ? cleanup.message : 'Unconfirmed fixture cleanup'}`,
          ),
        )
      }
      throw error
    }
  } finally {
    if (!registered) releaseFixtureSlot()
    creatingFixtures.delete(creation)
    finishCreation()
  }
}

/** Same bounded response semantics across the two synthetic provider transports. */
const collaborationFixtureScript = `
const fixturePrompt = prefix => {
  const line=prefix.split('\\n').findLast(line=>line.startsWith('{')&&line.includes('"version":"pact-agent-prompt-v1"'))
  if(!line)throw Error('Missing frozen fixture prompt')
  return JSON.parse(line)
}
const fixtureDelta = (todoId, expectedRevision, operation, fields={}) => ({
  todoId,expectedRevision,operation,kind:null,title:null,detail:null,recommendation:null,evidence:null,
  question:null,resolutionKind:null,mergeTargetId:null,reason:'Checked the frozen cancellation evidence.',userSourceIds:[],evidenceRefs:[],...fields
})
const collaborationReport = async (prefix, facts, transport) => {
  const context=fixturePrompt(prefix),reference=context.collaboration,auth=context.collaborationAuthorization
  if(!reference||!auth||!context.sourceGrant)throw Error('Missing frozen collaboration authorization')
  const read=request=>transport({...context.sourceGrant,...request})
  const index=async source=>(await read({source,taskId:auth.taskId,revision:auth.baseTodoRevision})).flatMap(page=>page.items)
  const todos=await index('todos'),required=await index('required_inputs')
  const task=typeof reference.task==='string'?reference.task:await read({document:reference.task})
  if(reference.plan?.id)await read({document:reference.plan})
  if(auth.reviewScopeRef)await read({document:auth.reviewScopeRef})
  const answers=new Map(),batches=new Map()
  for(const batchId of new Set(required.map(item=>item.batchId))) {
    const pages=await read({source:'batch',batchId})
    batches.set(batchId,pages.flatMap(page=>page.members))
    for(const page of pages)if(page.body)await read({document:page.body})
    for(const member of batches.get(batchId)) {
      const anchor=JSON.parse(await read({document:member.anchorDocument}))
      await read({document:member.body})
      if(anchor.type==='todo'&&anchor.question)answers.set(anchor.todoId,{anchor,commentId:member.commentId})
    }
  }
  const report={submission:auth.duty,outcome:'complete',summary:reference.stage+' inspected.',todoDeltas:[],inputResponses:required.map(item=>({batchId:item.batchId,memberId:item.memberId,disposition:'resolved',reason:'The authorized actor fully handled this frozen input.',todoId:null}))}
  for(const todo of todos) {
    const answer=answers.get(todo.id)
    if(todo.question&&todo.answerResolver===auth.actor&&answer&&answer.anchor.question.id===todo.question.id&&answer.anchor.question.revision===todo.question.revision) {
      report.todoDeltas.push(fixtureDelta(todo.id,todo.revision,'confirm',{resolutionKind:'resolved',reason:'Applied the user’s exact frozen answer to this question.',userSourceIds:[answer.commentId]}))
    } else if(!todo.question&&todo.status==='awaiting_review'&&['plan_review','code_review'].includes(auth.duty)) {
      report.todoDeltas.push(fixtureDelta(todo.id,todo.revision,'confirm',{resolutionKind:todo.resolutionKind??'resolved',reason:'Independently confirmed the submitted cancellation resolution.'}))
    } else if(!todo.question&&['stage_result','plan_submission'].includes(auth.duty)) {
      report.todoDeltas.push(fixtureDelta(todo.id,todo.revision,'propose_resolution',{resolutionKind:reference.stage==='respond'?'not_adopted':'resolved',reason:reference.stage==='respond'?'Checked the evidence; this suggestion is not needed.':'The authorized work now disposes the pending request.'}))
    }
  }
  const plan='1. Keep cancellation with its owner. 2. Verify Stop and restart. 3. Review the resulting code.'
  if(['plan_submission','plan_adoption'].includes(auth.duty))report.plan=auth.basePlanRef??plan
  if(auth.duty==='plan_review'||auth.duty==='plan_adoption') { report.reviewedPlan=auth.basePlanRef;report.verdict='accepted' }
  const bareBuild=['','/build','@claude /build','@codex /build'].includes(task.trim())
  if((auth.duty==='plan_submission'&&!auth.basePlanRef&&task.includes('unclear'))||(auth.duty==='stage_result'&&(reference.stage==='clarify'||(reference.stage==='implement'&&bareBuild))&&!todos.length)) {
    report.outcome='needs_user';report.summary='One scope decision is needed.'
    report.todoDeltas.push(fixtureDelta('scope',0,'create',{kind:'decision',title:'Choose the cancellation scope',detail:'The scope determines the implementation.',question:{id:'scope',revision:1,type:'choice',question:'Which cancellation scope should change?',reason:'The scope determines the implementation.',options:['Current request','All pending requests'],recommended:0,answerResolver:auth.duty==='plan_submission'?reference.primary:reference.implementer}}))
  }
  if(auth.duty==='code_review') {
    report.reviewScopeRef=auth.reviewScopeRef
    facts.reviewCount=(facts.reviewCount??0)+1
    report.verdict='accepted'
    if(facts.reviewCount===1&&!todos.some(todo=>todo.id==='cleanup')) {
      report.todoDeltas.push(fixtureDelta('cleanup',0,'create',{kind:'opinion',title:'Keep cancellation with its owner',detail:'The pending request needs explicit disposal.',recommendation:'Release the request when its owner stops.',evidence:'cancellation.ts:1'}))
      if(task.includes('Todo navigation')) {
        for(const [id,title] of [['navigation-second','Preserve the frozen source'],['navigation-third','Keep the clicked Todo aligned']])
          report.todoDeltas.push(fixtureDelta(id,0,'create',{kind:'opinion',title,detail:('The request owner preserves its exact source and releases pending work.\\n\\n').repeat(100),recommendation:'Keep navigation on this exact Todo version.',evidence:'Checked the frozen cancellation scope.'}))
      }
      report.verdict='changes_requested'
    }
  }
  const unresolved=todos.some(todo=>!report.todoDeltas.some(delta=>delta.todoId===todo.id&&delta.operation==='confirm'))||report.todoDeltas.some(delta=>delta.operation==='create')
  if(['plan_review','code_review','plan_adoption'].includes(auth.duty)&&unresolved)report.verdict='changes_requested'
  if(auth.duty==='code_review'&&!unresolved){report.verdict='accepted';report.summary='No unresolved feedback'}
  return report
}
const nativeReport = report => ({...report,plan:report.plan??null,reviewedPlan:report.reviewedPlan??null,reviewScopeRef:report.reviewScopeRef??null,verdict:report.verdict??null})
const readFixtureSource = async (request, call) => {
  let offset=0,text='',pages=[]
  for(let index=0;index<128;index++) {
    const result=await call({...request,offset}),page=JSON.parse(result.content[0].text)
    if(page.source!==(request.source??'document')||page.offset!==offset)throw Error('Frozen source page does not match the requested identity')
    if((request.source??'document')==='document')text+=page.text;else pages.push(JSON.parse(page.text))
    if(page.nextOffset===null)return (request.source??'document')==='document'?text:pages
    if(page.nextOffset<=offset)throw Error('Source did not advance')
    offset=page.nextOffset
  }
  throw Error('Fixture source page capacity exceeded')
}
`

/** Synthetic stream-json transport only; never loads real native settings, Hooks or a model. */
async function writeClaudeSdkFixture(
  directory: string,
  scenario: NonNullable<RuntimeFixtureOptions['claudeConversation']>,
  resolvedModel = 'custom-fixture-one[1m]',
  sessionTitles = false,
): Promise<string> {
  const path = join(directory, 'claude-sdk-fixture.mjs')
  const source = `import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
${collaborationFixtureScript}
const scenario = ${JSON.stringify(scenario)}
const sessionTitles = ${JSON.stringify(sessionTitles)}
const resolvedModel = ${JSON.stringify(resolvedModel)}
const forkScenario = scenario.startsWith('fork_')
const statePath = ${JSON.stringify(join(directory, 'claude-sdk-state.json'))}
const arg = (name) => { const equal = process.argv.find((value) => value.startsWith(name + '=')); if (equal) return equal.slice(name.length + 1); const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const fallbackSessionId = arg('--session-id') ?? arg('--resume') ?? randomUUID()
const permissionMode = arg('--permission-mode') ?? 'default'
let model = arg('--model') ?? 'opus'
let effort = arg('--effort') ?? 'high'
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const lines = createInterface({ input: process.stdin })
const inputIterator = lines[Symbol.asyncIterator]()
const facts = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { count: 0, reviewCount: 0 }
const persist = () => writeFileSync(statePath, JSON.stringify(facts))
process.once('uncaughtException',error=>{facts.fixtureError=String(error.message).slice(0,512);persist();process.stderr.write(facts.fixtureError+'\\n');process.exit(1)})
let collaborationPrefix = '', sdkServers = []
if (forkScenario && arg('--resume')) { (facts.resumes ??= []).push(fallbackSessionId); persist() }
const sdkSource = async request => {
  const own=sdkServers.find(name=>name.startsWith('pact_peer'))
  const call = async message => { const requestId=randomUUID();send({type:'control_request',request_id:requestId,request:{subtype:'mcp_message',server_name:own,message}});for(;;){const line=await inputIterator.next();if(line.done)throw Error('Source transport ended');const reply=JSON.parse(line.value);if(reply.type==='control_response'&&reply.response.request_id===requestId){const response=reply.response.response?.mcp_response;if(!response?.result)throw Error('Source MCP call failed');return response.result}if(reply.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:reply.request_id,response:{}}})} }
  if(!sdkSource.ready){await call({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'pact-fixture',version:'1'}}});await call({jsonrpc:'2.0',method:'notifications/initialized'});sdkSource.ready=true}
  return readFixtureSource(request,args=>call({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'read_collaboration_source',arguments:args}}))
}
for (;;) {
  const line=await inputIterator.next();if(line.done)break
  const message = JSON.parse(line.value)
  if (message.type === 'control_request') {
    if (message.request.subtype === 'initialize') { collaborationPrefix = message.request.appendSystemPrompt ?? ''; sdkServers = message.request.sdkMcpServers ?? [] }
    let response = { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: forkScenario ? [{ value: 'opus', displayName: resolvedModel, description: 'Synthetic alias', resolvedModel }] : [], account: {}, hooks_applied: true, current_permission_mode: permissionMode }
    if (forkScenario) {
      if (message.request.subtype === 'set_model') model = message.request.model
      if (message.request.subtype === 'apply_flag_settings') effort = message.request.settings.effortLevel ?? effort
      if (message.request.subtype === 'get_settings') {
        facts.settingsReads = (facts.settingsReads ?? 0) + 1; persist()
        response = { applied: { model: model === 'opus' ? resolvedModel : model, effort: scenario === 'fork_settings_once' && facts.settingsReads === 1 ? 'max' : effort } }
      }
    }
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response, pending_permission_requests: [], pending_user_dialog_requests: [] } })
  } else if (message.type === 'user') {
    const sessionId = message.session_id || fallbackSessionId
    send({ type: 'system', subtype: 'init', session_id: sessionId, uuid: randomUUID(), cwd: process.cwd(), tools: [], mcp_servers: [], model: 'claude-fixture', permissionMode, slash_commands: [], output_style: 'default', apiKeySource: 'none', claude_code_version: '2.1.272', skills: [], plugins: [] })
    // Native Skill metadata is a zero-query operation, not a Model Turn.
    if ((scenario === 'collaboration' || sessionTitles) && message.message?.content === 'Pact native Skill metadata.') {
      facts.metadataReads = (facts.metadataReads ?? 0) + 1; persist()
      send({ type: 'result', subtype: 'success', session_id: sessionId, uuid: randomUUID(), user_message_uuid: message.uuid, user_message_uuids: [message.uuid], result: '', is_error: false, duration_ms: 0, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [], stop_reason: 'end_turn' })
      continue
    }
    const count = facts.count + 1
    facts.count = count; writeFileSync(statePath, JSON.stringify(facts))
    await new Promise((resolve) => setTimeout(resolve, 1800))
    if (sessionTitles && JSON.stringify(message.message.content).includes('Pact Session metadata:')) {
      const own = sdkServers.find(name => name.startsWith('pact_peer'))
      const args = {title:'Title from the authorized Turn'}
      const metadataTool = 'mcp__'+own+'__publish_session_title'
      send({type:'assistant',session_id:sessionId,uuid:randomUUID(),parent_tool_use_id:'child',user_message_uuid:message.uuid,message:{id:randomUUID(),role:'assistant',type:'message',model:'claude-fixture',content:[{type:'tool_use',id:'child-title',name:metadataTool,input:{title:'Untrusted child title'}}],stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}})
      send({type:'user',session_id:sessionId,uuid:randomUUID(),parent_tool_use_id:'child',message:{role:'user',content:[{type:'tool_result',tool_use_id:'child-title',content:'Child result',is_error:false}]}})
      const callId = 'title-'+count
      send({type:'assistant',session_id:sessionId,uuid:randomUUID(),parent_tool_use_id:null,user_message_uuid:message.uuid,message:{id:randomUUID(),role:'assistant',type:'message',model:'claude-fixture',content:[{type:'tool_use',id:callId,name:metadataTool,input:args}],stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}})
      send({type:'user',session_id:sessionId,uuid:randomUUID(),parent_tool_use_id:null,message:{role:'user',content:[{type:'tool_result',tool_use_id:callId,content:'Title validated',is_error:false}]}})
    }
    let formalOutput
    if (scenario === 'collaboration' && arg('--json-schema')) {
      const content=typeof message.message.content==='string'?message.message.content:message.message.content.filter(item=>item.type==='text').map(item=>item.text).join('\\n')
      const report = await collaborationReport(collaborationPrefix+'\\n'+content, facts, sdkSource)
      formalOutput={version:JSON.parse(arg('--json-schema')).properties.version.const,answer:'Claude fixture response.',result:nativeReport(report)}
      persist()
    }
    const failed = scenario === 'failure_once' && count === 1
    if (!failed) send({ type: 'assistant', session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null, user_message_uuid: message.uuid, message: { id: randomUUID(), role: 'assistant', type: 'message', model: 'claude-fixture', content: [{ type: 'text', text: 'Claude fixture response.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
    send({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', session_id: sessionId, uuid: randomUUID(), user_message_uuid: message.uuid, user_message_uuids: [message.uuid], ...(formalOutput ? {structured_output:formalOutput} : {}), result: failed ? '' : 'Claude fixture response.', errors: failed ? ['Fixture context window exceeded'] : [], is_error: failed, duration_ms: 1, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [], stop_reason: 'end_turn' })
  }
}
`
  await writeFile(path, source)
  return path
}

async function writeCodexAppServer(
  directory: string,
  scenario: NonNullable<RuntimeFixtureOptions['codexAppServer']>,
  skills: NonNullable<RuntimeFixtureOptions['codexSkills']>,
  sessionTitles = false,
  soakTerminalFile?: string,
): Promise<string> {
  const path = join(directory, 'codex-app-server-fixture.mjs')
  const statePath = join(directory, 'codex-app-server-state.json')
  const persistSource =
    process.platform === 'win32'
      ? `${windowsFixtureRenameSource}\nconst persist = () => { const temporary = statePath + '.' + process.pid + '.tmp'; writeFileSync(temporary, JSON.stringify(state)); windowsFixtureRename(temporary, statePath) }`
      : "const persist = () => { const temporary = statePath + '.' + process.pid + '.tmp'; writeFileSync(temporary, JSON.stringify(state)); renameSync(temporary, statePath) }"
  const source = `import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

${collaborationFixtureScript}
const scenario = ${JSON.stringify(scenario)}
const sessionTitles = ${JSON.stringify(sessionTitles)}
const skills = ${JSON.stringify(skills)}
const statePath = ${JSON.stringify(statePath)}
const soakTerminalFile = ${JSON.stringify(soakTerminalFile ?? null)}
const lines = createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
state.reviewCount ??= 0; state.methods ??= []; state.modelStarts ??= []; state.threadStarts ??= 0; state.threads ??= {}; state.permissionDecisions ??= []; state.skillInputs ??= []
let approvalComplete
let pendingStop
${persistSource}
process.once('uncaughtException',error=>{state.fixtureError=String(error.message).slice(0,512);persist();process.stderr.write(state.fixtureError+'\\n');process.exit(1)})
const native = (id) => {
  if (state.threads[id]) return state.threads[id]
  const path = join(process.env.CODEX_HOME, 'sessions', createHash('sha256').update(id).digest('hex') + '.jsonl')
  const thread = { items: [], turns: [], config: {}, status: 'idle', path, model: 'gpt-fixture', reasoningEffort: 'medium' }
  state.threads[id] = thread
  writeFileSync(path, [
    { type: 'session_meta', payload: { id } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Synthetic native base instructions.' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\\nSynthetic fixture only.' }, { type: 'input_text', text: '<environment_context>Fixture directory</environment_context>' }] } },
  ].map((record) => JSON.stringify(record) + '\\n').join(''))
  return thread
}
const recovered = (threadId) => {
  const clientId = state.clientId ?? process.env.PACT_TEST_RECOVERY_RUN_ID
  if (scenario !== 'lost_ack_recovered' || !clientId || threadId !== 'fixture-thread') return undefined
  return { id: 'fixture-recovered-turn', status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1, error: null, items: [{ type: 'userMessage', id: 'fixture-recovered-user', clientId, content: [] }, { type: 'agentMessage', id: 'fixture-recovered-message', text: 'Recovered after lost ACK.' }] }
}
const page = (data, params) => {
  const ordered = params.sortDirection === 'desc' ? data.toReversed() : data
  const offset = Number(params.cursor ?? 0), count = params.limit ?? 25
  return { data: ordered.slice(offset, offset + count), nextCursor: offset + count < data.length ? String(offset + count) : null }
}
const threadView = (id) => { const row = native(id); return { id, name: row.name ?? null, path: row.path, status: { type: row.status }, model: row.model, reasoningEffort: row.reasoningEffort, ...(row.forkedFromId ? { forkedFromId: row.forkedFromId } : {}) } }

for await (const line of lines) {
  const request = JSON.parse(line)
  if (request.method) {
    if (state.methods.length >= 4096) throw new Error('Fixture request history budget exceeded.')
    state.methods.push(request.method); persist()
  }
  if (request.id === 'session-scope-approval' && !request.method) {
    if (state.permissionDecisions.length >= 8) throw new Error('Fixture permission response budget exceeded.')
    state.permissionDecisions.push(request.result?.decision ?? 'error'); persist()
    const finish = approvalComplete; approvalComplete = undefined
    finish?.()
  }
  else if (request.method === 'initialize') send({ id: request.id, result: {} })
  else if (request.method === 'turn/interrupt' && scenario === 'controlled_stop') {
    if (!pendingStop || pendingStop.threadId !== request.params.threadId || pendingStop.turnId !== request.params.turnId) throw new Error('Stop targeted a different fixture task')
    const stop = pendingStop; pendingStop = undefined
    clearTimeout(stop.timer)
    clearInterval(stop.stream)
    const thread = native(stop.threadId)
    thread.status = 'idle'
    thread.turns.push({id:stop.turnId,status:'interrupted',startedAt:1,completedAt:2,durationMs:1,error:null})
    thread.items.push({turnId:stop.turnId,item:{type:'agentMessage',id:'fixture-message',text:stop.text}})
    persist()
    send({id:request.id,result:{}})
    send({method:'turn/completed',params:{threadId:stop.threadId,turn:{id:stop.turnId,status:'interrupted'}}})
  }
  else if (request.method === 'model/list') send({ id: request.id, result: { data: [] } })
  else if (request.method === 'skills/list') send({ id: request.id, result: { data: [{ cwd: request.params.cwds?.[0] ?? process.cwd(), skills, errors: [] }] } })
  else if (request.method === 'config/read') send({ id: request.id, result: { config: { model: 'gpt-fixture', model_reasoning_effort: 'medium', approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'danger-full-access' } } })
  else if (request.method === 'thread/settings/update') {
    const params = request.params
    if (scenario === 'collaboration' && params.sandboxPolicy) native(params.threadId).policy = {approvalPolicy:params.approvalPolicy,approvalsReviewer:params.approvalsReviewer,sandbox:params.sandboxPolicy}
    if (params.model) native(params.threadId).model = params.model
    if (params.effort) native(params.threadId).reasoningEffort = params.effort
    persist()
    send({ id: request.id, result: {} })
    send({ method: 'thread/settings/updated', params: { threadId: params.threadId, threadSettings: { ...(params.model ? { model: params.model, effort: params.effort } : {}), approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer, sandboxPolicy: params.sandboxPolicy, ...(params.permissions ? { activePermissionProfile: { id: params.permissions } } : {}) } } })
  }
  else if (request.method === 'thread/read' && scenario === 'native_context_recovery') {
    if (state.threads[request.params.threadId]) send({ id: request.id, result: { thread: threadView(request.params.threadId) } })
    else send({ id: request.id, error: { code: -32001, message: 'Unknown thread: native session not found' } })
  } else if (request.method === 'thread/read' && scenario !== 'retry_inspection_silent' && scenario !== 'complete_title_silent') {
    send({ id: request.id, result: { thread: threadView(request.params.threadId) } })
  } else if (request.method === 'thread/name/set') {
    native(request.params.threadId).name = request.params.name; persist()
    send({ id: request.id, result: {} })
    send({ method: 'thread/name/updated', params: { threadId: request.params.threadId, threadName: request.params.name } })
  } else if (request.method === 'thread/fork' && scenario === 'fork_complete') {
    const sourceId = request.params.threadId, parent = native(sourceId)
    if (request.params.excludeTurns !== true || request.params.deferGoalContinuation !== true || !parent.turns.some((turn) => turn.id === request.params.lastTurnId && turn.status === 'completed')) throw new Error('Fork fixture requires an exact completed cutoff and a bounded, deferred native response.')
    const childId = 'fixture-fork-' + ((state.forks ??= 0) + 1); state.forks += 1
    const child = native(childId)
    child.forkedFromId = sourceId; child.model = request.params.model; child.reasoningEffort = request.params.config?.model_reasoning_effort ?? 'medium'
    child.items = structuredClone(parent.items); child.turns = structuredClone(parent.turns)
    let rows = readFileSync(parent.path, 'utf8').trim().split('\\n').map((line) => JSON.parse(line))
    const cutoff = rows.findIndex((record) => record.type === 'event_msg' && record.payload.type === 'task_complete' && record.payload.turn_id === request.params.lastTurnId)
    if (cutoff < 0) throw new Error('Fork fixture cutoff is absent from its owned rollout.')
    rows = rows.slice(0, cutoff + 1)
    rows[0] = { type: 'session_meta', payload: { id: childId, history_mode: 'legacy', forked_from_id: sourceId } }
    writeFileSync(child.path, rows.map((record) => JSON.stringify(record) + '\\n').join('')); persist()
    send({ id: request.id, result: { thread: threadView(childId), model: child.model, reasoningEffort: child.reasoningEffort, approvalPolicy: request.params.approvalPolicy ?? 'on-request', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } } })
  } else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    if (request.method === 'thread/resume' && request.params.excludeTurns !== true) throw new Error('Unbounded native resume fixture request.')
    if (scenario === 'writer_rejected_once' && request.method === 'thread/resume' && state.modelStarts.length === 1 && !state.writerRejected) {
      state.writerRejected = true; persist()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      send({ id: request.id, error: { code: -32600, message: 'thread ' + request.params.threadId + ' already has an active writer' } })
      continue
    }
    const threadId = request.method === 'thread/resume' ? request.params.threadId : scenario === 'native_context_recovery' ? 'rebuilt-thread' + (state.threadStarts ? '-' + state.threadStarts : '') : state.threadStarts || state.threads['fixture-thread'] ? 'fixture-thread-new-' + (state.threadStarts + 1) : 'fixture-thread'
    if (request.method === 'thread/start') state.threadStarts += 1
    native(threadId); persist()
    if (request.params.config) native(threadId).config = request.params.config
    send({ id: request.id, result: { thread: threadView(threadId), model: native(threadId).model, reasoningEffort: native(threadId).reasoningEffort, approvalPolicy: request.params.approvalPolicy ?? 'on-request', approvalsReviewer: request.params.approvalsReviewer ?? 'user', sandbox: { type: 'dangerFullAccess' }, ...(request.params.permissions ? { activePermissionProfile: { id: request.params.permissions } } : {}) } })
  } else if (request.method === 'thread/inject_items') {
    appendFileSync(native(request.params.threadId).path, request.params.items.map((payload) => JSON.stringify({ type: 'response_item', payload }) + '\\n').join('')); persist()
    send({ id: request.id, result: {} })
  } else if (request.method === 'thread/delete' && scenario === 'native_context_recovery') {
    send({ id: request.id, result: {} })
  } else if (request.method === 'turn/start') {
    const selectedSkills = request.params.input.filter((item) => item.type === 'skill').map(({name,path}) => ({name,path}))
    if (selectedSkills.length) {
      if (selectedSkills.length > 8 || state.skillInputs.length >= 8 || Buffer.byteLength(JSON.stringify(selectedSkills)) > 32 * 1024) throw new Error('Fixture Skill input capacity exceeded.')
      state.skillInputs.push(selectedSkills)
    }
    const threadId = request.params.threadId
    state.modelStarts.push(request.params.clientUserMessageId)
    const turnId = state.modelStarts.length === 1 ? 'fixture-turn' : 'fixture-turn-' + state.modelStarts.length
    native(threadId).status = 'active'; persist()
    if (scenario === 'lost_ack_recovered') {
      state.clientId = request.params.clientUserMessageId; native(threadId).status = 'idle'; persist()
      process.exit(1)
    } else if (scenario === 'lost_ack_absent_then_retry' && !state.attempts) {
      state.attempts = 1; native(threadId).status = 'notLoaded'; persist()
      process.exit(1)
    } else {
      send({ id: request.id, result: { turn: { id: turnId } } })
      // A cached app-server may deliver old notifications after the new ACK.
      send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'retired-turn', itemId: 'retired-output', delta: 'Retired output must never appear.' } })
      send({ method: 'turn/completed', params: { threadId, turn: { id: 'retired-turn', status: 'failed', error: 'temporary failure' } } })
      send({ method: 'error', params: { threadId, turnId: 'retired-turn', message: 'Retired failure' } })
      let text = scenario === 'lost_ack_absent_then_retry' ? 'New task after recovery.' : 'Bounded lifecycle response.'
      if (soakTerminalFile) text += '\\n\\n[soak.json](soak.json) · [soak.ts](soak.ts)'
      if (scenario === 'handoff_echo') {
        const prefix=request.params.input.filter(item=>item.type==='text').map(item=>item.text).join('\\n')
        const context=fixturePrompt(prefix)
        const own=Object.entries(native(threadId).config).find(([name])=>name.startsWith('mcp_servers.pact_peer'))?.[1]
        const readSource=document=>readFixtureSource({...context.sourceGrant,document},async args=>{
          if(!own||!context.sourceGrant)throw Error('Missing frozen handoff source reader')
          const rpc=await fetch(own.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_collaboration_source',arguments:args}}),signal:AbortSignal.timeout(5000)}).then(response=>response.json())
          if(!rpc.result)throw Error('Handoff source MCP failed')
          return rpc.result
        })
        let received=''
        for(const entry of context.handoffContext??[]) {
          const content=entry.document?await readSource(entry.document):entry.content
          received+=(received?' | ':'')+entry.speaker+':'+content
          if(Buffer.byteLength(received)>512*1024)throw Error('Synthetic handoff echo exceeds its output budget')
        }
        text='Handoff received: '+received
      }
      const complete = () => {
        native(threadId).status = 'idle'
        if (scenario === 'native_title' && !native(threadId).name) native(threadId).name = 'Native auto title'
        native(threadId).turns.push({ id: turnId, status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1, error: null })
        native(threadId).items.push({ turnId, item: { type: 'userMessage', id: 'fixture-user', clientId: request.params.clientUserMessageId, content: [] } }, { turnId, item: { type: 'agentMessage', id: 'fixture-message', text } }); persist()
        send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'fixture-message', text } } })
        if (soakTerminalFile) {
          if (state.modelStarts.length > 128) throw Error('Soak native Turn capacity exceeded')
          appendFileSync(soakTerminalFile, JSON.stringify({threadId,turnId,terminalAt:Date.now()})+'\\n', {mode:0o600})
        }
        send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
      }
      if (sessionTitles && request.params.input.some(item => item.type === 'text' && item.text.includes('Pact Session metadata:'))) {
        const key = Object.keys(native(threadId).config).find(key=>key.startsWith('mcp_servers.pact_peer'))
        const args = {title:'Title from the authorized Turn'}
        const rpc = await fetch(native(threadId).config[key].url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/call',params:{name:'publish_session_title',arguments:args}}),signal:AbortSignal.timeout(5000)}).then(response=>response.json())
        send({method:'item/completed',params:{threadId,turnId,item:{id:'title-'+turnId,type:'mcpToolCall',server:key.slice('mcp_servers.'.length),tool:'publish_session_title',arguments:args,result:rpc.result,error:null,status:'completed'}}})
      }
      if (scenario === 'collaboration' && request.params.outputSchema) {
        const prefix = request.params.input.filter(item=>item.type==='text').map(item=>item.text).join('\\n')
        const own=Object.entries(native(threadId).config).find(([name])=>name.startsWith('mcp_servers.pact_peer'))[1]
        const readSource=request=>readFixtureSource(request,async args=>{const rpc=await fetch(own.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_collaboration_source',arguments:args}}),signal:AbortSignal.timeout(5000)}).then(response=>response.json());if(!rpc.result)throw Error('Source MCP failed');return rpc.result})
        const report = await collaborationReport(prefix, state, readSource)
        text=JSON.stringify({version:request.params.outputSchema.properties.version.const,answer:'Bounded lifecycle response.',result:nativeReport(report)})
        persist();complete()
      } else if (scenario === 'session_permission_scope') {
        approvalComplete = complete
        send({ id: 'session-scope-approval', method: 'item/commandExecution/requestApproval', params: {
          threadId, turnId, itemId: 'scope-command', command: ['pnpm', 'test'], cwd: process.cwd(),
          availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['pnpm', 'test'] } }, { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'allow' } } }, 'acceptForSession', 'decline', 'cancel'],
        } })
      } else if (scenario === 'controlled_stop' && state.modelStarts.length === 1) {
        // One partial answer stays active until the actual Adapter's interrupt
        // request; model speed cannot close the UI's preparation window.
        const text = 'Controlled partial response remains visible.'
        const timer = setTimeout(()=>{state.fixtureError='Controlled Stop was not requested within 60 seconds';persist();process.exit(1)},60000)
        let chunks=0
        const stream=setInterval(()=>{
          const delta=' Stream '+(++chunks)+'.'
          pendingStop.text+=delta
          send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'fixture-message',delta}})
          if(chunks===120)clearInterval(stream)
        },100)
        pendingStop = {threadId,turnId,text,timer,stream}
        send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'fixture-message',delta:text}})
      } else if (scenario === 'background_stream') {
        send({ method: 'item/reasoning/summaryTextDelta', params: { threadId, turnId, itemId: 'fixture-reasoning', delta: 'Reviewing current request.' } })
        let part=0,body=''
        const timer=setInterval(()=>{
          const delta='Part '+(++part)+' saved. '
          body+=delta
          send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'fixture-message',delta}})
          if(part===60){
            clearInterval(timer)
            native(threadId).status='idle'
            native(threadId).turns.push({id:turnId,status:'completed',startedAt:1,completedAt:2,durationMs:1,error:null})
            const text=body+'\\n\\nBackground result complete.'
            native(threadId).items.push({turnId,item:{type:'userMessage',id:'fixture-user-'+turnId,clientId:request.params.clientUserMessageId,content:[]}},{turnId,item:{type:'agentMessage',id:'fixture-message',text}})
            persist()
            send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id:'fixture-message',text}}})
            send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}})
          }
        },80)
      } else if (scenario === 'shutdown_pending_delta') {
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'fixture-message', delta: 'Saved by the graceful shutdown flush.' } })
      } else if (scenario === 'retry_progress') {
        setTimeout(() => send({ method: 'item/reasoning/summaryTextDelta', params: { threadId, turnId, itemId: 'fixture-reasoning', delta: 'Reviewing the original request.' } }), 1_000)
        setTimeout(complete, 2_000)
      } else if (scenario === 'context_limit') {
        setTimeout(() => send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', error: 'context window exceeded' } } }), 1_000)
      } else complete()
    }
  } else if (request.method === 'thread/turns/list' && scenario !== 'retry_inspection_silent') {
    if (request.params.itemsView !== 'notLoaded') throw new Error('Native metadata fixture requested hydrated Turns.')
    const recoveredTurn = recovered(request.params.threadId)
    send({ id: request.id, result: page(recoveredTurn ? [recoveredTurn] : native(request.params.threadId).turns, request.params) })
  } else if (request.method === 'thread/items/list' && scenario !== 'retry_inspection_silent') {
    const recoveredTurn = recovered(request.params.threadId)
    const items = recoveredTurn ? recoveredTurn.items.map((item) => ({ turnId: recoveredTurn.id, item })) : native(request.params.threadId).items
    send({ id: request.id, result: page(items.filter((entry) => !request.params.turnId || entry.turnId === request.params.turnId), request.params) })
  }
  // thread/read intentionally remains unanswered only in the title- and Retry-inspection-silence fixtures.
}
clearTimeout(pendingStop?.timer)
clearInterval(pendingStop?.stream)
`
  await writeFile(path, source)
  return path
}
