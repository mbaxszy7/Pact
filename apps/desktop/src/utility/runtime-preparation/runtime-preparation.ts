import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

import type {
  RpcResult,
  RuntimeAgentId,
  RuntimeAgentReadiness,
  RuntimeExecutablePathUpdate,
  RuntimePreparation as RuntimePreparationSnapshot,
} from '@pact/contracts'
import type { RuntimePreparationRepository } from '@pact/persistence'

import { RUNTIME_MINIMUM_VERSIONS } from '@pact/contracts'

import { recordDiagnostic } from '../../diagnostics/utility-log'
import { OwnedProcessGroup } from '../owned-process-group'
import {
  AgyProbeError,
  isAgyProbeSettled,
  isUnsafeWindowsCmdPath,
  reconcileSettledAgyProbeArtifact,
  removeDirConfirmed,
  resolveTrustedWindowsCmdExe,
  runAgyAcpProbe,
  type AgyAcpSessionContext,
  type UnconfirmedAgyProbeArtifact,
} from './agy-acp-probe'

const PROBE_TIMEOUT_MS = 4_000
const AGY_ACP_INIT_TIMEOUT_MS = 4_000
const AGY_ACP_SESSION_TIMEOUT_MS = 22_000
const AGY_ACP_EXTENDED_BUDGET_MS = 38_000
const AGY_ACP_EXTENDED_SESSION_TIMEOUT_MS = 32_000
const AGY_ACP_MAX_FRAME_BYTES = 256 * 1024
const AGY_ACP_MAX_TOTAL_BYTES = 2 * 1024 * 1024
const READINESS_RPC_BUDGET_MS = 27_500
const AGY_ACP_CLEANUP_RESERVE_MS = 4_500
const CLI_PROBE_CLEANUP_RESERVE_MS = 4_000
const READINESS_REPLY_MARGIN_MS = 500
const MAX_CAPTURE_BYTES = 64 * 1024
const INSTALLATION_DISCOVERY_MS = 1_000
const INSTALLATION_DISCOVERY_ENTRIES = 128
const INSTALLATION_DISCOVERY_BYTES = 64 * 1024
const SHELL_EXECUTION_MS = 2_000
const SHELL_TOTAL_MS = 3_000
const MAX_PATH_ENTRIES = 128
const MAX_ACTIVE_AGY_PROBES = 2
const MAX_UNCONFIRMED_AGY_PROBE_DIRS = 16
const MAX_ACTIVE_CLI_PROBES_PER_AGENT = 4
const CLI_READY_CACHE_TTL_MS = 30_000
const AGY_READY_CACHE_TTL_MS = 180_000
const AGY_TRANSIENT_TIMEOUT_GRACE_MS = 10 * 60 * 1000
const AGY_MAX_CONSECUTIVE_ABSORBED_TIMEOUTS = 1
const READY_CACHE_MAX_ENTRIES = 3
const READY_CACHE_MAX_BYTES = 16 * 1024

interface ExecutableFingerprint {
  readonly executablePath: string
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly ino: number
}

interface CachedReadyReadiness {
  readonly configKey: string
  readonly generation: number
  readonly selectedPath: string | undefined
  readonly fingerprint: ExecutableFingerprint
  readonly readiness: RuntimeAgentReadiness
  readonly cachedAt: number
  expiresAt: number
  readonly graceExpiresAt: number
  readonly bytes: number
  consecutiveTimeouts: number
}

interface AgentProbeOutcome {
  readonly raw: RuntimeAgentReadiness
  readonly gracefulReady?: RuntimeAgentReadiness
}

export interface AgyReadinessSessionHook {
  readonly onNotification?: (method: string, params: unknown) => void
  readonly inspectSession: (
    context: AgyAcpSessionContext,
    cliVersion: string | undefined,
  ) => Promise<void>
}

interface AttachedAgySessionHook {
  readonly hook: AgyReadinessSessionHook
  readonly signal?: AbortSignal | undefined
}

interface AgySessionHookDispatch {
  readonly useExtendedTimeout: boolean
  readonly onNotification: (method: string, params: unknown) => void
  readonly runHooks: (
    context: AgyAcpSessionContext,
    cliVersion: string | undefined,
  ) => Promise<void>
}

type FixedCliProbeCommand = 'version' | 'claude_auth' | 'codex_auth'
type FixedLookupCommand =
  | 'where_claude'
  | 'where_codex'
  | 'where_agy'
  | 'zsh_claude'
  | 'zsh_codex'
  | 'zsh_agy'

interface ProbeCommandResult {
  exitCode: number | null
  output: string
  timedOut: boolean
  failedToStart: boolean
  closeUnconfirmed?: boolean
}

interface InFlightAgentProbe {
  readonly generation: number
  readonly selectedPath: string | undefined
  readonly controller: AbortController
  readonly subscribers: Set<symbol>
  closing: boolean
  agyHooksStarted: boolean
  readonly agySessionHooks: Set<AttachedAgySessionHook>
  readonly promise: Promise<AgentProbeOutcome>
  readonly settled: Promise<void>
}

export function runtimeAgentDisplayName(agentId: RuntimeAgentId): string {
  if (agentId === 'claude') return 'Claude Code'
  if (agentId === 'codex') return 'Codex'
  return 'Antigravity'
}

function fixedCliProbeArgs(command: FixedCliProbeCommand): {
  readonly argv: readonly string[]
  readonly windowsCmdSuffix: string
} {
  if (command === 'version') return { argv: ['--version'], windowsCmdSuffix: '--version' }
  if (command === 'claude_auth')
    return { argv: ['auth', 'status'], windowsCmdSuffix: 'auth status' }
  return { argv: ['login', 'status'], windowsCmdSuffix: 'login status' }
}

function fixedLookupArgs(command: FixedLookupCommand): {
  readonly executable: string
  readonly argv: readonly string[]
} {
  if (command === 'where_claude') return { executable: 'where.exe', argv: ['claude'] }
  if (command === 'where_codex') return { executable: 'where.exe', argv: ['codex'] }
  if (command === 'where_agy') return { executable: 'where.exe', argv: ['agy'] }
  if (command === 'zsh_claude')
    return { executable: '/bin/zsh', argv: ['-lc', 'command -v claude'] }
  if (command === 'zsh_codex') return { executable: '/bin/zsh', argv: ['-lc', 'command -v codex'] }
  return { executable: '/bin/zsh', argv: ['-lc', 'command -v agy'] }
}

export class RuntimePreparation {
  private configurationGeneration = 0
  private environmentTask: Promise<void> | undefined
  private environmentOwner: OwnedProcessGroup | undefined
  private readonly environmentAbort = new AbortController()
  private readonly agyProbes = new Set<OwnedProcessGroup>()
  private readonly unconfirmedAgyProbes = new Map<OwnedProcessGroup, UnconfirmedAgyProbeArtifact>()
  private readonly inFlightAgentProbes = new Map<RuntimeAgentId, InFlightAgentProbe>()
  private readonly closingAgentProbes = new Set<Promise<void>>()
  private readonly pendingArtifactCleanupsByProvider = new Map<
    RuntimeAgentId,
    Set<Promise<unknown>>
  >([
    ['claude', new Set()],
    ['codex', new Set()],
    ['agy', new Set()],
  ])
  private readonly unconfirmedAgyProbeDirs = new Set<string>()
  private disposeFlushDeadlineAt: number | undefined
  private readonly cliProbes = new Map<RuntimeAgentId, Set<OwnedProcessGroup>>([
    ['claude', new Set()],
    ['codex', new Set()],
    ['agy', new Set()],
  ])
  private readonly unconfirmedCliProbes = new Map<RuntimeAgentId, Set<OwnedProcessGroup>>([
    ['claude', new Set()],
    ['codex', new Set()],
    ['agy', new Set()],
  ])
  private readonly readyCache = new Map<RuntimeAgentId, CachedReadyReadiness>()
  private readyCacheBytes = 0
  private lastAcpAgentInfoVersion: string | undefined
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly repository: RuntimePreparationRepository,
    private readonly options: { discoverShellPath?: boolean; env?: NodeJS.ProcessEnv } = {},
  ) {}

  static canCompleteOnboarding(preparation: Pick<RuntimePreparationSnapshot, 'agents'>): boolean {
    return preparation.agents.filter((agent) => agent.state === 'ready').length >= 2
  }

  static validateActivePairReadiness(
    preparation: Pick<RuntimePreparationSnapshot, 'agents'>,
    primaryAgentId: RuntimeAgentId,
    secondaryAgentId: RuntimeAgentId,
  ): { ok: true } | { ok: false; code: 'VALIDATION' | 'RUNTIME_UNAVAILABLE'; message: string } {
    if (primaryAgentId === secondaryAgentId) {
      return {
        ok: false,
        code: 'VALIDATION',
        message: 'Primary and secondary Agents must be different.',
      }
    }
    if (!RuntimePreparation.canCompleteOnboarding(preparation)) {
      return {
        ok: false,
        code: 'RUNTIME_UNAVAILABLE',
        message: 'At least two Agents must be ready before completing setup.',
      }
    }
    const byId = new Map(preparation.agents.map((agent) => [agent.agentId, agent]))
    if (
      byId.get(primaryAgentId)?.state !== 'ready' ||
      byId.get(secondaryAgentId)?.state !== 'ready'
    ) {
      return {
        ok: false,
        code: 'RUNTIME_UNAVAILABLE',
        message: 'Both selected Agents must be ready before saving.',
      }
    }
    return { ok: true }
  }

  readLastAcpAgentVersion(): string | undefined {
    return this.lastAcpAgentInfoVersion
  }

  /** One Utility-lifetime PATH snapshot; authentication and readiness are always checked afresh. */
  async prepareEnvironment(signal?: AbortSignal, deadlineAt?: number): Promise<void> {
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('Runtime preparation is shutting down.')
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      throw new Error('Runtime preparation deadline reached.')
    }
    if (!this.options.discoverShellPath || process.platform !== 'darwin') return
    this.environmentTask ??= this.resolveShellPath()
    if (!signal && deadlineAt === undefined) await this.environmentTask
    else {
      await RuntimePreparation.waitWithAbortAndDeadline(this.environmentTask, signal, deadlineAt)
    }
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('Runtime preparation is shutting down.')
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      throw new Error('Runtime preparation deadline reached.')
    }
  }

  private static async waitWithAbortAndDeadline(
    target: Promise<unknown>,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<void> {
    signal?.throwIfAborted()
    const waiters: Array<Promise<never>> = []
    let onAbort: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    if (signal) {
      waiters.push(
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        }),
      )
    }
    if (deadlineAt !== undefined) {
      const remainingMs = deadlineAt - Date.now()
      if (remainingMs <= 0) {
        if (onAbort && signal) signal.removeEventListener('abort', onAbort)
        throw new Error('Runtime preparation deadline reached.')
      }
      waiters.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Runtime preparation deadline reached.')),
            remainingMs,
          )
        }),
      )
    }
    try {
      await Promise.race([target, ...waiters])
    } finally {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
    }
  }

  private static async awaitAllWithinDeadline(
    promises: readonly Promise<unknown>[],
    flushDeadlineAt?: number,
  ): Promise<boolean> {
    if (promises.length === 0) return true
    const allSettled = Promise.allSettled(promises).then(() => true)
    if (flushDeadlineAt === undefined) {
      return await allSettled
    }
    const remainingMs = flushDeadlineAt - Date.now()
    if (remainingMs <= 0) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        allSettled,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), remainingMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  dispose(flushDeadlineAt?: number): Promise<void> {
    this.disposed = true
    this.disposeFlushDeadlineAt = flushDeadlineAt
    this.deleteReadyCache()
    const flightWaiters = new Set<Promise<void>>(this.closingAgentProbes)
    for (const entry of this.inFlightAgentProbes.values()) {
      entry.closing = true
      this.closingAgentProbes.add(entry.settled)
      flightWaiters.add(entry.settled)
      entry.controller.abort()
    }
    this.environmentAbort.abort()
    // The in-flight owner retains its original absolute cleanup deadline, including on Quit.
    this.disposal ??= (async () => {
      await this.environmentTask
      const gracefulDeadlineAt =
        flushDeadlineAt === undefined
          ? Date.now() + 2_000
          : Math.min(
              flushDeadlineAt,
              Date.now() + Math.max(0, Math.min(1_250, flushDeadlineAt - Date.now() - 1_250)),
            )
      await RuntimePreparation.awaitAllWithinDeadline([...flightWaiters], gracefulDeadlineAt)
      const allCliProbes: OwnedProcessGroup[] = []
      for (const set of this.cliProbes.values()) {
        allCliProbes.push(...set)
      }
      const closeResults = await Promise.allSettled([
        ...[...this.agyProbes].map((probe) => probe.close(flushDeadlineAt)),
        ...allCliProbes.map((probe) => probe.close(flushDeadlineAt)),
      ])
      const flightsSettled = await RuntimePreparation.awaitAllWithinDeadline(
        [...flightWaiters],
        flushDeadlineAt,
      )
      await this.reconcileUnconfirmedAgyProbes()
      await this.reconcileUnconfirmedAgyProbeDirs()
      const allArtifactCleanups: Array<Promise<unknown>> = []
      for (const set of this.pendingArtifactCleanupsByProvider.values()) {
        allArtifactCleanups.push(...set)
      }
      const artifactsSettled = await RuntimePreparation.awaitAllWithinDeadline(
        allArtifactCleanups,
        flushDeadlineAt,
      )
      await this.reconcileUnconfirmedAgyProbeDirs()
      const remainingArtifactCleanups = (['claude', 'codex', 'agy'] as const).some(
        (agentId) => (this.pendingArtifactCleanupsByProvider.get(agentId)?.size ?? 0) > 0,
      )
      for (const probe of this.agyProbes) {
        if (isAgyProbeSettled(probe)) this.agyProbes.delete(probe)
      }
      for (const agentId of ['claude', 'codex', 'agy'] as const) {
        this.pruneSettledCliProbes(agentId)
      }
      const hasRemainingCliProbes = (['claude', 'codex', 'agy'] as const).some(
        (agentId) =>
          (this.cliProbes.get(agentId)?.size ?? 0) > 0 ||
          (this.unconfirmedCliProbes.get(agentId)?.size ?? 0) > 0,
      )
      if (this.environmentOwner) throw new Error('The shell process was not released.')
      if (
        closeResults.some((result) => result.status === 'rejected') ||
        !flightsSettled ||
        !artifactsSettled ||
        this.inFlightAgentProbes.size > 0 ||
        this.closingAgentProbes.size > 0 ||
        remainingArtifactCleanups ||
        this.unconfirmedAgyProbeDirs.size > 0 ||
        this.agyProbes.size > 0 ||
        this.unconfirmedAgyProbes.size > 0 ||
        hasRemainingCliProbes
      ) {
        throw new Error('Runtime preparation probes were not released.')
      }
    })()
    return this.disposal
  }

  private async resolveShellPath(): Promise<void> {
    const deadline = Date.now() + SHELL_TOTAL_MS
    const executionDeadline = deadline - (SHELL_TOTAL_MS - SHELL_EXECUTION_MS)
    const inheritedPath = process.env.PATH ?? ''
    const marker = `\0PACT_PATH_${randomUUID()}\0`
    const output: Buffer[] = []
    let capturedBytes = 0
    let finished = false
    let resolveResult!: (value: string | undefined) => void
    const result = new Promise<string | undefined>((resolve) => {
      resolveResult = resolve
    })
    const settle = (value?: string): void => {
      if (finished) return
      finished = true
      resolveResult(value)
    }
    const stop = (): void => settle()
    const current = (): boolean => !finished && !this.disposed && Date.now() < executionDeadline
    const timer = setTimeout(stop, SHELL_EXECUTION_MS)
    const signal = this.environmentAbort.signal
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    // Startup output is untrusted and may contain secrets. Count both streams, retain only bounded
    // stdout in memory for the framed PATH, and never send either stream to diagnostics.
    const capture = (chunk: Buffer, stdout: boolean): void => {
      if (!current()) return stop()
      capturedBytes += chunk.length
      if (capturedBytes > MAX_CAPTURE_BYTES) return stop()
      if (stdout) output.push(chunk)
    }
    void (async () => {
      const home = await realpath(homedir())
      if (!current()) return stop()
      const environment = { ...process.env }
      delete environment.ZDOTDIR
      delete environment.PWD
      delete environment.OLDPWD
      const owner = new OwnedProcessGroup()
      this.environmentOwner = owner
      const child = owner.spawn(
        '/bin/zsh',
        [
          '-lic',
          // Keep the shell alive until its process-group identity has been observed. EOF makes
          // read return 1, so terminate explicitly with zero after clearing exit/history hooks.
          `unset HISTFILE; unsetopt RCS; builtin printf '\\0${marker.slice(1, -1)}\\0%s\\0' "$PATH"; builtin read -r _pact_path_ack; exit 0`,
        ],
        { cwd: home, env: environment },
      )
      child.stdout.on('data', (chunk: Buffer) => capture(chunk, true))
      child.stderr.on('data', (chunk: Buffer) => capture(chunk, false))
      child.once('error', stop)
      child.once('close', (code) => {
        if (!current() || code !== 0) return stop()
        const text = Buffer.concat(output).toString('utf8')
        const start = text.indexOf(marker)
        const end = text.indexOf('\0', start + marker.length)
        if (start < 0 || end < 0 || text.indexOf(marker, start + marker.length) >= 0) return stop()
        settle(text.slice(start + marker.length, end))
      })
      await owner.observe()
      if (!current()) return stop()
      child.stdin.end()
    })().catch(stop)

    let shellPath: string | undefined
    try {
      shellPath = await result
    } finally {
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      // Cleanup failure rejects the shared gate and retains this owner. No retry or partial PATH
      // can turn an unconfirmed shell exit into a successful runtime preparation.
      if (this.environmentOwner) {
        await this.environmentOwner.close(
          Math.min(deadline, Date.now() + SHELL_TOTAL_MS - SHELL_EXECUTION_MS),
        )
        this.environmentOwner = undefined
      }
    }
    if (shellPath === undefined || this.disposed || Date.now() >= deadline) return
    const paths = [inheritedPath ? inheritedPath.split(delimiter) : [], shellPath.split(delimiter)]
    if (
      paths.some(
        (entries) =>
          entries.length > MAX_PATH_ENTRIES || entries.some((entry) => !isAbsolute(entry)),
      )
    )
      return
    const merged = [...new Set(paths.flat())]
    const effectivePath = merged.join(delimiter)
    if (merged.length > MAX_PATH_ENTRIES || Buffer.byteLength(effectivePath) > MAX_CAPTURE_BYTES)
      return
    // Probes, model catalogs, recovery and native Agent children all inherit this same snapshot.
    process.env.PATH = effectivePath
  }

  private effectiveEnv(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env
  }

  catalogIdentity(workingDirectory?: string, activePairKey?: string): string {
    const env = this.effectiveEnv()
    return createHash('sha256')
      .update(
        JSON.stringify([
          workingDirectory,
          ...(activePairKey ? [activePairKey] : []),
          this.configurationGeneration,
          this.repository.readSelectedExecutablePath('claude'),
          this.repository.readSelectedExecutablePath('codex'),
          this.repository.readSelectedExecutablePath('agy'),
          env.PATH,
          env.LOCALAPPDATA,
          env.ANTIGRAVITY_GEMINI_DIR,
        ]),
      )
      .digest('hex')
  }

  providerConfigurationKey(agentId: RuntimeAgentId): string {
    const env = this.effectiveEnv()
    return createHash('sha256')
      .update(
        JSON.stringify([
          agentId,
          this.configurationGeneration,
          this.repository.readSelectedExecutablePath(agentId),
          env.PATH,
          env.LOCALAPPDATA,
          ...(agentId === 'agy' ? [env.ANTIGRAVITY_GEMINI_DIR] : []),
        ]),
      )
      .digest('hex')
  }

  private pruneSettledCliProbes(provider: RuntimeAgentId): void {
    const unconfirmedSet = this.unconfirmedCliProbes.get(provider)
    const activeSet = this.cliProbes.get(provider)
    if (unconfirmedSet) {
      for (const probe of unconfirmedSet) {
        if (isAgyProbeSettled(probe)) {
          unconfirmedSet.delete(probe)
          activeSet?.delete(probe)
        }
      }
    }
    if (activeSet) {
      for (const probe of activeSet) {
        if (isAgyProbeSettled(probe) && !unconfirmedSet?.has(probe)) {
          activeSet.delete(probe)
        }
      }
    }
  }

  hasClosingProbe(provider: RuntimeAgentId): boolean {
    return (
      this.inFlightAgentProbes.get(provider)?.closing === true ||
      (this.pendingArtifactCleanupsByProvider.get(provider)?.size ?? 0) > 0 ||
      this.unconfirmedProviderProbes(provider).length > 0
    )
  }

  unconfirmedProviderProbes(provider: RuntimeAgentId): readonly OwnedProcessGroup[] {
    this.pruneSettledCliProbes(provider)
    const unresolved: OwnedProcessGroup[] = [...(this.unconfirmedCliProbes.get(provider) ?? [])]
    if (provider === 'agy') {
      for (const probe of this.unconfirmedAgyProbes.keys()) {
        if (!isAgyProbeSettled(probe)) {
          unresolved.push(probe)
        }
      }
    }
    return unresolved
  }

  async findRecoveryExecutable(
    agentId: RuntimeAgentId,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    await this.prepareEnvironment(signal)
    signal.throwIfAborted()
    const selected = this.repository.readSelectedExecutablePath(agentId)
    // A read-only history check needs an executable, not auth/version subprocesses.
    const executable =
      selected && (await this.isExecutable(selected))
        ? selected
        : ((agentId === 'claude' ? await this.findWindowsDesktopClaude(signal) : undefined) ??
          (await this.findOnInheritedPath(agentId, 128)))
    signal.throwIfAborted()
    return executable
  }

  invalidateAgentReadiness(agentId?: RuntimeAgentId): void {
    this.deleteReadyCache(agentId)
  }

  private deleteReadyCache(agentId?: RuntimeAgentId): void {
    if (agentId !== undefined) {
      const existing = this.readyCache.get(agentId)
      if (!existing) return
      this.readyCacheBytes = Math.max(0, this.readyCacheBytes - existing.bytes)
      this.readyCache.delete(agentId)
      return
    }
    this.readyCache.clear()
    this.readyCacheBytes = 0
  }

  private hasUnconfirmedCleanup(agentId: RuntimeAgentId): boolean {
    return (
      this.unconfirmedProviderProbes(agentId).length > 0 ||
      (agentId === 'agy' &&
        (this.unconfirmedAgyProbes.size > 0 || this.unconfirmedAgyProbeDirs.size > 0))
    )
  }

  private async fingerprintExecutable(
    executablePath: string,
  ): Promise<ExecutableFingerprint | undefined> {
    if (!(await this.isExecutable(executablePath))) return undefined
    try {
      const info = await stat(executablePath)
      if (!info.isFile()) return undefined
      return {
        executablePath,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        ino: info.ino,
      }
    } catch {
      return undefined
    }
  }

  private static fingerprintsMatch(
    left: ExecutableFingerprint,
    right: ExecutableFingerprint,
  ): boolean {
    return (
      left.executablePath === right.executablePath &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs &&
      left.ino === right.ino
    )
  }

  private storeReadyCache(
    agentId: RuntimeAgentId,
    configKey: string,
    generation: number,
    selectedPath: string | undefined,
    fingerprint: ExecutableFingerprint,
    readiness: RuntimeAgentReadiness,
  ): void {
    this.deleteReadyCache(agentId)
    const now = Date.now()
    const ttlMs = agentId === 'agy' ? AGY_READY_CACHE_TTL_MS : CLI_READY_CACHE_TTL_MS
    const bytes =
      Buffer.byteLength(JSON.stringify(readiness), 'utf8') +
      Buffer.byteLength(fingerprint.executablePath, 'utf8') +
      Buffer.byteLength(configKey, 'utf8')
    if (bytes > READY_CACHE_MAX_BYTES) return
    while (
      this.readyCache.size >= READY_CACHE_MAX_ENTRIES ||
      this.readyCacheBytes + bytes > READY_CACHE_MAX_BYTES
    ) {
      const oldestKey = this.readyCache.keys().next().value
      if (!oldestKey) break
      this.deleteReadyCache(oldestKey)
    }
    if (
      this.readyCache.size >= READY_CACHE_MAX_ENTRIES ||
      this.readyCacheBytes + bytes > READY_CACHE_MAX_BYTES
    ) {
      return
    }
    this.readyCache.set(agentId, {
      configKey,
      generation,
      selectedPath,
      fingerprint,
      readiness,
      cachedAt: now,
      expiresAt: now + ttlMs,
      graceExpiresAt: now + AGY_TRANSIENT_TIMEOUT_GRACE_MS,
      bytes,
      consecutiveTimeouts: 0,
    })
    this.readyCacheBytes += bytes
  }

  private async lookupReadyCache(
    agentId: RuntimeAgentId,
    selectedPath: string | undefined,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<RuntimeAgentReadiness | undefined> {
    const cached = this.readyCache.get(agentId)
    if (!cached) return undefined
    const configKey = this.providerConfigurationKey(agentId)
    if (
      cached.generation !== this.configurationGeneration ||
      cached.selectedPath !== selectedPath ||
      cached.configKey !== configKey ||
      Date.now() >= cached.expiresAt
    ) {
      return undefined
    }
    const currentFingerprint = await this.fingerprintExecutable(cached.fingerprint.executablePath)
    signal?.throwIfAborted()
    if (this.disposed) {
      throw new Error('Runtime preparation is shutting down.')
    }
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      throw new Error('Runtime preparation deadline reached.')
    }
    if (
      this.readyCache.get(agentId) !== cached ||
      this.inFlightAgentProbes.has(agentId) ||
      this.hasUnconfirmedCleanup(agentId) ||
      cached.generation !== this.configurationGeneration ||
      this.providerConfigurationKey(agentId) !== configKey
    ) {
      return undefined
    }
    if (
      !currentFingerprint ||
      !RuntimePreparation.fingerprintsMatch(cached.fingerprint, currentFingerprint)
    ) {
      this.deleteReadyCache(agentId)
      return undefined
    }
    this.readyCache.delete(agentId)
    this.readyCache.set(agentId, cached)
    return { ...cached.readiness }
  }

  private async evaluateFlightOutcome(
    agentId: RuntimeAgentId,
    createdGeneration: number,
    createdSelectedPath: string | undefined,
    createdConfigKey: string,
    startedWithAgyHook: boolean,
    controller: AbortController,
    raw: RuntimeAgentReadiness,
  ): Promise<AgentProbeOutcome> {
    if (
      this.disposed ||
      controller.signal.aborted ||
      createdGeneration !== this.configurationGeneration ||
      this.providerConfigurationKey(agentId) !== createdConfigKey
    ) {
      return { raw }
    }
    if (
      raw.state === 'ready' &&
      raw.executablePath &&
      !startedWithAgyHook &&
      !this.hasUnconfirmedCleanup(agentId)
    ) {
      const fingerprint = await this.fingerprintExecutable(raw.executablePath)
      if (
        fingerprint &&
        !this.disposed &&
        !controller.signal.aborted &&
        createdGeneration === this.configurationGeneration &&
        this.providerConfigurationKey(agentId) === createdConfigKey &&
        !this.hasUnconfirmedCleanup(agentId)
      ) {
        this.storeReadyCache(
          agentId,
          createdConfigKey,
          createdGeneration,
          createdSelectedPath,
          fingerprint,
          raw,
        )
      }
      return { raw }
    }
    if (
      agentId === 'agy' &&
      raw.state === 'startup_failed' &&
      raw.detail === 'Authentication check timed out.' &&
      this.repository.hasCompletedFirstUseSetup() &&
      !startedWithAgyHook &&
      !this.hasUnconfirmedCleanup('agy')
    ) {
      const prior = this.readyCache.get('agy')
      const now = Date.now()
      if (
        prior &&
        prior.configKey === createdConfigKey &&
        prior.generation === createdGeneration &&
        prior.selectedPath === createdSelectedPath &&
        now < prior.graceExpiresAt
      ) {
        const currentFingerprint = await this.fingerprintExecutable(
          prior.fingerprint.executablePath,
        )
        if (
          this.readyCache.get('agy') === prior &&
          currentFingerprint &&
          RuntimePreparation.fingerprintsMatch(prior.fingerprint, currentFingerprint) &&
          !this.disposed &&
          !controller.signal.aborted &&
          createdGeneration === this.configurationGeneration &&
          this.providerConfigurationKey('agy') === createdConfigKey &&
          !this.hasUnconfirmedCleanup('agy')
        ) {
          prior.consecutiveTimeouts += 1
          if (prior.consecutiveTimeouts <= AGY_MAX_CONSECUTIVE_ABSORBED_TIMEOUTS) {
            // Expire positive TTL immediately so the next check/Send still probes fresh instead of masking sustained hangs.
            prior.expiresAt = now
            return { raw, gracefulReady: { ...prior.readiness } }
          }
        }
      }
      this.deleteReadyCache('agy')
      return { raw }
    }
    if (!startedWithAgyHook || raw.state !== 'ready') {
      this.deleteReadyCache(agentId)
    }
    return { raw }
  }

  async inspectReadiness(
    signal?: AbortSignal,
    agentIds?: readonly RuntimeAgentId[],
    deadlineAt?: number,
    options?: {
      readonly agySessionHook?: AgyReadinessSessionHook
      readonly forceRefresh?: boolean
    },
  ): Promise<RpcResult<RuntimePreparationSnapshot>> {
    const maxBudgetMs = options?.agySessionHook
      ? AGY_ACP_EXTENDED_BUDGET_MS
      : READINESS_RPC_BUDGET_MS
    const effectiveDeadlineAt =
      deadlineAt !== undefined
        ? Math.min(deadlineAt, Date.now() + maxBudgetMs)
        : Date.now() + READINESS_RPC_BUDGET_MS
    try {
      await this.prepareEnvironment(signal, effectiveDeadlineAt)
      signal?.throwIfAborted()
      return {
        ok: true,
        value: await this.collectReadinessSnapshot(
          signal,
          agentIds,
          effectiveDeadlineAt,
          options?.agySessionHook,
          options?.forceRefresh === true,
        ),
      }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Runtime preparation could not be completed.' },
      }
    }
  }

  async inspectProviderReadiness(
    provider: RuntimeAgentId,
    signal?: AbortSignal,
    options?: { readonly forceRefresh?: boolean },
  ): Promise<RpcResult<RuntimeAgentReadiness>> {
    const deadlineAt = Date.now() + READINESS_RPC_BUDGET_MS
    try {
      await this.prepareEnvironment(signal, deadlineAt)
      signal?.throwIfAborted()
      const agent = await this.probeAgentCoalesced(
        provider,
        this.repository.readSelectedExecutablePath(provider),
        signal,
        deadlineAt,
        undefined,
        options?.forceRefresh === true,
      )
      signal?.throwIfAborted()
      const cliVersion = agent.version?.match(/\b\d{1,5}\.\d{1,5}\.\d{1,5}\b/u)?.[0]
      recordDiagnostic({
        operation: 'readiness',
        phase: agent.state === 'ready' ? 'ready' : 'blocked',
        agentId: agent.agentId,
        ...(cliVersion ? { cliVersion } : {}),
      })
      return { ok: true, value: agent }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Runtime preparation could not be completed.' },
      }
    }
  }

  async selectExecutable(
    input: RuntimeExecutablePathUpdate,
  ): Promise<RpcResult<RuntimePreparationSnapshot>> {
    try {
      await this.prepareEnvironment()
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Runtime preparation could not be completed.' },
      }
    }
    // Persist only a validated absolute executable path, then immediately re-run the same
    // readiness path used at startup so manual selection cannot bypass authentication checks.
    if (!(await this.isExecutable(input.executablePath))) {
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'Choose an executable file for this Agent.' },
      }
    }
    this.repository.saveSelectedExecutablePath(input.agentId, input.executablePath)
    this.configurationGeneration += 1
    this.deleteReadyCache()
    const existing = this.inFlightAgentProbes.get(input.agentId)
    if (existing && existing.subscribers.size === 0) {
      existing.closing = true
      this.closingAgentProbes.add(existing.settled)
      existing.controller.abort()
    }
    return this.inspectReadiness(undefined, undefined, undefined, { forceRefresh: true })
  }

  private static normalizeRequestedAgents(
    agentIds?: readonly RuntimeAgentId[],
  ): readonly RuntimeAgentId[] {
    if (!agentIds) return ['claude', 'codex', 'agy']
    const unique: RuntimeAgentId[] = []
    for (const agentId of agentIds) {
      if (!unique.includes(agentId)) unique.push(agentId)
    }
    return unique
  }

  private async probeAgentCoalesced(
    agentId: RuntimeAgentId,
    selectedPath: string | undefined,
    signal?: AbortSignal,
    deadlineAt?: number,
    agySessionHook?: AgyReadinessSessionHook,
    forceRefresh = false,
  ): Promise<RuntimeAgentReadiness> {
    let entry!: InFlightAgentProbe
    let attachedAgyHookEntry: AttachedAgySessionHook | undefined
    while (true) {
      signal?.throwIfAborted()
      if (this.disposed) {
        throw new Error('Runtime preparation is shutting down.')
      }
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        throw new Error('Runtime preparation deadline reached.')
      }

      if (
        !forceRefresh &&
        !(agentId === 'agy' && agySessionHook !== undefined) &&
        !this.inFlightAgentProbes.has(agentId) &&
        !this.hasUnconfirmedCleanup(agentId)
      ) {
        // oxlint-disable-next-line no-await-in-loop -- Verify cached executable metadata on disk before bypassing probe.
        const cachedReadiness = await this.lookupReadyCache(
          agentId,
          selectedPath,
          signal,
          deadlineAt,
        )
        if (cachedReadiness) {
          return cachedReadiness
        }
        signal?.throwIfAborted()
        if (this.disposed) {
          throw new Error('Runtime preparation is shutting down.')
        }
        if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
          throw new Error('Runtime preparation deadline reached.')
        }
      }

      const existing = this.inFlightAgentProbes.get(agentId)
      if (existing) {
        if (
          !existing.closing &&
          existing.generation === this.configurationGeneration &&
          existing.selectedPath === selectedPath &&
          !existing.controller.signal.aborted
        ) {
          if (agentId === 'agy' && agySessionHook && !existing.agyHooksStarted) {
            attachedAgyHookEntry = { hook: agySessionHook, signal }
            existing.agySessionHooks.add(attachedAgyHookEntry)
          }
          entry = existing
          break
        }
        // Wait for any closing or superseded physical probe of the same agent to finish before
        // spawning a replacement so concurrent ACP count stays strictly bounded and stale results
        // are never reused.
        // oxlint-disable-next-line no-await-in-loop -- Wait on closing/superseded physical flight before retry.
        await RuntimePreparation.waitWithAbortAndDeadline(existing.settled, signal, deadlineAt)
        continue
      }

      const controller = new AbortController()
      const subscribers = new Set<symbol>()
      const agySessionHooks = new Set<AttachedAgySessionHook>()
      if (agentId === 'agy' && agySessionHook) {
        attachedAgyHookEntry = { hook: agySessionHook, signal }
        agySessionHooks.add(attachedAgyHookEntry)
      }
      let createdEntry: InFlightAgentProbe | undefined
      const onEnvAbort = (): void => {
        if (createdEntry) {
          createdEntry.closing = true
          this.closingAgentProbes.add(createdEntry.settled)
        }
        controller.abort(this.environmentAbort.signal.reason)
      }
      this.environmentAbort.signal.addEventListener('abort', onEnvAbort, { once: true })
      const flightDeadlineAt = deadlineAt ?? Date.now() + READINESS_RPC_BUDGET_MS
      const flightCleanupTasks = new Set<Promise<void>>()
      const trackCleanupTask = (task: Promise<void>): void => {
        flightCleanupTasks.add(task)
        void task.finally(() => {
          flightCleanupTasks.delete(task)
        })
      }
      const agySessionDispatch: AgySessionHookDispatch | undefined =
        agentId === 'agy'
          ? {
              useExtendedTimeout: Boolean(agySessionHook && deadlineAt !== undefined),
              onNotification: (method, params) => {
                for (const sub of agySessionHooks) {
                  if (!sub.signal?.aborted) {
                    sub.hook.onNotification?.(method, params)
                  }
                }
              },
              runHooks: async (context, cliVersion) => {
                if (createdEntry) {
                  createdEntry.agyHooksStarted = true
                }
                const snapshot = [...agySessionHooks]
                for (const sub of snapshot) {
                  if (sub.signal?.aborted) continue
                  try {
                    // oxlint-disable-next-line no-await-in-loop -- Coalesced hooks run sequentially on one open ACP probe session.
                    await sub.hook.inspectSession(context, cliVersion)
                  } catch {
                    // Isolate hook errors so readiness still reports ready.
                  }
                }
              },
            }
          : undefined
      const createdGeneration = this.configurationGeneration
      const createdSelectedPath = selectedPath
      const createdConfigKey = this.providerConfigurationKey(agentId)
      const startedWithAgyHook = agentId === 'agy' && agySessionHook !== undefined
      const promise = this.probeAgent(
        agentId,
        selectedPath,
        controller.signal,
        flightDeadlineAt,
        trackCleanupTask,
        agySessionDispatch,
      ).then((raw) =>
        this.evaluateFlightOutcome(
          agentId,
          createdGeneration,
          createdSelectedPath,
          createdConfigKey,
          startedWithAgyHook,
          controller,
          raw,
        ),
      )
      const settled = promise
        .then(
          () => undefined,
          () => undefined,
        )
        .then(async () => {
          if (flightCleanupTasks.size > 0) {
            if (createdEntry) {
              createdEntry.closing = true
              this.closingAgentProbes.add(settled)
            }
            await Promise.allSettled(flightCleanupTasks)
          }
          return undefined
        })
        .finally(() => {
          this.environmentAbort.signal.removeEventListener('abort', onEnvAbort)
          if (createdEntry && this.inFlightAgentProbes.get(agentId) === createdEntry) {
            this.inFlightAgentProbes.delete(agentId)
          }
          this.closingAgentProbes.delete(settled)
        })
      // Prevent unhandled rejections if every subscriber detaches via AbortSignal before settle.
      void promise.catch(() => undefined)
      createdEntry = {
        generation: this.configurationGeneration,
        selectedPath,
        controller,
        subscribers,
        closing: false,
        agyHooksStarted: false,
        agySessionHooks,
        promise,
        settled,
      }
      if (this.environmentAbort.signal.aborted) {
        createdEntry.closing = true
        this.closingAgentProbes.add(settled)
        controller.abort(this.environmentAbort.signal.reason)
      }
      entry = createdEntry
      this.inFlightAgentProbes.set(agentId, entry)
      break
    }

    const token = Symbol()
    entry.subscribers.add(token)
    if (!signal) {
      try {
        const outcome = await entry.promise
        return forceRefresh ? outcome.raw : (outcome.gracefulReady ?? outcome.raw)
      } finally {
        entry.subscribers.delete(token)
        if (attachedAgyHookEntry) {
          entry.agySessionHooks.delete(attachedAgyHookEntry)
        }
      }
    }

    try {
      return await new Promise<RuntimeAgentReadiness>((resolve, reject) => {
        let callerSettled = false
        const cleanup = (): void => {
          signal.removeEventListener('abort', onCallerAbort)
        }
        const buildAbortError = (): Error => {
          if (signal.reason instanceof Error) return signal.reason
          const error = new Error('Runtime preparation probe was aborted.', {
            cause: signal.reason,
          })
          error.name = 'AbortError'
          return error
        }
        const abortCaller = (): void => {
          if (callerSettled) return
          callerSettled = true
          entry.subscribers.delete(token)
          if (attachedAgyHookEntry) {
            entry.agySessionHooks.delete(attachedAgyHookEntry)
          }
          const abortErr = buildAbortError()
          if (entry.subscribers.size === 0) {
            entry.closing = true
            this.closingAgentProbes.add(entry.settled)
            entry.controller.abort(signal.reason)
            void entry.settled.finally(() => reject(abortErr))
            return
          }
          reject(abortErr)
        }
        const onCallerAbort = (): void => abortCaller()
        signal.addEventListener('abort', onCallerAbort, { once: true })
        if (signal.aborted) {
          cleanup()
          abortCaller()
          return
        }
        void (async () => {
          try {
            const outcome = await entry.promise
            cleanup()
            if (callerSettled) return
            if (signal.aborted) {
              abortCaller()
              return
            }
            callerSettled = true
            resolve(forceRefresh ? outcome.raw : (outcome.gracefulReady ?? outcome.raw))
          } catch (error: unknown) {
            cleanup()
            if (callerSettled) return
            if (signal.aborted) {
              abortCaller()
              return
            }
            callerSettled = true
            reject(error instanceof Error ? error : new Error('Runtime probe failed.'))
          }
        })()
      })
    } finally {
      entry.subscribers.delete(token)
      if (attachedAgyHookEntry) {
        entry.agySessionHooks.delete(attachedAgyHookEntry)
      }
    }
  }

  private async collectReadinessSnapshot(
    signal?: AbortSignal,
    agentIds?: readonly RuntimeAgentId[],
    deadlineAt?: number,
    agySessionHook?: AgyReadinessSessionHook,
    forceRefresh = false,
  ): Promise<RuntimePreparationSnapshot> {
    const requestedAgents = RuntimePreparation.normalizeRequestedAgents(agentIds)
    // The probes are independent and bounded, so startup latency is the slowest probe rather than
    // the sum of all active CLIs.
    const agents = await Promise.all(
      requestedAgents.map((agentId) =>
        this.probeAgentCoalesced(
          agentId,
          this.repository.readSelectedExecutablePath(agentId),
          signal,
          deadlineAt,
          agentId === 'agy' ? agySessionHook : undefined,
          forceRefresh,
        ),
      ),
    )
    signal?.throwIfAborted()
    for (const agent of agents) {
      const cliVersion = agent.version?.match(/\b\d{1,5}\.\d{1,5}\.\d{1,5}\b/u)?.[0]
      recordDiagnostic({
        operation: 'readiness',
        phase: agent.state === 'ready' ? 'ready' : 'blocked',
        agentId: agent.agentId,
        ...(cliVersion ? { cliVersion } : {}),
      })
    }
    return { firstUse: !this.repository.hasCompletedFirstUseSetup(), agents }
  }

  private async probeAgent(
    agentId: RuntimeAgentId,
    selectedPath: string | undefined,
    signal?: AbortSignal,
    deadlineAt?: number,
    trackCleanupTask?: (task: Promise<void>) => void,
    agySessionDispatch?: AgySessionHookDispatch,
  ): Promise<RuntimeAgentReadiness> {
    const checkedAt = new Date().toISOString()
    let executablePath: string | undefined
    try {
      signal?.throwIfAborted()
      if (this.unconfirmedProviderProbes(agentId).length > 0) {
        return {
          agentId,
          state: 'cannot_verify',
          ...(selectedPath ? { executablePath: selectedPath } : {}),
          detail: `${runtimeAgentDisplayName(agentId)} check could not be confirmed.`,
          checkedAt,
        }
      }
      executablePath = await this.findExecutable(agentId, selectedPath, signal, deadlineAt)
      signal?.throwIfAborted()
      if (!executablePath) {
        return {
          agentId,
          state: 'missing',
          detail: selectedPath
            ? 'Saved executable path was not found. Choose a valid path or reinstall.'
            : 'No executable was found.',
          checkedAt,
        }
      }

      // --version is both the version source and the bounded "can this executable start?" probe. It
      // deliberately avoids a model request, network quota, or workspace access.
      const version = await this.runCliProbeCommand(
        agentId,
        executablePath,
        'version',
        signal,
        deadlineAt,
      )
      signal?.throwIfAborted()
      if (version.closeUnconfirmed) {
        return {
          agentId,
          state: 'cannot_verify',
          executablePath,
          detail: `${runtimeAgentDisplayName(agentId)} version check cleanup could not be confirmed.`,
          checkedAt,
        }
      }
      if (version.failedToStart || version.timedOut || version.exitCode !== 0) {
        return {
          agentId,
          state: 'startup_failed',
          executablePath,
          detail: version.timedOut ? 'Version check timed out.' : 'The executable could not start.',
          checkedAt,
        }
      }

      const versionText = this.parseVersionLine(version.output)
      const minimumVersion = RUNTIME_MINIMUM_VERSIONS[agentId]
      const agentName = runtimeAgentDisplayName(agentId)
      const compatibility = this.versionCompatibility(versionText, minimumVersion)
      if (compatibility !== 'supported') {
        return {
          agentId,
          state: compatibility === 'outdated' ? 'unsupported_version' : 'cannot_verify',
          executablePath,
          ...(versionText ? { version: versionText } : {}),
          detail:
            compatibility === 'outdated'
              ? `Requires ${agentName} ${minimumVersion} or later. Upgrade ${agentName}, then check again.`
              : `Could not read the ${agentName} version. Version ${minimumVersion} or later is required. Upgrade or select a supported installation, then check again.`,
          checkedAt,
        }
      }

      if (agentId === 'agy') {
        return await this.probeAgyAuthentication(
          executablePath,
          versionText,
          checkedAt,
          signal,
          deadlineAt,
          trackCleanupTask,
          agySessionDispatch,
        )
      }

      // Each CLI owns its authentication truth. Exit 0 means the CLI accepted an effective login or
      // API configuration; Pact does not inspect credential files itself.
      const auth = await this.runCliProbeCommand(
        agentId,
        executablePath,
        agentId === 'claude' ? 'claude_auth' : 'codex_auth',
        signal,
        deadlineAt,
      )
      signal?.throwIfAborted()
      if (auth.closeUnconfirmed) {
        return {
          agentId,
          state: 'cannot_verify',
          executablePath,
          ...(versionText ? { version: versionText } : {}),
          detail: `${agentName} authentication check cleanup could not be confirmed.`,
          checkedAt,
        }
      }
      if (auth.exitCode === 0 && !auth.timedOut && !auth.failedToStart) {
        return {
          agentId,
          state: 'ready',
          executablePath,
          ...(versionText ? { version: versionText } : {}),
          checkedAt,
        }
      }

      if (auth.exitCode === 1 && !auth.timedOut && !auth.failedToStart) {
        return {
          agentId,
          state: 'authentication_required',
          executablePath,
          ...(versionText ? { version: versionText } : {}),
          detail:
            agentId === 'claude'
              ? 'Run claude auth login in your terminal, or set up a login or compatible API configuration.'
              : 'Run codex login in your terminal, then check again.',
          checkedAt,
        }
      }

      return {
        agentId,
        state: auth.failedToStart || auth.timedOut ? 'startup_failed' : 'cannot_verify',
        executablePath,
        ...(versionText ? { version: versionText } : {}),
        detail: auth.timedOut
          ? 'Authentication check timed out.'
          : auth.failedToStart
            ? 'Authentication check could not start.'
            : 'This CLI version did not return a recognized authentication status.',
        checkedAt,
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (this.disposed) {
        throw new Error('Runtime preparation is shutting down.', { cause: error })
      }
      return {
        agentId,
        state: 'cannot_verify',
        ...(executablePath ? { executablePath } : {}),
        detail: `Could not verify ${runtimeAgentDisplayName(agentId)} installation.`,
        checkedAt,
      }
    }
  }

  private recordUnconfirmedAgyProbeDir(dirPath: string): void {
    this.unconfirmedAgyProbeDirs.add(dirPath)
  }

  private async reconcileUnconfirmedAgyProbeDirs(): Promise<boolean> {
    const pending = [...this.unconfirmedAgyProbeDirs]
    if (pending.length === 0) return false
    await Promise.allSettled(
      pending.map(async (dirPath) => {
        if (await removeDirConfirmed(dirPath)) {
          this.unconfirmedAgyProbeDirs.delete(dirPath)
        }
      }),
    )
    return this.unconfirmedAgyProbeDirs.size >= MAX_UNCONFIRMED_AGY_PROBE_DIRS
  }

  private async reconcileUnconfirmedAgyProbes(): Promise<boolean> {
    const settledEntries: Array<[OwnedProcessGroup, UnconfirmedAgyProbeArtifact]> = []
    for (const entry of this.unconfirmedAgyProbes.entries()) {
      if (isAgyProbeSettled(entry[0])) settledEntries.push(entry)
    }
    await Promise.allSettled(
      settledEntries.map(async ([probe, artifact]) => {
        this.unconfirmedAgyProbes.delete(probe)
        this.agyProbes.delete(probe)
        const removed = await reconcileSettledAgyProbeArtifact(artifact).catch(() => false)
        if (!removed) {
          this.recordUnconfirmedAgyProbeDir(artifact.probeRoot)
        }
      }),
    )
    return this.unconfirmedAgyProbes.size > 0
  }

  private ownAgyProbe(
    signal: AbortSignal,
    onCloseInput: () => void | Promise<void>,
  ): OwnedProcessGroup {
    signal.throwIfAborted()
    for (const candidate of this.agyProbes) {
      if (isAgyProbeSettled(candidate) && !this.unconfirmedAgyProbes.has(candidate)) {
        this.agyProbes.delete(candidate)
      }
    }
    if (this.disposed || this.agyProbes.size >= MAX_ACTIVE_AGY_PROBES) {
      throw new AgyProbeError('close_unconfirmed', 'Antigravity probe capacity is unavailable.')
    }
    const probe = new OwnedProcessGroup({ signal, onCloseInput })
    this.agyProbes.add(probe)
    return probe
  }

  private async probeAgyAuthentication(
    executablePath: string,
    cliVersion: string | undefined,
    checkedAt: string,
    signal?: AbortSignal,
    deadlineAt?: number,
    trackCleanupTask?: (task: Promise<void>) => void,
    agySessionDispatch?: AgySessionHookDispatch,
  ): Promise<RuntimeAgentReadiness> {
    const [probesUnconfirmed, dirsBlocked] = await Promise.all([
      this.reconcileUnconfirmedAgyProbes(),
      this.reconcileUnconfirmedAgyProbeDirs(),
    ])
    if (probesUnconfirmed || dirsBlocked) {
      return {
        agentId: 'agy',
        state: 'cannot_verify',
        executablePath,
        ...(cliVersion ? { version: cliVersion } : {}),
        detail: 'Antigravity authentication check could not be confirmed.',
        checkedAt,
      }
    }

    const effectiveDeadlineAt = deadlineAt ?? Date.now() + READINESS_RPC_BUDGET_MS
    const businessDeadlineAt = effectiveDeadlineAt - AGY_ACP_CLEANUP_RESERVE_MS
    const closeDeadlineAt = Math.floor(
      Math.max(Date.now() + 1, effectiveDeadlineAt - READINESS_REPLY_MARGIN_MS),
    )
    if (businessDeadlineAt <= Date.now()) {
      return {
        agentId: 'agy',
        state: 'startup_failed',
        executablePath,
        ...(cliVersion ? { version: cliVersion } : {}),
        detail: 'Authentication check timed out.',
        checkedAt,
      }
    }

    const combinedAbort = new AbortController()
    const onAbort = (): void => combinedAbort.abort(signal?.reason)
    this.environmentAbort.signal.addEventListener('abort', onAbort, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (this.environmentAbort.signal.aborted || signal?.aborted) {
      combinedAbort.abort(signal?.reason ?? this.environmentAbort.signal.reason)
    }

    let discoveredAgentInfoVersion: string | undefined
    try {
      await runAgyAcpProbe<void>({
        executablePath,
        ...(this.options.env ? { env: this.options.env } : {}),
        signal: combinedAbort.signal,
        initializeTimeoutMs: Math.min(
          AGY_ACP_INIT_TIMEOUT_MS,
          Math.max(0, businessDeadlineAt - Date.now()),
        ),
        timeoutMs: agySessionDispatch?.useExtendedTimeout
          ? Math.min(
              AGY_ACP_EXTENDED_SESSION_TIMEOUT_MS,
              Math.max(0, businessDeadlineAt - Date.now()),
            )
          : AGY_ACP_SESSION_TIMEOUT_MS,
        businessDeadlineAt,
        closeDeadlineAt,
        getShutdownDeadlineAt: () => this.disposeFlushDeadlineAt,
        maxFrameBytes: AGY_ACP_MAX_FRAME_BYTES,
        maxTotalBytes: AGY_ACP_MAX_TOTAL_BYTES,
        ownProbe: (probeSignal, onCloseInput) => this.ownAgyProbe(probeSignal, onCloseInput),
        onAgentInfoVersion: (agentInfoVersion) => {
          // Record ACP server version separately; RuntimeAgentReadiness.version always reflects CLI --version.
          discoveredAgentInfoVersion = agentInfoVersion
          this.lastAcpAgentInfoVersion = agentInfoVersion
        },
        onNotification: (method, params) => agySessionDispatch?.onNotification(method, params),
        inspectSession: async (context) => {
          if (agySessionDispatch) {
            await agySessionDispatch.runHooks(context, cliVersion)
          }
        },
        onCloseError: (_error, probe, artifact) => {
          if (!isAgyProbeSettled(probe)) {
            this.unconfirmedAgyProbes.set(probe, artifact)
          }
        },
        onProbeSettled: (probe) => {
          if (isAgyProbeSettled(probe)) {
            this.unconfirmedAgyProbes.delete(probe)
            this.agyProbes.delete(probe)
          }
        },
        reconcileArtifact: async (artifact) => {
          const agyCleanups = this.pendingArtifactCleanupsByProvider.get('agy')!
          const task = reconcileSettledAgyProbeArtifact(artifact)
            .catch(() => false)
            .then((removed) => {
              if (!removed) {
                this.recordUnconfirmedAgyProbeDir(artifact.probeRoot)
              }
              return removed
            })
            .finally(() => {
              agyCleanups.delete(task)
            })
          agyCleanups.add(task)
          trackCleanupTask?.(task.then(() => undefined))
          const remainingForArtifact = effectiveDeadlineAt - Date.now() - 100
          if (remainingForArtifact <= 0) return false
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            return await Promise.race([
              task,
              new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), remainingForArtifact)
              }),
            ])
          } finally {
            clearTimeout(timer)
          }
        },
      })
      signal?.throwIfAborted()
      return {
        agentId: 'agy',
        state: 'ready',
        executablePath,
        ...(cliVersion ? { version: cliVersion } : {}),
        ...(discoveredAgentInfoVersion ? { agentInfoVersion: discoveredAgentInfoVersion } : {}),
        checkedAt,
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (this.disposed) {
        throw new Error('Runtime preparation is shutting down.', { cause: error })
      }
      const versionFields = {
        ...(cliVersion ? { version: cliVersion } : {}),
        ...(discoveredAgentInfoVersion ? { agentInfoVersion: discoveredAgentInfoVersion } : {}),
      }
      if (error instanceof AgyProbeError) {
        if (error.kind === 'unauthenticated') {
          return {
            agentId: 'agy',
            state: 'authentication_required',
            executablePath,
            ...versionFields,
            detail: 'Run agy to sign in in your terminal, then check again.',
            checkedAt,
          }
        }
        if (error.kind === 'start_failed') {
          return {
            agentId: 'agy',
            state: 'startup_failed',
            executablePath,
            ...versionFields,
            detail: 'Authentication check could not start.',
            checkedAt,
          }
        }
        if (error.kind === 'timeout') {
          return {
            agentId: 'agy',
            state: 'startup_failed',
            executablePath,
            ...versionFields,
            detail: 'Authentication check timed out.',
            checkedAt,
          }
        }
        if (error.kind === 'close_unconfirmed') {
          return {
            agentId: 'agy',
            state: 'cannot_verify',
            executablePath,
            ...versionFields,
            detail: 'Antigravity authentication check could not be confirmed.',
            checkedAt,
          }
        }
      }
      return {
        agentId: 'agy',
        state: 'cannot_verify',
        executablePath,
        ...versionFields,
        detail: 'This CLI version did not return a recognized authentication status.',
        checkedAt,
      }
    } finally {
      this.environmentAbort.signal.removeEventListener('abort', onAbort)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async findExecutable(
    agentId: RuntimeAgentId,
    selectedPath: string | undefined,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<string | undefined> {
    // An explicit user choice wins while it remains executable; automatic discovery is only the
    // recovery path when no saved choice exists or the saved file disappeared.
    if (selectedPath && (await this.isExecutable(selectedPath))) return selectedPath
    signal?.throwIfAborted()
    return (
      (agentId === 'claude' ? await this.findWindowsDesktopClaude(signal) : undefined) ??
      (await this.findOnInheritedPath(agentId)) ??
      (await this.findWithPlatformLookup(agentId, signal, deadlineAt))
    )
  }

  /** Desktop updates its native CLI separately from PATH installations. Never replace an explicit choice. */
  private async findWindowsDesktopClaude(signal?: AbortSignal): Promise<string | undefined> {
    const localAppData = this.effectiveEnv().LOCALAPPDATA
    if (process.platform !== 'win32' || !localAppData || !isAbsolute(localAppData)) return undefined
    const deadline = Date.now() + INSTALLATION_DISCOVERY_MS
    let entries = 0,
      bytes = 0
    const check = (): void => {
      signal?.throwIfAborted()
      if (Date.now() >= deadline) throw new Error('Native installation discovery timed out.')
    }
    const directories = async (path: string, pattern: RegExp): Promise<string[]> => {
      check()
      let directory
      try {
        directory = await opendir(path, { bufferSize: 16 })
      } catch (error) {
        check()
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return []
        throw error
      }
      const names: string[] = []
      for await (const entry of directory) {
        check()
        bytes += Buffer.byteLength(entry.name)
        if (++entries > INSTALLATION_DISCOVERY_ENTRIES || bytes > INSTALLATION_DISCOVERY_BYTES)
          throw new Error('Native installation discovery exceeds its capacity.')
        if (entry.isDirectory() && pattern.test(entry.name)) names.push(entry.name)
      }
      check()
      return names
    }
    const root = join(localAppData, 'Claude-Data')
    const installations: Array<{ path: string; version: number[] }> = []
    for (const profile of await directories(root, /^claude_[a-z0-9]+$/u)) {
      const runtimeRoot = join(root, profile, 'claude-code')
      // oxlint-disable-next-line no-await-in-loop -- One bounded directory handle at a time.
      for (const version of await directories(runtimeRoot, /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u))
        installations.push({
          path: join(runtimeRoot, version),
          version: version.split('.').map(Number),
        })
    }
    installations.sort((left, right) => {
      for (let component = 0; component < 3; component++) {
        const difference = right.version[component]! - left.version[component]!
        if (difference) return difference
      }
      return left.path.localeCompare(right.path)
    })
    for (const installation of installations) {
      // oxlint-disable-next-line no-await-in-loop -- Newest completed installation wins within the same discovery budget.
      const builds = await directories(installation.path, /^[a-f0-9]{12,64}$/u)
      for (const build of builds.toSorted()) {
        const executable = join(installation.path, build, 'claude.exe')
        // oxlint-disable-next-line no-await-in-loop -- Do not speculate on executable startup or authentication during lookup.
        if (await this.isExecutable(executable)) {
          check()
          return executable
        }
      }
    }
    check()
    return undefined
  }

  // The inherited PATH is the cheapest lookup and preserves the environment used to launch Pact.
  private async findOnInheritedPath(
    agentId: RuntimeAgentId,
    directoryLimit?: number,
  ): Promise<string | undefined> {
    const candidates = (this.effectiveEnv().PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .slice(0, directoryLimit)
      .flatMap((directory) =>
        this.candidateExecutableNames(agentId).map((name) => join(directory, name)),
      )
    const matches = await Promise.all(
      candidates.map(async (candidate) =>
        (await this.isExecutable(candidate)) ? candidate : undefined,
      ),
    )
    return matches.find(Boolean)
  }

  // GUI applications can have a different PATH from the user's terminal. Use the platform's
  // normal command lookup as a fallback without sourcing arbitrary project scripts.
  private async findWithPlatformLookup(
    agentId: RuntimeAgentId,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<string | undefined> {
    if (process.platform === 'win32') {
      const lookupCommand: FixedLookupCommand =
        agentId === 'claude' ? 'where_claude' : agentId === 'codex' ? 'where_codex' : 'where_agy'
      const result = await this.runLookupCommand(agentId, lookupCommand, signal, deadlineAt)
      if (result.closeUnconfirmed) {
        throw new Error('Platform executable lookup cleanup could not be confirmed.')
      }
      const candidates = result.output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((candidate) => /\.(?:exe|cmd)$/iu.test(candidate))
      const matches = await Promise.all(
        candidates.map(async (candidate) =>
          (await this.isExecutable(candidate)) ? candidate : undefined,
        ),
      )
      return matches.find(Boolean)
    }
    if (process.platform === 'darwin') {
      if (this.options.discoverShellPath) return undefined
      const lookupCommand: FixedLookupCommand =
        agentId === 'claude' ? 'zsh_claude' : agentId === 'codex' ? 'zsh_codex' : 'zsh_agy'
      const result = await this.runLookupCommand(agentId, lookupCommand, signal, deadlineAt)
      if (result.closeUnconfirmed) {
        throw new Error('Platform executable lookup cleanup could not be confirmed.')
      }
      const candidate = result.output.split(/\r?\n/u).find(Boolean)?.trim()
      return candidate && (await this.isExecutable(candidate)) ? candidate : undefined
    }
    return undefined
  }

  private candidateExecutableNames(agentId: RuntimeAgentId): string[] {
    return process.platform === 'win32' ? [`${agentId}.exe`, `${agentId}.cmd`] : [agentId]
  }

  private async isExecutable(filePath: string): Promise<boolean> {
    if (!isAbsolute(filePath)) return false
    try {
      await access(filePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  private parseVersionLine(output: string): string | undefined {
    const firstLine = output.split(/\r?\n/u).find(Boolean)?.trim()
    return firstLine ? firstLine.slice(0, 160) : undefined
  }

  private versionCompatibility(
    version: string | undefined,
    minimumVersion: string,
  ): 'supported' | 'outdated' | 'unknown' {
    // Match a complete version token from any CLI's first output line, never a partial or
    // malformed number. Build metadata does not affect ordering; prereleases precede a release.
    const match = version?.match(
      /(?:^|\s)(\d{1,5})\.(\d{1,5})\.(\d{1,5})(-[\da-z]+(?:[.-][\da-z]+)*)?(?:\+[\da-z]+(?:[.-][\da-z]+)*)?(?=$|\s|\()/iu,
    )
    if (!match) return 'unknown'
    const minimum = minimumVersion.split('.').map(Number)
    for (let index = 0; index < 3; index++) {
      const difference = Number(match[index + 1]) - minimum[index]!
      if (difference !== 0) return difference > 0 ? 'supported' : 'outdated'
    }
    return match[4] ? 'outdated' : 'supported'
  }

  private runCliProbeCommand(
    agentId: RuntimeAgentId,
    executablePath: string,
    command: FixedCliProbeCommand,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<ProbeCommandResult> {
    const spec = fixedCliProbeArgs(command)
    const isWindowsCommand = process.platform === 'win32' && /\.cmd$/iu.test(executablePath)
    if (isWindowsCommand && isUnsafeWindowsCmdPath(executablePath)) {
      return Promise.resolve({
        exitCode: null,
        output: '',
        timedOut: false,
        failedToStart: true,
      })
    }
    const targetExecutable = isWindowsCommand
      ? resolveTrustedWindowsCmdExe(this.effectiveEnv())
      : executablePath
    if (isWindowsCommand && !targetExecutable) {
      return Promise.resolve({
        exitCode: null,
        output: '',
        timedOut: false,
        failedToStart: true,
      })
    }
    return this.spawnBoundedProbe(
      agentId,
      targetExecutable ?? executablePath,
      isWindowsCommand
        ? ['/d', '/s', '/c', `""${executablePath}" ${spec.windowsCmdSuffix}"`]
        : spec.argv,
      isWindowsCommand,
      signal,
      deadlineAt,
    )
  }

  private runLookupCommand(
    agentId: RuntimeAgentId,
    command: FixedLookupCommand,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<ProbeCommandResult> {
    const spec = fixedLookupArgs(command)
    return this.spawnBoundedProbe(agentId, spec.executable, spec.argv, false, signal, deadlineAt)
  }

  // Run only fixed CLI probes inside OwnedProcessGroup so timed-out/cancelled children never
  // unref and leak past caller concurrency permits while still alive.
  private async spawnBoundedProbe(
    agentId: RuntimeAgentId,
    targetExecutable: string,
    args: readonly string[],
    windowsVerbatimArguments: boolean,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<ProbeCommandResult> {
    if (signal?.aborted || this.disposed || this.environmentAbort.signal.aborted) {
      return { exitCode: null, output: '', timedOut: true, failedToStart: false }
    }
    const execBudgetMs =
      deadlineAt === undefined
        ? PROBE_TIMEOUT_MS
        : Math.min(
            PROBE_TIMEOUT_MS,
            Math.max(0, deadlineAt - Date.now() - CLI_PROBE_CLEANUP_RESERVE_MS),
          )
    if (execBudgetMs <= 0) {
      return { exitCode: null, output: '', timedOut: true, failedToStart: false }
    }
    this.pruneSettledCliProbes(agentId)
    const activeSet = this.cliProbes.get(agentId)!
    const unconfirmedSet = this.unconfirmedCliProbes.get(agentId)!
    if (activeSet.size >= MAX_ACTIVE_CLI_PROBES_PER_AGENT || unconfirmedSet.size > 0) {
      return {
        exitCode: null,
        output: '',
        timedOut: false,
        failedToStart: true,
        closeUnconfirmed: true,
      }
    }

    let exitCode: number | null = null
    let output = ''
    let outputBytes = 0
    let failedToStart = false
    let timedOut = false
    let closeUnconfirmed = false
    const probeAbort = new AbortController()
    const probe = new OwnedProcessGroup({ signal: probeAbort.signal })
    activeSet.add(probe)

    const onExternalAbort = (): void => {
      timedOut = true
      probeAbort.abort(signal?.reason ?? this.environmentAbort.signal.reason)
    }
    signal?.addEventListener('abort', onExternalAbort, { once: true })
    this.environmentAbort.signal.addEventListener('abort', onExternalAbort, { once: true })

    try {
      if (signal?.aborted || this.disposed || this.environmentAbort.signal.aborted) {
        timedOut = true
        probeAbort.abort()
      } else {
        let child: ReturnType<OwnedProcessGroup['spawn']> | undefined
        try {
          child = probe.spawn(targetExecutable, [...args], {
            ...(this.options.env ? { env: this.options.env } : {}),
            windowsHide: true,
            windowsVerbatimArguments,
          })
        } catch {
          failedToStart = true
        }
        if (child) {
          const spawnedChild = child
          if (!spawnedChild.stdin.destroyed) spawnedChild.stdin.end()

          exitCode = await new Promise<number | null>((resolve) => {
            let settled = false
            const capture = (chunk: Buffer, isStdout: boolean): void => {
              const length = Math.min(chunk.length, MAX_CAPTURE_BYTES - outputBytes)
              if (length > 0) {
                if (isStdout) output += chunk.subarray(0, length).toString('utf8')
                outputBytes += length
              }
            }
            const onStdout = (chunk: Buffer): void => capture(chunk, true)
            const onStderr = (chunk: Buffer): void => capture(chunk, false)
            const finish = (code: number | null): void => {
              if (settled) return
              settled = true
              clearTimeout(timeout)
              probeAbort.signal.removeEventListener('abort', onProbeAborted)
              spawnedChild.stdout.off('data', onStdout)
              spawnedChild.stderr.off('data', onStderr)
              resolve(code)
            }
            const onProbeAborted = (): void => {
              timedOut = true
              finish(null)
            }
            const timeout = setTimeout(() => {
              timedOut = true
              probeAbort.abort()
              finish(null)
            }, execBudgetMs)
            spawnedChild.stdout.on('data', onStdout)
            spawnedChild.stderr.on('data', onStderr)
            spawnedChild.once('error', () => {
              failedToStart = true
              finish(null)
            })
            spawnedChild.once('close', (code) => finish(code))
            probeAbort.signal.addEventListener('abort', onProbeAborted, { once: true })
            if (probeAbort.signal.aborted) onProbeAborted()
          })
        }
      }
    } finally {
      signal?.removeEventListener('abort', onExternalAbort)
      this.environmentAbort.signal.removeEventListener('abort', onExternalAbort)
      const closeDeadlineAt =
        deadlineAt === undefined
          ? undefined
          : Math.floor(Math.max(Date.now() + 1, deadlineAt - READINESS_REPLY_MARGIN_MS))
      await probe.close(closeDeadlineAt).catch(() => {
        closeUnconfirmed = true
      })
      if (closeUnconfirmed || !isAgyProbeSettled(probe)) {
        closeUnconfirmed = true
        unconfirmedSet.add(probe)
      } else {
        activeSet.delete(probe)
      }
    }

    return {
      exitCode,
      output,
      timedOut,
      failedToStart,
      ...(closeUnconfirmed ? { closeUnconfirmed: true } : {}),
    }
  }
}
