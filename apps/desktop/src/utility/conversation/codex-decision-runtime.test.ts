import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { decisionCapabilitySchema, type DecisionInput } from '@pact/contracts'

import type { DecisionInputLoader } from './decision-runtime.js'

import { decisionFixture } from '../../../../../packages/persistence/src/decision-fixture.test-support.js'
import { CodexDecisionRuntime } from './codex-decision-runtime.js'
import * as decisionIsolation from './decision-native-isolation.js'
import * as decisionGuard from './decision-response-guard.js'
import { nativeWorkingMemoryCapacities } from './native-working-memory.js'

// Protocol fixtures replace only OS containment; native tests exercise the real sandbox.
vi.mock('./decision-native-isolation', async (original) => {
  const actual = await original<typeof import('./decision-native-isolation')>()
  return {
    ...actual,
    resolveDecisionNativeExecutable: async (selected: string) => ({
      path: selected,
      fingerprint: 'owned-protocol-fixture',
      current: async () => true,
    }),
    decisionDarwinSandbox: (executable: string) => ({ command: executable, args: [] }),
    retainCodexInstallationId: async (home: string) => ({
      home,
      path: join(home, 'installation_id'),
      current: async () => true,
      close: async () => {},
    }),
  }
})

// Protocol controls exercise admission only. Real Codex metadata is covered by native tests.
const exactNativeModel = {
  id: 'gpt-6-luna',
  model: 'gpt-6-luna',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Owned effort' }],
  inputModalities: ['text', 'image'],
}

it.each([
  'unsupported_protocol',
  'stale',
  'executable_unavailable',
  'unsupported_network',
] as const)(
  'preserves the typed %s admission refusal without starting native work',
  async (reason) => {
    const resolveNative = vi
      .spyOn(decisionIsolation, 'resolveDecisionNativeExecutable')
      .mockRejectedValueOnce(Error(reason))
    const dispatch = vi.fn<() => void>()
    const runtime = new CodexDecisionRuntime({
      executable: process.execPath,
      current: () => true,
      dispatch,
      environment: {},
    })
    try {
      expect(await runtime.probeAdmission()).toMatchObject({
        supported: false,
        reason,
        physicalReleased: true,
      })
      expect(resolveNative).toHaveBeenCalledOnce()
      expect(dispatch).not.toHaveBeenCalled()
      expect(await runtime.settlement()).toBe(true)
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
    } finally {
      await runtime.dispose()
      resolveNative.mockRestore()
    }
  },
)

it('retains the decision lease until the final durable completion callback physically joins', async () => {
  const f = await decisionFixture()
  const completionStarted = Promise.withResolvers<void>()
  const completionClosed = Promise.withResolvers<void>()
  const physicalCompletion = vi.fn<
    NonNullable<ConstructorParameters<typeof CodexDecisionRuntime>[0]['physicalCompletion']>
  >(async (facts) => {
    expect(facts.nativeGeneration).toBe(0)
    expect(facts.witness).toBeNull()
    expect(facts.outcome).toEqual({ kind: 'unavailable', reason: 'duplicate' })
    expect(facts.deadlineAt - Date.now()).toBeGreaterThan(0)
    expect(facts.deadlineAt - Date.now()).toBeLessThanOrEqual(4000)
    completionStarted.resolve()
    await completionClosed.promise
  })
  const runtime = new CodexDecisionRuntime({
    executable: '/unused',
    cwd: '/unused',
    current: () => true,
    reserve: () => 'duplicate',
    dispatch: () => {
      throw Error('No inference is admitted.')
    },
    physicalCompletion,
  })
  try {
    expect(await runtime.evaluateDecision(f.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'duplicate',
    })
    await completionStarted.promise
    let released = false
    const settling = runtime.settlement().then((value) => {
      released = value
      return value
    })
    await Promise.resolve()
    expect(released).toBe(false)
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
    completionClosed.resolve()
    expect(await settling).toBe(true)
    expect(physicalCompletion).toHaveBeenCalledOnce()
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
  } finally {
    completionClosed.resolve()
    await runtime.dispose()
    f.db.close()
  }
})

it.each([15_000, 1_000])(
  'holds admission before complete input and preserves the original %i ms host deadline',
  async (duration) => {
    const f = await decisionFixture()
    vi.useFakeTimers()
    const startedAt = Date.now(),
      signal = new AbortController().signal,
      executable = vi.fn<() => Promise<string>>(async () => {
        throw Error('Duplicate input must not start native')
      }),
      reserve = vi.fn<(input: DecisionInput, facts: { deadlineAt: number }) => 'duplicate'>(
        () => 'duplicate',
      ),
      dispatch = vi.fn<() => void>()
    const runtime = new CodexDecisionRuntime({
      executable,
      cwd: '/unused',
      current: () => true,
      ...(duration < 15_000 ? { deadlineAt: startedAt + duration } : {}),
      reserve,
      dispatch,
    })
    const text = 'Complete source: 🙂\\\"\n'.repeat(512)
    f.input.sources[0]!.text = text
    f.input.sources[0]!.digest = createHash('sha256').update(text).digest('hex')
    const loader = vi.fn<DecisionInputLoader>(async (context) => {
      expect(context.deadlineAt).toBe(startedAt + duration)
      expect(context.signal).not.toBe(signal)
      expect(context.signal.aborted).toBe(false)
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
      expect(runtime.diagnostics().working).toMatchObject({
        heldBytes: 4 * 1024 * 1024,
        items: 1,
        released: false,
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 320))
      return f.input
    })
    try {
      const result = runtime.evaluateDecision(loader, signal)
      await vi.advanceTimersByTimeAsync(320)
      expect(await result).toEqual({ kind: 'unavailable', reason: 'duplicate' })
      expect(loader).toHaveBeenCalledOnce()
      expect(reserve).toHaveBeenCalledExactlyOnceWith(f.input, { deadlineAt: startedAt + duration })
      expect(reserve.mock.calls[0]![0].sources[0]).toEqual({
        id: f.input.sources[0]!.id,
        text,
        digest: createHash('sha256').update(text).digest('hex'),
      })
      expect(executable).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
      expect(await runtime.settlement()).toBe(true)
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
    } finally {
      await runtime.dispose()
      vi.useRealTimers()
      f.db.close()
    }
  },
)

it('includes a slow loader in the single 15-second deadline and retains admission until it settles', async () => {
  const f = await decisionFixture()
  vi.useFakeTimers()
  const reserve = vi.fn<() => 'reserved'>(() => 'reserved'),
    dispatch = vi.fn<() => void>(),
    executable = vi.fn<() => Promise<string>>(async () => '/unused'),
    release = Promise.withResolvers<DecisionInput>()
  let loaderSignal: AbortSignal | undefined
  const runtime = new CodexDecisionRuntime({
    executable,
    cwd: '/unused',
    current: () => true,
    reserve,
    dispatch,
  })
  try {
    const result = runtime.evaluateDecision((context: Parameters<DecisionInputLoader>[0]) => {
      loaderSignal = context.signal
      return release.promise
    }, new AbortController().signal)
    let physicallySettled = false
    const physical = runtime.settlement().then((released) => {
      physicallySettled = true
      return released
    })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(loaderSignal?.aborted).toBe(false)
    expect(reserve).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ kind: 'unavailable', reason: 'timeout' })
    expect(loaderSignal?.aborted).toBe(true)
    expect(physicallySettled).toBe(false)
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
    release.resolve(f.input)
    expect(await physical).toBe(true)
    expect(reserve).not.toHaveBeenCalled()
    expect(executable).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
  } finally {
    release.resolve(f.input)
    await runtime.dispose()
    vi.useRealTimers()
    f.db.close()
  }
})

it('cancels advice while a loader awaits I/O but joins its physical owner before releasing admission', async () => {
  const f = await decisionFixture(),
    inputReady = Promise.withResolvers<void>(),
    ownerReleased = Promise.withResolvers<void>(),
    loaderStarted = Promise.withResolvers<AbortSignal>(),
    reserve = vi.fn<() => 'reserved'>(() => 'reserved'),
    dispatch = vi.fn<() => void>(),
    executable = vi.fn<() => Promise<string>>(async () => '/unused'),
    controller = new AbortController()
  const runtime = new CodexDecisionRuntime({
    executable,
    cwd: '/unused',
    current: () => true,
    reserve,
    dispatch,
  })
  try {
    const result = runtime.evaluateDecision(
      async ({ signal }: Parameters<DecisionInputLoader>[0]) => {
        loaderStarted.resolve(signal)
        try {
          await inputReady.promise
          return f.input
        } finally {
          await ownerReleased.promise
        }
      },
      controller.signal,
    )
    const observed = await loaderStarted.promise
    controller.abort()
    expect(await result).toEqual({ kind: 'unavailable', reason: 'cancelled' })
    expect(observed.aborted).toBe(true)
    let physicallySettled = false
    const physical = runtime.dispose().then((released) => {
      physicallySettled = true
      return released
    })
    inputReady.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(physicallySettled).toBe(false)
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
    ownerReleased.resolve()
    expect(await physical).toBe(true)
    expect(reserve).not.toHaveBeenCalled()
    expect(executable).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
  } finally {
    inputReady.resolve()
    ownerReleased.resolve()
    await runtime.dispose()
    f.db.close()
  }
})

it.each(['synchronous', 'asynchronous'] as const)(
  'refuses a %s throwing loader without persistent reservation or dispatch',
  async (kind) => {
    const reserve = vi.fn<() => 'reserved'>(() => 'reserved'),
      dispatch = vi.fn<() => void>(),
      executable = vi.fn<() => Promise<string>>(async () => '/unused')
    const runtime = new CodexDecisionRuntime({
      executable,
      cwd: '/unused',
      current: () => true,
      reserve,
      dispatch,
    })
    const loader: DecisionInputLoader = () => {
      if (kind === 'asynchronous') return Promise.reject(Error('Owned loading failure'))
      throw Error('Owned loading failure')
    }
    try {
      expect(await runtime.evaluateDecision(loader, new AbortController().signal)).toEqual({
        kind: 'unavailable',
        reason: 'runtime_unavailable',
      })
      expect(await runtime.settlement()).toBe(true)
      expect(reserve).not.toHaveBeenCalled()
      expect(executable).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
    } finally {
      await runtime.dispose()
    }
  },
)

it('validates loaded full source hashes before reservation or native startup', async () => {
  const f = await decisionFixture(),
    reserve = vi.fn<() => 'reserved'>(() => 'reserved'),
    dispatch = vi.fn<() => void>(),
    executable = vi.fn<() => Promise<string>>(async () => '/unused')
  const runtime = new CodexDecisionRuntime({
    executable,
    cwd: '/unused',
    current: () => true,
    reserve,
    dispatch,
  })
  f.input.sources[0]!.text += ' changed after its source digest'
  try {
    expect(await runtime.evaluateDecision(() => f.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'invalid_input',
    })
    expect(await runtime.settlement()).toBe(true)
    expect(reserve).not.toHaveBeenCalled()
    expect(executable).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
    f.db.close()
  }
})

it('refuses excessive complete input before native startup, persistent reservation or dispatch and releases its actual lease', async () => {
  const f = await decisionFixture(),
    executable = vi.fn<() => Promise<string>>(async () => {
      throw Error('Native must not start')
    })
  const reserve = vi.fn<() => 'reserved'>(() => 'reserved'),
    dispatch = vi.fn<() => void>()
  const runtime = new CodexDecisionRuntime({
    executable,
    cwd: '/unused',
    current: () => true,
    reserve,
    dispatch,
  })
  try {
    const text = '🙂'.repeat((128 * 1024) / 4)
    f.input.sources[0]!.text = text
    f.input.sources[0]!.digest = createHash('sha256').update(text).digest('hex')
    expect(await runtime.evaluateDecision(f.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'invalid_input',
    })
    expect(await runtime.settlement()).toBe(true)
    expect(executable).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(f.input.sources[0]!.text).toBe(text)
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
  } finally {
    await runtime.dispose()
    f.db.close()
  }
})
it('permanently fences a disposed invocation without reacquiring resources or starting native work', async () => {
  const executable = vi.fn<() => Promise<string>>(async () => '/unused'),
    dispatch = vi.fn<() => void>()
  const runtime = new CodexDecisionRuntime({
    executable,
    cwd: '/unused',
    current: () => true,
    dispatch,
  })
  expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
  expect(await runtime.dispose()).toBe(true)
  expect(await runtime.evaluateDecision({}, new AbortController().signal)).toEqual({
    kind: 'unavailable',
    reason: 'busy',
  })
  expect(await runtime.probeAdmission()).toMatchObject({ supported: false, reason: 'busy' })
  expect(executable).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()
  expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
})
it('has one App admission and zero waiting invocations, independent of future retry or business dispatch', async () => {
  const context = {
    executable: '/unused',
    cwd: '/unused',
    current: () => true,
    dispatch: () => undefined,
  }
  const first = new CodexDecisionRuntime(context)
  try {
    expect(() => new CodexDecisionRuntime(context)).toThrow('capacity is full')
  } finally {
    await first.dispose()
  }
  const next = new CodexDecisionRuntime(context)
  expect(await next.dispose()).toBe(true)
  expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
})

it.runIf(process.platform === 'darwin').each([
  { mutation: 'none', expected: 'recommendation' },
  { mutation: 'account', expected: 'stale' },
  { mutation: 'configuration', expected: 'stale' },
  { mutation: 'unsupported_configuration', expected: 'runtime_unavailable' },
  { mutation: 'executable_path', expected: 'stale' },
  { mutation: 'executable_identity', expected: 'stale' },
  { mutation: 'unavailable_executable', expected: 'runtime_unavailable' },
] as const)(
  'rechecks native authority and resolved executable before advice with $mutation mutation',
  async ({ mutation, expected }) => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-decision-authority-')),
      executable = join(directory, 'owned-native.cjs'),
      marker = join(directory, 'dispatched'),
      methods = join(directory, 'methods.jsonl'),
      f = await decisionFixture(),
      dispatch = vi.fn<() => void>(),
      reserve = vi.fn<() => 'reserved'>(() => 'reserved')
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const mutation = ${JSON.stringify(mutation)};
let changed = false, requests = 0;
const nativeRouteArg=process.argv.find(x=>x.startsWith('chatgpt_base_url='));const nativeRoute=nativeRouteArg?JSON.parse(nativeRouteArg.slice('chatgpt_base_url='.length)):'https://chatgpt.com';
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', (line) => {
  if (++requests > 32) process.exit(2);
  const request = JSON.parse(line), params = request.params || {};
  fs.appendFileSync(${JSON.stringify(methods)}, JSON.stringify({ method: request.method, refreshToken: params.refreshToken }) + '\\n');
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = { userAgent: 'pact/0.163.0 (owned fixture)', platformOs: 'macos', codexHome: ${JSON.stringify(join(directory, 'native'))} };
  if (request.method === 'config/read') result = { config: { chatgpt_base_url:nativeRoute,features: { use_agent_identity: false }, ...(changed && mutation === 'configuration' ? { forced_chatgpt_workspace_id: 'changed-owned-workspace' } : {}), ...(changed && mutation === 'unsupported_configuration' ? { model_provider: 'unsupported' } : {}) } };
  if (request.method === 'account/read') result = { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: changed && mutation === 'account' ? 'changed@example.test' : 'owned@example.test', planType: 'plus' }, workspaceRouting: { chatgptAccountId: 'owned-account', backendOrigin: 'https://chatgpt.com', accountRoutingOverride: 'NO_CONSTRAINT' } };
  if (request.method === 'model/list') result = { data: [${JSON.stringify(exactNativeModel)}], nextCursor: null };
  if (request.method === 'thread/start') result = { cwd: params.cwd, model: params.model, modelProvider: params.modelProvider, thread: { id: 'owned-thread', cwd: params.cwd, ephemeral: true }, sandbox: { type: 'readOnly', networkAccess: false } };
  emit({ id: request.id, result });
  if (request.method === 'turn/start') {
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(marker)})) return;
      clearInterval(timer);
      changed = true;
      if (mutation === 'executable_identity') fs.appendFileSync(__filename, '\\n// changed owned executable\\n');
      emit({ method: 'item/completed', params: { threadId: 'owned-thread', turnId: 'owned-turn', item: { type: 'agentMessage', text: '{"candidateId":"wait","highlights":[]}' } } });
      emit({ method: 'turn/completed', params: { threadId: 'owned-thread', turnId: 'owned-turn', turn: { status: 'completed' } } });
    }, 2);
  }
});
`,
      { mode: 0o700 },
    )
    const resolveExecutable = vi.fn<() => Promise<string | undefined>>(async () => {
      if (existsSync(marker)) {
        if (mutation === 'executable_path') return join(directory, 'different-owned-native.cjs')
        if (mutation === 'unavailable_executable') return undefined
      }
      return executable
    })
    let suppliedPrompt: string | undefined
    // Only the response guard is replaced here. The owned protocol process,
    // original config/account RPCs, executable resolution and physical group
    // remain real; native tests cover the unmodified HTTP/auth boundary.
    const guard = vi
      .spyOn(decisionGuard, 'createDecisionResponseGuard')
      .mockImplementation(async (_upstream, memory) => {
        const workspace = memory.reserve(6 * 1024 * 1024)
        const facts: Awaited<
          ReturnType<typeof decisionGuard.createDecisionResponseGuard>
        >['facts'] = {
          received: 0,
          metadataForwarded: 0,
          inputBytes: null,
          forwarded: 0,
          rejectedRequests: 0,
          rejectedResponses: 0,
          acceptedResponses: 0,
          nativeBytes: 0,
          upgrades: 0,
          active: 0,
          peakActive: 0,
          auth401: 0,
          authReload401: 0,
          authChanged: false,
          reorderedRequest: false,
          physicalReleased: false,
          transportError: undefined,
          upstreamStatus: undefined,
          upstreamContentType: undefined,
          upstreamContentEncoding: undefined,
          refusal: undefined,
        }
        let owner = Promise.resolve()
        return {
          baseUrl: 'http://127.0.0.1:1/owned/v1',
          port: 1,
          metadataBaseUrl: 'http://127.0.0.1:1/metadata/backend-api',
          setMetadataDestination: () => {},
          metadataPhase: () => {},
          stopForwarding: () => {},
          setDestination: () => {},
          facts,
          usage: undefined,
          bind: (authority) => {
            suppliedPrompt = authority.prompt
            owner = (async () => {
              if (!(await authority.current())) throw Error('Owned authority was not current')
              authority.dispatch()
              facts.forwarded++
              await writeFile(marker, 'dispatched')
            })()
            void owner.catch(() => undefined)
          },
          close: async () => {
            await owner
            facts.physicalReleased = true
            workspace.release()
          },
        }
      })
    const runtime = new CodexDecisionRuntime({
      executable: resolveExecutable,
      cwd: directory,
      environment: {
        PATH: process.env.PATH,
        HOME: directory,
        CODEX_HOME: join(directory, 'native'),
      },
      current: () => true,
      dispatch,
      reserve,
    })
    try {
      const outcome = await runtime.evaluateDecision(() => f.input, new AbortController().signal)
      expect(outcome).toEqual(
        expected === 'recommendation'
          ? { kind: 'recommendation', recommendation: { candidateId: 'wait', highlights: [] } }
          : { kind: 'unavailable', reason: expected },
      )
      expect(await runtime.settlement()).toBe(true)
      expect(dispatch).toHaveBeenCalledOnce()
      expect(runtime.invoked).toBe(true)
      expect(resolveExecutable).toHaveBeenCalledTimes(4)
      expect(suppliedPrompt?.endsWith(JSON.stringify(f.input))).toBe(true)
      const calls: Array<{ method: string; refreshToken?: boolean }> = (
        await readFile(methods, 'utf8')
      )
        .trim()
        .split('\n')
        .map((line: string) => JSON.parse(line))
      const accountReads = calls.filter((call) => call.method === 'account/read')
      expect(accountReads.every((call) => call.refreshToken === false)).toBe(true)
      expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
    } finally {
      await runtime.dispose()
      guard.mockRestore()
      f.db.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

const versionCases: Array<{
  label: string
  admitted: boolean
  originator?: string
  userAgent: string
}> = [
  ...[
    '0.163.0',
    '0.163.0-beta.1',
    '0.163.0.1',
    '0.163.0/extra',
    '0.163.0@wrapper',
    '0.163.1',
    '0.162.0',
  ].map((version) => ({
    label: version,
    admitted: version === '0.163.0',
    userAgent: `pact/${version} (Mac OS; owned fixture)`,
  })),
  {
    label: 'numeric and parenthesized originator',
    admitted: true,
    originator: 'Compat 0.163.0 (wrapper)',
    userAgent: 'Compat 0.163.0 (wrapper)/0.163.0 (Mac OS 26.6.1; arm64) terminal (pact; 0.0.0)',
  },
  {
    label: 'originator pin cannot mask native 0.164.0',
    admitted: false,
    originator: 'Compat 0.163.0 (wrapper)',
    userAgent: 'Compat 0.163.0 (wrapper)/0.164.0 (Mac OS 26.6.1; arm64) terminal (pact; 0.0.0)',
  },
  {
    label: 'nonsemver native cannot use client pin',
    admitted: false,
    userAgent: 'pact/not-semver (Mac OS Unknown; arm64) terminal (client/0.163.0)',
  },
  {
    label: 'different native cannot use client pin',
    admitted: false,
    userAgent: 'pact/v0.164.0 (Mac OS Unknown; arm64) terminal (client/0.163.0)',
  },
  {
    label: 'mismatched originator is rejected',
    admitted: false,
    originator: 'Owned originator',
    userAgent: 'pact/0.163.0 (Mac OS; owned fixture)',
  },
]
it.runIf(process.platform === 'darwin').each(versionCases)(
  'admits only the exact originator-bound native version: $label',
  async ({ userAgent, originator, admitted }) => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-decision-version-'))
    const executable = join(directory, 'owned-native.cjs'),
      calls = join(directory, 'methods.jsonl')
    // A genuine owned process controls only the protocol version. It never contacts
    // a provider or reads a user native home; actual Codex support has separate native fixtures.
    const initialized = {
      userAgent,
      platformOs: 'macos',
      codexHome: join(directory, 'native'),
    }
    await writeFile(
      executable,
      `#!/usr/bin/env node\nconst fs=require('node:fs'),readline=require('node:readline');const rl=readline.createInterface({input:process.stdin});let count=0;rl.on('line',line=>{if(++count>16)process.exit(2);const request=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(request.method)+'\\n');if(request.id===undefined)return;let result={};if(request.method==='initialize')result=${JSON.stringify(initialized)};if(request.method==='config/read')result={config:{features:{use_agent_identity:false},...(process.argv.find(x=>x.startsWith('chatgpt_base_url='))?{chatgpt_base_url:JSON.parse(process.argv.find(x=>x.startsWith('chatgpt_base_url=')).slice('chatgpt_base_url='.length))}:{})}};if(request.method==='account/read')result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:'owned@example.test',planType:'plus'},workspaceRouting:{chatgptAccountId:'owned-account',backendOrigin:'https://chatgpt.com',accountRoutingOverride:'NO_CONSTRAINT'}};if(request.method==='model/list')result={data:[${JSON.stringify(exactNativeModel)}],nextCursor:null};process.stdout.write(JSON.stringify({id:request.id,result})+'\\n')});`,
      { mode: 0o700 },
    )
    const dispatch = vi.fn<() => void>()
    const runtime = new CodexDecisionRuntime({
      executable,
      cwd: directory,
      environment: {
        PATH: process.env.PATH,
        HOME: directory,
        CODEX_HOME: join(directory, 'native'),
        ...(originator === undefined ? {} : { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: originator }),
      },
      current: () => true,
      dispatch,
    })
    try {
      const result = decisionCapabilitySchema.parse(await runtime.probeAdmission())
      expect(result).toMatchObject({
        provider: 'codex',
        modelId: 'gpt-6-luna',
        status: admitted ? 'supported' : 'unavailable',
        supported: admitted,
        reason: admitted ? 'supported' : 'unsupported_protocol',
        physicalReleased: true,
      })
      const methods = (await readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .map((line: string) => JSON.parse(line))
      expect(methods).not.toContain('thread/start')
      expect(methods).not.toContain('turn/start')
      expect(dispatch).not.toHaveBeenCalled()
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
    } finally {
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

type CapabilityFixtureState = {
  pages: Array<{ data: unknown[]; nextCursor: string | null }>
  account?: string
  config?: Record<string, unknown>
  projectConfig?: Record<string, unknown>
}

async function capabilityFixture(state: CapabilityFixtureState) {
  const directory = await mkdtemp(join(tmpdir(), 'pact-decision-capability-')),
    executable = join(directory, 'owned-native.cjs'),
    control = join(directory, 'control.json'),
    calls = join(directory, 'calls.jsonl')
  await writeFile(control, JSON.stringify(state))
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
let count=0;
rl.on('line',line=>{
  if(++count>64)process.exit(2);
  const request=JSON.parse(line),params=request.params||{},state=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
  fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:request.method,params,pid:process.pid})+'\\n');
  if(request.id===undefined)return;
  let result={};
  if(request.method==='initialize')result={userAgent:'pact/0.163.0 (owned fixture)',platformOs:'macos',codexHome:${JSON.stringify(join(directory, 'native'))}};
  if(request.method==='config/read')result={config:params.cwd===${JSON.stringify(directory)}?(state.projectConfig||state.config||{}):(state.config||{})};
  if(request.method==='config/read'&&process.argv.some(x=>x.startsWith('chatgpt_base_url=')))result.config.chatgpt_base_url=JSON.parse(process.argv.find(x=>x.startsWith('chatgpt_base_url=')).slice('chatgpt_base_url='.length));
  if(request.method==='account/read')result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:state.account||'owned@example.test',planType:'plus'},workspaceRouting:{chatgptAccountId:'owned-account',backendOrigin:'https://chatgpt.com',accountRoutingOverride:'NO_CONSTRAINT'}};
  if(request.method==='model/list')result=state.pages[Number(params.cursor||0)]||state.pages.at(-1);
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
`,
    { mode: 0o700 },
  )
  const dispatch = vi.fn<() => void>()
  const context = {
    executable,
    cwd: directory,
    environment: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: join(directory, 'native') },
    current: () => true,
    dispatch,
  }
  return {
    directory,
    executable,
    context,
    dispatch,
    update: (next: CapabilityFixtureState) => writeFile(control, JSON.stringify(next)),
    calls: async () =>
      (await readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .map((line): { method: string; params: Record<string, unknown> } => JSON.parse(line)),
    close: () => rm(directory, { recursive: true, force: true }),
  }
}

const capabilityCases = [
  {
    label: 'exact native identity',
    pages: [{ data: [exactNativeModel], nextCursor: null }],
    reason: 'supported',
  },
  { label: 'missing model', pages: [{ data: [], nextCursor: null }], reason: 'model_unavailable' },
  {
    label: 'picker alias',
    pages: [{ data: [{ ...exactNativeModel, id: 'luna-latest' }], nextCursor: null }],
    reason: 'model_unavailable',
  },
  {
    label: 'native alias',
    pages: [{ data: [{ ...exactNativeModel, model: 'luna-latest' }], nextCursor: null }],
    reason: 'model_unavailable',
  },
  {
    label: 'missing native identity',
    pages: [{ data: [{ ...exactNativeModel, model: null }], nextCursor: null }],
    reason: 'model_metadata_invalid',
  },
  {
    label: 'missing effort',
    pages: [{ data: [{ ...exactNativeModel, supportedReasoningEfforts: [] }], nextCursor: null }],
    reason: 'model_effort_unavailable',
  },
  {
    label: 'missing modalities',
    pages: [{ data: [{ ...exactNativeModel, inputModalities: null }], nextCursor: null }],
    reason: 'model_metadata_invalid',
  },
  {
    label: 'hidden exact model',
    pages: [{ data: [{ ...exactNativeModel, hidden: true }], nextCursor: null }],
    reason: 'model_unavailable',
  },
  {
    label: 'duplicate exact identity',
    pages: [{ data: [exactNativeModel, exactNativeModel], nextCursor: null }],
    reason: 'model_metadata_invalid',
  },
  {
    label: 'second page exact model',
    pages: [
      { data: [], nextCursor: '1' },
      { data: [exactNativeModel], nextCursor: null },
    ],
    reason: 'supported',
  },
  {
    label: 'repeated cursor',
    pages: [
      { data: [], nextCursor: '1' },
      { data: [], nextCursor: '1' },
    ],
    reason: 'model_metadata_invalid',
  },
  {
    label: 'oversized page',
    pages: [{ data: Array.from({ length: 26 }, () => exactNativeModel), nextCursor: null }],
    reason: 'model_metadata_invalid',
  },
  {
    label: 'page capacity',
    pages: Array.from({ length: 9 }, (_, index) => ({
      data: [],
      nextCursor: index === 8 ? null : String(index + 1),
    })),
    reason: 'catalog_limit',
  },
  {
    label: 'cumulative byte capacity',
    pages: [
      { data: [{ ...exactNativeModel, description: 'x'.repeat(150_000) }], nextCursor: '1' },
      {
        data: [{ id: 'other', model: 'other', description: 'y'.repeat(150_000) }],
        nextCursor: null,
      },
    ],
    reason: 'catalog_limit',
  },
]

it.runIf(process.platform === 'darwin').each(capabilityCases)(
  'checks complete bounded exact-model evidence without a Thread or Turn: $label',
  async ({ pages, reason }) => {
    const fixture = await capabilityFixture({ pages })
    const runtime = new CodexDecisionRuntime(fixture.context)
    try {
      const result = decisionCapabilitySchema.parse(await runtime.probeAdmission())
      expect(result).toMatchObject({
        provider: 'codex',
        modelId: 'gpt-6-luna',
        status: reason === 'supported' ? 'supported' : 'unavailable',
        supported: reason === 'supported',
        reason,
        physicalReleased: true,
      })
      expect(await runtime.settlement()).toBe(true)
      const calls = await fixture.calls()
      const lists = calls.filter((call) => call.method === 'model/list')
      expect(lists.length).toBeGreaterThan(0)
      expect(lists.length).toBeLessThanOrEqual(8)
      expect(
        lists.every((call) => call.params.limit === 25 && call.params.includeHidden === false),
      ).toBe(true)
      expect(calls.map((call) => call.method)).not.toContain('thread/start')
      expect(calls.map((call) => call.method)).not.toContain('turn/start')
      expect(fixture.dispatch).not.toHaveBeenCalled()
      expect(runtime.invoked).toBe(false)
      expect(runtime.usage).toBeUndefined()
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
      expect(JSON.stringify(result)).not.toContain(fixture.directory)
      expect(JSON.stringify(result)).not.toContain('owned@example.test')
    } finally {
      await runtime.dispose()
      await fixture.close()
    }
  },
)

it.runIf(process.platform === 'darwin')(
  'uses only global native configuration for a host probe and publishes its independent process witness before protocol I/O',
  async () => {
    const fixture = await capabilityFixture({
        pages: [{ data: [exactNativeModel], nextCursor: null }],
        projectConfig: { model_provider: 'project-provider' },
      }),
      prepared = vi.fn<() => void>(),
      probePrepared = vi.fn<
        NonNullable<ConstructorParameters<typeof CodexDecisionRuntime>[0]['probePrepared']>
      >(({ witness }) => {
        expect(witness.platform).toBe('darwin')
        if (witness.platform !== 'darwin') throw new Error('Expected the actual Darwin witness.')
        expect(witness.owner.pid).toBe(process.pid)
        expect(witness.root.pid).toBeGreaterThan(0)
        const prior = existsSync(join(fixture.directory, 'calls.jsonl'))
          ? readFileSync(join(fixture.directory, 'calls.jsonl'), 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
          : []
        expect(prior.some((call) => call.pid === witness.root.pid)).toBe(false)
      })
    const hostContext = {
      executable: fixture.executable,
      environment: fixture.context.environment,
      current: () => true,
      dispatch: fixture.dispatch,
      prepared,
      probePrepared,
    }
    const host = new CodexDecisionRuntime(hostContext)
    let project: CodexDecisionRuntime | undefined, execution: CodexDecisionRuntime | undefined
    try {
      const result = decisionCapabilitySchema.parse(await host.probeAdmission())
      expect(result.supported).toBe(true)
      expect(probePrepared).toHaveBeenCalledTimes(2)
      expect(prepared).not.toHaveBeenCalled()
      const reads = (await fixture.calls()).filter((call) => call.method === 'config/read')
      expect(reads).toHaveLength(4)
      expect(
        reads.every(
          (call) => call.params.cwd !== fixture.directory && call.params.cwd !== process.cwd(),
        ),
      ).toBe(true)
      project = new CodexDecisionRuntime(fixture.context)
      expect(await project.probeAdmission()).toMatchObject({
        supported: false,
        reason: 'unsupported_provider',
        physicalReleased: true,
      })
      execution = new CodexDecisionRuntime(hostContext)
      const loader = vi.fn<DecisionInputLoader>()
      expect(await execution.evaluateDecision(loader, new AbortController().signal)).toEqual({
        kind: 'unavailable',
        reason: 'runtime_unavailable',
      })
      expect(await execution.settlement()).toBe(true)
      expect(loader).not.toHaveBeenCalled()
      expect(fixture.dispatch).not.toHaveBeenCalled()
      expect(probePrepared).toHaveBeenCalledTimes(2)
    } finally {
      await host.dispose()
      await project?.dispose()
      await execution?.dispose()
      await fixture.close()
    }
  },
)

it.runIf(process.platform === 'darwin')(
  'fingerprints native authority, full exact model metadata, executable identity and Project CWD without caching',
  async () => {
    const state = { pages: [{ data: [exactNativeModel], nextCursor: null }] },
      fixture = await capabilityFixture(state)
    const probe = async (cwd = fixture.directory) => {
      const runtime = new CodexDecisionRuntime({ ...fixture.context, cwd })
      try {
        const result = decisionCapabilitySchema.parse(await runtime.probeAdmission())
        expect(result.supported).toBe(true)
        return result.configurationFingerprint
      } finally {
        await runtime.dispose()
      }
    }
    try {
      const original = await probe()
      expect(await probe()).toBe(original)
      await fixture.update({ ...state, account: 'changed@example.test' })
      expect(await probe()).not.toBe(original)
      await fixture.update({
        pages: [
          {
            data: [{ ...exactNativeModel, displayName: 'Changed native metadata' }],
            nextCursor: null,
          },
        ],
      })
      expect(await probe()).not.toBe(original)
      await fixture.update({
        ...state,
        config: { forced_chatgpt_workspace_id: 'changed-workspace' },
      })
      expect(await probe()).not.toBe(original)
      await fixture.update(state)
      expect(await probe(tmpdir())).not.toBe(original)
      await writeFile(
        fixture.executable,
        (await readFile(fixture.executable, 'utf8')) + '\n// identity changed\n',
      )
      expect(await probe()).not.toBe(original)
      expect((await fixture.calls()).filter((call) => call.method === 'model/list')).toHaveLength(7)
      expect(fixture.dispatch).not.toHaveBeenCalled()
    } finally {
      await fixture.close()
    }
  },
)

it.runIf(process.platform === 'darwin')(
  'rechecks exact model evidence for execution after a successful probe',
  async () => {
    const fixture = await capabilityFixture({
        pages: [{ data: [exactNativeModel], nextCursor: null }],
      }),
      input = await decisionFixture(),
      first = new CodexDecisionRuntime(fixture.context)
    let execution: CodexDecisionRuntime | undefined
    try {
      expect((await first.probeAdmission()).supported).toBe(true)
      await fixture.update({ pages: [{ data: [], nextCursor: null }] })
      execution = new CodexDecisionRuntime({ ...fixture.context, reserve: () => 'reserved' })
      expect(
        await execution.evaluateDecision(() => input.input, new AbortController().signal),
      ).toEqual({ kind: 'unavailable', reason: 'runtime_unavailable' })
      expect(await execution.settlement()).toBe(true)
      expect(execution.diagnostics().failure).toBe('Native model unavailable')
      expect((await fixture.calls()).filter((call) => call.method === 'model/list')).toHaveLength(2)
      expect((await fixture.calls()).map((call) => call.method)).not.toContain('thread/start')
      expect(fixture.dispatch).not.toHaveBeenCalled()
    } finally {
      await first.dispose()
      await execution?.dispose()
      input.db.close()
      await fixture.close()
    }
  },
)

it.runIf(process.platform === 'darwin').each(['timeout', 'cancelled', 'dispose'] as const)(
  'keeps the original capability deadline and physical lease while executable resolution is %s',
  async (mode) => {
    vi.useFakeTimers()
    const loaded = Promise.withResolvers<string>(),
      controller = new AbortController(),
      executable = vi.fn<() => Promise<string>>(async () => loaded.promise),
      runtime = new CodexDecisionRuntime({
        executable,
        cwd: '/unused',
        current: () => true,
        dispatch: () => undefined,
        deadlineAt: Date.now() + 1_000,
      })
    try {
      const result = runtime.probeAdmission(controller.signal)
      let released = false
      const physical = runtime.settlement().then((value) => {
        released = value
        return value
      })
      await vi.advanceTimersByTimeAsync(999)
      expect(executable).toHaveBeenCalledOnce()
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(1)
      else if (mode === 'dispose') void runtime.dispose()
      else controller.abort()
      expect(decisionCapabilitySchema.parse(await result)).toMatchObject({
        supported: false,
        reason: mode === 'dispose' ? 'cancelled' : mode,
        physicalReleased: false,
        configurationFingerprint: null,
      })
      expect(released).toBe(false)
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
      loaded.resolve('/unused')
      expect(await physical).toBe(true)
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
    } finally {
      loaded.resolve('/unused')
      await runtime.dispose()
      vi.useRealTimers()
    }
  },
)
