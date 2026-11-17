import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  providerUsageSnapshotSchema,
  type ProviderUsageCancelResult,
  type ProviderUsageProvider,
  type ProviderUsageSnapshot,
  type ProviderUsageStatus,
  type ProviderUsageUtilityCancelInput,
  type ProviderUsageUtilityRefreshInput,
  type ProviderUsageWindow,
  type RpcResult,
} from '@pact/contracts'

import { codexProcessEnvironment } from '../conversation/codex-process-environment'
import { runClaudeInfoProbe, runCodexInfoProbe } from '../native-info-probe'
import { OwnedProcessGroup } from '../owned-process-group'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation'

const TOTAL_DEADLINE_MS = 24_000
const CLEANUP_RESERVE_MS = 4_000
const QUERY_TIMEOUT_MS = 20_000
const CANCEL_WAIT_MS = 5_000
const COOLDOWN_MS = 30_000
const RATE_LIMIT_BACKOFF_MS = 60_000
const FRESHNESS_MS = 5 * 60 * 1000
const MAX_RAW_BYTES = 1024 * 1024
const MAX_FRAME_BYTES = 256 * 1024

interface ConfirmedUsageWindows {
  readonly configKey: string
  readonly identityDigest: string
  readonly fiveHour: ProviderUsageWindow | null
  readonly sevenDay: ProviderUsageWindow | null
  readonly checkedAt: string
  readonly checkedAtMs: number
  degraded: boolean
}

interface NonWindowOutcome {
  readonly configKey: string
  readonly status: 'unauthenticated' | 'not_applicable' | 'unsupported' | 'unavailable'
  readonly checkedAt: string | null
  readonly identityConfirmed: boolean
  readonly identityDigest: string | null
  readonly message: string
}

interface ActiveUsageProbe {
  readonly ownerId: string
  readonly requestId: string
  readonly controller: AbortController
  cancelling: boolean
  task: Promise<RpcResult<ProviderUsageSnapshot>>
  readonly settled: Promise<void>
  readonly resolveSettled: () => void
}

interface ProviderSlot {
  revision: number
  windows: ConfirmedUsageWindows | undefined
  nonWindow: NonWindowOutcome | undefined
  cooldownUntilMs: number
  unconfirmedProbes: Set<OwnedProcessGroup>
  activeIdentityConfirmed: boolean
  active: ActiveUsageProbe | undefined
}

interface ProbeOutcome {
  status: ProviderUsageStatus
  fiveHour: ProviderUsageWindow | null
  sevenDay: ProviderUsageWindow | null
  identityConfirmed: boolean
  identityDigest: string | null
  message?: string
  rateLimited?: boolean
}

function isProbeSettled(probe: OwnedProcessGroup): boolean {
  return probe.released || probe.settledAfterCloseTimeout()
}

function sha256Digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function clampPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, Math.round(value)))
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function normalizeUnixSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const ms = value * 1000
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function isWindowExpired(window: ProviderUsageWindow | null, nowMs: number): boolean {
  if (!window?.resetsAt) return false
  const resetsMs = Date.parse(window.resetsAt)
  return Number.isFinite(resetsMs) && resetsMs <= nowMs
}

function looksRateLimited(error: unknown): boolean {
  const message =
    error instanceof Error && typeof error.message === 'string' ? error.message.toLowerCase() : ''
  return message.includes('429') || message.includes('rate limit') || message.includes('too many')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function stringProperty(record: object, key: string): string | undefined {
  const value = Reflect.get(record, key)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function objectProperty(record: object, key: string): object | undefined {
  const value = Reflect.get(record, key)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Utility-owned readout for Codex and Claude Code 5h/7d plan utilization windows.
 * Owns per-provider single-slot execution, PII-free normalization, bounded cache,
 * cooldown/freshness, cancellation, and physical cleanup confirmation.
 */
export class ProviderUsage {
  private readonly probeRoot: string
  private readonly probes = new Set<OwnedProcessGroup>()
  private readonly slots: Record<ProviderUsageProvider, ProviderSlot> = {
    codex: {
      revision: 0,
      windows: undefined,
      nonWindow: undefined,
      cooldownUntilMs: 0,
      unconfirmedProbes: new Set(),
      activeIdentityConfirmed: false,
      active: undefined,
    },
    claude: {
      revision: 0,
      windows: undefined,
      nonWindow: undefined,
      cooldownUntilMs: 0,
      unconfirmedProbes: new Set(),
      activeIdentityConfirmed: false,
      active: undefined,
    },
  }
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly runtimePreparation: RuntimePreparation,
    workspaceStorageRoot: string,
  ) {
    this.probeRoot = join(workspaceStorageRoot, 'provider-usage-probe')
  }

  read(provider: ProviderUsageProvider): RpcResult<ProviderUsageSnapshot> {
    if (this.disposed) {
      return {
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Pact is shutting down.' },
      }
    }
    return { ok: true, value: this.projectSnapshot(provider) }
  }

  async refresh(
    input: ProviderUsageUtilityRefreshInput,
  ): Promise<RpcResult<ProviderUsageSnapshot>> {
    if (this.disposed) {
      return {
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Pact is shutting down.' },
      }
    }
    const slot = this.slots[input.provider]
    if (this.reconcileUnconfirmedProbes(slot)) {
      return {
        ok: true,
        value: this.buildSnapshot(input.provider, {
          status: 'close_unconfirmed',
          fiveHour: null,
          sevenDay: null,
          checkedAt: null,
          identityConfirmed: false,
          message: 'Cleanup pending',
        }),
      }
    }

    if (slot.active) {
      if (slot.active.ownerId === input.ownerId && slot.active.requestId === input.requestId) {
        return slot.active.task
      }
      if (slot.active.cancelling) {
        return {
          ok: true,
          value: this.projectActiveOverlay(input.provider, 'cancelling'),
        }
      }
      return {
        ok: true,
        value: this.projectActiveOverlay(input.provider, 'busy'),
      }
    }

    const nowMs = Date.now()
    const currentConfigKey = this.runtimePreparation.providerConfigurationKey(input.provider)
    let configChanged = false
    if (slot.windows && slot.windows.configKey !== currentConfigKey) {
      slot.windows = undefined
      configChanged = true
    }
    if (slot.nonWindow && slot.nonWindow.configKey !== currentConfigKey) {
      slot.nonWindow = undefined
      configChanged = true
    }
    if (configChanged) {
      slot.cooldownUntilMs = 0
    }
    if (nowMs < slot.cooldownUntilMs) {
      return { ok: true, value: this.projectSnapshot(input.provider) }
    }

    const controller = new AbortController()
    let resolveSettled!: () => void
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })

    const active: ActiveUsageProbe = {
      ownerId: input.ownerId,
      requestId: input.requestId,
      controller,
      cancelling: false,
      task: Promise.resolve({
        ok: false,
        error: { code: 'INTERNAL', message: 'Uninitialized usage probe.' },
      }),
      settled,
      resolveSettled,
    }
    slot.active = active

    const task = this.executeProbe(input.provider, currentConfigKey, active, slot)
    active.task = task
    return task
  }

  async cancel(
    input: ProviderUsageUtilityCancelInput,
  ): Promise<RpcResult<ProviderUsageCancelResult>> {
    const slot = this.slots[input.provider]
    const active = slot.active
    if (!active || active.ownerId !== input.ownerId || active.requestId !== input.requestId) {
      return { ok: true, value: { cancelled: false, settled: true } }
    }
    active.cancelling = true
    active.controller.abort()
    const settledBeforeDeadline = await Promise.race([
      active.settled.then(() => true),
      delay(CANCEL_WAIT_MS).then(() => false),
    ])
    return {
      ok: true,
      value: {
        cancelled: true,
        settled: settledBeforeDeadline && !this.reconcileUnconfirmedProbes(slot),
      },
    }
  }

  async releaseOwner(ownerId: string): Promise<RpcResult<{ ready: true }>> {
    const pending: Promise<unknown>[] = []
    for (const provider of ['codex', 'claude'] as const) {
      const active = this.slots[provider].active
      if (!active || active.ownerId !== ownerId) continue
      active.cancelling = true
      active.controller.abort()
      pending.push(Promise.race([active.settled, delay(CANCEL_WAIT_MS)]))
    }
    await Promise.allSettled(pending)
    return { ok: true, value: { ready: true } }
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.disposal ??= (async () => {
      const pending: Promise<void>[] = []
      for (const provider of ['codex', 'claude'] as const) {
        const active = this.slots[provider].active
        if (!active) continue
        active.cancelling = true
        active.controller.abort()
        pending.push(active.settled)
      }
      await Promise.allSettled(pending)
      const closeResults = await Promise.allSettled([...this.probes].map((probe) => probe.close()))
      for (const probe of this.probes) {
        if (isProbeSettled(probe)) this.probes.delete(probe)
      }
      const codexUnconfirmed = this.reconcileUnconfirmedProbes(this.slots.codex)
      const claudeUnconfirmed = this.reconcileUnconfirmedProbes(this.slots.claude)
      if (
        closeResults.some((result) => result.status === 'rejected') ||
        this.probes.size > 0 ||
        codexUnconfirmed ||
        claudeUnconfirmed
      ) {
        throw new Error('Provider usage probes did not finish closing.')
      }
    })()
    return this.disposal
  }

  private async executeProbe(
    provider: ProviderUsageProvider,
    startConfigKey: string,
    active: ActiveUsageProbe,
    slot: ProviderSlot,
  ): Promise<RpcResult<ProviderUsageSnapshot>> {
    slot.activeIdentityConfirmed = false
    const deadline = Date.now() + TOTAL_DEADLINE_MS
    let configKey = startConfigKey
    let timedOut = false
    const deadlineTimer = setTimeout(() => {
      timedOut = true
      active.controller.abort(new Error('Provider usage check timed out.'))
    }, TOTAL_DEADLINE_MS)

    try {
      await mkdir(this.probeRoot, { recursive: true, mode: 0o700 })
      active.controller.signal.throwIfAborted()

      const preparation = await this.runtimePreparation.inspectReadiness(active.controller.signal)
      active.controller.signal.throwIfAborted()
      // prepareEnvironment() inside inspectReadiness may populate PATH on macOS cold start;
      // lock the configuration key against the resolved environment before probing.
      configKey = this.runtimePreparation.providerConfigurationKey(provider)
      if (!preparation.ok) {
        return {
          ok: true,
          value: this.handleProbeFailure(provider, configKey, slot, {
            status: 'unavailable',
            message: 'Unavailable',
            clearCache: false,
            rateLimited: false,
          }),
        }
      }

      const agent = preparation.value.agents.find((candidate) => candidate.agentId === provider)
      if (!agent || agent.state === 'missing' || !agent.executablePath) {
        const checkedAtMs = Date.now()
        slot.cooldownUntilMs = checkedAtMs + COOLDOWN_MS
        return {
          ok: true,
          value: this.recordNonWindowOutcome(provider, slot, {
            configKey,
            status: 'unavailable',
            checkedAt: new Date(checkedAtMs).toISOString(),
            identityConfirmed: false,
            identityDigest: null,
            message: 'Not installed',
          }),
        }
      }
      if (agent.state === 'unsupported_version') {
        const checkedAtMs = Date.now()
        slot.cooldownUntilMs = checkedAtMs + COOLDOWN_MS
        return {
          ok: true,
          value: this.recordNonWindowOutcome(provider, slot, {
            configKey,
            status: 'unsupported',
            checkedAt: new Date(checkedAtMs).toISOString(),
            identityConfirmed: false,
            identityDigest: null,
            message: 'Update CLI',
          }),
        }
      }
      if (agent.state === 'authentication_required') {
        const checkedAtMs = Date.now()
        slot.cooldownUntilMs = checkedAtMs + COOLDOWN_MS
        return {
          ok: true,
          value: this.recordNonWindowOutcome(provider, slot, {
            configKey,
            status: 'unauthenticated',
            checkedAt: new Date(checkedAtMs).toISOString(),
            identityConfirmed: false,
            identityDigest: null,
            message: 'Sign in required',
          }),
        }
      }
      if (agent.state === 'startup_failed' || agent.state === 'cannot_verify') {
        return {
          ok: true,
          value: this.handleProbeFailure(provider, configKey, slot, {
            status: 'unavailable',
            message: 'Unavailable',
            clearCache: false,
            rateLimited: false,
          }),
        }
      }

      const queryBudgetMs = Math.min(QUERY_TIMEOUT_MS, deadline - Date.now() - CLEANUP_RESERVE_MS)
      if (queryBudgetMs <= 0) {
        throw new Error('Provider usage check reached its deadline.')
      }

      const outcome =
        provider === 'codex'
          ? await this.probeCodexUsage(
              agent.executablePath,
              configKey,
              active.controller.signal,
              queryBudgetMs,
              slot,
            )
          : await this.probeClaudeUsage(
              agent.executablePath,
              configKey,
              active.controller.signal,
              queryBudgetMs,
              slot,
            )

      if (this.reconcileUnconfirmedProbes(slot)) {
        slot.windows = undefined
        slot.nonWindow = undefined
        return {
          ok: true,
          value: this.buildSnapshot(provider, {
            status: 'close_unconfirmed',
            fiveHour: null,
            sevenDay: null,
            checkedAt: null,
            identityConfirmed: false,
            message: 'Cleanup pending',
          }),
        }
      }

      if (this.runtimePreparation.providerConfigurationKey(provider) !== configKey) {
        slot.windows = undefined
        slot.nonWindow = undefined
        return {
          ok: true,
          value: this.buildSnapshot(provider, {
            status: 'unavailable',
            fiveHour: null,
            sevenDay: null,
            checkedAt: null,
            identityConfirmed: false,
            message: 'Unavailable',
          }),
        }
      }

      const hasUsableWindows =
        (outcome.status === 'ready' || outcome.status === 'partial') &&
        outcome.identityConfirmed &&
        outcome.identityDigest !== null &&
        (outcome.fiveHour !== null || outcome.sevenDay !== null)

      const checkedAtMs = Date.now()
      const checkedAt = new Date(checkedAtMs).toISOString()
      slot.cooldownUntilMs =
        checkedAtMs + (outcome.rateLimited ? RATE_LIMIT_BACKOFF_MS : COOLDOWN_MS)

      if (hasUsableWindows && outcome.identityDigest !== null) {
        slot.nonWindow = undefined
        slot.windows = {
          configKey,
          identityDigest: outcome.identityDigest,
          fiveHour: outcome.fiveHour,
          sevenDay: outcome.sevenDay,
          checkedAt,
          checkedAtMs,
          degraded: false,
        }
        return {
          ok: true,
          value: this.buildSnapshot(provider, {
            status: outcome.status,
            fiveHour: outcome.fiveHour,
            sevenDay: outcome.sevenDay,
            checkedAt,
            identityConfirmed: true,
          }),
        }
      }

      const nonWindowStatus: NonWindowOutcome['status'] =
        outcome.status === 'unauthenticated' ||
        outcome.status === 'not_applicable' ||
        outcome.status === 'unsupported'
          ? outcome.status
          : 'unavailable'

      return {
        ok: true,
        value: this.recordNonWindowOutcome(provider, slot, {
          configKey,
          status: nonWindowStatus,
          checkedAt,
          identityConfirmed: outcome.identityConfirmed,
          identityDigest: outcome.identityDigest,
          message: outcome.message ?? 'Unavailable',
        }),
      }
    } catch (error) {
      if (this.reconcileUnconfirmedProbes(slot)) {
        slot.windows = undefined
        slot.nonWindow = undefined
        return {
          ok: true,
          value: this.buildSnapshot(provider, {
            status: 'close_unconfirmed',
            fiveHour: null,
            sevenDay: null,
            checkedAt: null,
            identityConfirmed: false,
            message: 'Cleanup pending',
          }),
        }
      }
      if (this.disposed) {
        return {
          ok: false,
          error: { code: 'RUNTIME_UNAVAILABLE', message: 'Pact is shutting down.' },
        }
      }
      if (active.cancelling || (!timedOut && isAbortError(error))) {
        if (slot.active?.requestId === active.requestId) slot.active = undefined
        return { ok: true, value: this.projectSnapshot(provider) }
      }
      const message =
        timedOut ||
        isAbortError(error) ||
        (error instanceof Error && /timed out|deadline/iu.test(error.message))
          ? 'Timed out'
          : 'Unavailable'
      return {
        ok: true,
        value: this.handleProbeFailure(provider, configKey, slot, {
          status: 'unavailable',
          message,
          clearCache: false,
          rateLimited: looksRateLimited(error),
        }),
      }
    } finally {
      clearTimeout(deadlineTimer)
      if (slot.active?.requestId === active.requestId) {
        slot.active = undefined
      }
      active.resolveSettled()
    }
  }

  private async probeCodexUsage(
    executablePath: string,
    configKey: string,
    signal: AbortSignal,
    timeoutMs: number,
    slot: ProviderSlot,
  ): Promise<ProbeOutcome> {
    let accountReadSettled = false
    let preSettleAccountUpdates = 0
    let accountUpdatedDuringProbe = false
    let currentProbe: OwnedProcessGroup | undefined

    return runCodexInfoProbe<ProbeOutcome>({
      executablePath,
      workingDirectory: this.probeRoot,
      env: codexProcessEnvironment(),
      signal,
      timeoutMs,
      timeoutMessage: 'Codex usage check timed out.',
      maxFrameBytes: MAX_FRAME_BYTES,
      maxTotalBytes: MAX_RAW_BYTES,
      initializeParams: {
        clientInfo: { name: 'pact', title: 'Pact', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      },
      ownProbe: (probeSignal, onCloseInput) => {
        currentProbe = this.ownProbe(probeSignal, onCloseInput)
        return currentProbe
      },
      onNotification: (method) => {
        if (method !== 'account/updated') return
        if (accountReadSettled) {
          accountUpdatedDuringProbe = true
          this.reconcileObservedIdentity(slot, configKey, null, true)
          return
        }
        preSettleAccountUpdates += 1
        if (preSettleAccountUpdates > 1) {
          accountUpdatedDuringProbe = true
          this.reconcileObservedIdentity(slot, configKey, null, true)
        }
      },
      inspect: async (transport) => {
        const accountPromise = transport
          .request('account/read', { refreshToken: false })
          .then((accountResult) => {
            if (!accountResult || typeof accountResult !== 'object') {
              this.reconcileObservedIdentity(slot, configKey, null, true)
              return { accountResult, identity: undefined }
            }
            const account = objectProperty(accountResult, 'account')
            const userId = stringProperty(accountResult, 'userId')
            const requiresOpenaiAuth = Reflect.get(accountResult, 'requiresOpenaiAuth') === true
            const workspaceRouting = objectProperty(accountResult, 'workspaceRouting')
            const chatgptAccountId = workspaceRouting
              ? stringProperty(workspaceRouting, 'chatgptAccountId')
              : undefined
            const accountType = account ? stringProperty(account, 'type') : undefined
            const email = account ? stringProperty(account, 'email') : undefined
            const identityConfirmed = Boolean(email || userId || chatgptAccountId)
            const identityDigest = identityConfirmed
              ? sha256Digest([accountType ?? '', email ?? '', userId ?? '', chatgptAccountId ?? ''])
              : null
            const invalidateWindows =
              !identityConfirmed || accountType === 'apiKey' || (!account && requiresOpenaiAuth)
            this.reconcileObservedIdentity(slot, configKey, identityDigest, invalidateWindows)
            return {
              accountResult,
              identity: {
                unauthenticated: !account && requiresOpenaiAuth,
                isApiKey: accountType === 'apiKey',
                identityConfirmed,
                identityDigest,
              },
            }
          })
          .finally(() => {
            accountReadSettled = true
          })

        const [accountSettled, limitsSettled] = await Promise.allSettled([
          accountPromise,
          transport.request('account/rateLimits/read', {}),
        ])
        if (accountUpdatedDuringProbe) {
          this.reconcileObservedIdentity(slot, configKey, null, true)
          return {
            status: 'unavailable',
            fiveHour: null,
            sevenDay: null,
            identityConfirmed: false,
            identityDigest: null,
            message: 'Unavailable',
          }
        }
        if (accountSettled.status === 'rejected') {
          throw accountSettled.reason instanceof Error
            ? accountSettled.reason
            : new Error('Codex account check failed.')
        }
        const { identity } = accountSettled.value
        if (!identity) {
          throw new Error('Codex App Server returned an invalid account response.')
        }
        if (identity.unauthenticated) {
          return {
            status: 'unauthenticated',
            fiveHour: null,
            sevenDay: null,
            identityConfirmed: false,
            identityDigest: null,
            message: 'Sign in required',
          }
        }
        if (identity.isApiKey) {
          return {
            status: 'not_applicable',
            fiveHour: null,
            sevenDay: null,
            identityConfirmed: identity.identityConfirmed,
            identityDigest: identity.identityDigest,
            message: 'API key',
          }
        }

        const { identityConfirmed, identityDigest } = identity

        if (limitsSettled.status === 'rejected') {
          throw limitsSettled.reason instanceof Error
            ? limitsSettled.reason
            : new Error('Codex rate limits check failed.')
        }
        const limitsResult = limitsSettled.value
        if (!limitsResult || typeof limitsResult !== 'object') {
          throw new Error('Codex App Server returned invalid rate limits.')
        }

        const byLimitId = objectProperty(limitsResult, 'rateLimitsByLimitId')
        const bucket = byLimitId
          ? objectProperty(byLimitId, 'codex')
          : objectProperty(limitsResult, 'rateLimits')

        if (!bucket) {
          return {
            status: 'not_applicable',
            fiveHour: null,
            sevenDay: null,
            identityConfirmed,
            identityDigest,
            message: 'No plan limits',
          }
        }

        let fiveHour: ProviderUsageWindow | null = null
        let sevenDay: ProviderUsageWindow | null = null
        for (const windowCandidate of [
          objectProperty(bucket, 'primary'),
          objectProperty(bucket, 'secondary'),
        ]) {
          if (!windowCandidate) continue
          const durationMins = Reflect.get(windowCandidate, 'windowDurationMins')
          const usedPercent = clampPercent(Reflect.get(windowCandidate, 'usedPercent'))
          const resetsAt = normalizeUnixSeconds(Reflect.get(windowCandidate, 'resetsAt'))
          if (durationMins === 300 && !fiveHour && usedPercent !== null) {
            fiveHour = { usedPercent, resetsAt }
          } else if (durationMins === 10080 && !sevenDay && usedPercent !== null) {
            sevenDay = { usedPercent, resetsAt }
          }
        }

        const status: ProviderUsageStatus =
          fiveHour && sevenDay ? 'ready' : fiveHour || sevenDay ? 'partial' : 'not_applicable'

        return {
          status,
          fiveHour,
          sevenDay,
          identityConfirmed,
          identityDigest,
          ...(status === 'not_applicable' ? { message: 'No plan limits' } : {}),
        }
      },
      onCloseError: () => {
        if (currentProbe && !isProbeSettled(currentProbe)) slot.unconfirmedProbes.add(currentProbe)
        slot.windows = undefined
        slot.nonWindow = undefined
      },
      onProbeSettled: (probe) => {
        if (isProbeSettled(probe)) {
          slot.unconfirmedProbes.delete(probe)
          this.probes.delete(probe)
        }
      },
    })
  }

  private async probeClaudeUsage(
    executablePath: string,
    configKey: string,
    signal: AbortSignal,
    timeoutMs: number,
    slot: ProviderSlot,
  ): Promise<ProbeOutcome> {
    let currentProbe: OwnedProcessGroup | undefined
    return runClaudeInfoProbe<ProbeOutcome>({
      executablePath,
      workingDirectory: this.probeRoot,
      signal,
      timeoutMs,
      timeoutMessage: 'Claude Code usage check timed out.',
      queryOptions: {
        permissionMode: 'dontAsk',
        permissionPrompts: 'none',
        persistSession: false,
        settingSources: ['user'],
        settings: { disableAllHooks: true },
        strictMcpConfig: true,
        mcpServers: {},
        tools: [],
        hooks: {},
        plugins: [],
        extraArgs: { 'safe-mode': null },
      },
      ownProbe: (probeSignal, onCloseInput) => {
        currentProbe = this.ownProbe(probeSignal, onCloseInput)
        return currentProbe
      },
      inspect: async (session) => {
        const accountPromise = session.accountInfo().then((account) => {
          const identityConfirmed = Boolean(account.email || account.organization)
          const identityDigest = identityConfirmed
            ? sha256Digest([
                account.email ?? '',
                account.organization ?? '',
                account.apiProvider ?? '',
                account.subscriptionType ?? '',
              ])
            : null
          const nonPlanProvider = Boolean(
            account.apiProvider && account.apiProvider !== 'firstParty',
          )
          this.reconcileObservedIdentity(
            slot,
            configKey,
            identityDigest,
            !identityConfirmed || nonPlanProvider,
          )
          return { account, identityConfirmed, identityDigest, nonPlanProvider }
        })

        const [accountSettled, usageSettled] = await Promise.allSettled([
          accountPromise,
          session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
            skipBehaviors: true,
          }),
        ])
        if (accountSettled.status === 'rejected') {
          throw accountSettled.reason instanceof Error
            ? accountSettled.reason
            : new Error('Claude Code account check failed.')
        }
        const { account, identityConfirmed, identityDigest, nonPlanProvider } = accountSettled.value

        if (nonPlanProvider) {
          return {
            status: 'not_applicable',
            fiveHour: null,
            sevenDay: null,
            identityConfirmed,
            identityDigest,
            message: 'Cloud billing',
          }
        }

        if (usageSettled.status === 'rejected') {
          throw usageSettled.reason instanceof Error
            ? usageSettled.reason
            : new Error('Claude Code usage check failed.')
        }
        const usage = usageSettled.value

        if (!usage.rate_limits_available || !usage.rate_limits) {
          const noAuthToken =
            (!account.tokenSource || account.tokenSource === 'none') &&
            (!account.apiKeySource || account.apiKeySource === 'none') &&
            !account.email &&
            !account.subscriptionType &&
            !usage.subscription_type
          if (noAuthToken) {
            return {
              status: 'unauthenticated',
              fiveHour: null,
              sevenDay: null,
              identityConfirmed: false,
              identityDigest: null,
              message: 'Sign in required',
            }
          }
          if (account.apiKeySource && account.apiKeySource !== 'none') {
            return {
              status: 'not_applicable',
              fiveHour: null,
              sevenDay: null,
              identityConfirmed,
              identityDigest,
              message: 'API key',
            }
          }
          return {
            status: 'not_applicable',
            fiveHour: null,
            sevenDay: null,
            identityConfirmed,
            identityDigest,
            message: 'No plan limits',
          }
        }

        const rawFive = usage.rate_limits.five_hour
        const rawSeven = usage.rate_limits.seven_day
        const fiveHourPercent = rawFive ? clampPercent(rawFive.utilization) : null
        const sevenDayPercent = rawSeven ? clampPercent(rawSeven.utilization) : null

        const fiveHour: ProviderUsageWindow | null =
          fiveHourPercent !== null
            ? {
                usedPercent: fiveHourPercent,
                resetsAt: normalizeIsoTimestamp(rawFive?.resets_at),
              }
            : null
        const sevenDay: ProviderUsageWindow | null =
          sevenDayPercent !== null
            ? {
                usedPercent: sevenDayPercent,
                resetsAt: normalizeIsoTimestamp(rawSeven?.resets_at),
              }
            : null

        const status: ProviderUsageStatus =
          fiveHour && sevenDay ? 'ready' : fiveHour || sevenDay ? 'partial' : 'unavailable'

        return {
          status,
          fiveHour,
          sevenDay,
          identityConfirmed,
          identityDigest,
          ...(status === 'unavailable' ? { message: 'Unavailable' } : {}),
        }
      },
      onCloseError: () => {
        if (currentProbe && !isProbeSettled(currentProbe)) slot.unconfirmedProbes.add(currentProbe)
        slot.windows = undefined
        slot.nonWindow = undefined
      },
      onProbeSettled: (probe) => {
        if (isProbeSettled(probe)) {
          slot.unconfirmedProbes.delete(probe)
          this.probes.delete(probe)
        }
      },
    })
  }

  private reconcileUnconfirmedProbes(slot: ProviderSlot): boolean {
    for (const probe of slot.unconfirmedProbes) {
      if (isProbeSettled(probe)) {
        slot.unconfirmedProbes.delete(probe)
        this.probes.delete(probe)
      }
    }
    return slot.unconfirmedProbes.size > 0
  }

  private ownProbe(
    signal: AbortSignal,
    onCloseInput: () => void | Promise<void>,
  ): OwnedProcessGroup {
    signal.throwIfAborted()
    this.reconcileUnconfirmedProbes(this.slots.codex)
    this.reconcileUnconfirmedProbes(this.slots.claude)
    for (const candidate of this.probes) {
      if (isProbeSettled(candidate)) this.probes.delete(candidate)
    }
    if (this.disposed || this.probes.size >= 2) {
      throw new Error('Provider usage capacity is unavailable.')
    }
    const probe = new OwnedProcessGroup({ signal, onCloseInput })
    this.probes.add(probe)
    return probe
  }

  private reconcileObservedIdentity(
    slot: ProviderSlot,
    configKey: string,
    identityDigest: string | null,
    invalidateWindows: boolean,
  ): void {
    slot.activeIdentityConfirmed = !invalidateWindows && identityDigest !== null
    if (
      slot.windows &&
      (invalidateWindows ||
        slot.windows.configKey !== configKey ||
        (identityDigest !== null && identityDigest !== slot.windows.identityDigest))
    ) {
      slot.windows = undefined
    }
    if (
      slot.nonWindow &&
      (slot.nonWindow.configKey !== configKey ||
        (identityDigest !== null &&
          slot.nonWindow.identityDigest !== null &&
          identityDigest !== slot.nonWindow.identityDigest))
    ) {
      slot.nonWindow = undefined
    }
  }

  private recordNonWindowOutcome(
    provider: ProviderUsageProvider,
    slot: ProviderSlot,
    outcome: NonWindowOutcome,
  ): ProviderUsageSnapshot {
    slot.windows = undefined
    slot.nonWindow = outcome
    return this.buildSnapshot(provider, {
      status: outcome.status,
      fiveHour: null,
      sevenDay: null,
      checkedAt: outcome.checkedAt,
      identityConfirmed: outcome.identityConfirmed,
      message: outcome.message,
    })
  }

  private handleProbeFailure(
    provider: ProviderUsageProvider,
    configKey: string,
    slot: ProviderSlot,
    options: {
      status: 'unavailable'
      message: string
      clearCache: boolean
      rateLimited: boolean
    },
  ): ProviderUsageSnapshot {
    const checkedAtMs = Date.now()
    slot.cooldownUntilMs = checkedAtMs + (options.rateLimited ? RATE_LIMIT_BACKOFF_MS : COOLDOWN_MS)
    if (
      !options.clearCache &&
      slot.activeIdentityConfirmed &&
      slot.windows &&
      slot.windows.configKey === configKey
    ) {
      slot.windows.degraded = true
      slot.nonWindow = undefined
      return this.buildSnapshot(provider, {
        status: 'stale',
        fiveHour: slot.windows.fiveHour,
        sevenDay: slot.windows.sevenDay,
        checkedAt: slot.windows.checkedAt,
        identityConfirmed: true,
      })
    }
    return this.recordNonWindowOutcome(provider, slot, {
      configKey,
      status: options.status,
      checkedAt: new Date(checkedAtMs).toISOString(),
      identityConfirmed: false,
      identityDigest: null,
      message: options.message,
    })
  }

  private projectActiveOverlay(
    provider: ProviderUsageProvider,
    status: 'loading' | 'busy' | 'cancelling',
    message?: string,
  ): ProviderUsageSnapshot {
    const slot = this.slots[provider]
    const currentConfigKey = this.runtimePreparation.providerConfigurationKey(provider)
    const windows =
      slot.windows && slot.windows.configKey === currentConfigKey ? slot.windows : undefined
    return this.buildSnapshot(provider, {
      status,
      fiveHour: windows?.fiveHour ?? null,
      sevenDay: windows?.sevenDay ?? null,
      checkedAt: windows?.checkedAt ?? null,
      identityConfirmed: Boolean(windows),
      ...(message ? { message } : {}),
    })
  }

  private projectSnapshot(provider: ProviderUsageProvider): ProviderUsageSnapshot {
    const slot = this.slots[provider]
    if (this.reconcileUnconfirmedProbes(slot)) {
      return this.buildSnapshot(provider, {
        status: 'close_unconfirmed',
        fiveHour: null,
        sevenDay: null,
        checkedAt: null,
        identityConfirmed: false,
        message: 'Cleanup pending',
      })
    }
    if (slot.active) {
      return this.projectActiveOverlay(provider, slot.active.cancelling ? 'cancelling' : 'loading')
    }

    const currentConfigKey = this.runtimePreparation.providerConfigurationKey(provider)
    if (slot.windows && slot.windows.configKey !== currentConfigKey) {
      slot.windows = undefined
    }
    if (slot.nonWindow && slot.nonWindow.configKey !== currentConfigKey) {
      slot.nonWindow = undefined
    }

    if (slot.windows) {
      const nowMs = Date.now()
      const windows = slot.windows
      const expired =
        nowMs - windows.checkedAtMs > FRESHNESS_MS ||
        isWindowExpired(windows.fiveHour, nowMs) ||
        isWindowExpired(windows.sevenDay, nowMs)
      const status: ProviderUsageStatus =
        windows.degraded || expired
          ? 'stale'
          : windows.fiveHour && windows.sevenDay
            ? 'ready'
            : 'partial'
      return this.buildSnapshot(provider, {
        status,
        fiveHour: windows.fiveHour,
        sevenDay: windows.sevenDay,
        checkedAt: windows.checkedAt,
        identityConfirmed: true,
      })
    }

    if (slot.nonWindow) {
      return this.buildSnapshot(provider, {
        status: slot.nonWindow.status,
        fiveHour: null,
        sevenDay: null,
        checkedAt: slot.nonWindow.checkedAt,
        identityConfirmed: slot.nonWindow.identityConfirmed,
        message: slot.nonWindow.message,
      })
    }

    return this.buildSnapshot(provider, {
      status: 'idle',
      fiveHour: null,
      sevenDay: null,
      checkedAt: null,
      identityConfirmed: false,
    })
  }

  private buildSnapshot(
    provider: ProviderUsageProvider,
    fields: Omit<ProviderUsageSnapshot, 'provider' | 'revision' | 'cooldownUntil'>,
  ): ProviderUsageSnapshot {
    const slot = this.slots[provider]
    slot.revision += 1
    const cooldownUntil =
      slot.cooldownUntilMs > Date.now() ? new Date(slot.cooldownUntilMs).toISOString() : null
    return providerUsageSnapshotSchema.parse({
      provider,
      revision: slot.revision,
      cooldownUntil,
      ...fields,
    })
  }
}
