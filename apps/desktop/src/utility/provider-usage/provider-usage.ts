import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  MAX_PROVIDER_USAGE_POOLS,
  providerUsageSnapshotSchema,
  type ProviderUsageCancelResult,
  type ProviderUsagePool,
  type ProviderUsageProvider,
  type ProviderUsageSnapshot,
  type ProviderUsageStatus,
  type ProviderUsageUtilityCancelInput,
  type ProviderUsageUtilityRefreshInput,
  type ProviderUsageWindow,
  type RpcResult,
} from '@pact/contracts'

import { codexProcessEnvironment } from '../conversation/codex-process-environment'
import { runClaudeInfoProbe, runCodexInfoProbe, withProbeTimeout } from '../native-info-probe'
import { OwnedProcessGroup } from '../owned-process-group'
import { isUnsafeWindowsCmdPath } from '../runtime-preparation/agy-acp-probe'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation'

const ALL_USAGE_PROVIDERS: readonly ProviderUsageProvider[] = ['codex', 'claude', 'agy']
const MAX_CONCURRENT_APP_PROBES = 2
const TOTAL_DEADLINE_MS = 24_000
const CLEANUP_RESERVE_MS = 4_000
const QUERY_TIMEOUT_MS = 20_000
const AGY_QUERY_TIMEOUT_MS = 10_000
const CANCEL_WAIT_MS = 5_000
const COOLDOWN_MS = 30_000
const RATE_LIMIT_BACKOFF_MS = 60_000
const FRESHNESS_MS = 5 * 60 * 1000
const MAX_RAW_BYTES = 1024 * 1024
const MAX_FRAME_BYTES = 256 * 1024
const AGY_MAX_RAW_BYTES = 64 * 1024

interface ConfirmedUsageWindows {
  readonly configKey: string
  readonly identityDigest: string | null
  readonly fiveHour: ProviderUsageWindow | null
  readonly sevenDay: ProviderUsageWindow | null
  readonly pools?: readonly ProviderUsagePool[] | undefined
  readonly checkedAt: string
  readonly checkedAtMs: number
  readonly message?: string
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
  pools?: readonly ProviderUsagePool[] | undefined
  identityConfirmed: boolean
  identityDigest: string | null
  message?: string
  rateLimited?: boolean
}

interface PermitWaiter {
  readonly resolve: (acquired: boolean) => void
  readonly cleanup: () => void
}

interface AgyBucketCandidate {
  readonly id?: string
  readonly name: string
  readonly window?: string
  readonly disabled: boolean
  readonly remainingFraction: number | null
  readonly resetsAt: string | null
}

interface AgyGroupCandidate {
  readonly id?: string
  readonly name: string
  readonly buckets: readonly AgyBucketCandidate[]
}

function createEmptySlot(): ProviderSlot {
  return {
    revision: 0,
    windows: undefined,
    nonWindow: undefined,
    cooldownUntilMs: 0,
    unconfirmedProbes: new Set(),
    activeIdentityConfirmed: false,
    active: undefined,
  }
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

export function remainingFractionToUsedPercent(remainingFraction: unknown): number | null {
  if (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction)) return null
  const clampedRemaining = Math.min(1, Math.max(0, remainingFraction))
  const usedPercent = Math.round((1 - clampedRemaining) * 1000) / 10
  return Math.min(100, Math.max(0, usedPercent))
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

function looksUnauthenticatedText(text: string): boolean {
  return /authentication (?:required|failed|interrupted|timed out)|not logged in|sign in required|please visit the url to log in/iu.test(
    text,
  )
}

function classifyAgyNonSubscriptionMessage(
  text: string,
): 'API key' | 'Cloud billing' | 'No plan limits' {
  if (/api[ _-]?key|gemini-api-key/iu.test(text)) return 'API key'
  if (/vertex|cloud billing|agent-platform|enterprise agent platform|gcp billing/iu.test(text)) {
    return 'Cloud billing'
  }
  return 'No plan limits'
}

function fixedAgyPoolIdentity(group: AgyGroupCandidate): {
  readonly id: string
  readonly label: string
  readonly messageLabel: string
} {
  // Map ONLY known bucket/pool IDs or exact canonical pool labels to fixed safe strings
  // so custom organization, team, or project names never cross IPC.
  const idTokens = [group.id ?? '', ...group.buckets.map((bucket) => bucket.id ?? '')].filter(
    (token) => token.length > 0,
  )
  const normalizedName = group.name.trim().toLowerCase()
  if (
    idTokens.some((id) => /^(?:gemini[-_]?pro|pro(?:$|[-_]))/iu.test(id)) ||
    normalizedName === 'gemini pro' ||
    normalizedName === 'gemini pro models'
  ) {
    return { id: 'gemini-pro', label: 'Gemini Pro', messageLabel: 'Gemini Pro quota pool' }
  }
  if (
    idTokens.some((id) => /^gemini(?:$|[-_])/iu.test(id)) ||
    normalizedName === 'gemini models' ||
    normalizedName === 'gemini'
  ) {
    return { id: 'gemini', label: 'Gemini Models', messageLabel: 'Gemini Models quota' }
  }
  if (
    idTokens.some((id) => /^(?:partner|third[-_]?party|3p)(?:$|[-_])/iu.test(id)) ||
    normalizedName === 'claude & gpt-oss' ||
    normalizedName === 'claude and gpt models' ||
    normalizedName === 'partner models'
  ) {
    return { id: 'claude-gpt', label: 'Claude & GPT', messageLabel: 'Partner Models quota' }
  }
  if (
    idTokens.some((id) => /^claude(?:$|[-_])/iu.test(id)) ||
    normalizedName === 'claude' ||
    normalizedName === 'claude models'
  ) {
    return { id: 'claude', label: 'Claude', messageLabel: 'Claude quota pool' }
  }
  if (idTokens.some((id) => /^premium(?:$|[-_])/iu.test(id)) || normalizedName === 'premium') {
    return { id: 'premium', label: 'Premium', messageLabel: 'Premium quota pool' }
  }
  return { id: 'pool', label: 'Quota pool', messageLabel: 'Selected quota pool' }
}

function fixedAgyPoolLabel(group: AgyGroupCandidate): string {
  return fixedAgyPoolIdentity(group).messageLabel
}

function isFiveHourAgyBucket(bucket: AgyBucketCandidate): boolean {
  if (bucket.id && (bucket.id === 'gemini-5h' || /^(?:.*[-_])?5h$/iu.test(bucket.id))) {
    return true
  }
  if (bucket.window && /^\s*(?:5\s*h(?:ours?|r)?|300\s*m(?:ins?)?)\s*$/iu.test(bucket.window)) {
    return true
  }
  return /\b5[\s-]*h(?:our|r)?s?\b/iu.test(bucket.name)
}

function isWeeklyAgyBucket(bucket: AgyBucketCandidate): boolean {
  if (
    bucket.id &&
    (bucket.id === 'gemini-weekly' ||
      bucket.id === 'gemini-7d' ||
      /^(?:.*[-_])?(?:weekly|7d)$/iu.test(bucket.id))
  ) {
    return true
  }
  if (
    bucket.window &&
    /^\s*(?:weekly|1\s*w(?:eek)?|7\s*d(?:ays?)?|168\s*h(?:ours?|r)?|10080\s*m(?:ins?)?)\s*$/iu.test(
      bucket.window,
    )
  ) {
    return true
  }
  return /\b(?:weekly|7[\s-]*d(?:ay)?s?)\b/iu.test(bucket.name)
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Utility-owned readout for Codex, Claude Code, and Antigravity 5h/7d plan utilization windows.
 * Owns per-provider single-slot execution, App-wide <= 2 concurrent probe admission, PII-free
 * normalization, bounded cache, cooldown/freshness, cancellation, and physical cleanup confirmation.
 */
export class ProviderUsage {
  private readonly probeRoot: string
  private readonly probes = new Set<OwnedProcessGroup>()
  private readonly unconfirmedAgyDirs = new Map<OwnedProcessGroup, string>()
  private readonly slots: Record<ProviderUsageProvider, ProviderSlot> = {
    codex: createEmptySlot(),
    claude: createEmptySlot(),
    agy: createEmptySlot(),
  }
  private activePermitCount = 0
  private readonly permitWaiters: PermitWaiter[] = []
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly runtimePreparation: RuntimePreparation,
    workspaceStorageRoot: string,
    private readonly options: { env?: NodeJS.ProcessEnv } = {},
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
          message: 'Wait to retry',
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
    for (const provider of ALL_USAGE_PROVIDERS) {
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
      for (const provider of ALL_USAGE_PROVIDERS) {
        const active = this.slots[provider].active
        if (!active) continue
        active.cancelling = true
        active.controller.abort()
        pending.push(active.settled)
      }
      for (const waiter of this.permitWaiters.splice(0)) {
        waiter.cleanup()
        waiter.resolve(false)
      }
      await Promise.allSettled(pending)
      const closeResults = await Promise.allSettled([...this.probes].map((probe) => probe.close()))
      const settledDirs: string[] = []
      for (const [probe, dir] of this.unconfirmedAgyDirs.entries()) {
        if (isProbeSettled(probe)) {
          this.unconfirmedAgyDirs.delete(probe)
          settledDirs.push(dir)
        }
      }
      await Promise.allSettled(settledDirs.map((dir) => rm(dir, { recursive: true, force: true })))
      for (const probe of this.probes) {
        if (isProbeSettled(probe)) this.probes.delete(probe)
      }
      const anyUnconfirmed = this.totalUnconfirmedProbes() > 0
      if (
        closeResults.some((result) => result.status === 'rejected') ||
        this.probes.size > 0 ||
        anyUnconfirmed
      ) {
        throw new Error('Provider usage probes did not finish closing.')
      }
    })()
    return this.disposal
  }

  private totalUnconfirmedProbes(): number {
    let count = 0
    for (const provider of ALL_USAGE_PROVIDERS) {
      this.reconcileUnconfirmedProbes(this.slots[provider])
      count += this.slots[provider].unconfirmedProbes.size
    }
    for (const [probe, dir] of this.unconfirmedAgyDirs.entries()) {
      if (isProbeSettled(probe)) {
        this.unconfirmedAgyDirs.delete(probe)
        void rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    return count
  }

  /**
   * Acquires one of the <= 2 App-wide active probe slots (unconfirmed physical probes hold their
   * slot until settled). With 3 providers and 1 active request per provider, at most 1 provider
   * ever waits for an active slot to finish.
   */
  private async acquireProbePermit(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    if (this.disposed) return false
    const unconfirmed = this.totalUnconfirmedProbes()
    if (this.activePermitCount + unconfirmed < MAX_CONCURRENT_APP_PROBES) {
      this.activePermitCount += 1
      return true
    }
    // If all 2 App-wide slots are occupied by unconfirmed probes and nothing active is running to
    // release a slot promptly, return busy immediately rather than waiting until deadline.
    if (this.activePermitCount === 0 || this.permitWaiters.length >= 1) {
      return false
    }

    return new Promise<boolean>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.permitWaiters.indexOf(entry)
        if (index >= 0) this.permitWaiters.splice(index, 1)
        const aborted = new Error('Provider usage probe was cancelled.', { cause: signal.reason })
        aborted.name = 'AbortError'
        reject(aborted)
      }
      const entry: PermitWaiter = {
        resolve,
        cleanup: () => signal.removeEventListener('abort', onAbort),
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      this.permitWaiters.push(entry)
    })
  }

  private releaseProbePermit(): void {
    this.activePermitCount = Math.max(0, this.activePermitCount - 1)
    if (this.permitWaiters.length === 0) return
    const unconfirmed = this.totalUnconfirmedProbes()
    if (!this.disposed && this.activePermitCount + unconfirmed < MAX_CONCURRENT_APP_PROBES) {
      const next = this.permitWaiters.shift()
      if (next) {
        this.activePermitCount += 1
        next.cleanup()
        next.resolve(true)
      }
      return
    }
    if (this.disposed || this.activePermitCount === 0) {
      for (const waiter of this.permitWaiters.splice(0)) {
        waiter.cleanup()
        waiter.resolve(false)
      }
    }
  }

  private syncUnconfirmedReadinessProbes(
    provider: ProviderUsageProvider,
    slot: ProviderSlot,
  ): void {
    for (const unresolved of this.runtimePreparation.unconfirmedProviderProbes(provider)) {
      slot.unconfirmedProbes.add(unresolved)
    }
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
    let holdsPermit = false
    const deadlineTimer = setTimeout(() => {
      timedOut = true
      active.controller.abort(new Error('Provider usage check timed out.'))
    }, TOTAL_DEADLINE_MS)

    try {
      holdsPermit = await this.acquireProbePermit(active.controller.signal)
      if (!holdsPermit) {
        if (this.disposed) {
          return {
            ok: false,
            error: { code: 'RUNTIME_UNAVAILABLE', message: 'Pact is shutting down.' },
          }
        }
        return {
          ok: true,
          value: this.projectActiveOverlay(provider, 'busy', 'Wait to retry'),
        }
      }

      await mkdir(this.probeRoot, { recursive: true, mode: 0o700 })
      active.controller.signal.throwIfAborted()

      const preparation = await this.runtimePreparation.inspectProviderReadiness(
        provider,
        active.controller.signal,
      )
      this.syncUnconfirmedReadinessProbes(provider, slot)
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
            message: 'Wait to retry',
          }),
        }
      }
      active.controller.signal.throwIfAborted()
      // prepareEnvironment() inside inspectProviderReadiness may populate PATH on macOS cold start;
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

      const agent = preparation.value
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

      const providerQueryCap = provider === 'agy' ? AGY_QUERY_TIMEOUT_MS : QUERY_TIMEOUT_MS
      const queryBudgetMs = Math.min(providerQueryCap, deadline - Date.now() - CLEANUP_RESERVE_MS)
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
          : provider === 'claude'
            ? await this.probeClaudeUsage(
                agent.executablePath,
                configKey,
                active.controller.signal,
                queryBudgetMs,
                slot,
              )
            : await this.probeAgyUsage(
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
            message: 'Wait to retry',
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
        (outcome.fiveHour !== null || outcome.sevenDay !== null)

      const checkedAtMs = Date.now()
      const checkedAt = new Date(checkedAtMs).toISOString()
      slot.cooldownUntilMs =
        checkedAtMs + (outcome.rateLimited ? RATE_LIMIT_BACKOFF_MS : COOLDOWN_MS)

      if (hasUsableWindows) {
        const stableIdentityDigest = outcome.identityConfirmed ? outcome.identityDigest : null
        slot.nonWindow = undefined
        slot.windows = {
          configKey,
          identityDigest: stableIdentityDigest,
          fiveHour: outcome.fiveHour,
          sevenDay: outcome.sevenDay,
          ...(outcome.pools ? { pools: outcome.pools } : {}),
          checkedAt,
          checkedAtMs,
          ...(outcome.message ? { message: outcome.message } : {}),
          degraded: false,
        }
        return {
          ok: true,
          value: this.buildSnapshot(provider, {
            status: outcome.status,
            fiveHour: outcome.fiveHour,
            sevenDay: outcome.sevenDay,
            ...(outcome.pools ? { pools: [...outcome.pools] } : {}),
            checkedAt,
            identityConfirmed: stableIdentityDigest !== null,
            ...(outcome.message ? { message: outcome.message } : {}),
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
      this.syncUnconfirmedReadinessProbes(provider, slot)
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
            message: 'Wait to retry',
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
      this.syncUnconfirmedReadinessProbes(provider, slot)
      if (slot.active?.requestId === active.requestId) {
        slot.active = undefined
      }
      if (holdsPermit) {
        this.releaseProbePermit()
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
      env: codexProcessEnvironment(undefined, this.options.env),
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
        ...(this.options.env ? { env: this.options.env } : {}),
      },
      ownProbe: (probeSignal, onCloseInput) => {
        currentProbe = this.ownProbe(probeSignal, onCloseInput)
        return currentProbe
      },
      inspect: async (session) => {
        const accountPromise = session.accountInfo().then((account) => {
          const accountUuid =
            stringProperty(account, 'accountUuid') ??
            stringProperty(account, 'userId') ??
            stringProperty(account, 'user_id')
          const identityConfirmed = Boolean(account.email || accountUuid)
          const identityDigest = identityConfirmed
            ? sha256Digest([
                account.email ?? '',
                accountUuid ?? '',
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

  private async probeAgyUsage(
    executablePath: string,
    configKey: string,
    signal: AbortSignal,
    timeoutMs: number,
    slot: ProviderSlot,
  ): Promise<ProbeOutcome> {
    const agyProbeDir = await mkdtemp(join(this.probeRoot, 'agy-'))
    let child: ChildProcessWithoutNullStreams | undefined
    let probe: OwnedProcessGroup | undefined
    let closeFailed = false

    try {
      await chmod(agyProbeDir, 0o700)
      signal.throwIfAborted()
      probe = this.ownProbe(signal, () => {
        if (child && !child.stdin.destroyed) child.stdin.end()
      })

      const effectiveTimeoutMs = Math.min(AGY_QUERY_TIMEOUT_MS, timeoutMs)
      const isWindowsCommand = process.platform === 'win32' && /\.cmd$/iu.test(executablePath)
      if (isWindowsCommand && isUnsafeWindowsCmdPath(executablePath)) {
        throw new Error('Unsafe Windows executable path.')
      }
      const env = this.options.env
      const target = isWindowsCommand ? ((env ?? process.env).ComSpec ?? 'cmd.exe') : executablePath
      const args = isWindowsCommand
        ? ['/d', '/s', '/c', `""${executablePath}" -p /usage --output-format json"`]
        : ['-p', '/usage', '--output-format', 'json']

      const runningChild = probe.spawn(target, args, {
        cwd: agyProbeDir,
        ...(env ? { env } : {}),
        windowsHide: true,
        windowsVerbatimArguments: isWindowsCommand,
      })
      child = runningChild
      // Zero-Turn read-only command: close stdin immediately so interactive auth prompts never block.
      runningChild.stdin.end()

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let totalBytes = 0
      let overflowed = false

      const rawResult = await withProbeTimeout(
        new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const onStdout = (chunk: Buffer): void => {
              totalBytes += chunk.length
              if (totalBytes > AGY_MAX_RAW_BYTES) {
                overflowed = true
                runningChild.stdout.destroy()
                runningChild.stderr.destroy()
                reject(new Error('Antigravity usage output exceeded its 64 KiB budget.'))
                return
              }
              stdoutChunks.push(chunk)
            }
            const onStderr = (chunk: Buffer): void => {
              totalBytes += chunk.length
              if (totalBytes > AGY_MAX_RAW_BYTES) {
                overflowed = true
                runningChild.stdout.destroy()
                runningChild.stderr.destroy()
                reject(new Error('Antigravity usage output exceeded its 64 KiB budget.'))
                return
              }
              stderrChunks.push(chunk)
            }
            const cleanupListeners = (): void => {
              runningChild.stdout.off('data', onStdout)
              runningChild.stderr.off('data', onStderr)
            }
            runningChild.stdout.on('data', onStdout)
            runningChild.stderr.on('data', onStderr)
            runningChild.once('error', (err) => {
              cleanupListeners()
              reject(err)
            })
            runningChild.once('close', (exitCode) => {
              cleanupListeners()
              if (overflowed) return
              resolve({
                exitCode,
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
              })
            })
          },
        ),
        effectiveTimeoutMs,
        'Antigravity usage check timed out.',
        signal,
      )

      return this.parseAgyUsageOutput(rawResult, configKey, slot)
    } finally {
      if (probe) {
        const currentProbe = probe
        await currentProbe.close().catch((error: unknown) => {
          closeFailed = true
          if (!isProbeSettled(currentProbe)) {
            slot.unconfirmedProbes.add(currentProbe)
            this.unconfirmedAgyDirs.set(currentProbe, agyProbeDir)
          }
          slot.windows = undefined
          slot.nonWindow = undefined
          throw error
        })
        if (!closeFailed && isProbeSettled(currentProbe)) {
          slot.unconfirmedProbes.delete(currentProbe)
          this.unconfirmedAgyDirs.delete(currentProbe)
          this.probes.delete(currentProbe)
          await rm(agyProbeDir, { recursive: true, force: true }).catch(() => undefined)
        }
      } else {
        await rm(agyProbeDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  private parseAgyUsageOutput(
    raw: { exitCode: number | null; stdout: string; stderr: string },
    configKey: string,
    slot: ProviderSlot,
  ): ProbeOutcome {
    const trimmedStdout = raw.stdout.trim()
    let parsed: unknown
    if (trimmedStdout.length > 0) {
      try {
        parsed = JSON.parse(trimmedStdout)
      } catch {
        // Handle NDJSON where the final JSON record holds the structured payload.
        const lastLine = trimmedStdout
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .findLast((line) => line.length > 0)
        if (lastLine) {
          try {
            parsed = JSON.parse(lastLine)
          } catch {
            parsed = undefined
          }
        }
      }
    }

    const rootObj = isPlainRecord(parsed) ? parsed : undefined

    const observedIdentity = rootObj
      ? ProviderUsage.extractAgyIdentity(rootObj, configKey)
      : undefined

    const errorField = rootObj ? stringProperty(rootObj, 'error') : undefined
    const statusField = rootObj ? stringProperty(rootObj, 'status') : undefined
    const combinedFailureText = [errorField ?? '', raw.stderr].filter(Boolean).join('\n')

    if (
      (statusField?.toUpperCase() === 'ERROR' || raw.exitCode !== 0) &&
      looksUnauthenticatedText(combinedFailureText)
    ) {
      this.reconcileObservedIdentity(slot, configKey, null, true)
      return {
        status: 'unauthenticated',
        fiveHour: null,
        sevenDay: null,
        identityConfirmed: false,
        identityDigest: null,
        message: 'Sign in required',
      }
    }

    if (statusField?.toUpperCase() === 'ERROR' || raw.exitCode !== 0) {
      if (observedIdentity?.identityConfirmed && observedIdentity.identityDigest !== null) {
        this.reconcileObservedIdentity(
          slot,
          configKey,
          observedIdentity.identityDigest,
          observedIdentity.nonSubscriptionAccount,
        )
      } else {
        this.reconcileObservedIdentity(
          slot,
          configKey,
          null,
          Boolean(observedIdentity?.nonSubscriptionAccount),
        )
      }
      if (/no quota summary is available/iu.test(combinedFailureText)) {
        const identityConfirmed = Boolean(observedIdentity?.identityConfirmed)
        const identityDigest = observedIdentity?.identityDigest ?? null
        this.reconcileObservedIdentity(slot, configKey, identityDigest, true)
        return {
          status: 'not_applicable',
          fiveHour: null,
          sevenDay: null,
          identityConfirmed,
          identityDigest,
          message: classifyAgyNonSubscriptionMessage(combinedFailureText),
        }
      }
      if (/429|rate limit|too many/iu.test(combinedFailureText)) {
        throw new Error('429 rate limit exceeded')
      }
      throw new Error('Antigravity usage check failed.')
    }

    if (!rootObj || !observedIdentity) {
      throw new Error('Antigravity returned invalid usage JSON.')
    }

    const quotaContainer = ProviderUsage.unwrapAgyQuotaObject(rootObj)
    const commandObj = objectProperty(rootObj, 'command')
    const commandDataObj = commandObj ? objectProperty(commandObj, 'data') : undefined
    const description =
      (quotaContainer ? stringProperty(quotaContainer, 'description') : undefined) ??
      (commandDataObj ? stringProperty(commandDataObj, 'description') : undefined) ??
      (commandObj ? stringProperty(commandObj, 'description') : undefined) ??
      stringProperty(rootObj, 'description') ??
      ''
    const responseText = stringProperty(rootObj, 'response') ?? ''
    const classificationText = [description, responseText, observedIdentity.authKindText]
      .filter(Boolean)
      .join(' ')

    if (observedIdentity.nonSubscriptionAccount) {
      this.reconcileObservedIdentity(slot, configKey, observedIdentity.identityDigest, true)
      return {
        status: 'not_applicable',
        fiveHour: null,
        sevenDay: null,
        identityConfirmed: observedIdentity.identityConfirmed,
        identityDigest: observedIdentity.identityDigest,
        message: classifyAgyNonSubscriptionMessage(classificationText),
      }
    }

    if (!quotaContainer) {
      this.reconcileObservedIdentity(slot, configKey, observedIdentity.identityDigest, true)
      return {
        status: 'not_applicable',
        fiveHour: null,
        sevenDay: null,
        identityConfirmed: observedIdentity.identityConfirmed,
        identityDigest: observedIdentity.identityDigest,
        message: classifyAgyNonSubscriptionMessage(classificationText),
      }
    }

    const parsedGroups = ProviderUsage.parseAgyGroups(quotaContainer)
    if (!parsedGroups) {
      throw new Error('Antigravity usage groups are malformed.')
    }

    const activeGroups = parsedGroups.filter((group) =>
      group.buckets.some((bucket) => !bucket.disabled && bucket.remainingFraction !== null),
    )

    if (activeGroups.length === 0) {
      this.reconcileObservedIdentity(slot, configKey, observedIdentity.identityDigest, true)
      return {
        status: 'not_applicable',
        fiveHour: null,
        sevenDay: null,
        identityConfirmed: observedIdentity.identityConfirmed,
        identityDigest: observedIdentity.identityDigest,
        message: classifyAgyNonSubscriptionMessage(classificationText),
      }
    }

    this.reconcileObservedIdentity(
      slot,
      configKey,
      observedIdentity.identityDigest,
      !observedIdentity.identityConfirmed,
    )

    const extractedByGroup = activeGroups.map((group) => {
      let fiveHour: ProviderUsageWindow | null = null
      let sevenDay: ProviderUsageWindow | null = null
      let hasExplicitGeminiId = false
      for (const bucket of group.buckets) {
        if (bucket.disabled || bucket.remainingFraction === null) continue
        const usedPercent = remainingFractionToUsedPercent(bucket.remainingFraction)
        if (usedPercent === null) continue
        if (bucket.id === 'gemini-5h' || bucket.id === 'gemini-weekly') {
          hasExplicitGeminiId = true
        }
        if (!fiveHour && isFiveHourAgyBucket(bucket)) {
          fiveHour = { usedPercent, resetsAt: bucket.resetsAt }
        } else if (!sevenDay && isWeeklyAgyBucket(bucket)) {
          sevenDay = { usedPercent, resetsAt: bucket.resetsAt }
        }
      }
      return {
        group,
        fiveHour,
        sevenDay,
        hasExplicitGeminiId,
        isGeminiNamed: /\bgemini\b/iu.test(group.name),
      }
    })

    const withWindows = extractedByGroup.filter(
      (candidate) => candidate.fiveHour !== null || candidate.sevenDay !== null,
    )
    const selected =
      withWindows.find((candidate) => candidate.hasExplicitGeminiId) ??
      withWindows.find((candidate) => candidate.isGeminiNamed) ??
      withWindows[0]

    if (!selected) {
      return {
        status: 'not_applicable',
        fiveHour: null,
        sevenDay: null,
        identityConfirmed: observedIdentity.identityConfirmed,
        identityDigest: observedIdentity.identityDigest,
        message: classifyAgyNonSubscriptionMessage(classificationText),
      }
    }

    const status: ProviderUsageStatus = selected.fiveHour && selected.sevenDay ? 'ready' : 'partial'
    const multiplePools = parsedGroups.length > 1
    const orderedCandidates = [
      selected,
      ...withWindows.filter((candidate) => candidate !== selected),
    ].slice(0, MAX_PROVIDER_USAGE_POOLS)
    const pools: ProviderUsagePool[] | undefined =
      orderedCandidates.length > 1
        ? (() => {
            const usedIds = new Map<string, number>()
            const usedLabels = new Map<string, number>()
            return orderedCandidates.map((candidate) => {
              const identity = fixedAgyPoolIdentity(candidate.group)
              const idCount = (usedIds.get(identity.id) ?? 0) + 1
              usedIds.set(identity.id, idCount)
              const labelCount = (usedLabels.get(identity.label) ?? 0) + 1
              usedLabels.set(identity.label, labelCount)
              return {
                id: idCount === 1 ? identity.id : `${identity.id}-${idCount}`,
                label: labelCount === 1 ? identity.label : `${identity.label} ${labelCount}`,
                fiveHour: candidate.fiveHour,
                sevenDay: candidate.sevenDay,
              }
            })
          })()
        : undefined

    return {
      status,
      fiveHour: selected.fiveHour,
      sevenDay: selected.sevenDay,
      ...(pools ? { pools } : {}),
      identityConfirmed: observedIdentity.identityConfirmed,
      identityDigest: observedIdentity.identityDigest,
      ...(multiplePools ? { message: fixedAgyPoolLabel(selected.group) } : {}),
    }
  }

  private static extractAgyIdentity(
    rootObj: Record<string, unknown>,
    configKey: string,
  ): {
    readonly identityConfirmed: boolean
    readonly identityDigest: string | null
    readonly nonSubscriptionAccount: boolean
    readonly authKindText: string
  } {
    const commandObj = objectProperty(rootObj, 'command')
    const commandDataObj = commandObj ? objectProperty(commandObj, 'data') : undefined
    const containers = [rootObj, commandDataObj, commandObj].filter(
      (candidate): candidate is object => candidate !== undefined,
    )
    const firstStringInContainers = (
      keys: readonly string[],
      nestedKey?: string,
    ): string | undefined => {
      for (const container of containers) {
        const target = nestedKey ? objectProperty(container, nestedKey) : container
        if (!target) continue
        for (const key of keys) {
          const found = stringProperty(target, key)
          if (found !== undefined) return found
        }
      }
      return undefined
    }

    const email =
      firstStringInContainers(['email'], 'account') ?? firstStringInContainers(['email'])
    const userId =
      firstStringInContainers(['userId', 'user_id', 'accountId', 'account_id', 'sub'], 'account') ??
      firstStringInContainers(['userId', 'user_id', 'accountId', 'account_id'])
    const authMethod =
      firstStringInContainers(['authMethod', 'auth_method', 'type'], 'account') ??
      firstStringInContainers(['authMethod', 'auth_method', 'billing_mode']) ??
      ''
    const tier =
      firstStringInContainers(['tier'], 'account') ??
      firstStringInContainers(['plan_name'], 'credits') ??
      firstStringInContainers(['user_tier', 'tier', 'plan_name']) ??
      ''

    // Require a stable per-account identifier (verified userId/accountId or email), never bare
    // authMethod + tier or exit code, before confirming identity to retain stale windows across failures.
    const identityConfirmed = Boolean(email || userId)
    const nonSubscriptionAccount =
      /^(?:api[_-]?key|gemini-api-key|vertex|vertex[_-]?ai|agent-platform|cloud[_-]?billing)$/iu.test(
        authMethod.trim(),
      )
    const identityDigest = identityConfirmed
      ? sha256Digest(['agy', configKey, email ?? '', userId ?? ''])
      : null

    return {
      identityConfirmed,
      identityDigest,
      nonSubscriptionAccount,
      authKindText: [authMethod, tier].filter(Boolean).join(' '),
    }
  }

  private static hasAgyQuotaCollections(candidate: object): boolean {
    return (
      Array.isArray(Reflect.get(candidate, 'groups')) ||
      Array.isArray(Reflect.get(candidate, 'buckets'))
    )
  }

  private static unwrapAgyQuotaObject(rootObj: Record<string, unknown>): object | undefined {
    if (ProviderUsage.hasAgyQuotaCollections(rootObj)) {
      return rootObj
    }
    for (const key of ['quota', 'usage', 'data', 'result'] as const) {
      const nested = objectProperty(rootObj, key)
      if (nested && ProviderUsage.hasAgyQuotaCollections(nested)) {
        return nested
      }
    }
    const commandObj = objectProperty(rootObj, 'command')
    if (commandObj) {
      for (const key of ['data', 'result', 'quota', 'usage'] as const) {
        const nested = objectProperty(commandObj, key)
        if (nested && ProviderUsage.hasAgyQuotaCollections(nested)) {
          return nested
        }
      }
      if (ProviderUsage.hasAgyQuotaCollections(commandObj)) {
        return commandObj
      }
    }
    const responseText = stringProperty(rootObj, 'response')
    if (responseText && responseText.trim().startsWith('{')) {
      try {
        const nestedParsed: unknown = JSON.parse(responseText)
        if (
          nestedParsed &&
          typeof nestedParsed === 'object' &&
          !Array.isArray(nestedParsed) &&
          ProviderUsage.hasAgyQuotaCollections(nestedParsed)
        ) {
          return nestedParsed
        }
      } catch {
        return undefined
      }
    }
    return undefined
  }

  private static parseAgyGroups(container: object): AgyGroupCandidate[] | undefined {
    const rawGroups = Reflect.get(container, 'groups')
    if (Array.isArray(rawGroups)) {
      const groups: AgyGroupCandidate[] = []
      for (const rawGroup of rawGroups) {
        if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) return undefined
        const groupId =
          stringProperty(rawGroup, 'id') ??
          stringProperty(rawGroup, 'group_id') ??
          stringProperty(rawGroup, 'groupId')
        const groupName =
          stringProperty(rawGroup, 'name') ??
          stringProperty(rawGroup, 'display_name') ??
          'Gemini Models'
        const buckets = ProviderUsage.parseAgyBuckets(Reflect.get(rawGroup, 'buckets'))
        if (!buckets) return undefined
        groups.push({ ...(groupId ? { id: groupId } : {}), name: groupName, buckets })
      }
      return groups
    }

    const topBuckets = Reflect.get(container, 'buckets')
    if (Array.isArray(topBuckets)) {
      const buckets = ProviderUsage.parseAgyBuckets(topBuckets)
      if (!buckets) return undefined
      return [{ name: 'Gemini Models', buckets }]
    }
    return []
  }

  private static parseAgyBuckets(rawBuckets: unknown): AgyBucketCandidate[] | undefined {
    if (rawBuckets === undefined || rawBuckets === null) return []
    if (!Array.isArray(rawBuckets)) return undefined
    const buckets: AgyBucketCandidate[] = []
    for (const rawBucket of rawBuckets) {
      if (!rawBucket || typeof rawBucket !== 'object' || Array.isArray(rawBucket)) return undefined
      const id =
        stringProperty(rawBucket, 'id') ??
        stringProperty(rawBucket, 'bucket_id') ??
        stringProperty(rawBucket, 'bucketId')
      const name =
        stringProperty(rawBucket, 'name') ??
        stringProperty(rawBucket, 'display_name') ??
        stringProperty(rawBucket, 'displayName') ??
        id ??
        ''
      const window =
        stringProperty(rawBucket, 'window') ??
        stringProperty(rawBucket, 'refresh_window_label') ??
        stringProperty(rawBucket, 'refreshWindowLabel')
      const disabled = Reflect.get(rawBucket, 'disabled') === true
      const rawRemaining =
        Reflect.get(rawBucket, 'remaining_fraction') ?? Reflect.get(rawBucket, 'remainingFraction')
      const remainingFraction =
        typeof rawRemaining === 'number' && Number.isFinite(rawRemaining) ? rawRemaining : null
      const rawReset = Reflect.get(rawBucket, 'reset_time') ?? Reflect.get(rawBucket, 'resetTime')
      const resetsAt = normalizeIsoTimestamp(rawReset)
      buckets.push({
        ...(id ? { id } : {}),
        name,
        ...(window ? { window } : {}),
        disabled,
        remainingFraction,
        resetsAt,
      })
    }
    return buckets
  }

  private reconcileUnconfirmedProbes(slot: ProviderSlot): boolean {
    for (const probe of slot.unconfirmedProbes) {
      if (isProbeSettled(probe)) {
        slot.unconfirmedProbes.delete(probe)
        this.probes.delete(probe)
        const dir = this.unconfirmedAgyDirs.get(probe)
        if (dir) {
          this.unconfirmedAgyDirs.delete(probe)
          void rm(dir, { recursive: true, force: true }).catch(() => undefined)
        }
      }
    }
    return slot.unconfirmedProbes.size > 0
  }

  private ownProbe(
    signal: AbortSignal,
    onCloseInput: () => void | Promise<void>,
  ): OwnedProcessGroup {
    signal.throwIfAborted()
    for (const provider of ALL_USAGE_PROVIDERS) {
      this.reconcileUnconfirmedProbes(this.slots[provider])
    }
    for (const candidate of this.probes) {
      if (isProbeSettled(candidate)) this.probes.delete(candidate)
    }
    if (this.disposed || this.probes.size >= MAX_CONCURRENT_APP_PROBES) {
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
      slot.windows.identityDigest !== null &&
      slot.windows.configKey === configKey
    ) {
      slot.windows.degraded = true
      slot.nonWindow = undefined
      return this.buildSnapshot(provider, {
        status: 'stale',
        fiveHour: slot.windows.fiveHour,
        sevenDay: slot.windows.sevenDay,
        ...(slot.windows.pools ? { pools: [...slot.windows.pools] } : {}),
        checkedAt: slot.windows.checkedAt,
        identityConfirmed: true,
        ...(slot.windows.message ? { message: slot.windows.message } : {}),
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
      ...(windows?.pools ? { pools: [...windows.pools] } : {}),
      checkedAt: windows?.checkedAt ?? null,
      identityConfirmed: Boolean(windows?.identityDigest),
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
        message: 'Wait to retry',
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
        isWindowExpired(windows.sevenDay, nowMs) ||
        Boolean(
          windows.pools?.some(
            (pool) =>
              isWindowExpired(pool.fiveHour, nowMs) || isWindowExpired(pool.sevenDay, nowMs),
          ),
        )
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
        ...(windows.pools ? { pools: [...windows.pools] } : {}),
        checkedAt: windows.checkedAt,
        identityConfirmed: windows.identityDigest !== null,
        ...(windows.message ? { message: windows.message } : {}),
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
