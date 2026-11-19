import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimePreparation as RuntimePreparationSnapshot } from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { OwnedProcessGroup } from '../owned-process-group.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { ProviderUsage, remainingFractionToUsedPercent } from './provider-usage.js'

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
  agyBehavior?:
    | 'multi_pool'
    | 'single_pool'
    | 'five_hour_only'
    | 'api_key'
    | 'cloud_billing'
    | 'no_quota_summary'
    | 'unauthenticated'
    | 'rate_limit_error'
    | 'overflow_64k'
    | 'hold_usage'
    | 'org_custom_pool'
    | 'no_account_id'
    | 'command_envelope'
    | 'command_envelope_partner_only'
    | 'command_envelope_cloud_billing'
  codexEmail?: string
  claudeEmail?: string
  agyEmail?: string
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
    cwdMode?: number
    args?: string[]
    ts?: number
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
  const isolatedHome = join(dir, 'home')
  const isolatedGemini = join(isolatedHome, '.gemini')
  await mkdir(storageRoot, { recursive: true })
  await mkdir(isolatedGemini, { recursive: true })
  const isolatedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    ANTIGRAVITY_GEMINI_DIR: isolatedGemini,
  }
  const db = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
  })
  const runtime = new RuntimePreparation(db.runtimePreparationRepository, { env: isolatedEnv })
  const usage = new ProviderUsage(runtime, storageRoot, { env: isolatedEnv })

  const codexPath = join(dir, 'codex-usage-fixture.mjs')
  const claudePath = join(dir, 'claude-usage-fixture.mjs')
  const agyPath = join(dir, 'agy-usage-fixture.mjs')
  const codexStatePath = join(dir, 'codex-state.json')
  const claudeStatePath = join(dir, 'claude-state.json')
  const agyStatePath = join(dir, 'agy-state.json')
  const codexFactsPath = join(dir, 'codex-facts.jsonl')
  const claudeFactsPath = join(dir, 'claude-facts.jsonl')
  const agyFactsPath = join(dir, 'agy-facts.jsonl')
  const concurrencyFactsPath = join(dir, 'concurrency-facts.jsonl')
  const releasePath = join(dir, 'release')

  const initialState = {
    codexBehavior: options.codexBehavior ?? 'both',
    claudeBehavior: options.claudeBehavior ?? 'both',
    agyBehavior: options.agyBehavior ?? 'multi_pool',
    codexEmail: options.codexEmail ?? 'alpha@example.test',
    claudeEmail: options.claudeEmail ?? 'alpha@example.test',
    agyEmail: options.agyEmail ?? 'alpha@example.test',
    failLimits: false,
    delayMs: 0,
  }
  await writeFile(codexStatePath, JSON.stringify(initialState))
  await writeFile(claudeStatePath, JSON.stringify(initialState))
  await writeFile(agyStatePath, JSON.stringify(initialState))

  await writeFile(
    codexPath,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const statePath = ${JSON.stringify(codexStatePath)}
const factsPath = ${JSON.stringify(codexFactsPath)}
const concurrencyPath = ${JSON.stringify(concurrencyFactsPath)}
const releasePath = ${JSON.stringify(releasePath)}
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const record = (entry) => appendFileSync(factsPath, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
const recordConcurrency = (event) => appendFileSync(concurrencyPath, JSON.stringify({ provider: 'codex', pid: process.pid, event, ts: Date.now() }) + '\\n')
let ended = false
const markEnd = () => {
  if (ended) return
  ended = true
  recordConcurrency('end')
}
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
record({ event: 'spawn', cwd: process.cwd() })
recordConcurrency('start')
process.on('exit', markEnd)
process.on('SIGTERM', () => { markEnd(); process.exit(0) })

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
    } else if (state.delayMs > 0) {
      setTimeout(replyLimits, state.delayMs)
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
const concurrencyPath = ${JSON.stringify(concurrencyFactsPath)}
const releasePath = ${JSON.stringify(releasePath)}
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const record = (entry) => appendFileSync(factsPath, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
const recordConcurrency = (event) => appendFileSync(concurrencyPath, JSON.stringify({ provider: 'claude', pid: process.pid, event, ts: Date.now() }) + '\\n')
let ended = false
const markEnd = () => {
  if (ended) return
  ended = true
  recordConcurrency('end')
}
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
record({ event: 'spawn', cwd: process.cwd() })
recordConcurrency('start')
process.on('exit', markEnd)
process.on('SIGTERM', () => { markEnd(); process.exit(0) })

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
    } else if (state.delayMs > 0) {
      setTimeout(replyUsage, state.delayMs)
    } else {
      replyUsage()
    }
  }
}
`,
    { mode: 0o755 },
  )
  await chmod(claudePath, 0o755)

  await writeFile(
    agyPath,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'

const statePath = ${JSON.stringify(agyStatePath)}
const factsPath = ${JSON.stringify(agyFactsPath)}
const concurrencyPath = ${JSON.stringify(concurrencyFactsPath)}
const releasePath = ${JSON.stringify(releasePath)}
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const cwdMode = statSync(process.cwd()).mode & 0o777
const args = process.argv.slice(2)
const record = (entry) => appendFileSync(factsPath, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
const recordConcurrency = (event) => appendFileSync(concurrencyPath, JSON.stringify({ provider: 'agy', pid: process.pid, event, ts: Date.now() }) + '\\n')
record({ event: 'spawn', cwd: process.cwd(), cwdMode, args, email: state.agyEmail })
recordConcurrency('start')
process.on('exit', () => recordConcurrency('end'))

const finish = () => {
  if (state.agyBehavior === 'overflow_64k') {
    process.stdout.write('x'.repeat(70 * 1024))
    process.exit(0)
    return
  }
  if (state.agyBehavior === 'unauthenticated') {
    process.stdout.write(JSON.stringify({
      conversation_id: '',
      status: 'ERROR',
      response: '',
      error: 'authentication failed or timed out',
    }) + '\\n')
    process.stderr.write('Authentication required. Please visit the URL to log in:\\n')
    process.exit(1)
    return
  }
  if (state.agyBehavior === 'rate_limit_error') {
    process.stdout.write(JSON.stringify({
      status: 'ERROR',
      email: state.agyEmail,
      error: '429 rate limit exceeded',
    }) + '\\n')
    process.exit(1)
    return
  }
  if (state.failLimits) {
    process.stdout.write(JSON.stringify({
      status: 'ERROR',
      email: state.agyEmail,
      error: 'quota service unavailable',
    }) + '\\n')
    process.exit(1)
    return
  }
  if (state.agyBehavior === 'api_key') {
    process.stdout.write(JSON.stringify({
      email: state.agyEmail,
      auth_method: 'gemini-api-key',
      description: 'Gemini API key',
      groups: [],
    }) + '\\n')
    process.exit(0)
    return
  }
  if (state.agyBehavior === 'cloud_billing') {
    process.stdout.write(JSON.stringify({
      email: state.agyEmail,
      auth_method: 'agent-platform',
      description: 'Vertex AI Cloud billing',
      groups: [],
    }) + '\\n')
    process.exit(0)
    return
  }
  if (state.agyBehavior === 'no_quota_summary') {
    process.stderr.write('no quota summary is available for this account\\n')
    process.exit(1)
    return
  }

  if (state.agyBehavior === 'command_envelope_cloud_billing') {
    process.stdout.write(JSON.stringify({
      conversation_id: '',
      status: 'SUCCESS',
      response: 'No subscription quota windows.',
      duration_seconds: 0,
      num_turns: 0,
      command: {
        name: 'usage',
        data: {
          description: 'Vertex AI Cloud billing is active without plan limits.',
          groups: [],
        },
      },
    }) + '\\n')
    process.exit(0)
    return
  }

  const reset5h = new Date(Date.now() + 3600_000).toISOString()
  const resetWeekly = new Date(Date.now() + 6 * 86_400_000).toISOString()
  if (
    state.agyBehavior === 'command_envelope' ||
    state.agyBehavior === 'command_envelope_partner_only'
  ) {
    const partnerBuckets = [
      { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9137, reset_time: resetWeekly },
      { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: reset5h },
    ]
    const envelopeGroups =
      state.agyBehavior === 'command_envelope_partner_only'
        ? [
            {
              name: 'Gemini Models',
              buckets: [],
            },
            {
              name: 'Claude and GPT models',
              buckets: partnerBuckets,
            },
          ]
        : [
            {
              name: 'Gemini Models',
              buckets: [
                { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.463, reset_time: resetWeekly },
                { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.438, reset_time: reset5h },
              ],
            },
            {
              name: 'Claude and GPT models',
              buckets: partnerBuckets,
            },
          ]
    process.stdout.write(JSON.stringify({
      conversation_id: '',
      status: 'SUCCESS',
      response: 'Plan usage summary.',
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
      command: {
        name: 'usage',
        data: {
          description: 'You are on a Google AI Pro plan.',
          groups: envelopeGroups,
        },
      },
    }) + '\\n')
    process.exit(0)
    return
  }
  const geminiBuckets =
    state.agyBehavior === 'five_hour_only'
      ? [{ id: 'gemini-5h', name: '5-hour', window: '5h', remaining_fraction: 0.875, reset_time: reset5h }]
      : [
          { id: 'gemini-5h', name: '5-hour', window: '5h', remaining_fraction: 0.875, reset_time: reset5h },
          { id: 'gemini-weekly', name: 'Weekly', window: '7d', remaining_fraction: 0.333, reset_time: resetWeekly },
        ]
  const groups =
    state.agyBehavior === 'single_pool' || state.agyBehavior === 'five_hour_only'
      ? [{ name: 'Gemini Models', buckets: geminiBuckets }]
      : state.agyBehavior === 'org_custom_pool'
        ? [
            {
              name: 'Acme Secret Enterprise Project X',
              buckets: [
                { id: 'custom-5h', name: '5-hour', window: '5h', remaining_fraction: 0.75, reset_time: reset5h },
                { id: 'custom-7d', name: 'Weekly', window: '7d', remaining_fraction: 0.5, reset_time: resetWeekly },
              ],
            },
            {
              name: 'Internal Secondary Pool',
              buckets: [
                { id: 'other-7d', name: 'Weekly', window: '7d', remaining_fraction: 0.9, reset_time: resetWeekly },
              ],
            },
          ]
        : [
            { name: 'Gemini Models', buckets: geminiBuckets },
            {
              name: 'Partner Models',
              buckets: [
                { id: 'partner-5h', name: '5-hour', window: '5h', remaining_fraction: 0.5, reset_time: reset5h },
              ],
            },
          ]

  const payload =
    state.agyBehavior === 'no_account_id'
      ? {
          account: { authMethod: 'google-login', tier: 'pro', organization: 'Shared Org' },
          description: 'Antigravity Pro',
          groups,
        }
      : {
          email: state.agyEmail,
          account: { email: state.agyEmail, organization: 'Antigravity Corp Secret' },
          description: 'Antigravity Pro',
          groups,
        }

  process.stdout.write(JSON.stringify(payload) + '\\n')
  process.exit(0)
}

if (state.agyBehavior === 'hold_usage') {
  const timer = setInterval(() => {
    if (existsSync(releasePath)) {
      clearInterval(timer)
      finish()
    }
  }, 15)
} else if (state.delayMs > 0) {
  setTimeout(finish, state.delayMs)
} else {
  finish()
}
`,
    { mode: 0o755 },
  )
  await chmod(agyPath, 0o755)

  let readinessAgents: RuntimePreparationSnapshot['agents'] = [
    {
      agentId: 'claude',
      state: 'ready',
      executablePath: claudePath,
      checkedAt: new Date().toISOString(),
    },
    {
      agentId: 'codex',
      state: 'ready',
      executablePath: codexPath,
      checkedAt: new Date().toISOString(),
    },
    {
      agentId: 'agy',
      state: 'ready',
      executablePath: agyPath,
      checkedAt: new Date().toISOString(),
    },
  ]
  let configSeed = 'config-1'
  const fullReadinessSpy = vi.spyOn(runtime, 'inspectReadiness')
  vi.spyOn(runtime, 'inspectProviderReadiness').mockImplementation(async (provider) => {
    const found = readinessAgents.find((candidate) => candidate.agentId === provider)
    return found
      ? { ok: true, value: found }
      : {
          ok: true,
          value: { agentId: provider, state: 'missing', checkedAt: new Date().toISOString() },
        }
  })
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
    agyStatePath,
    codexFactsPath,
    claudeFactsPath,
    agyFactsPath,
    concurrencyFactsPath,
    releasePath,
    fullReadinessSpy,
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
    async updateAgyState(next: Partial<typeof initialState>) {
      const current = JSON.parse(await readFile(agyStatePath, 'utf8'))
      await writeFile(agyStatePath, JSON.stringify({ ...current, ...next }))
    },
  }
}

describe('remainingFractionToUsedPercent formula', () => {
  it('converts remaining_fraction via Math.round((1 - remaining_fraction) * 1000) / 10 clamped to 0..100', () => {
    expect(remainingFractionToUsedPercent(1)).toBe(0)
    expect(remainingFractionToUsedPercent(0)).toBe(100)
    expect(remainingFractionToUsedPercent(0.875)).toBe(12.5)
    expect(remainingFractionToUsedPercent(0.3333)).toBe(66.7)
    expect(remainingFractionToUsedPercent(1.5)).toBe(0)
    expect(remainingFractionToUsedPercent(-0.25)).toBe(100)
    expect(remainingFractionToUsedPercent(Number.NaN)).toBeNull()
    expect(remainingFractionToUsedPercent(undefined)).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('ProviderUsage utility owner', () => {
  it('probes Codex, Claude, and Antigravity inside 0o700 private directories without leaking PII or raw output, parsing agy quota buckets and pool scope notes', async () => {
    const f = await createUsageFixture({
      codexBehavior: 'five_hour_only',
      claudeBehavior: 'both',
      agyBehavior: 'multi_pool',
      codexEmail: 'private.user@corp.example',
      claudeEmail: 'private.claude@corp.example',
      agyEmail: 'private.agy@corp.example',
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

    const agyResult = await f.usage.refresh({
      ownerId,
      provider: 'agy',
      requestId: crypto.randomUUID(),
    })
    expect(agyResult).toMatchObject({
      ok: true,
      value: {
        provider: 'agy',
        status: 'ready',
        fiveHour: { usedPercent: 12.5, resetsAt: expect.any(String) },
        sevenDay: { usedPercent: 66.7, resetsAt: expect.any(String) },
        identityConfirmed: true,
        message: 'Gemini Models quota',
      },
    })
    expect(f.usage.read('agy')).toMatchObject({
      ok: true,
      value: {
        provider: 'agy',
        status: 'ready',
        message: 'Gemini Models quota',
      },
    })

    const serialized = JSON.stringify([codexResult, claudeResult, agyResult])
    expect(serialized).not.toContain('private.user@corp.example')
    expect(serialized).not.toContain('private.claude@corp.example')
    expect(serialized).not.toContain('private.agy@corp.example')
    expect(serialized).not.toContain('Org Secret')
    expect(serialized).not.toContain('Antigravity Corp Secret')
    expect(serialized).not.toContain(f.dir)

    const codexFacts = await f.readFacts(f.codexFactsPath)
    const claudeFacts = await f.readFacts(f.claudeFactsPath)
    const agyFacts = await f.readFacts(f.agyFactsPath)
    expect(codexFacts[0]?.cwd).toContain('provider-usage-probe')
    expect(claudeFacts[0]?.cwd).toContain('provider-usage-probe')
    expect(agyFacts[0]?.cwd).toContain('provider-usage-probe')
    expect(agyFacts[0]?.cwdMode).toBe(0o700)
    expect(agyFacts[0]?.args).toEqual(['-p', '/usage', '--output-format', 'json'])

    // All spawned probe processes are confirmed dead after completion.
    for (const fact of [...codexFacts, ...claudeFacts, ...agyFacts]) {
      expect(() => process.kill(fact.pid, 0)).toThrow(/ESRCH/u)
    }

    // Single-pool agy omits the multi-pool message note.
    f.setConfigSeed('config-single-pool')
    await f.updateAgyState({ agyBehavior: 'single_pool' })
    const singlePoolAgy = await f.usage.refresh({
      ownerId,
      provider: 'agy',
      requestId: crypto.randomUUID(),
    })
    if (!singlePoolAgy.ok) throw new Error(singlePoolAgy.error.message)
    expect(singlePoolAgy.value.status).toBe('ready')
    expect(singlePoolAgy.value.message).toBeUndefined()
    expect(singlePoolAgy.value.pools).toBeUndefined()
  })

  it('reports non-window states honestly across all 3 providers (unauthenticated, apiKey, cloud billing, no limits, 64 KiB cap)', async () => {
    const f = await createUsageFixture({
      codexBehavior: 'unauthenticated',
      claudeBehavior: 'cloud_billing',
      agyBehavior: 'unauthenticated',
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

    expect(
      await f.usage.refresh({ ownerId, provider: 'agy', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: {
        status: 'unauthenticated',
        fiveHour: null,
        sevenDay: null,
        message: 'Sign in required',
      },
    })

    f.setConfigSeed('config-2')
    await f.updateCodexState({ codexBehavior: 'api_key' })
    await f.updateClaudeState({ claudeBehavior: 'api_key' })
    await f.updateAgyState({ agyBehavior: 'api_key' })

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
    expect(
      await f.usage.refresh({ ownerId, provider: 'agy', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'not_applicable', message: 'API key' },
    })

    f.setConfigSeed('config-3')
    await f.updateAgyState({ agyBehavior: 'cloud_billing' })
    expect(
      await f.usage.refresh({ ownerId, provider: 'agy', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'not_applicable', message: 'Cloud billing' },
    })

    f.setConfigSeed('config-4')
    await f.updateAgyState({ agyBehavior: 'no_quota_summary' })
    expect(
      await f.usage.refresh({ ownerId, provider: 'agy', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'not_applicable', message: 'No plan limits' },
    })

    f.setConfigSeed('config-5')
    await f.updateAgyState({ agyBehavior: 'overflow_64k' })
    expect(
      await f.usage.refresh({ ownerId, provider: 'agy', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'unavailable', fiveHour: null, sevenDay: null, message: 'Unavailable' },
    })
  })

  it('strictly enforces App-wide <= 2 concurrent active probes across all 3 providers while serializing the 3rd slot cleanly', async () => {
    const f = await createUsageFixture({
      codexBehavior: 'both',
      claudeBehavior: 'both',
      agyBehavior: 'multi_pool',
    })
    await f.updateCodexState({ delayMs: 120 })
    await f.updateClaudeState({ delayMs: 120 })
    await f.updateAgyState({ delayMs: 120 })

    const ownerId = crypto.randomUUID()
    const [codexRes, claudeRes, agyRes] = await Promise.all([
      f.usage.refresh({ ownerId, provider: 'codex', requestId: crypto.randomUUID() }),
      f.usage.refresh({ ownerId, provider: 'claude', requestId: crypto.randomUUID() }),
      f.usage.refresh({ ownerId, provider: 'agy', requestId: crypto.randomUUID() }),
    ])

    expect(codexRes).toMatchObject({ ok: true, value: { status: 'ready' } })
    expect(claudeRes).toMatchObject({ ok: true, value: { status: 'ready' } })
    expect(agyRes).toMatchObject({
      ok: true,
      value: { status: 'ready', message: 'Gemini Models quota' },
    })

    const events = (await readFile(f.concurrencyFactsPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const raw: unknown = JSON.parse(line)
        if (typeof raw !== 'object' || raw === null) return { event: 'end' as const, ts: 0 }
        const event = Reflect.get(raw, 'event') === 'start' ? ('start' as const) : ('end' as const)
        const tsRaw = Reflect.get(raw, 'ts')
        return { event, ts: typeof tsRaw === 'number' ? tsRaw : 0 }
      })
      .toSorted((left, right) =>
        left.ts !== right.ts ? left.ts - right.ts : left.event === 'end' ? -1 : 1,
      )

    let active = 0
    let maxConcurrent = 0
    for (const entry of events) {
      if (entry.event === 'start') {
        active += 1
        maxConcurrent = Math.max(maxConcurrent, active)
      } else {
        active = Math.max(0, active - 1)
      }
    }
    expect(events.filter((e) => e.event === 'start')).toHaveLength(3)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('invalidates prior account windows and nonWindow on account switch + limits failure and mid-probe cancel()', async () => {
    const f = await createUsageFixture({
      codexBehavior: 'both',
      claudeBehavior: 'both',
      agyBehavior: 'multi_pool',
      codexEmail: 'account-a@example.test',
      claudeEmail: 'account-a@example.test',
      agyEmail: 'account-a@example.test',
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
    expect(
      await f.usage.refresh({ ownerId, provider: 'agy', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'ready', fiveHour: { usedPercent: 12.5 }, sevenDay: { usedPercent: 66.7 } },
    })

    // 2. Account switches to Account B and limits probe FAILS (bypassing cooldown via time).
    // Keep same configSeed to prove identityDigest change (not configKey) invalidates Account A's numbers!
    const baseNow = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow + 31_000)

    await f.updateCodexState({ codexEmail: 'account-b@example.test', failLimits: true })
    await f.updateClaudeState({ claudeEmail: 'account-b@example.test', failLimits: true })
    await f.updateAgyState({ agyEmail: 'account-b@example.test', failLimits: true })

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
    expect(
      await f.usage.refresh({ ownerId, provider: 'agy', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'unavailable', fiveHour: null, sevenDay: null, message: 'Unavailable' },
    })

    // Test cancel-on-hide waiting for physical child exit on agy:
    nowSpy.mockReturnValue(baseNow + 95_000)
    await f.updateAgyState({ agyBehavior: 'hold_usage', failLimits: false })
    const agyCancelReq = crypto.randomUUID()
    const agyPending = f.usage.refresh({ ownerId, provider: 'agy', requestId: agyCancelReq })
    await vi.waitFor(async () => {
      const facts = await f.readFacts(f.agyFactsPath)
      expect(facts.length).toBeGreaterThanOrEqual(3)
    })
    const heldAgyPid = (await f.readFacts(f.agyFactsPath)).at(-1)?.pid
    expect(heldAgyPid).toBeDefined()
    expect(await f.usage.cancel({ ownerId, provider: 'agy', requestId: agyCancelReq })).toEqual({
      ok: true,
      value: { cancelled: true, settled: true },
    })
    expect(() => process.kill(heldAgyPid!, 0)).toThrow(/ESRCH/u)
    await agyPending

    // Now test mid-probe cancel() after identity switch when prior slot held windows vs nonWindow:
    nowSpy.mockReturnValue(baseNow + 130_000)
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

    nowSpy.mockReturnValue(baseNow + 165_000)
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

    expect(await codexPending).toMatchObject({
      ok: true,
      value: { status: 'idle', fiveHour: null, sevenDay: null },
    })
    expect(await claudePending).toMatchObject({
      ok: true,
      value: { status: 'idle', fiveHour: null, sevenDay: null },
    })
  })

  it('enforces 30s/60s cooldown, 5m staleness, busy/cancelling single-slot overlays, and clean owner release including agy', async () => {
    const f = await createUsageFixture({
      codexBehavior: 'hold_limits_after_account',
      claudeBehavior: 'both',
      agyBehavior: 'multi_pool',
    })
    const ownerOne = crypto.randomUUID()
    const ownerTwo = crypto.randomUUID()
    const reqOne = crypto.randomUUID()

    // While ownerOne is probing Codex, ownerTwo sees 'busy'.
    const firstProbe = f.usage.refresh({ ownerId: ownerOne, provider: 'codex', requestId: reqOne })
    await vi.waitFor(
      async () => {
        const facts = await f.readFacts(f.codexFactsPath)
        expect(facts.some((fact) => fact.event === 'account_read_sent')).toBe(true)
      },
      { timeout: 5_000 },
    )
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

    // Cooldown prevents immediate re-probe; stale after 5 minutes on agy too.
    const t0 = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)
    expect(
      await f.usage.refresh({
        ownerId: ownerOne,
        provider: 'agy',
        requestId: crypto.randomUUID(),
      }),
    ).toMatchObject({
      ok: true,
      value: { status: 'ready', fiveHour: { usedPercent: 12.5 }, message: 'Gemini Models quota' },
    })

    const factsBeforeCooldown = (await f.readFacts(f.agyFactsPath)).length
    nowSpy.mockReturnValue(t0 + 10_000)
    expect(
      await f.usage.refresh({
        ownerId: ownerOne,
        provider: 'agy',
        requestId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: true, value: { status: 'ready', cooldownUntil: expect.any(String) } })
    expect((await f.readFacts(f.agyFactsPath)).length).toBe(factsBeforeCooldown)

    // After 5m+, cached snapshot transitions to 'stale' while preserving pool scope message.
    nowSpy.mockReturnValue(t0 + 5 * 60_000 + 1)
    expect(f.usage.read('agy')).toMatchObject({
      ok: true,
      value: {
        status: 'stale',
        fiveHour: { usedPercent: 12.5 },
        message: 'Gemini Models quota',
      },
    })

    // 429 error on same confirmed identity triggers 60s backoff while retaining stale cached windows.
    await f.updateAgyState({ agyBehavior: 'rate_limit_error' })
    const rateLimited = await f.usage.refresh({
      ownerId: ownerOne,
      provider: 'agy',
      requestId: crypto.randomUUID(),
    })
    expect(rateLimited).toMatchObject({
      ok: true,
      value: {
        status: 'stale',
        fiveHour: { usedPercent: 12.5 },
        message: 'Gemini Models quota',
        cooldownUntil: expect.any(String),
      },
    })
    const cooldownMs = rateLimited.ok ? Date.parse(rateLimited.value.cooldownUntil!) : 0
    expect(cooldownMs - (t0 + 5 * 60_000 + 1)).toBeGreaterThanOrEqual(59_000)
  })

  it('recovers automatically from close_unconfirmed once the owned probe process releases and blocks the 3rd provider with busy while 2 unconfirmed probes hold both App-wide slots', async () => {
    const f = await createUsageFixture({
      codexBehavior: 'both',
      claudeBehavior: 'both',
      agyBehavior: 'multi_pool',
    })
    const ownerId = crypto.randomUUID()
    const descriptor = Object.getOwnPropertyDescriptor(OwnedProcessGroup.prototype, 'close')
    const closeImpl =
      descriptor && typeof descriptor.value === 'function' ? descriptor.value : undefined
    if (!closeImpl) throw new Error('Expected OwnedProcessGroup.prototype.close')
    const callOrigClose = async (group: OwnedProcessGroup, deadlineAt?: number): Promise<void> => {
      await Reflect.apply(closeImpl, group, [deadlineAt])
    }

    let failCount = 2
    let releaseDeferred!: () => void
    const deferredGate = new Promise<void>((release) => {
      releaseDeferred = release
    })
    const closedPromises: Promise<void>[] = []
    vi.spyOn(OwnedProcessGroup.prototype, 'close').mockImplementation(async function (
      this: OwnedProcessGroup,
      deadlineAt?: number,
    ) {
      if (failCount > 0) {
        failCount -= 1
        const done = deferredGate.then(async () => {
          await callOrigClose(this, deadlineAt).catch(() => undefined)
          return undefined
        })
        closedPromises.push(done)
        throw new Error('Simulated cleanup timeout')
      }
      return callOrigClose(this, deadlineAt)
    })

    expect(
      await f.usage.refresh({ ownerId, provider: 'codex', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'close_unconfirmed', message: 'Wait to retry', identityConfirmed: false },
    })
    expect(
      await f.usage.refresh({ ownerId, provider: 'claude', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'close_unconfirmed', message: 'Wait to retry', identityConfirmed: false },
    })

    // Both App-wide slots are held by unconfirmed probes -> 3rd provider returns busy immediately!
    expect(
      await f.usage.refresh({ ownerId, provider: 'agy', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'busy', message: 'Wait to retry' },
    })
    expect(await f.readFacts(f.agyFactsPath)).toEqual([])

    releaseDeferred()
    await Promise.all(closedPromises)

    expect(f.usage.read('codex')).toMatchObject({
      ok: true,
      value: { status: 'idle', fiveHour: null, sevenDay: null },
    })
    expect(
      await f.usage.refresh({ ownerId, provider: 'agy', requestId: crypto.randomUUID() }),
    ).toMatchObject({
      ok: true,
      value: { status: 'ready', fiveHour: { usedPercent: 12.5 }, identityConfirmed: true },
    })
    expect(f.fullReadinessSpy).not.toHaveBeenCalled()
  })

  it('redacts custom org/project pool names to fixed labels, refuses stale retention without a stable account ID, and cleans up mkdtemp on pre-spawn abort', async () => {
    const f = await createUsageFixture({
      agyBehavior: 'org_custom_pool',
      agyEmail: 'owner@example.test',
    })
    const ownerId = crypto.randomUUID()

    // 1. Custom org/project pool names NEVER cross IPC — mapped to fixed 'Selected quota pool'.
    const customPoolRes = await f.usage.refresh({
      ownerId,
      provider: 'agy',
      requestId: crypto.randomUUID(),
    })
    expect(customPoolRes).toMatchObject({
      ok: true,
      value: {
        status: 'ready',
        fiveHour: { usedPercent: 25 },
        sevenDay: { usedPercent: 50 },
        pools: [
          {
            id: 'pool',
            label: 'Quota pool',
            fiveHour: { usedPercent: 25 },
            sevenDay: { usedPercent: 50 },
          },
          {
            id: 'pool-2',
            label: 'Quota pool 2',
            fiveHour: null,
            sevenDay: { usedPercent: 10 },
          },
        ],
        identityConfirmed: true,
        message: 'Selected quota pool',
      },
    })
    expect(JSON.stringify(customPoolRes)).not.toContain('Acme')
    expect(JSON.stringify(customPoolRes)).not.toContain('Secret')
    expect(JSON.stringify(customPoolRes)).not.toContain('Internal')

    // 2. Without a stable account ID (authMethod + tier + organization only), fresh probe displays
    // returned windows with identityConfirmed=false, and a subsequent failed probe does NOT retain them!
    f.setConfigSeed('config-no-id')
    await f.updateAgyState({ agyBehavior: 'no_account_id', failLimits: false })
    const noIdFresh = await f.usage.refresh({
      ownerId,
      provider: 'agy',
      requestId: crypto.randomUUID(),
    })
    expect(noIdFresh).toMatchObject({
      ok: true,
      value: {
        status: 'ready',
        fiveHour: { usedPercent: 12.5 },
        sevenDay: { usedPercent: 66.7 },
        identityConfirmed: false,
        message: 'Gemini Models quota',
      },
    })

    const t0 = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0 + 35_000)
    await f.updateAgyState({ agyBehavior: 'no_account_id', failLimits: true })
    // Make error JSON omit email so only authMethod + tier exists (or empty error):
    await f.updateAgyState({ agyEmail: '', failLimits: true })
    const noIdFailed = await f.usage.refresh({
      ownerId,
      provider: 'agy',
      requestId: crypto.randomUUID(),
    })
    expect(noIdFailed).toMatchObject({
      ok: true,
      value: {
        status: 'unavailable',
        fiveHour: null,
        sevenDay: null,
        identityConfirmed: false,
        message: 'Unavailable',
      },
    })

    // 3. Abort during probeAgyUsage before ownProbe cleans up mkdtemp directory immediately!
    nowSpy.mockReturnValue(t0 + 90_000)
    const ownProbeSpy = vi
      .spyOn(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- White-box spy on private ownProbe abort seam.
        f.usage as unknown as {
          ownProbe: (signal: AbortSignal, onClose: () => void) => OwnedProcessGroup
        },
        'ownProbe',
      )
      .mockImplementationOnce(() => {
        const abortErr = new Error('Simulated pre-spawn abort')
        abortErr.name = 'AbortError'
        throw abortErr
      })
    await f.usage.refresh({
      ownerId,
      provider: 'agy',
      requestId: crypto.randomUUID(),
    })
    expect(ownProbeSpy).toHaveBeenCalledTimes(1)
    const probeRootEntries = await readdir(join(f.storageRoot, 'provider-usage-probe')).catch(
      () => [] as string[],
    )
    expect(probeRootEntries.filter((name) => name.startsWith('agy-'))).toEqual([])
    expect(f.fullReadinessSpy).not.toHaveBeenCalled()
  })

  it('holds Usage permits when version/auth subprocesses in inspectProviderReadiness fail physical close confirmation on timeout/abort', async () => {
    const f = await createUsageFixture()
    const ownerId = crypto.randomUUID()

    let claudeProbeSettled = false
    let codexProbeSettled = false
    const fakeClaudeGroup = {
      get released() {
        return claudeProbeSettled
      },
      settledAfterCloseTimeout: () => claudeProbeSettled,
      close: async () => {
        if (!claudeProbeSettled) throw new Error('Claude version child still alive')
      },
    }
    const fakeCodexGroup = {
      get released() {
        return codexProbeSettled
      },
      settledAfterCloseTimeout: () => codexProbeSettled,
      close: async () => {
        if (!codexProbeSettled) throw new Error('Codex auth child still alive')
      },
    }

    vi.spyOn(f.runtime, 'unconfirmedProviderProbes').mockImplementation((provider) => {
      if (provider === 'claude') {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Minimal OwnedProcessGroup double for unconfirmed readiness subprocess test.
        return claudeProbeSettled ? [] : [fakeClaudeGroup as unknown as OwnedProcessGroup]
      }
      if (provider === 'codex') {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Minimal OwnedProcessGroup double for unconfirmed readiness subprocess test.
        return codexProbeSettled ? [] : [fakeCodexGroup as unknown as OwnedProcessGroup]
      }
      return []
    })
    vi.spyOn(f.runtime, 'inspectProviderReadiness').mockImplementation(async (provider) => ({
      ok: true,
      value: {
        agentId: provider,
        state: 'cannot_verify',
        detail: 'Version check cleanup could not be confirmed.',
        checkedAt: new Date().toISOString(),
      },
    }))

    // 1. Both claude and codex fail physical exit confirmation during inspectProviderReadiness -> occupy all 2 App-wide permits!
    const [claudeRes, codexRes] = await Promise.all([
      f.usage.refresh({ ownerId, provider: 'claude', requestId: crypto.randomUUID() }),
      f.usage.refresh({ ownerId, provider: 'codex', requestId: crypto.randomUUID() }),
    ])
    expect(claudeRes).toMatchObject({ ok: true, value: { status: 'close_unconfirmed' } })
    expect(codexRes).toMatchObject({ ok: true, value: { status: 'close_unconfirmed' } })

    // 2. While both version/auth children remain unconfirmed, a 3rd provider (agy) MUST NOT spawn and returns 'busy'!
    const agyBlocked = await f.usage.refresh({
      ownerId,
      provider: 'agy',
      requestId: crypto.randomUUID(),
    })
    expect(agyBlocked).toMatchObject({
      ok: true,
      value: { status: 'busy', message: 'Wait to retry' },
    })

    // 3. Once one unconfirmed child physically exits, its permit releases cleanly!
    claudeProbeSettled = true
    codexProbeSettled = true
    vi.restoreAllMocks()
  })

  it('parses Antigravity CLI command.data.groups envelope, 3p partner pool label, and command.data cloud billing description', async () => {
    const f = await createUsageFixture({
      agyBehavior: 'command_envelope',
    })
    const ownerId = crypto.randomUUID()

    const envelopeRes = await f.usage.refresh({
      ownerId,
      provider: 'agy',
      requestId: crypto.randomUUID(),
    })
    expect(envelopeRes).toMatchObject({
      ok: true,
      value: {
        provider: 'agy',
        status: 'ready',
        fiveHour: { usedPercent: 56.2, resetsAt: expect.any(String) },
        sevenDay: { usedPercent: 53.7, resetsAt: expect.any(String) },
        pools: [
          {
            id: 'gemini',
            label: 'Gemini Models',
            fiveHour: { usedPercent: 56.2, resetsAt: expect.any(String) },
            sevenDay: { usedPercent: 53.7, resetsAt: expect.any(String) },
          },
          {
            id: 'claude-gpt',
            label: 'Claude & GPT',
            fiveHour: { usedPercent: 0, resetsAt: expect.any(String) },
            sevenDay: { usedPercent: 8.6, resetsAt: expect.any(String) },
          },
        ],
        identityConfirmed: false,
        message: 'Gemini Models quota',
      },
    })

    // Secondary pool expiry alone transitions cached snapshot to stale on read().
    const tEnvelope = Date.now()
    const envNowSpy = vi.spyOn(Date, 'now').mockReturnValue(tEnvelope + 4_000_000)
    expect(f.usage.read('agy')).toMatchObject({
      ok: true,
      value: {
        provider: 'agy',
        status: 'stale',
        pools: expect.arrayContaining([
          expect.objectContaining({ id: 'gemini' }),
          expect.objectContaining({ id: 'claude-gpt' }),
        ]),
      },
    })
    envNowSpy.mockRestore()

    // Partner-only active pool under command.data (Claude and GPT models / 3p-* buckets)
    f.setConfigSeed('config-partner-only')
    await f.updateAgyState({ agyBehavior: 'command_envelope_partner_only' })
    const partnerRes = await f.usage.refresh({
      ownerId,
      provider: 'agy',
      requestId: crypto.randomUUID(),
    })
    expect(partnerRes).toMatchObject({
      ok: true,
      value: {
        provider: 'agy',
        status: 'ready',
        fiveHour: { usedPercent: 0, resetsAt: expect.any(String) },
        sevenDay: { usedPercent: 8.6, resetsAt: expect.any(String) },
        identityConfirmed: false,
        message: 'Partner Models quota',
      },
    })

    // Non-subscription description inside command.data
    f.setConfigSeed('config-cmd-cloud-billing')
    await f.updateAgyState({ agyBehavior: 'command_envelope_cloud_billing' })
    const billingRes = await f.usage.refresh({
      ownerId,
      provider: 'agy',
      requestId: crypto.randomUUID(),
    })
    expect(billingRes).toMatchObject({
      ok: true,
      value: {
        provider: 'agy',
        status: 'not_applicable',
        fiveHour: null,
        sevenDay: null,
        message: 'Cloud billing',
      },
    })
  })
})
