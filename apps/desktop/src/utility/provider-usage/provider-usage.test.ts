import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimePreparation as RuntimePreparationSnapshot } from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { OwnedProcessGroup } from '../owned-process-group.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { ProviderUsage } from './provider-usage.js'

interface UsageFixtureOptions {
  codexBehavior?:
    | 'both'
    | 'five_hour_only'
    | 'seven_day_only'
    | 'api_key'
    | 'unauthenticated'
    | 'no_limits'
    | 'rate_limit_error'
    | 'account_read_error'
    | 'account_updated_mid_probe'
    | 'hold_limits_after_account'
  claudeBehavior?:
    | 'both'
    | 'five_hour_only'
    | 'cloud_billing'
    | 'api_key'
    | 'unauthenticated'
    | 'hold_usage_after_account'
  codexEmail?: string
  claudeEmail?: string
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  // oxlint-disable-next-line no-await-in-loop -- Dispose each probe owner before deleting temp directories.
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function readFacts(file: string): Promise<
  Array<{
    pid: number
    event?: string
    email?: string
    method?: string
    subtype?: string
    cwd?: string
  }>
> {
  try {
    return (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

async function createUsageFixture(options: UsageFixtureOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pact-provider-usage-test-'))
  const storageRoot = join(dir, 'storage')
  await mkdir(storageRoot, { recursive: true })
  const db = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
  })
  const runtime = new RuntimePreparation(db.runtimePreparationRepository)
  const usage = new ProviderUsage(runtime, storageRoot)

  const codexPath = join(dir, 'codex-usage-fixture.mjs')
  const claudePath = join(dir, 'claude-usage-fixture.mjs')
  const codexStatePath = join(dir, 'codex-state.json')
  const claudeStatePath = join(dir, 'claude-state.json')
  const codexFactsPath = join(dir, 'codex-facts.jsonl')
  const claudeFactsPath = join(dir, 'claude-facts.jsonl')
  const releasePath = join(dir, 'release')

  const initialState = {
    codexBehavior: options.codexBehavior ?? 'both',
    claudeBehavior: options.claudeBehavior ?? 'both',
    codexEmail: options.codexEmail ?? 'alpha@example.test',
    claudeEmail: options.claudeEmail ?? 'alpha@example.test',
    failLimits: false,
  }
  await writeFile(codexStatePath, JSON.stringify(initialState))
  await writeFile(claudeStatePath, JSON.stringify(initialState))

  await writeFile(
    codexPath,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const statePath = ${JSON.stringify(codexStatePath)}
const factsPath = ${JSON.stringify(codexFactsPath)}
const releasePath = ${JSON.stringify(releasePath)}
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const record = (entry) => appendFileSync(factsPath, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
record({ event: 'spawn', cwd: process.cwd() })

const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  const req = JSON.parse(line)
  if (req.method) record({ method: req.method })
  if (req.method === 'initialize') {
    send({ id: req.id, result: {} })
  } else if (req.method === 'account/read') {
    if (state.codexBehavior === 'account_read_error') {
      send({ id: req.id, error: { message: 'account read failed' } })
    } else if (state.codexBehavior === 'unauthenticated') {
      send({ id: req.id, result: { account: null, requiresOpenaiAuth: true } })
    } else if (state.codexBehavior === 'api_key') {
      send({ id: req.id, result: { account: { type: 'apiKey', email: state.codexEmail }, requiresOpenaiAuth: false } })
    } else {
      send({ id: req.id, result: { account: { type: 'chatgpt', email: state.codexEmail }, userId: 'uid-' + state.codexEmail, requiresOpenaiAuth: false } })
    }
    record({ event: 'account_read_sent', email: state.codexEmail })
    if (state.codexBehavior === 'account_updated_mid_probe') {
      send({ method: 'account/updated', params: {} })
    }
  } else if (req.method === 'account/rateLimits/read') {
    const replyLimits = () => {
      if (state.codexBehavior === 'rate_limit_error') {
        send({ id: req.id, error: { message: '429 rate limit exceeded' } })
        return
      }
      if (state.failLimits) {
        send({ id: req.id, error: { message: 'limits endpoint unavailable' } })
        return
      }
      if (state.codexBehavior === 'no_limits') {
        send({ id: req.id, result: { rateLimits: null } })
        return
      }
      const future = Math.floor(Date.now() / 1000) + 3600
      const primary = state.codexBehavior === 'seven_day_only'
        ? null
        : { windowDurationMins: 300, usedPercent: 18, resetsAt: future }
      const secondary = state.codexBehavior === 'five_hour_only'
        ? null
        : { windowDurationMins: 10080, usedPercent: 82, resetsAt: future + 86400 }
      send({
        id: req.id,
        result: {
          rateLimitsByLimitId: {
            codex: {
              ...(primary ? { primary } : {}),
              ...(secondary ? { secondary } : {}),
            },
          },
        },
      })
    }
    if (state.codexBehavior === 'hold_limits_after_account') {
      const timer = setInterval(() => {
        if (existsSync(releasePath)) {
          clearInterval(timer)
          replyLimits()
        }
      }, 15)
    } else {
      replyLimits()
    }
  }
}
`,
    { mode: 0o755 },
  )
  await chmod(codexPath, 0o755)

  await writeFile(
    claudePath,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const statePath = ${JSON.stringify(claudeStatePath)}
const factsPath = ${JSON.stringify(claudeFactsPath)}
const releasePath = ${JSON.stringify(releasePath)}
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const record = (entry) => appendFileSync(factsPath, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
record({ event: 'spawn', cwd: process.cwd() })

const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  const msg = JSON.parse(line)
  if (msg.type !== 'control_request') continue
  record({ subtype: msg.request.subtype })
  if (msg.request.subtype === 'initialize') {
    const account =
      state.claudeBehavior === 'unauthenticated'
        ? {}
        : state.claudeBehavior === 'cloud_billing'
          ? { email: state.claudeEmail, organization: 'Org Secret', apiProvider: 'bedrock' }
          : state.claudeBehavior === 'api_key'
            ? { email: state.claudeEmail, apiKeySource: 'env' }
            : { email: state.claudeEmail, organization: 'Org Secret', apiProvider: 'firstParty', subscriptionType: 'max' }
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: {
          commands: [],
          agents: [],
          output_style: 'default',
          available_output_styles: ['default'],
          models: [],
          account,
          hooks_applied: true,
          current_permission_mode: 'dontAsk',
        },
      },
    })
    record({ event: 'claude_account_sent', email: state.claudeEmail })
  } else if (msg.request.subtype === 'get_usage') {
    const replyUsage = () => {
      if (state.failLimits) {
        send({
          type: 'control_response',
          response: { subtype: 'error', request_id: msg.request_id, error: 'Limits probe failed' },
        })
        return
      }
      if (state.claudeBehavior === 'unauthenticated' || state.claudeBehavior === 'api_key') {
        send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: msg.request_id,
            response: { subscription_type: null, rate_limits_available: false, rate_limits: null },
          },
        })
        return
      }
      const future = new Date(Date.now() + 3600_000).toISOString()
      const rate_limits =
        state.claudeBehavior === 'five_hour_only'
          ? { five_hour: { utilization: 25, resets_at: future } }
          : {
              five_hour: { utilization: 96, resets_at: future },
              seven_day: { utilization: 40, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
            }
      send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response: { subscription_type: 'max', rate_limits_available: true, rate_limits },
        },
      })
    }
    if (state.claudeBehavior === 'hold_usage_after_account') {
      const timer = setInterval(() => {
        if (existsSync(releasePath)) {
          clearInterval(timer)
          replyUsage()
        }
      }, 15)
    } else {
      replyUsage()
    }
  }
}
`,
    { mode: 0o755 },
  )
  await chmod(claudePath, 0o755)

  let readinessAgents: RuntimePreparationSnapshot['agents'] = [
    {
      agentId: 'codex',
      state: 'ready',
      executablePath: codexPath,
      checkedAt: new Date().toISOString(),
    },
    {
      agentId: 'claude',
      state: 'ready',
      executablePath: claudePath,
      checkedAt: new Date().toISOString(),
    },
  ]
  let configSeed = 'config-1'
  vi.spyOn(runtime, 'inspectReadiness').mockImplementation(async () => ({
    ok: true,
    value: { firstUse: false, agents: readinessAgents },
  }))
  vi.spyOn(runtime, 'providerConfigurationKey').mockImplementation(
    (provider) => `${provider}:${configSeed}`,
  )

  cleanups.push(async () => {
    await usage.dispose()
    await runtime.dispose()
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  return {
    dir,
    storageRoot,
    usage,
    runtime,
    codexStatePath,
    claudeStatePath,
    codexFactsPath,
    claudeFactsPath,
    releasePath,
    readFacts,
    setConfigSeed(next: string) {
      configSeed = next
    },
    setReadiness(next: typeof readinessAgents) {
      readinessAgents = next
    },
    async updateCodexState(next: Partial<typeof initialState>) {
      const current = JSON.parse(await readFile(codexStatePath, 'utf8'))
      await writeFile(codexStatePath, JSON.stringify({ ...current, ...next }))
    },
    async updateClaudeState(next: Partial<typeof initialState>) {
      const current = JSON.parse(await readFile(claudeStatePath, 'utf8'))
      await writeFile(claudeStatePath, JSON.stringify({ ...current, ...next }))
    },
  }
}

describe.skipIf(process.platform === 'win32')('ProviderUsage utility owner', () => {
  it('probes Codex and Claude inside an empty private directory without leaking PII or raw output, and omits absent windows', async () => {
    const f = await createUsageFixture({
      codexBehavior: 'five_hour_only',
      claudeBehavior: 'both',
      codexEmail: 'private.user@corp.example',
      claudeEmail: 'private.claude@corp.example',
    })
    const ownerId = crypto.randomUUID()

    const codexResult = await f.usage.refresh({
      ownerId,
      provider: 'codex',
      requestId: crypto.randomUUID(),
    })
    expect(codexResult).toMatchObject({
      ok: true,
      value: {
        provider: 'codex',
        status: 'partial',
        fiveHour: { usedPercent: 18, resetsAt: expect.any(String) },
        sevenDay: null,
        identityConfirmed: true,
      },
    })

    const claudeResult = await f.usage.refresh({
      ownerId,
      provider: 'claude',
      requestId: crypto.randomUUID(),
    })
    expect(claudeResult).toMatchObject({
      ok: true,
      value: {
        provider: 'claude',
        status: 'ready',
        fiveHour: { usedPercent: 96, resetsAt: expect.any(String) },
        sevenDay: { usedPercent: 40, resetsAt: expect.any(String) },
        identityConfirmed: true,
      },
    })

    const serialized = JSON.stringify([codexResult, claudeResult])
    expect(serialized).not.toContain('private.user@corp.example')
    expect(serialized).not.toContain('private.claude@corp.example')
    expect(serialized).not.toContain('Org Secret')
    expect(serialized).not.toContain(f.dir)

    const codexFacts = await f.readFacts(f.codexFactsPath)
    const claudeFacts = await f.readFacts(f.claudeFactsPath)
    expect(codexFacts[0]?.cwd).toContain('provider-usage-probe')
    expect(claudeFacts[0]?.cwd).toContain('provider-usage-probe')

    // All spawned probe processes are confirmed dead after completion.
    for (const fact of [...codexFacts, ...claudeFacts]) {
      expect(() => process.kill(fact.pid, 0)).toThrow(/ESRCH/u)
    }
  })

  it('reports non-window states honestly (unauthenticated, apiKey, cloud billing, no limits)', async () => {
    const f = await createUsageFixture({
      codexBehavior: 'unauthenticated',
      claudeBehavior: 'cloud_billing',
    })
    const ownerId = crypto.randomUUID()

    expect(
      await f.usage.refresh({ ownerId, provider: 'codex', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: {
        status: 'unauthenticated',
        fiveHour: null,
        sevenDay: null,
        message: 'Sign in required',
      },
    })

    expect(
      await f.usage.refresh({ ownerId, provider: 'claude', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'not_applicable', fiveHour: null, sevenDay: null, message: 'Cloud billing' },
    })

    f.setConfigSeed('config-2')
    await f.updateCodexState({ codexBehavior: 'api_key' })
    await f.updateClaudeState({ claudeBehavior: 'api_key' })

    expect(
      await f.usage.refresh({ ownerId, provider: 'codex', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'not_applicable', message: 'API key' },
    })
    expect(
      await f.usage.refresh({ ownerId, provider: 'claude', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'not_applicable', message: 'API key' },
    })
  })

  it('invalidates prior account windows and nonWindow on account switch + limits failure and mid-probe cancel()', async () => {
    const f = await createUsageFixture({
      codexBehavior: 'both',
      claudeBehavior: 'both',
      codexEmail: 'account-a@example.test',
      claudeEmail: 'account-a@example.test',
    })
    const ownerId = crypto.randomUUID()

    // 1. Account A succeeds and caches windows.
    expect(
      await f.usage.refresh({ ownerId, provider: 'codex', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'ready', fiveHour: { usedPercent: 18 }, sevenDay: { usedPercent: 82 } },
    })
    expect(
      await f.usage.refresh({ ownerId, provider: 'claude', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'ready', fiveHour: { usedPercent: 96 }, sevenDay: { usedPercent: 40 } },
    })

    // 2. Account switches to Account B and limits probe FAILS (bypassing cooldown via config seed or time).
    // Keep same configSeed to prove identityDigest change (not configKey) invalidates Account A's numbers!
    const baseNow = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow + 31_000)

    await f.updateCodexState({ codexEmail: 'account-b@example.test', failLimits: true })
    await f.updateClaudeState({ claudeEmail: 'account-b@example.test', failLimits: true })

    // Must NOT fall back to Account A's stale windows! Must report unavailable.
    expect(
      await f.usage.refresh({ ownerId, provider: 'codex', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'unavailable', fiveHour: null, sevenDay: null, message: 'Unavailable' },
    })
    expect(
      await f.usage.refresh({ ownerId, provider: 'claude', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'unavailable', fiveHour: null, sevenDay: null, message: 'Unavailable' },
    })

    // Now test mid-probe cancel() after identity switch when prior slot held windows vs nonWindow:
    // A) Prior slot holds nonWindow with confirmed identityDigest (Account B2 'no_limits') ->
    //    Account C starts probe, account/read reconciles to C, then cancel() clears Account B2's nonWindow -> 'idle'.
    nowSpy.mockReturnValue(baseNow + 95_000)
    await f.updateCodexState({
      codexEmail: 'account-b2@example.test',
      codexBehavior: 'no_limits',
      failLimits: false,
    })
    await f.updateClaudeState({
      claudeEmail: 'account-b2@example.test',
      claudeBehavior: 'api_key',
      failLimits: false,
    })
    expect(
      await f.usage.refresh({ ownerId, provider: 'codex', requestId: crypto.randomUUID() }),
    ).toMatchObject({ ok: true, value: { status: 'not_applicable', identityConfirmed: true } })
    expect(
      await f.usage.refresh({ ownerId, provider: 'claude', requestId: crypto.randomUUID() }),
    ).toMatchObject({ ok: true, value: { status: 'not_applicable', identityConfirmed: true } })

    nowSpy.mockReturnValue(baseNow + 130_000)
    await f.updateCodexState({
      codexEmail: 'account-c@example.test',
      codexBehavior: 'hold_limits_after_account',
      failLimits: false,
    })
    await f.updateClaudeState({
      claudeEmail: 'account-c@example.test',
      claudeBehavior: 'hold_usage_after_account',
      failLimits: false,
    })

    const codexCancelReq = crypto.randomUUID()
    const codexPending = f.usage.refresh({ ownerId, provider: 'codex', requestId: codexCancelReq })
    await vi.waitFor(async () => {
      const facts = await f.readFacts(f.codexFactsPath)
      expect(
        facts.some(
          (fact) => fact.event === 'account_read_sent' && fact.email === 'account-c@example.test',
        ),
      ).toBe(true)
    })

    const claudeCancelReq = crypto.randomUUID()
    const claudePending = f.usage.refresh({
      ownerId,
      provider: 'claude',
      requestId: claudeCancelReq,
    })
    await vi.waitFor(async () => {
      const facts = await f.readFacts(f.claudeFactsPath)
      expect(
        facts.some(
          (fact) => fact.event === 'claude_account_sent' && fact.email === 'account-c@example.test',
        ),
      ).toBe(true)
    })

    expect(await f.usage.cancel({ ownerId, provider: 'codex', requestId: codexCancelReq })).toEqual(
      { ok: true, value: { cancelled: true, settled: true } },
    )
    expect(
      await f.usage.cancel({ ownerId, provider: 'claude', requestId: claudeCancelReq }),
    ).toEqual({ ok: true, value: { cancelled: true, settled: true } })

    // Mid-probe cancel after identity change cleared prior nonWindow -> snapshot is idle, not stale not_applicable!
    expect(await codexPending).toMatchObject({
      ok: true,
      value: { status: 'idle', fiveHour: null, sevenDay: null },
    })
    expect(await claudePending).toMatchObject({
      ok: true,
      value: { status: 'idle', fiveHour: null, sevenDay: null },
    })
    expect(f.usage.read('codex')).toMatchObject({
      ok: true,
      value: { status: 'idle', fiveHour: null, sevenDay: null },
    })
    expect(f.usage.read('claude')).toMatchObject({
      ok: true,
      value: { status: 'idle', fiveHour: null, sevenDay: null },
    })

    // B) Prior slot holds valid windows (Account D cached) -> Account E held -> cancel() clears Account D's windows -> 'idle'.
    nowSpy.mockReturnValue(baseNow + 165_000)
    await f.updateCodexState({
      codexEmail: 'account-d@example.test',
      codexBehavior: 'both',
      failLimits: false,
    })
    expect(
      await f.usage.refresh({ ownerId, provider: 'codex', requestId: crypto.randomUUID() }),
    ).toMatchObject({ ok: true, value: { status: 'ready', fiveHour: { usedPercent: 18 } } })

    nowSpy.mockReturnValue(baseNow + 200_000)
    await f.updateCodexState({
      codexEmail: 'account-e@example.test',
      codexBehavior: 'hold_limits_after_account',
    })
    const cancelWinReq = crypto.randomUUID()
    const winPending = f.usage.refresh({ ownerId, provider: 'codex', requestId: cancelWinReq })
    await vi.waitFor(async () => {
      const facts = await f.readFacts(f.codexFactsPath)
      expect(
        facts.some(
          (fact) => fact.event === 'account_read_sent' && fact.email === 'account-e@example.test',
        ),
      ).toBe(true)
    })
    expect(await f.usage.cancel({ ownerId, provider: 'codex', requestId: cancelWinReq })).toEqual({
      ok: true,
      value: { cancelled: true, settled: true },
    })
    expect(await winPending).toMatchObject({
      ok: true,
      value: { status: 'idle', fiveHour: null, sevenDay: null },
    })

    // C) account/updated mid-probe notification invalidates cached windows.
    nowSpy.mockReturnValue(baseNow + 235_000)
    await f.updateCodexState({
      codexEmail: 'account-f@example.test',
      codexBehavior: 'both',
    })
    expect(
      await f.usage.refresh({ ownerId, provider: 'codex', requestId: crypto.randomUUID() }),
    ).toMatchObject({ ok: true, value: { status: 'ready', fiveHour: { usedPercent: 18 } } })

    nowSpy.mockReturnValue(baseNow + 270_000)
    await f.updateCodexState({
      codexEmail: 'account-f@example.test',
      codexBehavior: 'account_updated_mid_probe',
    })
    expect(
      await f.usage.refresh({ ownerId, provider: 'codex', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'unavailable', fiveHour: null, sevenDay: null, message: 'Unavailable' },
    })
  })

  it('enforces 30s/60s cooldown, 5m staleness, busy/cancelling single-slot overlays, and clean owner release', async () => {
    const f = await createUsageFixture({
      codexBehavior: 'hold_limits_after_account',
      claudeBehavior: 'both',
    })
    const ownerOne = crypto.randomUUID()
    const ownerTwo = crypto.randomUUID()
    const reqOne = crypto.randomUUID()

    // While ownerOne is probing Codex, ownerTwo sees 'busy'.
    const firstProbe = f.usage.refresh({ ownerId: ownerOne, provider: 'codex', requestId: reqOne })
    await vi.waitFor(async () => {
      const facts = await f.readFacts(f.codexFactsPath)
      expect(facts.some((fact) => fact.event === 'account_read_sent')).toBe(true)
    })
    expect(
      await f.usage.refresh({
        ownerId: ownerTwo,
        provider: 'codex',
        requestId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: true, value: { status: 'busy' } })

    // Releasing ownerOne cancels active probe cleanly and kills child process.
    expect(await f.usage.releaseOwner(ownerOne)).toEqual({ ok: true, value: { ready: true } })
    await firstProbe
    const codexFacts = await f.readFacts(f.codexFactsPath)
    for (const fact of codexFacts) {
      expect(() => process.kill(fact.pid, 0)).toThrow(/ESRCH/u)
    }

    // Cooldown prevents immediate re-probe; stale after 5 minutes.
    const t0 = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)
    await f.updateCodexState({ codexBehavior: 'both' })
    expect(
      await f.usage.refresh({
        ownerId: ownerOne,
        provider: 'codex',
        requestId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: true, value: { status: 'ready' } })

    const factsBeforeCooldown = (await f.readFacts(f.codexFactsPath)).length
    nowSpy.mockReturnValue(t0 + 10_000)
    expect(
      await f.usage.refresh({
        ownerId: ownerOne,
        provider: 'codex',
        requestId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: true, value: { status: 'ready', cooldownUntil: expect.any(String) } })
    expect((await f.readFacts(f.codexFactsPath)).length).toBe(factsBeforeCooldown)

    // After 5m+, cached snapshot transitions to 'stale'.
    nowSpy.mockReturnValue(t0 + 5 * 60_000 + 1)
    expect(f.usage.read('codex')).toMatchObject({
      ok: true,
      value: { status: 'stale', fiveHour: { usedPercent: 18 } },
    })

    // 429 error triggers 60-second backoff while retaining stale cached windows for same identity.
    await f.updateCodexState({ codexBehavior: 'rate_limit_error' })
    const rateLimited = await f.usage.refresh({
      ownerId: ownerOne,
      provider: 'codex',
      requestId: crypto.randomUUID(),
    })
    expect(rateLimited).toMatchObject({
      ok: true,
      value: { status: 'stale', fiveHour: { usedPercent: 18 }, cooldownUntil: expect.any(String) },
    })
    const cooldownMs = rateLimited.ok ? Date.parse(rateLimited.value.cooldownUntil!) : 0
    expect(cooldownMs - (t0 + 5 * 60_000 + 1)).toBeGreaterThanOrEqual(59_000)

    // Probe failure before identity confirmation must NOT return cached stale windows with identityConfirmed: true.
    nowSpy.mockReturnValue(t0 + 10 * 60_000)
    await f.updateCodexState({ codexBehavior: 'account_read_error' })
    expect(
      await f.usage.refresh({
        ownerId: ownerOne,
        provider: 'codex',
        requestId: crypto.randomUUID(),
      }),
    ).toMatchObject({
      ok: true,
      value: {
        status: 'unavailable',
        fiveHour: null,
        sevenDay: null,
        identityConfirmed: false,
        message: 'Unavailable',
      },
    })
  })

  it('recovers automatically from close_unconfirmed once the owned probe process releases', async () => {
    const f = await createUsageFixture({ codexBehavior: 'both' })
    const ownerId = crypto.randomUUID()
    const descriptor = Object.getOwnPropertyDescriptor(OwnedProcessGroup.prototype, 'close')
    const closeImpl =
      descriptor && typeof descriptor.value === 'function' ? descriptor.value : undefined
    if (!closeImpl) throw new Error('Expected OwnedProcessGroup.prototype.close')
    const callOrigClose = async (group: OwnedProcessGroup, deadlineAt?: number): Promise<void> => {
      await Reflect.apply(closeImpl, group, [deadlineAt])
    }
    let firstClose = true
    let releaseDeferred!: () => void
    const deferredGate = new Promise<void>((release) => {
      releaseDeferred = release
    })
    const closedLater = Promise.withResolvers<void>()
    const spy = vi.spyOn(OwnedProcessGroup.prototype, 'close').mockImplementation(async function (
      this: OwnedProcessGroup,
      deadlineAt?: number,
    ) {
      if (firstClose) {
        firstClose = false
        void deferredGate.then(async () => {
          await callOrigClose(this, deadlineAt).catch(() => undefined)
          closedLater.resolve()
          return undefined
        })
        throw new Error('Simulated cleanup timeout')
      }
      return callOrigClose(this, deadlineAt)
    })
    void spy

    expect(
      await f.usage.refresh({ ownerId, provider: 'codex', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'close_unconfirmed', message: 'Wait to retry', identityConfirmed: false },
    })
    expect(f.usage.read('codex')).toMatchObject({
      ok: true,
      value: { status: 'close_unconfirmed', message: 'Wait to retry' },
    })

    releaseDeferred()
    await closedLater.promise

    expect(f.usage.read('codex')).toMatchObject({
      ok: true,
      value: { status: 'idle', fiveHour: null, sevenDay: null },
    })
    expect(
      await f.usage.refresh({ ownerId, provider: 'codex', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'ready', fiveHour: { usedPercent: 18 }, identityConfirmed: true },
    })
  })
})
