import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process'
import type { Socket } from 'node:net'

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import type {
  AgentNativeContextRebuildInput,
  AgentNativeContextRebuildResult,
  AgentNativeInitializedBindingProbeInput,
  AgentNativeTitleInput,
} from '../../packages/agent-runtime/src/index.js'
import type {
  NativeContextRebuildChunk,
  NativeProbeResult,
} from '../../packages/contracts/src/index.js'

import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import {
  writeWindowsObservedLauncher,
  type WindowsLaunchOwner,
} from '../e2e/windows-cli-launcher.js'

export const desktopRoot = resolve(import.meta.dirname, '../../apps/desktop')
const desktopRequire = createRequire(join(desktopRoot, 'package.json'))
export const hash = (text: string | Buffer): string =>
  createHash('sha256').update(text).digest('hex')

type HelperDiagnostic = {
  stage: 'canonicalize' | 'identity' | 'remove'
  canonicalMatches: boolean | null
  errno: 'EACCES' | 'EPERM' | 'ENOENT' | 'ENOTDIR' | 'ENOTEMPTY' | 'EBUSY' | 'EIO' | 'EINVAL' | null
}
const groupFailureMessages = new Map([
  ['The owned process did not establish its owned group.', 'initial-identity'],
  ['The owned group lost its verified process identity.', 'lost-anchor'],
  ['The owned group identity changed.', 'identity-changed'],
  ['Process group identities could not be checked.', 'observation-failed'],
  ['Process group observation exceeded its limit.', 'observation-overflow'],
  ['Process group observation was invalid.', 'observation-invalid'],
  ['Process group identity was invalid.', 'row-invalid'],
  ['Process group ownership exceeded its identity limit.', 'identity-capacity'],
  ['Process group release could not be confirmed.', 'release-unconfirmed'],
  ['The owned owned group could not be stopped.', 'signal-failed'],
  ['The owned process scope did not release before its deadline.', 'release-deadline'],
  ['Process input cleanup did not settle.', 'input-unsettled'],
])
const execFileAsync = promisify(execFile)

/** Fixture process ownership; production Adapter interfaces and policies remain unchanged. */
export class NativeProcessOwner {
  readonly group: OwnedProcessGroup
  private child: ChildProcessWithoutNullStreams | undefined
  private closed: Promise<void> | undefined
  private closeTask: Promise<void> | undefined
  private recheckTask: Promise<void> | undefined
  private firstCloseSettled = false
  private firstCloseRejected = false
  private childClosed = false
  private controlClosed = false
  private helperReleased = false
  private jobEmpty = false
  private helperDiagnostic: HelperDiagnostic | undefined
  private groupFailure: string | undefined

  private constructor(
    readonly command: string,
    readonly deadlineAt: number,
    private readonly windows: WindowsLaunchOwner | undefined,
    group?: OwnedProcessGroup,
  ) {
    this.group = group ?? new OwnedProcessGroup()
  }

  static async prepare(
    command: string,
    root: string,
    deadlineAt: number,
    group?: OwnedProcessGroup,
  ): Promise<NativeProcessOwner> {
    const remaining = Math.floor(deadlineAt - performance.now())
    if (remaining <= 0 || remaining > 50_000) throw new Error('Native fixture deadline is invalid')
    const windows =
      process.platform === 'win32'
        ? await writeWindowsObservedLauncher(root, command, remaining)
        : undefined
    return new NativeProcessOwner(command, deadlineAt, windows, group)
  }

  start(args: readonly string[], options: SpawnOptions): ChildProcessWithoutNullStreams {
    if (this.child || this.closeTask || performance.now() >= this.deadlineAt)
      throw new Error('Owned native process admission is obsolete')
    this.windows?.armStartup(Math.min(this.deadlineAt, performance.now() + 10_000))
    if (options.cwd !== undefined && typeof options.cwd !== 'string')
      throw new Error('Native fixture requires its exact string working directory')
    if (options.shell !== undefined && options.shell !== false)
      throw new Error('Native fixture cannot use a shell')
    if (
      options.stdio !== undefined &&
      options.stdio !== 'pipe' &&
      (!Array.isArray(options.stdio) ||
        options.stdio.length !== 3 ||
        options.stdio.some((entry) => entry !== 'pipe'))
    )
      throw new Error('Native fixture requires three owned protocol pipes')
    const child = this.group.spawn(this.windows?.executablePath ?? this.command, [...args], {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      windowsHide: options.windowsHide,
    })
    this.child = child
    this.closed = new Promise((done) => {
      child.once('close', () => {
        this.childClosed = true
        done()
        // The native root is genuinely closed. Settle its owner (including any
        // remaining owned descendants) while retaining uncertain cleanup facts.
        void this.close().catch(() => undefined)
      })
    })
    if (this.windows) {
      const cancel = this.windows.cancel.bind(this.windows)
      // Killing the Job helper would lose its authenticated empty receipt. Request
      // cancellation through its existing control owner and keep the helper alive.
      child.kill = () => {
        cancel()
        return true
      }
      void this.windows.empty.then(
        () => {
          this.jobEmpty = true
          return undefined
        },
        () => undefined,
      )
    }
    return child
  }

  started(): Promise<void> {
    return this.windows?.started.then(() => undefined) ?? Promise.resolve()
  }

  facts() {
    const admitted = Boolean(this.child)
    const physical =
      this.group.released && (!admitted || (this.childClosed && (!this.windows || this.jobEmpty)))
    return {
      admitted,
      childClosed: this.childClosed,
      groupReleased: this.group.released,
      windowsJobEmpty: this.windows ? (admitted ? this.jobEmpty : null) : null,
      controlClosed: !this.windows || this.controlClosed,
      helperReleased: !this.windows || this.helperReleased,
      released: physical && (!this.windows || (this.controlClosed && this.helperReleased)),
      ...(this.helperDiagnostic ? { helperDiagnostic: { ...this.helperDiagnostic } } : {}),
      ...(this.groupFailure ? { groupFailure: this.groupFailure } : {}),
    }
  }

  async failedGroupDiagnostic(): Promise<object | null> {
    if (!this.groupFailure || process.platform === 'win32') return null
    const input: unknown = Reflect.get(this.group, 'root')
    let witness: {
      pid: number
      ppid: number
      pgid: number
      started: string
      state: string
    } | null = null
    let rootFailure: string | null = null
    if (input instanceof Promise) {
      try {
        const value: unknown = await input
        if (value && typeof value === 'object') {
          const pid: unknown = Reflect.get(value, 'pid'),
            ppid: unknown = Reflect.get(value, 'ppid'),
            pgid: unknown = Reflect.get(value, 'pgid'),
            started: unknown = Reflect.get(value, 'started'),
            state: unknown = Reflect.get(value, 'state')
          if (
            typeof pid === 'number' &&
            typeof ppid === 'number' &&
            typeof pgid === 'number' &&
            typeof started === 'string' &&
            started.length <= 64 &&
            typeof state === 'string' &&
            state.length <= 16
          )
            witness = { pid, ppid, pgid, started, state }
        }
      } catch (error) {
        rootFailure =
          error instanceof Error
            ? (groupFailureMessages.get(error.message) ?? 'other')
            : 'non-error'
      }
    }
    let observed = false
    const members: Array<{ pid: number; ppid: number; pgid: number; state: string }> = []
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat='], {
        timeout: 2000,
        maxBuffer: 32 * 1024,
        shell: false,
      })
      for (const line of stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z+<>-]{1,16})\s*$/u.exec(line)
        if (!match) continue
        const pid = Number(match[1]),
          ppid = Number(match[2]),
          pgid = Number(match[3]),
          state = match[4]!
        if (pid === this.child?.pid || pgid === (witness?.pgid ?? this.child?.pid)) {
          if (members.length >= 256) throw new Error('Owned process diagnostic capacity exceeded')
          members.push({ pid, ppid, pgid, state })
        }
      }
      observed = true
    } catch {
      /* Missing observation stays missing rather than becoming empty proof. */
    }
    return {
      phase: 'failed-group',
      error: this.groupFailure,
      rootFailure,
      witness,
      childPid: this.child?.pid ?? null,
      childExitCode: this.child?.exitCode ?? null,
      childSignal: this.child?.signalCode ?? null,
      childClosed: this.childClosed,
      observed,
      members,
    }
  }

  close(options: { recheck?: boolean } = {}): Promise<void> {
    this.closeTask ??= Promise.resolve()
      .then(() => this.release())
      .then(
        () => {
          this.firstCloseSettled = true
          return undefined
        },
        (error: unknown) => {
          this.firstCloseSettled = true
          this.firstCloseRejected = true
          throw error
        },
      )
    if (options.recheck && this.firstCloseSettled && this.firstCloseRejected && !this.recheckTask) {
      // A genuine receipt from this original group/Job permits one explicit
      // completion of wrapper cleanup. Its original failure stays cached.
      this.recheckTask = Promise.resolve().then(() => {
        if (
          !this.group.released ||
          (this.child && (!this.childClosed || (this.windows && !this.jobEmpty)))
        )
          throw new Error('Owned native physical release remains unconfirmed')
        return this.release()
      })
    }
    return this.recheckTask ?? this.closeTask
  }

  private async release(): Promise<void> {
    let firstError: Error | undefined
    const attempt = async (work: () => Promise<void>): Promise<void> => {
      try {
        await work()
      } catch (error) {
        firstError ??= error instanceof Error ? error : new Error('Owned native cleanup failed')
      }
    }
    if (this.windows && this.child && !this.childClosed) this.child.stdin.end()
    await attempt(async () => {
      try {
        await this.group.close()
      } catch (error) {
        this.groupFailure =
          error instanceof Error
            ? (groupFailureMessages.get(error.message) ?? 'other')
            : 'non-error'
        throw error
      }
    })
    if (this.closed)
      await attempt(() => within(this.closed!, 1500, 'Owned helper child close deadline'))
    if (this.windows) {
      if (this.child && !this.jobEmpty) {
        this.windows.cancel()
        await attempt(async () => {
          await within(this.windows!.empty, 5000, 'Owned Windows Job release deadline')
          this.jobEmpty = true
        })
      }
      if (!this.controlClosed)
        await attempt(async () => {
          await this.windows!.disposeControl()
          this.controlClosed = true
        })
      // An unadmitted prepared helper owns no launched Job. Its control owner
      // still needs genuine disposal and canonical, guarded helper removal.
      if (
        !this.helperReleased &&
        this.group.released &&
        (!this.child || (this.childClosed && this.jobEmpty)) &&
        this.controlClosed
      ) {
        let stage: HelperDiagnostic['stage'] = 'canonicalize'
        let canonicalMatches: boolean | null = null
        try {
          canonicalMatches = (await realpath(this.windows.directory)) === this.windows.directory
          stage = 'identity'
          if (!canonicalMatches) throw new Error('Unsafe Windows RPC cleanup target')
          stage = 'remove'
          await rm(this.windows.directory, { recursive: true, force: true })
          this.helperReleased = true
        } catch (error) {
          const code: unknown =
            error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
          const allowed = [
            'EACCES',
            'EPERM',
            'ENOENT',
            'ENOTDIR',
            'ENOTEMPTY',
            'EBUSY',
            'EIO',
            'EINVAL',
          ] as const
          const errno = allowed.find((value) => value === code) ?? null
          this.helperDiagnostic = { stage, canonicalMatches, errno }
          console.info('[native cleanup helper]', JSON.stringify(this.helperDiagnostic))
          firstError ??= new Error('Owned Windows RPC launcher cleanup failed')
        }
      }
    }
    if (!this.facts().released)
      firstError ??= new Error('Owned native process cleanup is unconfirmed')
    if (firstError) throw firstError
  }
}

/** Each invocation owns one reserved ticket before any asynchronous preparation. */
export class NativeProcessSet {
  private readonly tickets: Array<{
    kind: 'factory' | 'rpc'
    phase: 'preparing' | 'prepared' | 'admitted' | 'failed'
    owner?: NativeProcessOwner
    preparation?: Promise<void>
  }> = []
  private readonly available: NativeProcessOwner[] = []
  private closing = false
  private closeTask: Promise<void> | undefined
  constructor(private readonly root: string) {}

  assertOpen(): void {
    if (this.closing) throw new Error('Native fixture process owner is closing')
  }

  private reserve(kind: 'factory' | 'rpc') {
    if (this.closing) throw new Error('Native fixture process owner is closing')
    const live = this.tickets.filter(
      (ticket) =>
        ticket.phase === 'preparing' ||
        ticket.phase === 'prepared' ||
        ticket.phase === 'failed' ||
        !ticket.owner?.facts().released,
    )
    if (
      this.tickets.length >= 64 ||
      live.length >= 8 ||
      (kind === 'factory' && live.filter((ticket) => ticket.kind === 'factory').length >= 4)
    )
      throw new Error('Native fixture owner capacity exceeded')
    const ticket: (typeof this.tickets)[number] = { kind, phase: 'preparing' }
    this.tickets.push(ticket)
    return ticket
  }

  private async prepareOwner(
    command: string,
    deadlineAt: number,
    kind: 'factory' | 'rpc',
    group?: OwnedProcessGroup,
  ) {
    const ticket = this.reserve(kind)
    const finished = Promise.withResolvers<void>()
    ticket.preparation = finished.promise
    try {
      const owner = await NativeProcessOwner.prepare(command, this.root, deadlineAt, group)
      ticket.owner = owner
      if (this.closing) {
        await owner.close()
        throw new Error('Native preparation ended after its owner began closing')
      }
      ticket.phase = 'prepared'
      return { ticket, owner }
    } catch (error) {
      ticket.phase = 'failed'
      throw error
    } finally {
      finished.resolve()
    }
  }

  async prepareRpcOwner(
    command: string,
    deadlineAt: number,
    group?: OwnedProcessGroup,
  ): Promise<NativeProcessOwner> {
    const { ticket, owner } = await this.prepareOwner(command, deadlineAt, 'rpc', group)
    if (this.closing) {
      await owner.close()
      throw new Error('Native fixture process owner is closing')
    }
    ticket.phase = 'admitted'
    return owner
  }

  get helperRoot(): string {
    return this.root
  }

  async prepare(command: string, count: number, deadlineAt: number): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 4)
      throw new Error('Native fixture process capacity exceeded')
    const needed = count - this.available.filter((owner) => owner.command === command).length
    if (this.available.length + needed > 4)
      throw new Error('Native fixture prepared capacity exceeded')
    for (let index = 0; index < needed; index++) {
      // oxlint-disable-next-line no-await-in-loop -- The synchronous SDK seam owns at most four prepared slots under the same fixture deadline.
      const { owner } = await this.prepareOwner(command, deadlineAt, 'factory')
      if (this.closing) {
        // oxlint-disable-next-line no-await-in-loop -- A late prepared owner must actually close before this bounded preparation loop exits.
        await owner.close()
        throw new Error('Native fixture process owner is closing')
      }
      this.available.push(owner)
    }
  }

  spawnOwned(command: string, args: readonly string[], options: SpawnOptions) {
    if (this.closing) throw new Error('Native fixture process owner is closing')
    const index = this.available.findIndex((owner) => owner.command === command)
    if (index < 0) throw new Error('Native fixture process was not prepared')
    const [owner] = this.available.splice(index, 1)
    const ticket = this.tickets.find((value) => value.owner === owner)
    if (!owner || !ticket) throw new Error('Native fixture owner ticket is unresolved')
    ticket.phase = 'admitted'
    return {
      child: owner.start(args, options),
      close: () => owner.close(),
      observe: () => owner.group.observe(),
    }
  }

  async spawnOwnedAsync(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
    deadlineAt: number,
  ) {
    const { ticket, owner } = await this.prepareOwner(command, deadlineAt, 'factory')
    if (this.closing) {
      await owner.close()
      throw new Error('Native fixture process owner is closing')
    }
    ticket.phase = 'admitted'
    return { child: owner.start(args, options), close: () => owner.close() }
  }

  spawn(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcessWithoutNullStreams {
    return this.spawnOwned(command, args, options).child
  }

  facts() {
    return this.tickets.map(
      (ticket) =>
        ticket.owner?.facts() ?? {
          admitted: false,
          childClosed: false,
          groupReleased: false,
          windowsJobEmpty: null,
          controlClosed: false,
          helperReleased: false,
          released: false,
          preparing: ticket.phase === 'preparing',
          preparationFailed: ticket.phase === 'failed',
        },
    )
  }

  async diagnostics(): Promise<Array<object | null>> {
    return Promise.all(
      this.tickets.flatMap((ticket) =>
        ticket.owner && !ticket.owner.facts().released
          ? [ticket.owner.failedGroupDiagnostic()]
          : [],
      ),
    )
  }

  close(): Promise<void> {
    this.closing = true
    this.closeTask ??= this.release()
    return this.closeTask
  }

  private async release(): Promise<void> {
    await Promise.allSettled(
      this.tickets.flatMap((ticket) => (ticket.preparation ? [ticket.preparation] : [])),
    )
    const results = await Promise.allSettled(
      this.tickets.flatMap((ticket) => (ticket.owner ? [ticket.owner.close()] : [])),
    )
    if (
      results.some((entry) => entry.status === 'rejected') ||
      this.facts().some((fact) => !fact.released)
    )
      throw new Error('Owned native factory cleanup is unconfirmed')
  }
}

export interface Boundary {
  nativeSessionId: string
  nativeTurnId: string
  nativeCutId: string
  bindingGeneration: number
  throughSequence: number
  deliveryCursor: number
  prefixHash: string
  prefixRecords: number
  prefixBytes: number
}
export interface Witness {
  version: string
  nativeSessionId: string
  sourceNativeSessionId: string
  sourceCutId: string
  sourcePrefixHash: string
  candidatePrefixHash: string
  idMap: Array<[string, string]>
  model: string | null
  effort: string | null
  permissionMode: string
  nativePath?: string
  initializedAt?: string
  initializedPrefixHash?: string
  initializedPrefixBytes?: number
  initializedPrefixRecords?: number
}
export interface ForkResult {
  nativeSessionId: string
  witness: Witness
}
export interface ForkInput {
  operationId: string
  sessionId: string
  cwd: string
  source: Boundary
  model: string | null
  effort: string | null
  permissionMode: 'native' | 'ask'
  nativeSessionId?: string
  witness?: Witness
  lastDispatchedPhase?: 'fork' | 'initialize'
  onDispatched: (executorId: string) => Promise<void>
  onCandidate: (id: string, witness: Witness) => Promise<void>
  reportNativeWork: (work: { executorId: string; state: string }) => void
}
export interface NativeAdapter {
  setNativeTitle?(
    input: AgentNativeTitleInput,
    signal: AbortSignal,
  ): Promise<'synchronized' | 'unavailable' | 'unknown_delivery'>
  rebuildNativeContext(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult>
  probeNativeStatus(
    input: AgentNativeInitializedBindingProbeInput,
    signal: AbortSignal,
  ): Promise<NativeProbeResult>
  prepareNativeFork(
    input: {
      cwd: string
      nativeSessionId: string
      nativeTurnId: string
      runId: string
      bindingGeneration: number
      throughSequence: number
      deliveryCursor: number
      responseHash: string
    },
    signal: AbortSignal,
  ): Promise<Boundary>
  forkNativeContext(input: ForkInput, signal: AbortSignal): Promise<ForkResult>
  initializeNativeFork(input: ForkInput, signal: AbortSignal): Promise<ForkResult>
  inspectNativeFork(
    input: ForkInput,
    signal: AbortSignal,
  ): Promise<{ kind: string; ready?: boolean; reason?: string; result?: ForkResult }>
  hasActiveBackgroundWork(): boolean
  dispose(): Promise<void>
}
export interface SdkQueryInput {
  prompt: unknown
  options: {
    model?: string
    effort?: string
    settings?: { env?: Record<string, string> }
    env?: NodeJS.ProcessEnv
    [key: string]: unknown
  }
}
interface AdapterBundle {
  ClaudeAgentAdapter: new (executable: string, dependencies: object) => NativeAdapter
  CodexAgentAdapter: new (
    executable: string,
    processFactory:
      | ((
          cwd: string,
        ) =>
          | ChildProcessWithoutNullStreams
          | { child: ChildProcessWithoutNullStreams; close: () => Promise<void> }
          | Promise<{ child: ChildProcessWithoutNullStreams; close: () => Promise<void> }>)
      | undefined,
    readOptions: { storageRoot: string },
  ) => NativeAdapter
}

// Actual production modules and their real Worker are built together, so a renamed
// Worker or unbundled dependency fails this gate as it would in the Electron build.
export async function buildAdapters(root: string): Promise<AdapterBundle> {
  const entry = join(root, 'native-adapters.ts')
  await writeFile(
    entry,
    `export {ClaudeAgentAdapter} from ${JSON.stringify(join(desktopRoot, 'src/utility/conversation/claude-agent-adapter.ts'))}; export {CodexAgentAdapter} from ${JSON.stringify(join(desktopRoot, 'src/utility/conversation/codex-agent-adapter.ts'))};`,
  )
  const configFile = join(root, 'native.config.mjs')
  await writeFile(
    configFile,
    `import {externalizeDepsPlugin} from ${JSON.stringify(pathToFileURL(desktopRequire.resolve('electron-vite')).href)}; export default {main:{plugins:[externalizeDepsPlugin({exclude:['@pact/contracts','@pact/agent-runtime']})],build:{outDir:${JSON.stringify(join(root, 'bundle'))},rollupOptions:{input:{'native-adapters':${JSON.stringify(entry)},'native-fork-worker':${JSON.stringify(join(desktopRoot, 'src/utility/conversation/native-fork-worker.ts'))}}}}}};`,
  )
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This is the installed, trusted build API rather than provider data.
  const { build } = desktopRequire('electron-vite') as {
    build: (options: object) => Promise<void>
  }
  await build({ root: desktopRoot, configFile, ignoreConfigWarning: true, logLevel: 'silent' })
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The entry above exports exactly these actual production classes.
  return desktopRequire(join(root, 'bundle/native-adapters.js')) as AdapterBundle
}

export function actualSdk(): {
  query: (input: SdkQueryInput) => unknown
  getSessionInfo: unknown
  getSessionMessages: (
    sessionId: string,
    options: {
      dir: string
      includeSystemMessages: true
      sessionStore: {
        load: (key: {
          projectKey: string
          sessionId: string
          subpath?: string
        }) => Promise<unknown[]>
        append: () => Promise<never>
      }
    },
  ) => Promise<unknown[]>
} {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The desktop package owns and pins this actual SDK dependency.
  return desktopRequire('@anthropic-ai/claude-agent-sdk') as ReturnType<typeof actualSdk>
}

export async function recordSdkVersion(): Promise<void> {
  const manifest: unknown = JSON.parse(
    await readFile(
      join(dirname(desktopRequire.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'),
      'utf8',
    ),
  )
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    typeof Reflect.get(manifest, 'version') !== 'string'
  )
    throw new Error('Actual Claude SDK package version is unavailable')
  console.info(`[native gate] Claude SDK: ${Reflect.get(manifest, 'version')}`)
}

export async function executable(
  agent: 'codex' | 'claude',
  owned: { root: string; cwd: string; home: string; processes: NativeProcessSet },
  setupDeadlineAt = performance.now() + 30_000,
): Promise<string> {
  const requested =
    process.env[`PACT_NATIVE_${agent.toUpperCase()}_EXECUTABLE`] ??
    (process.platform === 'win32' ? `${agent}.cmd` : agent)
  let path: string | undefined
  if (isAbsolute(requested) || requested.includes('/') || requested.includes('\\')) {
    try {
      path = await realpath(requested)
    } catch {
      throw new Error(`Required real ${agent} CLI is unavailable: ${requested}`)
    }
  } else {
    const directories = (process.env.PATH ?? '').split(delimiter)
    if (directories.length > 128) throw new Error('Native executable PATH exceeds 128 entries')
    // oxlint-disable no-await-in-loop -- Executable selection follows the real ordered PATH.
    for (const directory of directories) {
      try {
        const candidate = join(directory, requested)
        await access(candidate)
        path = await realpath(candidate)
        break
      } catch {
        /* Continue to the next actual PATH entry, never install a CLI. */
      }
    }
    // oxlint-enable no-await-in-loop
  }
  if (!path) throw new Error(`Required real ${agent} CLI is unavailable: ${requested}`)
  await owned.processes.prepare(path, 1, Math.min(setupDeadlineAt, performance.now() + 50_000))
  const deadlineAt = Math.min(setupDeadlineAt, performance.now() + 5000)
  let version: string
  let handle: ReturnType<NativeProcessSet['spawnOwned']> | undefined
  try {
    handle = owned.processes.spawnOwned(path, ['--version'], {
      cwd: owned.cwd,
      env: isolatedEnv(owned.root, owned.home),
      shell: false,
    })
    const child = handle.child
    version = await within(
      new Promise<string>((done, reject) => {
        const chunks: Buffer[] = []
        let stdoutBytes = 0,
          stderrBytes = 0
        child.stdout.on('data', (data: Buffer) => {
          stdoutBytes += data.length
          if (stdoutBytes > 8192) {
            child.kill()
            reject(new Error('Native version output exceeds 8 KiB'))
          } else chunks.push(data)
        })
        child.stderr.on('data', (data: Buffer) => {
          stderrBytes += data.length
          if (stderrBytes > 8192) {
            child.kill()
            reject(new Error('Native version error output exceeds 8 KiB'))
          }
        })
        child.once('error', () =>
          reject(new Error('Required native version command could not start')),
        )
        child.once('close', (code) => {
          if (code !== 0) reject(new Error('Required native version command failed'))
          else done(Buffer.concat(chunks).toString('utf8').trim())
        })
      }),
      Math.max(1, deadlineAt - performance.now()),
      'Native version deadline exceeded',
    )
  } finally {
    await handle?.close()
  }
  console.info(`[native gate] ${agent}: ${path}; ${version}`)
  if (!version.match(agent === 'codex' ? /^codex-cli \d+\./u : /^\d+\.\d+\.\d+ \(Claude Code\)/u))
    throw new Error(`Unexpected ${agent} CLI identity: ${version}`)
  return path
}

export async function ownedRoot(): Promise<{
  root: string
  cwd: string
  home: string
  processes: NativeProcessSet
}> {
  const root = await mkdtemp(join(tmpdir(), 'pact-native-gate-'))
  const cwd = join(root, 'project'),
    home = join(root, 'native')
  try {
    await mkdir(cwd)
    await mkdir(home)
    return { root, cwd, home, processes: new NativeProcessSet(root) }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export function isolatedEnv(root: string, home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: root,
    USERPROFILE: root,
    TMPDIR: tmpdir(),
    CODEX_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    TERM: 'dumb',
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    SystemDrive: process.env.SystemDrive,
    ComSpec: process.env.ComSpec,
    TEMP: root,
    TMP: root,
    // macOS system proxies can intercept reqwest even with no proxy variables inherited.
    // Only this fixture's loopback Provider bypasses a proxy; production configuration is unchanged.
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'pact',
    PACT_NATIVE_TOKEN: 'OWNED_LOOPBACK_ONLY',
    ANTHROPIC_API_KEY: 'OWNED_LOOPBACK_ONLY',
    ANTHROPIC_AUTH_TOKEN: 'OWNED_LOOPBACK_ONLY',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  }
}

export interface NativeThread {
  id: string
  name?: string | null
  path: string
  historyMode: string
  forkedFromId?: string
  status: { type: string }
  model: string
  reasoningEffort: string
}
interface RpcError {
  code: number
  message: string
}
export interface Reply<T> {
  result?: T
  error?: RpcError
}
interface Event {
  id?: number | string
  method?: string
  params?: {
    threadId?: string
    turn?: { id: string; status: string; error?: unknown }
  }
}
interface Pending {
  resolve: (reply: Reply<unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type CleanupStage = 'observe' | 'eof' | 'eof-grace' | 'group' | 'terminate' | 'kill' | 'close'
export interface NativeCleanupFacts {
  phase: 'open' | 'closing' | 'released' | 'released-with-errors' | 'unconfirmed'
  stages: Array<{
    stage: CleanupStage
    milliseconds: number
    errorClass: 'Error' | 'non-error' | null
  }>
  childExit: boolean
  childClosed: boolean
  closeSettled: boolean
  stdinEnded: boolean
  groupReleased: boolean
  pendingRequests: number
  lifetimeReleased: boolean
  released: boolean
  windowsJobEmpty: boolean | null
  helperReleased: boolean
  previousAttempt?: Omit<NativeCleanupFacts, 'previousAttempt'>
}

// All requests settle in 10s; no retries after unknown delivery. The only child
// killed on cleanup is this fixture's own child, never a Desktop/Pact process.
export class NativeRpc {
  readonly child: ChildProcessWithoutNullStreams
  readonly events: Event[] = []
  readonly methods: string[] = []
  readonly exited: Promise<void>
  private readonly closed: Promise<void>
  private readonly pending = new Map<number | string, Pending>()
  private buffer: Buffer = Buffer.alloc(0)
  private bytes = 0
  private next = 0
  private ended = false
  private fatal: Error | undefined
  private stderrBytes = 0
  private readonly deadline: ReturnType<typeof setTimeout>
  private closing: Promise<void> | undefined
  private closingRequested = false
  private childClosed = false
  private closeSettled = false
  private childExit = false
  private lifetimeReleased = false
  private released = false
  private cleanupPhase: NativeCleanupFacts['phase'] = 'open'
  private readonly cleanupStages: NativeCleanupFacts['stages'] = []
  private previousAttempt: Omit<NativeCleanupFacts, 'previousAttempt'> | undefined

  static async create(
    executablePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    options: {
      group?: OwnedProcessGroup | undefined
      onReleased?: () => void
      deadlineAt?: number
      processes?: NativeProcessSet
    } = {},
  ): Promise<NativeRpc> {
    const deadlineAt = Math.min(options.deadlineAt ?? Infinity, performance.now() + 50_000)
    const scope = options.processes
      ? await options.processes.prepareRpcOwner(executablePath, deadlineAt, options.group)
      : await NativeProcessOwner.prepare(
          executablePath,
          env['TEMP'] ?? cwd,
          deadlineAt,
          options.group,
        )
    try {
      options.processes?.assertOpen()
      return new NativeRpc(cwd, env, scope, options.onReleased)
    } catch (error) {
      await scope.close().catch(() => undefined)
      throw error
    }
  }

  private constructor(
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly scope: NativeProcessOwner,
    private readonly onReleased?: () => void,
  ) {
    this.child = scope.start(['app-server'], { cwd, env, shell: false, windowsHide: true })
    this.deadline = setTimeout(
      () => {
        this.fail(new Error('Owned Native RPC lifetime exceeded 50s'))
        this.child.kill('SIGTERM')
      },
      Math.max(1, scope.deadlineAt - performance.now()),
    )
    this.exited = new Promise((resolveExit) => {
      this.child.once('exit', () => {
        this.childExit = true
        this.ended = true
        this.fail(new Error('Owned native RPC exited'))
        resolveExit()
      })
      this.child.once('error', (error) => {
        this.ended = true
        this.fail(error)
        resolveExit()
      })
    })
    this.closed = new Promise((resolveClose) => {
      const finish = (): void => {
        clearTimeout(this.deadline)
        this.lifetimeReleased = true
        this.childClosed = true
        this.ended = true
        this.fail(new Error('Owned native RPC exited'))
        resolveClose()
      }
      this.child.once('close', () => {
        finish()
      })
    })
    this.child.stderr.on('data', (data: Buffer) => {
      this.stderrBytes += data.length
      if (this.stderrBytes > 64 * 1024) this.fail(new Error('Native stderr exceeds 64 KiB'))
    })
    this.child.stdin.on('error', (error) => this.fail(error))
    this.child.stdout.on('data', (data: Buffer) => {
      this.bytes += data.length
      if (this.bytes > 8 * 1024 * 1024) {
        this.fail(new Error('Native stream exceeds 8 MiB'))
        return
      }
      this.buffer = Buffer.concat([this.buffer, data])
      for (;;) {
        const newline = this.buffer.indexOf(10)
        if (newline < 0) {
          if (this.buffer.length > 1024 * 1024) this.fail(new Error('Native frame exceeds 1 MiB'))
          break
        }
        if (newline > 1024 * 1024) {
          this.fail(new Error('Native frame exceeds 1 MiB'))
          break
        }
        const line = this.buffer.subarray(0, newline)
        this.buffer = this.buffer.subarray(newline + 1)
        if (!line.length) continue
        try {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This bounded fixture parser observes the real CLI; assertions below verify protocol behavior.
          const event = JSON.parse(line.toString()) as Event & Reply<unknown>
          if (event.id != null && !event.method) {
            const pending = this.pending.get(event.id)
            if (pending) {
              clearTimeout(pending.timer)
              this.pending.delete(event.id)
              pending.resolve(event)
            }
          } else {
            if (this.events.length >= 512) throw new Error('Native event capacity exceeded')
            this.events.push(event)
            if (event.id != null) {
              this.child.stdin.write(
                `${JSON.stringify({ id: event.id, error: { code: -32601, message: 'Native fixture declines interactions' } })}\n`,
              )
              this.fail(new Error('Unexpected native interaction'))
            }
          }
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })
  }
  private fail(error: Error): void {
    this.fatal ??= error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
  request<T>(method: string, params: object): Promise<Reply<T>> {
    if (this.closingRequested) return Promise.reject(new Error('Owned Native RPC is closing'))
    if (this.fatal) return Promise.reject(this.fatal)
    if (this.pending.size >= 4 || this.methods.length >= 128)
      return Promise.reject(new Error('Native RPC admission bound exceeded'))
    const id = ++this.next
    this.methods.push(method)
    return new Promise<Reply<T>>((resolveReply, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new Error(`unknown_delivery: ${method} exceeded 10s`)
        this.fail(error)
        reject(error)
      }, 10_000)
      this.pending.set(id, {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The call site specifies the fixed-wire response whose fields its assertions inspect.
        resolve: (reply) => resolveReply(reply as Reply<T>),
        reject,
        timer,
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  async initialize(): Promise<void> {
    const request = this.request('initialize', {
      clientInfo: { name: 'pact', title: 'Pact Native Test', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    })
    const [reply] = await Promise.all([
      request,
      within(
        this.scope.started(),
        Math.min(10_000, Math.max(1, this.scope.deadlineAt - performance.now())),
        'Owned native startup deadline',
      ),
    ])
    result(reply)
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
  }
  async completed(threadId: string, turnId: string): Promise<void> {
    const deadline = Date.now() + 10_000
    // oxlint-disable no-await-in-loop -- Native completion and durable idle are sequential witnesses.
    while (Date.now() < deadline) {
      if (this.fatal) throw this.fatal
      const event = this.events.find(
        (value) =>
          value.method === 'turn/completed' &&
          value.params?.threadId === threadId &&
          value.params.turn?.id === turnId,
      )
      if (event) {
        if (event.params?.turn?.status !== 'completed' || event.params.turn.error != null)
          throw new Error('Native fixture Turn failed')
        const thread = result(
          await this.request<{ thread: NativeThread }>('thread/read', {
            threadId,
            includeTurns: false,
          }),
        ).thread
        if (thread.status.type !== 'idle') throw new Error('Native Turn is not idle')
        return
      }
      await pause(20)
    }
    // oxlint-enable no-await-in-loop
    throw new Error('unknown_delivery: Native Turn did not complete in 10s')
  }
  async endInputNaturally(): Promise<void> {
    if (this.closingRequested) throw new Error('Owned Native RPC is closing')
    await within(this.scope.group.observe(), 2000, 'Owned natural EOF observation deadline')
    this.child.stdin.end()
  }
  close(options: { recheck?: boolean } = {}): Promise<void> {
    this.closingRequested = true
    if (options.recheck && this.cleanupPhase === 'unconfirmed' && !this.previousAttempt) {
      this.previousAttempt = this.cleanupFacts()
      this.cleanupStages.length = 0
      this.closing = undefined
    }
    this.closing ??= Promise.resolve().then(() => this.release())
    return this.closing
  }
  /** Bounded lifecycle facts only: never retain protocol text, credentials or raw causes. */
  cleanupFacts(): NativeCleanupFacts {
    return {
      phase: this.cleanupPhase,
      stages: this.cleanupStages.map((stage) => ({ ...stage })),
      childExit: this.childExit,
      childClosed: this.childClosed,
      closeSettled: this.closeSettled,
      stdinEnded: this.child.stdin.writableEnded,
      groupReleased: this.scope.facts().groupReleased,
      pendingRequests: this.pending.size,
      lifetimeReleased: this.lifetimeReleased,
      released: this.released,
      windowsJobEmpty: this.scope.facts().windowsJobEmpty,
      helperReleased: this.scope.facts().helperReleased,
      ...(this.previousAttempt
        ? {
            previousAttempt: {
              ...this.previousAttempt,
              stages: this.previousAttempt.stages.map((stage) => ({ ...stage })),
            },
          }
        : {}),
    }
  }
  private async release(): Promise<void> {
    this.cleanupPhase = 'closing'
    clearTimeout(this.deadline)
    this.lifetimeReleased = true
    this.fail(new Error('Owned Native RPC is closing'))
    let firstError: Error | undefined
    const stage = async (
      name: CleanupStage,
      work: () => Promise<void>,
      required = true,
    ): Promise<void> => {
      const started = performance.now()
      let errorClass: 'Error' | 'non-error' | null = null
      try {
        await work()
      } catch (error) {
        errorClass = error instanceof Error ? 'Error' : 'non-error'
        if (required)
          firstError ??= error instanceof Error ? error : new Error('Owned Native cleanup failed')
      } finally {
        this.cleanupStages.push({
          stage: name,
          milliseconds: Math.ceil(performance.now() - started),
          errorClass,
        })
      }
    }
    if (!this.ended) {
      await stage('observe', async () => {
        await within(this.scope.group.observe(), 2000, 'Owned observation deadline')
      })
      await stage('eof', async () => {
        this.child.stdin.end()
      })
      await stage('eof-grace', () => within(this.exited, 1500, 'Owned EOF grace deadline'), false)
    }
    // A failed preliminary observation must not prevent the genuine owner from
    // independently proving release. All OS identity checks/signals remain there.
    await stage('group', () => this.scope.close({ recheck: Boolean(this.previousAttempt) }))
    await stage('close', async () => {
      await within(this.closed, 1500, 'Owned child close deadline')
      this.closeSettled = true
    })
    if (this.pending.size) firstError ??= new Error('Native requests leaked on cleanup')
    this.released =
      this.childClosed &&
      this.closeSettled &&
      this.pending.size === 0 &&
      this.scope.facts().released
    this.cleanupPhase = this.released
      ? firstError
        ? 'released-with-errors'
        : 'released'
      : 'unconfirmed'
    if (this.released) this.onReleased?.()
    if (!this.released) firstError ??= new Error('Owned Native physical release is unconfirmed')
    if (firstError) throw firstError
  }
}
export function result<T>(reply: Reply<T>): T {
  if (reply.error || reply.result === undefined)
    throw new Error(`Native RPC rejected: ${JSON.stringify(reply.error)}`)
  return reply.result
}
export const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolvePause) => setTimeout(resolvePause, milliseconds))

export async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class LoopbackProvider {
  readonly server: Server
  readonly requests: Array<{ path: string; method: string; inputHash: string }> = []
  readonly errors: Error[] = []
  private readonly sockets = new Set<Socket>()
  private bytes = 0
  url = ''
  constructor(private readonly replies: string[] = []) {
    this.server = createServer((request, response) => {
      void (async () => {
        try {
          const chunks: Buffer[] = []
          for await (const chunk of request) {
            this.bytes += chunk.length
            if (this.bytes > 2 * 1024 * 1024) throw new Error('Loopback input exceeds 2 MiB')
            chunks.push(chunk)
          }
          if (this.requests.length >= 16) throw new Error('Loopback request capacity exceeded')
          this.requests.push({
            path: request.url ?? '',
            method: request.method ?? '',
            inputHash: hash(Buffer.concat(chunks)),
          })
          // Claude startup's HEAD is permitted, but no Claude model POST is ever permitted.
          if (request.method === 'HEAD' && request.url === '/api/hello') {
            response.writeHead(503)
            response.end()
            return
          }
          const index = this.requests.filter((value) => value.method === 'POST').length
          const text = this.replies[index - 1]
          if (request.method !== 'POST' || request.url !== '/v1/responses' || text === undefined)
            throw new Error('Unexpected or excess loopback model request')
          const reasoning = {
            id: `native-reasoning-${index}`,
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: `NATIVE_SUMMARY_${index}` }],
            encrypted_content: `NATIVE_OPAQUE_${index}`,
          }
          const message = {
            id: `native-message-${index}`,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text, annotations: [] }],
          }
          const nativeResponse = {
            id: `native-response-${index}`,
            object: 'response',
            model: 'gpt-5.4',
            status: 'completed',
            output: [reasoning, message],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          }
          response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
          const event = (type: string, payload: object): void => {
            response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
          }
          event('response.created', {
            response: { ...nativeResponse, status: 'in_progress', output: [] },
          })
          event('response.output_item.added', {
            output_index: 0,
            item: { ...reasoning, summary: [] },
          })
          event('response.output_item.done', { output_index: 0, item: reasoning })
          event('response.output_item.added', {
            output_index: 1,
            item: { ...message, status: 'in_progress', content: [] },
          })
          event('response.content_part.added', {
            item_id: message.id,
            output_index: 1,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          })
          event('response.output_text.delta', {
            item_id: message.id,
            output_index: 1,
            content_index: 0,
            delta: text,
          })
          event('response.output_text.done', {
            item_id: message.id,
            output_index: 1,
            content_index: 0,
            text,
          })
          event('response.content_part.done', {
            item_id: message.id,
            output_index: 1,
            content_index: 0,
            part: message.content[0],
          })
          event('response.output_item.done', { output_index: 1, item: message })
          event('response.completed', { response: nativeResponse })
          response.end()
        } catch (error) {
          this.errors.push(error instanceof Error ? error : new Error(String(error)))
          if (!response.headersSent) response.writeHead(500)
          response.end()
        }
      })()
    })
    this.server.requestTimeout = 10_000
    this.server.headersTimeout = 10_000
    this.server.on('connection', (socket) => {
      if (this.sockets.size >= 8) {
        socket.destroy()
        return
      }
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
  }
  async start(): Promise<void> {
    await new Promise<void>((resolveListen, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Missing loopback address')
    this.url = `http://127.0.0.1:${address.port}`
  }
  async configureCodex(home: string): Promise<void> {
    await writeFile(
      join(home, 'config.toml'),
      `model = "gpt-5.4"\nmodel_provider = "pact_native_loopback"\nmodel_reasoning_effort = "high"\n[model_providers.pact_native_loopback]\nname = "Pact Native Loopback"\nbase_url = "${this.url}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nenv_key = "PACT_NATIVE_TOKEN"\nrequest_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 10000\n`,
    )
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()))
    if (this.sockets.size) await pause(20)
    if (this.sockets.size) throw new Error('Loopback sockets leaked on cleanup')
  }
}

async function attemptNativeCleanup(work: () => Promise<void>): Promise<boolean> {
  try {
    await work()
    return true
  } catch {
    return false
  }
}

export async function cleanupNativeFixture(
  owned: Awaited<ReturnType<typeof ownedRoot>>,
  {
    adapters = [],
    clients = [],
    provider,
  }: {
    adapters?: Array<Pick<NativeAdapter, 'dispose'>>
    clients?: NativeRpc[]
    provider?: LoopbackProvider
  } = {},
): Promise<void> {
  if (adapters.length > 8 || clients.length > 8)
    throw new Error('Native cleanup inventory exceeds its bound')
  const adaptersClosed: boolean[] = []
  for (const adapter of adapters) {
    // oxlint-disable-next-line no-await-in-loop -- Attempt each native writer even when a prior owner rejected disposal.
    adaptersClosed.push(await attemptNativeCleanup(() => adapter.dispose()))
  }
  const clientsClosed: boolean[] = []
  for (const client of clients) {
    // oxlint-disable-next-line no-await-in-loop -- A failed client must not prevent other admitted clients from attempting genuine closure.
    clientsClosed.push(await attemptNativeCleanup(() => client.close()))
  }
  const factoriesClosed = await attemptNativeCleanup(() => owned.processes.close())
  const providerClosed = !provider || (await attemptNativeCleanup(() => provider.close()))
  const clientFacts = clients.map((client) => client.cleanupFacts())
  const processFacts = owned.processes.facts()
  if (!factoriesClosed)
    console.info('[native failed-group]', JSON.stringify(await owned.processes.diagnostics()))
  const released =
    adaptersClosed.every(Boolean) &&
    clientsClosed.every(Boolean) &&
    factoriesClosed &&
    providerClosed &&
    clientFacts.every((facts) => facts.released) &&
    processFacts.every((facts) => facts.released)
  console.info(
    '[native before-delete]',
    JSON.stringify({
      adaptersClosed,
      clientsClosed,
      providerClosed,
      factoriesClosed,
      clients: clientFacts,
      processes: processFacts,
      released,
    }),
  )
  if (!released)
    throw new Error('Owned native fixture cleanup is unconfirmed; recovery data retained')
  try {
    await rm(owned.root, { recursive: true, force: true })
  } catch (error) {
    const code: unknown =
      error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
    const allowed = [
      'EACCES',
      'EPERM',
      'ENOENT',
      'ENOTDIR',
      'ENOTEMPTY',
      'EBUSY',
      'EIO',
      'EINVAL',
    ] as const
    console.info(
      '[native root-remove]',
      JSON.stringify({ stage: 'remove', errno: allowed.find((value) => value === code) ?? null }),
    )
    // oxlint-disable-next-line eslint/preserve-caught-error -- Only bounded allowlisted filesystem facts may escape; the raw cause can expose private paths.
    throw new Error('Owned native fixture directory removal failed; recovery data retained')
  }
}

export async function boundedNativeText(path: string, ownedStorageRoot: string): Promise<string> {
  const canonicalRoot = await realpath(ownedStorageRoot),
    canonicalPath = await realpath(path),
    withinRoot = relative(canonicalRoot, canonicalPath)
  if (
    !withinRoot ||
    isAbsolute(withinRoot) ||
    withinRoot === '..' ||
    withinRoot.startsWith(`..${sep}`)
  )
    throw new Error('Native fixture path is outside its owned storage root')
  const info = await stat(canonicalPath)
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('Native fixture exceeds 8 MiB')
  const text = await readFile(canonicalPath, 'utf8')
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Native fixture exceeds 8 MiB')
  return text
}
