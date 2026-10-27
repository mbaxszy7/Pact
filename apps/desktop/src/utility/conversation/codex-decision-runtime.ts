/* oxlint-disable no-await-in-loop -- Ancestor identity checks and one native notification consumer are deliberately sequential and bounded. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, lstat, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DECISION_DEADLINE_MS,
  DECISION_OUTPUT_BYTES,
  DECISION_CLEANUP_TARGET_MS,
  parseDecisionRecommendation,
  validateDecisionInput,
  type DecisionInput,
  type DecisionOutcome,
  type DecisionPhysicalWitness,
  type DecisionNativeStage,
  type SchedulingUsage,
} from '@pact/contracts'

import type {
  DecisionCapability,
  DecisionCapabilityReason,
  DecisionInputLoader,
  DecisionRuntime,
} from './decision-runtime'

import { OwnedProcessGroup } from '../owned-process-group'
import { CodexAppServerConnection } from './codex-app-server-connection'
import { codexProcessEnvironment } from './codex-process-environment'
import {
  assertDecisionEnvironment,
  decisionDarwinSandbox,
  resolveDecisionNativeExecutable,
  retainCodexInstallationId,
} from './decision-native-isolation'
import { createDecisionResponseGuard } from './decision-response-guard'
import { decisionRuntimePrompt } from './decision-runtime'
import {
  DecisionMemoryLease,
  type NativeMemoryReservation,
  type NativeMemoryAllocator,
} from './native-working-memory'

export type { DecisionInputLoader } from './decision-runtime'

const MODEL = 'gpt-6-luna'
const EFFORT = 'low'
const CATALOG_PAGE_ITEMS = 25
const CATALOG_PAGES = 8
const CATALOG_BYTES = 256 * 1024

const DISABLED = [
  'hooks',
  'plugins',
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'shell_tool',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'enable_request_compression',
]
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const object = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw Error('Invalid native metadata')
  return value
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Authority = {
  fingerprint: string
  accountId: string | null
  provider: Record<string, unknown>
  routingOverride: 'NO_CONSTRAINT' | 'us' | 'us_cr'
  destination: string
}
function isDecisionInputLoader(value: unknown): value is DecisionInputLoader {
  return typeof value === 'function'
}

/** One invocation. It has no business Adapter, Run dispatch or fallback authority. */
export class CodexDecisionRuntime implements DecisionRuntime {
  private readonly memory = new DecisionMemoryLease()
  private readonly nativeOwnerId = randomUUID()
  private readonly controller = new AbortController()
  private nativeExecutable: Awaited<ReturnType<typeof resolveDecisionNativeExecutable>> | undefined
  private installation: Awaited<ReturnType<typeof retainCodexInstallationId>> | undefined
  private nativeDiagnostics = {
    forkDenied: false,
    stateDenied: false,
    execServer: false,
    mcpStartup: false,
    shellSnapshot: false,
  }
  private nativeGeneration = 0
  private metadataRoute: { original: string; native: string } | undefined
  private mcpOverrides: Record<string, unknown> = {}
  private connection: CodexAppServerConnection | undefined
  private group: OwnedProcessGroup | undefined
  private guard: Awaited<ReturnType<typeof createDecisionResponseGuard>> | undefined
  private workspace: NativeMemoryReservation | undefined
  private directory: { path: string; dev: number; ino: number } | undefined
  private started = false
  private called = false
  private physical: Promise<boolean> | undefined
  private closeTask: Promise<boolean> | undefined
  private logicallySettled = false
  private logicalSettle: ((outcome: DecisionOutcome) => void) | undefined
  private cancelProbe: (() => void) | undefined
  private probing = false
  private deadlineAt = 0
  private phase = 'admission'
  private failure: string | undefined
  private failureReason: DecisionCapabilityReason | undefined
  private witness: DecisionPhysicalWitness | null = null
  private completionOutcome: DecisionOutcome | undefined
  private receiptRetirementUnconfirmed = false
  private refusalCode: number | undefined

  constructor(
    private readonly context: {
      executable: string | ((signal: AbortSignal) => Promise<string | undefined>)
      /** Absent only for host-global compatibility inspection; execution requires a Project. */
      cwd?: string
      current: () => boolean
      beginNativeStage?: (facts: {
        expectedGeneration: number
        stage: DecisionNativeStage
        previousWitness: DecisionPhysicalWitness | null
        previousPhysicalReleased: boolean
      }) => number
      /** Optional host admission deadline; native preparation never renews it. */
      deadlineAt?: number
      dispatch: () => void
      reserve?: (
        input: DecisionInput,
        facts: { deadlineAt: number },
      ) => 'reserved' | 'duplicate' | 'busy'
      prepared?: (facts: {
        witness: DecisionPhysicalWitness
        nativeGeneration: number
        configurationFingerprint: string
      }) => void
      /** Independent probe owner; called before native protocol I/O, without evaluation authority. */
      probePrepared?: (facts: {
        witness: DecisionPhysicalWitness
        nativeGeneration: number
      }) => void
      physicalPrepared?: (facts: {
        witness: DecisionPhysicalWitness
        nativeGeneration: number
      }) => void | Promise<void>
      retirePhysicalReceipts?: (facts: {
        memory: NativeMemoryAllocator
        deadlineAt: number
        signal?: AbortSignal
      }) => Promise<boolean>
      physicalCompletion?: (facts: {
        memory: NativeMemoryAllocator
        deadlineAt: number
        nativeGeneration: number
        witness: DecisionPhysicalWitness | null
        outcome?: DecisionOutcome
        usage?: SchedulingUsage
      }) => Promise<void>
      /** Native fixtures supply their owned environment; Conversation always inherits the original. */
      environment?: NodeJS.ProcessEnv
    },
  ) {}

  get invoked(): boolean {
    return this.called
  }
  get usage() {
    return this.guard?.usage
  }
  diagnostics() {
    return {
      phase: this.phase,
      native: { ...this.nativeDiagnostics },
      failure: this.failure,
      failureReason: this.failureReason,
      refusalCode: this.refusalCode,
      guard: this.guard?.facts,
      working: this.memory.diagnostics(),
    }
  }

  /** Only the exact native catalog, authority and executable are inspected; no Thread or Turn. */
  probeAdmission(signal?: AbortSignal): Promise<DecisionCapability> {
    const capability = (
      reason: DecisionCapabilityReason,
      physicalReleased: boolean,
      configurationFingerprint: string | null = null,
    ): DecisionCapability => ({
      provider: 'codex',
      modelId: MODEL,
      status: reason === 'supported' ? 'supported' : 'unavailable',
      supported: reason === 'supported',
      reason,
      configurationFingerprint,
      checkedAt: new Date().toISOString(),
      physicalReleased,
    })
    if (this.started) return Promise.resolve(capability('busy', this.memory.diagnostics().released))
    this.started = true
    this.probing = true
    this.deadlineAt = this.admissionDeadline()
    this.workspace = this.memory.reserve(4 * 1024 * 1024)
    return new Promise<DecisionCapability>((resolve) => {
      let settled = false
      const settle = (result: DecisionCapability) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        this.cancelProbe = undefined
        resolve(result)
      }
      const cancel = () => {
        this.controller.abort()
        settle(capability('cancelled', false))
      }
      const timer = setTimeout(
        () => {
          this.controller.abort()
          settle(capability('timeout', false))
        },
        Math.max(0, this.deadlineAt - Date.now()),
      )
      this.cancelProbe = cancel
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      // Publish ownership before resolving an executable or starting native I/O.
      // Logical timeout cannot release a resolver or a child that is still alive.
      const work = Promise.resolve()
        .then(() => this.prepareNative())
        .then(
          (prepared) => ({
            reason: 'supported' as DecisionCapabilityReason,
            fingerprint: prepared.configurationFingerprint,
          }),
          (error: unknown) => ({ reason: this.capabilityFailure(error), fingerprint: null }),
        )
      this.physical = work.then(async ({ reason, fingerprint }) => {
        const physicalReleased = await this.cleanup()
        settle(
          capability(
            physicalReleased ? reason : 'cleanup_unconfirmed',
            physicalReleased,
            fingerprint,
          ),
        )
        return physicalReleased
      })
    })
  }

  private capabilityFailure(error: unknown): DecisionCapabilityReason {
    if (
      error instanceof Error &&
      ['unsupported_protocol', 'stale', 'executable_unavailable', 'unsupported_network'].includes(
        error.message,
      )
    )
      this.failure = error.message
    if (
      error &&
      typeof error === 'object' &&
      ['ENOENT', 'ELOOP', 'EACCES', 'EPERM'].includes(String(Reflect.get(error, 'code')))
    )
      this.failure = String(Reflect.get(error, 'code'))
    if (Date.now() >= this.deadlineAt) return 'timeout'
    if (this.controller.signal.aborted) return 'cancelled'
    const known = new Map<string, DecisionCapabilityReason>([
      ['unsupported_protocol', 'unsupported_protocol'],
      ['stale', 'stale'],
      ['executable_unavailable', 'executable_unavailable'],
      ['unsupported_network', 'unsupported_network'],
      ['Unsupported decision runtime', 'unsupported_platform'],
      ['Unsupported native provider', 'unsupported_provider'],
      ['Unsupported native routing', 'unsupported_network'],
      ['Unsupported native authentication', 'unsupported_authentication'],
      ['Unsupported native protocol', 'unsupported_protocol'],
      ['Project authentication differs', 'project_authentication_differs'],
      ['Native executable unavailable', 'executable_unavailable'],
      ['Native model unavailable', 'model_unavailable'],
      ['Invalid native model metadata', 'model_metadata_invalid'],
      ['Native effort unavailable', 'model_effort_unavailable'],
      ['Native catalog capacity', 'catalog_limit'],
      ['Obsolete decision', 'stale'],
      ['Native decision configuration changed', 'stale'],
    ])
    return error instanceof Error ? (known.get(error.message) ?? 'unavailable') : 'unavailable'
  }

  private admissionDeadline(): number {
    const maximum = Date.now() + DECISION_DEADLINE_MS
    return Math.min(this.context.deadlineAt ?? maximum, maximum)
  }
  settlement(): Promise<boolean> {
    return this.physical ?? this.cleanup()
  }

  evaluateDecision(
    // oxlint-disable-next-line typescript/no-redundant-type-constituents -- Keep the host loader visible in the public input contract while validating all runtime values.
    value: unknown | DecisionInputLoader,
    signal: AbortSignal,
  ): Promise<DecisionOutcome> {
    if (this.started) return Promise.resolve({ kind: 'unavailable', reason: 'busy' })
    this.started = true
    this.deadlineAt = this.admissionDeadline()
    this.workspace = this.memory.reserve(4 * 1024 * 1024)
    return new Promise<DecisionOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const settle = (outcome: DecisionOutcome) => {
        if (this.logicallySettled) return
        this.completionOutcome = outcome
        this.logicallySettled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        this.logicalSettle = undefined
        resolve(outcome)
      }
      const cancel = () => {
        settle({ kind: 'unavailable', reason: 'cancelled' })
        this.controller.abort()
      }
      this.logicalSettle = settle
      timer = setTimeout(
        () => {
          settle({ kind: 'unavailable', reason: 'timeout' })
          this.controller.abort()
        },
        Math.max(0, this.deadlineAt - Date.now()),
      )
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      // Publish physical ownership before invoking host code. Cancellation may
      // settle advice immediately, but the loader must finish before its lease.
      const work = Promise.resolve()
        .then(() => this.loadAndRun(value))
        .then(
          async (outcome) => {
            if (outcome.kind === 'recommendation') {
              if (!this.logicallySettled) this.completionOutcome = outcome
              const released = await this.cleanup()
              settle(
                released
                  ? (this.completionOutcome ?? outcome)
                  : { kind: 'unavailable', reason: 'runtime_unavailable' },
              )
            } else settle(outcome)
            return undefined
          },
          (error) => {
            this.failureReason = this.capabilityFailure(error)
            const known = new Set([
              'Invalid native metadata',
              'Unsupported native provider',
              'Unsupported native routing',
              'Unsupported native authentication',
              'Unsupported native protocol',
              'Project authentication differs',
              'Invalid native account',
              'Invalid native endpoint',
              'Invalid native routing origin',
              'Native destination differs',
              'Native decision configuration changed',
              'Native model unavailable',
              'Invalid native model metadata',
              'Native effort unavailable',
              'Native catalog capacity',
              'Decision did not complete',
              'Foreign native decision event',
              'Foreign native decision turn',
              'Invalid decision answer',
              'Native operation refused',
              'Decision working capacity is full.',
            ])
            this.failure =
              error instanceof Error && known.has(error.message) ? error.message : 'unavailable'
            settle({
              kind: 'unavailable',
              reason: Date.now() >= this.deadlineAt ? 'timeout' : 'runtime_unavailable',
            })
          },
        )
      this.physical = work.then(() => this.cleanup())
    })
  }

  private checkDeadline(): void {
    this.controller.signal.throwIfAborted()
    if (Date.now() >= this.deadlineAt) throw Error('Decision deadline')
  }

  private async loadAndRun(value: unknown): Promise<DecisionOutcome> {
    this.checkDeadline()
    if (!this.context.cwd) return { kind: 'unavailable', reason: 'runtime_unavailable' }
    const loaded = isDecisionInputLoader(value)
      ? await value({
          signal: this.controller.signal,
          deadlineAt: this.deadlineAt,
        })
      : value
    this.checkDeadline()
    const admitted = validateDecisionInput(loaded)
    if (
      !admitted.success ||
      admitted.input.sources.some(
        (source) => createHash('sha256').update(source.text).digest('hex') !== source.digest,
      )
    )
      return { kind: 'unavailable', reason: 'invalid_input' }
    this.checkDeadline()
    let reserved: 'reserved' | 'duplicate' | 'busy'
    try {
      reserved = this.context.reserve?.(admitted.input, { deadlineAt: this.deadlineAt }) ?? 'busy'
    } catch {
      return { kind: 'unavailable', reason: 'stale' }
    }
    if (reserved !== 'reserved') return { kind: 'unavailable', reason: reserved }
    this.checkDeadline()
    return this.run(admitted.input)
  }

  dispose(): Promise<boolean> {
    this.logicalSettle?.({ kind: 'unavailable', reason: 'cancelled' })
    this.cancelProbe?.()
    this.controller.abort()
    return this.physical ?? this.cleanup()
  }

  private async rpc(method: string, params: object): Promise<Record<string, unknown>> {
    this.phase = method
    this.controller.signal.throwIfAborted()
    const remaining = this.deadlineAt - Date.now()
    if (remaining <= 0 || !this.connection) throw Error('Decision deadline')
    const message = await this.connection.request(method, params, {
      timeoutMs: Math.min(5_000, remaining),
      signal: this.controller.signal,
    })
    if (Reflect.has(message, 'error')) {
      const error = object(Reflect.get(message, 'error'))
      this.refusalCode = typeof error.code === 'number' ? error.code : undefined
      throw Error('Native operation refused')
    }
    return object(Reflect.get(message, 'result'))
  }

  private async resolveExecutable(): Promise<string> {
    this.checkDeadline()
    const executable =
      typeof this.context.executable === 'string'
        ? this.context.executable
        : await this.context.executable(this.controller.signal)
    this.checkDeadline()
    if (!executable) throw Error('Native executable unavailable')
    return executable
  }

  private provider(config: Record<string, unknown>) {
    const features =
      config.features === undefined || config.features === null ? {} : object(config.features)
    if (
      features.use_agent_identity === true ||
      features.respect_system_proxy === true ||
      config.network != null
    )
      throw Error('Unsupported native provider')
    const name = config.model_provider ?? 'openai'
    if (typeof name !== 'string' || name.length > 256) throw Error('Unsupported native provider')
    const custom = config.model_providers == null ? undefined : object(config.model_providers)[name]
    const definition = custom === undefined ? undefined : object(custom)
    if (
      definition &&
      (definition.wire_api !== 'responses' ||
        definition.requires_openai_auth !== true ||
        definition.env_key != null ||
        definition.experimental_bearer_token != null ||
        definition.gateway_oauth != null ||
        definition.auth != null ||
        definition.aws != null ||
        definition.query_params != null)
    )
      throw Error('Unsupported native provider')
    if (name !== 'openai' && !definition) throw Error('Unsupported native provider')
    const base =
      definition?.base_url ?? config.openai_base_url ?? 'https://chatgpt.com/backend-api/codex'
    if (
      definition &&
      (typeof definition.base_url !== 'string' ||
        Buffer.byteLength(JSON.stringify(definition)) > 16384)
    )
      throw Error('Unsupported native provider')
    const rawChatgptBase = config.chatgpt_base_url
    if (this.metadataRoute && rawChatgptBase !== this.metadataRoute.native)
      throw Error('Native decision configuration changed')
    const chatgptBase = this.metadataRoute?.original ?? rawChatgptBase ?? 'https://chatgpt.com'
    if (
      typeof base !== 'string' ||
      base.length > 4096 ||
      typeof chatgptBase !== 'string' ||
      chatgptBase.length > 4096
    )
      throw Error('Unsupported native routing')
    if (
      config.forced_chatgpt_workspace_id != null &&
      (typeof config.forced_chatgpt_workspace_id !== 'string' ||
        config.forced_chatgpt_workspace_id.length > 256)
    )
      throw Error('Unsupported native authentication')
    return {
      provider: name,
      definition,
      mcp: hash(config.mcp_servers ?? {}),
      mcpNames: Object.keys(object(config.mcp_servers ?? {})),
      base,
      chatgptBase,
      credentialStore: config.cli_auth_credentials_store ?? null,
      forcedWorkspace: config.forced_chatgpt_workspace_id ?? null,
    }
  }

  private async configuration() {
    // Extract only bounded scalar identity immediately. Two complete native
    // configuration DTOs must never remain resident across the next RPC.
    const before = this.context.cwd
      ? this.provider(
          object(
            (await this.rpc('config/read', { cwd: this.context.cwd, includeLayers: false })).config,
          ),
        )
      : undefined
    const local = this.provider(
      object(
        (await this.rpc('config/read', { cwd: this.directory!.path, includeLayers: false })).config,
      ),
    )
    if (before && hash(before) !== hash(local)) throw Error('Project authentication differs')
    return local
  }
  private async authority(): Promise<Authority> {
    if (!this.directory || !this.context.current()) throw Error('Obsolete decision')
    const env = this.context.environment ?? process.env
    if (
      [
        'OPENAI_BASE_URL',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'ALL_PROXY',
        'https_proxy',
        'http_proxy',
        'all_proxy',
        'OPENAI_ORGANIZATION',
        'OPENAI_PROJECT',
      ].some((key) => Boolean(env[key]))
    )
      throw Error('Unsupported native routing')
    const local = await this.configuration()
    this.guard?.metadataPhase(true)
    let account: Record<string, unknown>
    try {
      account = await this.rpc('account/read', { refreshToken: false })
    } finally {
      this.guard?.metadataPhase(false)
    }
    const identity = object(account.account)
    if (identity.type === 'apiKey' && account.requiresOpenaiAuth === true && local.definition) {
      const destination = new URL(local.base)
      if (
        destination.username ||
        destination.password ||
        destination.search ||
        destination.hash ||
        destination.protocol !== 'https:'
      )
        throw Error('Unsupported native routing')
      return {
        fingerprint: hash([local, identity]),
        accountId: null,
        routingOverride: 'NO_CONSTRAINT',
        destination: destination.href.replace(/\/$/u, ''),
        provider: local.definition,
      }
    }
    if (local.definition) throw Error('Unsupported native authentication')
    if (
      identity.type !== 'chatgpt' ||
      account.requiresOpenaiAuth !== true ||
      typeof identity.email !== 'string' ||
      !identity.email ||
      identity.email.length > 320
    )
      throw Error('Unsupported native authentication')
    const routing = object(account.workspaceRouting)
    if (
      typeof routing.chatgptAccountId !== 'string' ||
      !routing.chatgptAccountId ||
      routing.chatgptAccountId.length > 256 ||
      (routing.accountRoutingOverride !== 'NO_CONSTRAINT' &&
        routing.accountRoutingOverride !== 'us' &&
        routing.accountRoutingOverride !== 'us_cr')
    )
      throw Error('Invalid native account')
    const backend = new URL(String(routing.backendOrigin)),
      destination = new URL(local.base)
    for (const url of [backend, destination])
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw Error('Invalid native endpoint')
    if (backend.pathname !== '/') throw Error('Invalid native routing origin')
    if (destination.pathname.replace(/\/$/u, '').endsWith('/backend-api/codex')) {
      destination.protocol = backend.protocol
      destination.host = backend.host
    } else if (destination.origin !== backend.origin) throw Error('Native destination differs')
    return {
      fingerprint: hash([local, routing, identity]),
      accountId: routing.chatgptAccountId,
      routingOverride: routing.accountRoutingOverride,
      destination: destination.href.replace(/\/$/u, ''),
      provider: {
        name: 'OpenAI',
        wire_api: 'responses',
        requires_openai_auth: true,
        http_headers: {
          version: '0.163.0',
          ...(routing.accountRoutingOverride === 'NO_CONSTRAINT'
            ? {}
            : { 'x-openai-account-routing-override': routing.accountRoutingOverride }),
        },
      },
    }
  }

  private async exactModel(): Promise<string> {
    const cursors = new Set<string>()
    let cursor: string | undefined,
      bytes = 0,
      selected: string | undefined
    for (let page = 0; page < CATALOG_PAGES; page++) {
      const result = await this.rpc('model/list', {
        limit: CATALOG_PAGE_ITEMS,
        includeHidden: false,
        ...(cursor === undefined ? {} : { cursor }),
      })
      bytes += Buffer.byteLength(JSON.stringify(result))
      if (bytes > CATALOG_BYTES) throw Error('Native catalog capacity')
      if (!Array.isArray(result.data) || result.data.length > CATALOG_PAGE_ITEMS)
        throw Error('Invalid native model metadata')
      for (const value of result.data) {
        if (
          !isRecord(value) ||
          typeof value.id !== 'string' ||
          !value.id ||
          value.id.length > 256 ||
          typeof value.model !== 'string' ||
          !value.model ||
          value.model.length > 256
        )
          throw Error('Invalid native model metadata')
        // Picker aliases and upgrades do not prove the explicitly selected native model.
        if (value.id !== MODEL || value.model !== MODEL) continue
        if (
          selected !== undefined ||
          typeof value.hidden !== 'boolean' ||
          !Array.isArray(value.inputModalities) ||
          value.inputModalities.length > 8 ||
          !value.inputModalities.every((item) => typeof item === 'string' && item.length <= 32) ||
          !Array.isArray(value.supportedReasoningEfforts) ||
          value.supportedReasoningEfforts.length > 16 ||
          !value.supportedReasoningEfforts.every(
            (effort) =>
              isRecord(effort) &&
              typeof effort.reasoningEffort === 'string' &&
              effort.reasoningEffort.length <= 32,
          )
        )
          throw Error('Invalid native model metadata')
        if (value.hidden || !value.inputModalities.includes('text'))
          throw Error('Native model unavailable')
        if (!value.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === EFFORT))
          throw Error('Native effort unavailable')
        // Keep only the full native metadata digest between bounded pages.
        selected = hash(value)
      }
      if (result.nextCursor === null) {
        if (!selected) throw Error('Native model unavailable')
        return selected
      }
      if (
        typeof result.nextCursor !== 'string' ||
        !result.nextCursor ||
        result.nextCursor.length > 1024 ||
        cursors.has(result.nextCursor)
      )
        throw Error('Invalid native model metadata')
      cursors.add(result.nextCursor)
      cursor = result.nextCursor
    }
    throw Error('Native catalog capacity')
  }

  private async prepareNative() {
    this.checkDeadline()
    const env = this.context.environment ?? process.env
    assertDecisionEnvironment(env)
    if (process.platform !== 'darwin') throw Error('Unsupported decision runtime')
    if (!this.context.current()) throw Error('Obsolete decision')
    const executable = await this.resolveExecutable()
    this.nativeExecutable = await resolveDecisionNativeExecutable(executable, 'codex')
    const executableBefore = await stat(executable).catch(() => {
      throw Error('Native executable unavailable')
    })
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pact-decision-')))
    const identity = await lstat(directory)
    this.directory = { path: directory, dev: identity.dev, ino: identity.ino }
    // Empty directory alone is not enough: disable document inheritance before native startup.
    for (
      let ancestor = dirname(directory);
      ancestor !== dirname(ancestor);
      ancestor = dirname(ancestor)
    ) {
      try {
        await lstat(join(ancestor, '.git'))
        throw Error('Decision CWD is inside a repository')
      } catch (error) {
        if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'ENOENT')
          throw error
      }
    }
    if (this.context.retirePhysicalReceipts) {
      let admitted: boolean
      try {
        admitted = await this.context.retirePhysicalReceipts({
          memory: this.memory,
          deadlineAt: Math.min(this.deadlineAt, Date.now() + DECISION_CLEANUP_TARGET_MS),
          signal: this.controller.signal,
        })
      } catch (error) {
        this.receiptRetirementUnconfirmed = true
        throw error
      }
      if (!admitted) throw Error('Decision receipt capacity unavailable')
    }
    this.checkDeadline()
    this.installation = await retainCodexInstallationId(
      env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'),
    )
    this.guard = await createDecisionResponseGuard(
      undefined,
      this.memory,
      Math.max(1, this.deadlineAt - Date.now()),
    )
    const startStage = async (stage: DecisionNativeStage, metadata: boolean) => {
      this.checkDeadline()
      const previousWitness = this.witness
      const next =
        this.context.beginNativeStage?.({
          expectedGeneration: this.nativeGeneration,
          stage,
          previousWitness,
          previousPhysicalReleased: true,
        }) ?? this.nativeGeneration + 1
      if (next !== this.nativeGeneration + 1) throw Error('Unsupported native protocol')
      this.nativeGeneration = next
      this.witness = null
      this.group = new OwnedProcessGroup({
        signal: this.controller.signal,
        startupObservationMs: 2_000,
        ownerId: this.nativeOwnerId,
        memory: this.memory,
        deadlineAt: this.deadlineAt,
        ...(this.context.physicalPrepared
          ? {
              physicalPrepared: async (witness: DecisionPhysicalWitness) => {
                this.witness = witness
                await this.context.physicalPrepared!({
                  witness,
                  nativeGeneration: this.nativeGeneration,
                })
              },
            }
          : {}),
      })
      const args = [
        'app-server',
        ...DISABLED.flatMap((feature) => ['--disable', feature]),
        '-c',
        'project_doc_max_bytes=0',
        '-c',
        'web_search="disabled"',
        '-c',
        `sqlite_home=${JSON.stringify(directory)}`,
        '-c',
        `log_dir=${JSON.stringify(directory)}`,
      ]
      if (metadata)
        args.push('-c', `chatgpt_base_url=${JSON.stringify(this.metadataRoute!.native)}`)
      const expectedOriginator = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? 'pact'
      const sandbox = decisionDarwinSandbox(
        this.nativeExecutable!.path,
        directory,
        this.guard!.port,
        this.installation!.path,
      )
      const child = this.group.spawn(sandbox.command, [...sandbox.args, ...args], {
        cwd: directory,
        env: {
          ...codexProcessEnvironment(undefined, env),
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: expectedOriginator,
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
        },
      })
      child.stderr.on('data', (chunk: Buffer) => {
        const category = chunk.subarray(0, 16384).toString('utf8')
        this.nativeDiagnostics.forkDenied ||= /failed to spawn|Operation not permitted/u.test(
          category,
        )
        this.nativeDiagnostics.stateDenied ||=
          /Permission denied|Read-only file|failed to initialize sqlite/u.test(category)
        this.nativeDiagnostics.execServer ||= /exec.server/u.test(category)
        this.nativeDiagnostics.mcpStartup ||= /mcp|MCP/u.test(category)
        this.nativeDiagnostics.shellSnapshot ||= /shell.snapshot/u.test(category)
      })
      this.connection = new CodexAppServerConnection(
        child,
        undefined,
        () => this.group!.close(),
        undefined,
        () => this.context.current() && !this.controller.signal.aborted,
        this.memory,
      )
      this.connection.subscribeServerRequests((message) => {
        const id = Reflect.get(message, 'id')
        if (typeof id === 'string' || typeof id === 'number')
          void this.connection
            ?.respondError(id, 'Decision requests cannot invoke tools')
            .catch(() => undefined)
        this.controller.abort()
        return true
      })
      if (this.context.physicalPrepared || (this.probing && this.context.probePrepared)) {
        this.phase = 'physical_witness'
        const witness = await this.group.physicalWitness(this.nativeOwnerId)
        this.witness = witness
        this.checkDeadline()
        if (!this.context.current()) throw Error('Obsolete decision')
        await this.context.physicalPrepared?.({ witness, nativeGeneration: this.nativeGeneration })
        if (this.probing)
          this.context.probePrepared?.({ witness, nativeGeneration: this.nativeGeneration })
      }
      const initialized = await this.rpc('initialize', {
        clientInfo: { name: 'pact', title: 'Pact Relay', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      })
      const prefix = `${expectedOriginator}/`
      const nativeVersion =
        typeof initialized.userAgent === 'string' && initialized.userAgent.startsWith(prefix)
          ? /^(\S+)(?:\s|$)/u.exec(initialized.userAgent.slice(prefix.length))?.[1]
          : undefined
      if (
        nativeVersion !== '0.163.0' ||
        initialized.platformOs !== 'macos' ||
        typeof initialized.codexHome !== 'string' ||
        !initialized.codexHome ||
        initialized.codexHome.length > 32_768 ||
        initialized.codexHome !== this.installation!.home ||
        !(await this.installation!.current())
      )
        throw Error('Unsupported native protocol')
      await this.connection.notify('initialized', {}, { signal: this.controller.signal })
    }
    await startStage('host_metadata', false)
    const originalConfiguration = await this.configuration()
    if (originalConfiguration.mcpNames.length > 128) throw Error('Unsupported native protocol')
    this.mcpOverrides = Object.fromEntries(
      originalConfiguration.mcpNames.map((name) => [name, { enabled: false }]),
    )
    await this.closeNativeStage()
    this.guard.setMetadataDestination(originalConfiguration.chatgptBase)
    this.metadataRoute = {
      original: originalConfiguration.chatgptBase,
      native: this.guard.metadataBaseUrl,
    }
    await startStage('guarded_context', true)
    if (hash(await this.configuration()) !== hash(originalConfiguration))
      throw Error('Native decision configuration changed')
    const nativeAuthority = await this.authority()
    this.guard.setDestination(nativeAuthority.destination)
    const modelFingerprint = await this.exactModel()
    const executableCurrent = async () => {
      const resolved = await this.resolveExecutable()
      if (
        resolved !== executable ||
        !(await this.nativeExecutable!.current()) ||
        !(await this.installation!.current())
      )
        return false
      const current = await stat(resolved)
      this.checkDeadline()
      return (
        current.dev === executableBefore.dev &&
        current.ino === executableBefore.ino &&
        current.mtimeMs === executableBefore.mtimeMs &&
        current.ctimeMs === executableBefore.ctimeMs &&
        current.mode === executableBefore.mode &&
        current.size === executableBefore.size
      )
    }
    if (
      !this.context.current() ||
      !(await executableCurrent()) ||
      hash(await this.authority()) !== hash(nativeAuthority)
    )
      throw Error('Native decision configuration changed')
    this.checkDeadline()
    const configurationFingerprint = hash({
      provider: 'codex',
      model: MODEL,
      effort: EFFORT,
      modelFingerprint,
      authority: nativeAuthority.fingerprint,
      scope: this.context.cwd ? { kind: 'project', cwd: this.context.cwd } : { kind: 'host' },
      executable: {
        path: executable,
        dev: executableBefore.dev,
        ino: executableBefore.ino,
        mtimeMs: executableBefore.mtimeMs,
        ctimeMs: executableBefore.ctimeMs,
        mode: executableBefore.mode,
        size: executableBefore.size,
      },
      protocol: {
        nativeVersion: '0.163.0',
        codexHome: this.installation.home,
        platformOs: 'macos',
      },
    })
    const verifyOriginal = async () => {
      this.guard?.stopForwarding()
      await this.closeNativeStage()
      this.metadataRoute = undefined
      await startStage('project_verification', false)
      if (hash(await this.configuration()) !== hash(originalConfiguration))
        throw Error('Native decision configuration changed')
    }
    return {
      nativeAuthority,
      directory,
      executableCurrent,
      configurationFingerprint,
      verifyOriginal,
    }
  }

  private async run(input: DecisionInput): Promise<DecisionOutcome> {
    const {
      nativeAuthority,
      directory,
      executableCurrent,
      configurationFingerprint,
      verifyOriginal,
    } = await this.prepareNative()
    const connection = this.connection
    if (!connection) throw Error('Native connection unavailable')
    const providerId = `pact_decision_${randomUUID().replaceAll('-', '')}`
    const prompt = decisionRuntimePrompt(input) + JSON.stringify(input)
    const started = await this.rpc('thread/start', {
      cwd: directory,
      ephemeral: true,
      model: MODEL,
      modelProvider: providerId,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      allowProviderModelFallback: false,
      dynamicTools: [],
      environments: [],
      selectedCapabilityRoots: [],
      baseInstructions: 'Provide bounded decision advice using only supplied facts.',
      developerInstructions: 'Never execute tools or broaden authorization.',
      config: {
        chatgpt_base_url: this.metadataRoute!.original,
        mcp_servers: this.mcpOverrides,
        [`model_providers.${providerId}`]: {
          ...Object.fromEntries(
            Object.entries(nativeAuthority.provider).filter(([, value]) => value !== null),
          ),
          base_url: this.guard!.baseUrl,
          supports_websockets: false,
          request_max_retries: 0,
          stream_max_retries: 0,
          capabilities: {
            ...object(nativeAuthority.provider.capabilities ?? {}),
            remote_compaction: 'unsupported',
            external_web_access: false,
          },
        },
      },
    })
    const thread = object(started.thread),
      sandbox = object(started.sandbox)
    if (
      started.model !== MODEL ||
      started.modelProvider !== providerId ||
      started.cwd !== directory ||
      thread.cwd !== directory ||
      thread.ephemeral !== true ||
      typeof thread.id !== 'string' ||
      sandbox.type !== 'readOnly' ||
      sandbox.networkAccess !== false
    )
      throw Error('Native decision configuration changed')
    const threadId = thread.id
    this.guard!.bind({
      threadId,
      prompt,
      accountId: nativeAuthority.accountId,
      routingOverride: nativeAuthority.routingOverride,
      current: async () => {
        if (
          !this.context.current() ||
          !(await executableCurrent()) ||
          hash(await this.authority()) !== hash(nativeAuthority)
        )
          return false
        const witness = await this.group!.physicalWitness(this.nativeOwnerId)
        this.witness = witness
        if (!this.context.current() || this.controller.signal.aborted) return false
        this.context.prepared?.({
          witness,
          configurationFingerprint,
          nativeGeneration: this.nativeGeneration,
        })
        return true
      },
      dispatch: () => {
        if (!this.context.current() || this.controller.signal.aborted)
          throw Error('Obsolete decision dispatch')
        this.context.dispatch()
        this.called = true
      },
    })
    await this.rpc('turn/start', {
      threadId,
      model: MODEL,
      effort: EFFORT,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      environments: [],
    })
    let answer: string | undefined, turnId: string | undefined
    for (;;) {
      this.controller.signal.throwIfAborted()
      const event = await connection.nextNotification(
        Math.max(1, this.deadlineAt - Date.now()),
        this.controller.signal,
      )
      const method = Reflect.get(event, 'method'),
        params = object(Reflect.get(event, 'params') ?? {})
      if (params.threadId !== undefined && params.threadId !== threadId)
        throw Error('Foreign native decision event')
      if (typeof params.turnId === 'string') {
        if (turnId && params.turnId !== turnId) throw Error('Foreign native decision turn')
        turnId = params.turnId
      }
      const item = params.item === undefined ? undefined : object(params.item)
      if (
        method === 'item/started' &&
        item &&
        [
          'commandExecution',
          'mcpToolCall',
          'dynamicToolCall',
          'webSearch',
          'imageGeneration',
        ].includes(String(item.type))
      )
        throw Error('Unexpected native tool execution')
      if (method === 'item/completed' && item?.type === 'agentMessage') {
        if (
          answer !== undefined ||
          typeof item.text !== 'string' ||
          Buffer.byteLength(item.text) > DECISION_OUTPUT_BYTES
        )
          throw Error('Invalid decision answer')
        answer = item.text
      }
      if (method === 'turn/completed') {
        if (
          object(params.turn).status !== 'completed' ||
          answer === undefined ||
          !this.context.current()
        )
          throw Error('Decision did not complete')
        const parsed = parseDecisionRecommendation(answer, input)
        if (!parsed.success) return { kind: 'unavailable', reason: 'invalid_output' }
        if (
          !(await executableCurrent()) ||
          hash(await this.authority()) !== hash(nativeAuthority) ||
          !this.context.current()
        )
          return { kind: 'unavailable', reason: 'stale' }
        await verifyOriginal()
        this.checkDeadline()
        return { kind: 'recommendation', recommendation: parsed.recommendation }
      }
    }
  }

  private async closeNativeStage(): Promise<void> {
    const results = await Promise.allSettled([this.connection?.close(), this.group?.close()])
    if (results.some((x) => x.status === 'rejected') || (this.group && !this.group.released))
      throw Error('Unsupported native protocol')
    this.connection = undefined
    this.group = undefined
    if (this.installation && !(await this.installation.current()))
      throw Error('Native decision configuration changed')
  }
  private cleanup(): Promise<boolean> {
    if (this.closeTask) return this.closeTask
    this.started = true
    this.controller.abort()
    this.closeTask = (async () => {
      const cleanupDeadline = Date.now() + DECISION_CLEANUP_TARGET_MS
      this.guard?.stopForwarding()
      const results = await Promise.allSettled([this.connection?.close(), this.group?.close()])
      if (
        this.receiptRetirementUnconfirmed ||
        results.some((result) => result.status === 'rejected') ||
        (this.group && !this.group.released)
      )
        return false
      if (this.installation) {
        if (!(await this.installation.current().catch(() => false))) {
          this.completionOutcome = { kind: 'unavailable', reason: 'stale' }
          this.failureReason = 'stale'
        }
      }
      await this.guard?.close()
      await this.installation?.close()
      if (this.directory) {
        const current = await lstat(this.directory.path)
        if (
          current.dev !== this.directory.dev ||
          current.ino !== this.directory.ino ||
          !current.isDirectory()
        )
          return false
        await rm(this.directory.path, { recursive: true, force: false })
      }
      await this.context.physicalCompletion?.({
        memory: this.memory,
        deadlineAt: cleanupDeadline,
        nativeGeneration: this.nativeGeneration,
        witness: this.witness,
        ...(this.completionOutcome ? { outcome: this.completionOutcome } : {}),
        ...(this.usage ? { usage: this.usage } : {}),
      })
      this.workspace?.release()
      this.workspace = undefined
      this.memory.release()
      return true
    })().catch(() => false)
    return this.closeTask
  }
}
