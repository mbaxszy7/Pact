import type { Socket } from 'node:net'

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
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

import {
  removeWindowsRpcLauncherSync,
  writeWindowsRpcLauncher,
} from '../e2e/windows-cli-launcher.js'

export const desktopRoot = resolve(import.meta.dirname, '../../apps/desktop')
const desktopRequire = createRequire(join(desktopRoot, 'package.json'))
export const hash = (text: string | Buffer): string =>
  createHash('sha256').update(text).digest('hex')

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
    processFactory: ((cwd: string) => ChildProcessWithoutNullStreams) | undefined,
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
  owned: { root: string; cwd: string; home: string },
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
  const version = await new Promise<string>((resolveVersion, reject) => {
    execFile(
      path,
      ['--version'],
      { cwd: owned.cwd, env: isolatedEnv(owned.root, owned.home), timeout: 5000, maxBuffer: 8192 },
      (error, stdout) => {
        if (error) reject(new Error(`Required real ${agent} CLI is unavailable: ${error.message}`))
        else resolveVersion(stdout.trim())
      },
    )
  })
  console.info(`[native gate] ${agent}: ${path}; ${version}`)
  if (!version.match(agent === 'codex' ? /^codex-cli \d+\./u : /^\d+\.\d+\.\d+ \(Claude Code\)/u))
    throw new Error(`Unexpected ${agent} CLI identity: ${version}`)
  return path
}

export async function ownedRoot(): Promise<{ root: string; cwd: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pact-native-gate-'))
  const cwd = join(root, 'project'),
    home = join(root, 'native')
  try {
    await mkdir(cwd)
    await mkdir(home)
    return { root, cwd, home }
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
  private launcherCleanupError: Error | undefined
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

  constructor(
    executablePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly processGroup?: OwnedProcessGroup,
    private readonly onReleased?: () => void,
  ) {
    const isWindowsCommand = process.platform === 'win32' && /\.cmd$/iu.test(executablePath)
    if (isWindowsCommand && /[&|<>^%!"\r\n]/u.test(executablePath))
      throw new Error('Unsafe Windows executable path')
    const launcher =
      process.platform === 'win32'
        ? writeWindowsRpcLauncher(executablePath, env['TEMP'] ?? cwd)
        : undefined
    try {
      const options = {
        cwd,
        env,
        ...(launcher ? { windowsHide: true } : {}),
      }
      const target = launcher?.executable ?? executablePath
      this.child = processGroup
        ? processGroup.spawn(target, ['app-server'], options)
        : spawn(target, ['app-server'], {
            ...options,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
    } catch (error) {
      if (launcher) removeWindowsRpcLauncherSync(launcher.directory)
      throw error
    }
    this.deadline = setTimeout(() => {
      this.fail(new Error('Owned Native RPC lifetime exceeded 50s'))
      this.child.kill('SIGTERM')
    }, 50_000)
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
      const finish = async (): Promise<void> => {
        clearTimeout(this.deadline)
        this.lifetimeReleased = true
        this.childClosed = true
        this.ended = true
        this.fail(new Error('Owned native RPC exited'))
        if (launcher) {
          try {
            if ((await realpath(launcher.directory)) !== launcher.directory)
              throw new Error('Unsafe Windows RPC cleanup target')
            await rm(launcher.directory, {
              recursive: true,
              force: true,
              maxRetries: 3,
              retryDelay: 250,
            })
          } catch {
            this.launcherCleanupError = new Error('Owned Windows RPC launcher cleanup failed')
          }
        }
        resolveClose()
      }
      this.child.once('close', () => {
        void finish()
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
    result(
      await this.request('initialize', {
        clientInfo: { name: 'pact', title: 'Pact Native Test', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      }),
    )
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
  close(): Promise<void> {
    this.closingRequested = true
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
      groupReleased: this.processGroup?.released ?? this.childClosed,
      pendingRequests: this.pending.size,
      lifetimeReleased: this.lifetimeReleased,
      released: this.released,
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
        if (this.processGroup)
          await within(this.processGroup.observe(), 2000, 'Owned observation deadline')
      })
      await stage('eof', async () => {
        this.child.stdin.end()
      })
      await stage('eof-grace', () => within(this.exited, 1500, 'Owned EOF grace deadline'), false)
    }
    // A failed preliminary observation must not prevent the genuine owner from
    // independently proving release. All OS identity checks/signals remain there.
    if (this.processGroup) await stage('group', () => this.processGroup!.close())
    else {
      if (!this.ended)
        await stage(
          'terminate',
          async () => {
            this.child.kill('SIGTERM')
            await within(this.exited, 1500, 'Owned termination grace deadline')
          },
          false,
        )
      if (!this.ended)
        await stage('kill', async () => {
          this.child.kill('SIGKILL')
          await within(this.exited, 1500, 'Owned kill deadline')
        })
    }
    await stage('close', async () => {
      await within(this.closed, 1500, 'Owned child close deadline')
      this.closeSettled = true
    })
    firstError ??= this.launcherCleanupError
    if (this.pending.size) firstError ??= new Error('Native requests leaked on cleanup')
    this.released =
      this.childClosed &&
      this.closeSettled &&
      !this.launcherCleanupError &&
      this.pending.size === 0 &&
      (this.processGroup?.released ?? true)
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
