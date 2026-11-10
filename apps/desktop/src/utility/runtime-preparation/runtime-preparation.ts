import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, opendir } from 'node:fs/promises'
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

const PROBE_TIMEOUT_MS = 4_000
const MAX_CAPTURE_BYTES = 64 * 1024
const INSTALLATION_DISCOVERY_MS = 1_000
const INSTALLATION_DISCOVERY_ENTRIES = 128
const INSTALLATION_DISCOVERY_BYTES = 64 * 1024

interface ProbeCommandResult {
  exitCode: number | null
  output: string
  timedOut: boolean
  failedToStart: boolean
}

export class RuntimePreparation {
  private configurationGeneration = 0
  constructor(private readonly repository: RuntimePreparationRepository) {}

  catalogIdentity(workingDirectory?: string): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          workingDirectory,
          this.configurationGeneration,
          this.repository.readSelectedExecutablePath('claude'),
          this.repository.readSelectedExecutablePath('codex'),
          process.env.PATH,
          process.env.LOCALAPPDATA,
        ]),
      )
      .digest('hex')
  }

  async findRecoveryExecutable(
    agentId: RuntimeAgentId,
    signal: AbortSignal,
  ): Promise<string | undefined> {
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

  async inspectReadiness(signal?: AbortSignal): Promise<RpcResult<RuntimePreparationSnapshot>> {
    try {
      signal?.throwIfAborted()
      return { ok: true, value: await this.collectReadinessSnapshot(signal) }
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
    return this.inspectReadiness()
  }

  private async collectReadinessSnapshot(
    signal?: AbortSignal,
  ): Promise<RuntimePreparationSnapshot> {
    // The probes are independent and bounded, so startup latency is the slower probe rather than
    // the sum of both CLIs.
    const [claude, codex] = await Promise.all([
      this.probeAgent('claude', this.repository.readSelectedExecutablePath('claude'), signal),
      this.probeAgent('codex', this.repository.readSelectedExecutablePath('codex'), signal),
    ])
    signal?.throwIfAborted()
    for (const agent of [claude, codex]) {
      const cliVersion = agent.version?.match(/\b\d{1,5}\.\d{1,5}\.\d{1,5}\b/u)?.[0]
      recordDiagnostic({
        operation: 'readiness',
        phase: agent.state === 'ready' ? 'ready' : 'blocked',
        agentId: agent.agentId,
        ...(cliVersion ? { cliVersion } : {}),
      })
    }
    return { firstUse: !this.repository.hasCompletedFirstUseSetup(), agents: [claude, codex] }
  }

  private async probeAgent(
    agentId: RuntimeAgentId,
    selectedPath: string | undefined,
    signal?: AbortSignal,
  ): Promise<RuntimeAgentReadiness> {
    const checkedAt = new Date().toISOString()
    signal?.throwIfAborted()
    const executablePath = await this.findExecutable(agentId, selectedPath, signal)
    signal?.throwIfAborted()
    if (!executablePath) {
      return {
        agentId,
        state: 'missing',
        detail: selectedPath
          ? 'The saved executable is no longer available.'
          : 'No executable was found.',
        checkedAt,
      }
    }

    // --version is both the version source and the bounded "can this executable start?" probe. It
    // deliberately avoids a model request, network quota, or workspace access.
    const version = await this.runProbeCommand(executablePath, ['--version'], signal)
    signal?.throwIfAborted()
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
    const agentName = agentId === 'claude' ? 'Claude Code' : 'Codex'
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

    // Each CLI owns its authentication truth. Exit 0 means the CLI accepted an effective login or
    // API configuration; Pact does not inspect credential files itself.
    const auth = await this.runProbeCommand(
      executablePath,
      agentId === 'claude' ? ['auth', 'status'] : ['login', 'status'],
      signal,
    )
    signal?.throwIfAborted()
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
            ? 'Claude Code needs a login or compatible API configuration available to Pact.'
            : 'Codex reports that sign-in is required.',
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
  }

  private async findExecutable(
    agentId: RuntimeAgentId,
    selectedPath: string | undefined,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    // An explicit user choice wins while it remains executable; automatic discovery is only the
    // recovery path when no saved choice exists or the saved file disappeared.
    if (selectedPath && (await this.isExecutable(selectedPath))) return selectedPath
    signal?.throwIfAborted()
    return (
      (agentId === 'claude' ? await this.findWindowsDesktopClaude(signal) : undefined) ??
      (await this.findOnInheritedPath(agentId)) ??
      (await this.findWithPlatformLookup(agentId, signal))
    )
  }

  /** Desktop updates its native CLI separately from PATH installations. Never replace an explicit choice. */
  private async findWindowsDesktopClaude(signal?: AbortSignal): Promise<string | undefined> {
    const localAppData = process.env.LOCALAPPDATA
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
    const candidates = (process.env.PATH ?? '')
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
  ): Promise<string | undefined> {
    const base = agentId === 'claude' ? 'claude' : 'codex'
    if (process.platform === 'win32') {
      const result = await this.runProbeCommand('where.exe', [base], signal)
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
      const command = agentId === 'claude' ? 'command -v claude' : 'command -v codex'
      const result = await this.runProbeCommand('/bin/zsh', ['-lc', command], signal)
      const candidate = result.output.split(/\r?\n/u).find(Boolean)?.trim()
      return candidate && (await this.isExecutable(candidate)) ? candidate : undefined
    }
    return undefined
  }

  private candidateExecutableNames(agentId: RuntimeAgentId): string[] {
    const base = agentId === 'claude' ? 'claude' : 'codex'
    return process.platform === 'win32' ? [`${base}.exe`, `${base}.cmd`] : [base]
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
    // Match a complete version token from either CLI's first output line, never a partial or
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

  // Run only fixed CLI probes. User-controlled values are passed as arguments, never through a
  // general-purpose shell, and output is bounded because CLI output is untrusted input.
  private runProbeCommand(
    executablePath: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<ProbeCommandResult> {
    return new Promise((resolve) => {
      let output = ''
      let outputBytes = 0
      let failedToStart = false
      let timedOut = false
      let settled = false
      if (signal?.aborted) {
        resolve({ exitCode: null, output, timedOut: true, failedToStart: false })
        return
      }
      const isWindowsCommand = process.platform === 'win32' && /\.cmd$/iu.test(executablePath)
      if (isWindowsCommand && /[&|<>^%!"\r\n]/u.test(executablePath)) {
        resolve({ exitCode: null, output, timedOut: false, failedToStart: true })
        return
      }
      const child = spawn(
        isWindowsCommand ? (process.env.ComSpec ?? 'cmd.exe') : executablePath,
        isWindowsCommand ? ['/d', '/s', '/c', `""${executablePath}" ${args.join(' ')}"`] : args,
        {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: isWindowsCommand,
        },
      )
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let closeTimer: ReturnType<typeof setTimeout> | undefined
      const capture = (chunk: Buffer, stdout: boolean): void => {
        const length = Math.min(chunk.length, MAX_CAPTURE_BYTES - outputBytes)
        if (length > 0) {
          if (stdout) output += chunk.subarray(0, length).toString('utf8')
          outputBytes += length
        }
      }
      // Diagnostics are drained under the same byte budget, never parsed as machine results.
      const stdout = (chunk: Buffer): void => capture(chunk, true)
      const stderr = (chunk: Buffer): void => capture(chunk, false)
      const finish = (exitCode: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        clearTimeout(killTimer)
        clearTimeout(closeTimer)
        signal?.removeEventListener('abort', stop)
        child.stdout.off('data', stdout)
        child.stderr.off('data', stderr)
        child.stdout.destroy()
        child.stderr.destroy()
        resolve({ exitCode, output, timedOut, failedToStart })
      }
      const stop = (): void => {
        if (settled || closeTimer) return
        timedOut = true
        child.kill()
        killTimer = setTimeout(() => child.kill('SIGKILL'), 250)
        // A descendant retaining stdio must not keep a probe waiter alive.
        closeTimer = setTimeout(() => {
          child.kill('SIGKILL')
          child.unref()
          finish(null)
        }, 750)
      }
      const timeout = setTimeout(stop, PROBE_TIMEOUT_MS)
      child.stdout.on('data', stdout)
      child.stderr.on('data', stderr)
      child.once('error', () => {
        failedToStart = true
        finish(null)
      })
      child.once('close', finish)
      signal?.addEventListener('abort', stop, { once: true })
      if (signal?.aborted) stop()
    })
  }
}
