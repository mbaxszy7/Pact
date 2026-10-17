import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { randomUUID } from 'node:crypto'
/* oxlint-disable typescript/no-unsafe-type-assertion -- The fake process is a deliberately minimal protocol boundary stub. */
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const nativeLaunch = vi.hoisted(() => ({
  spawn: vi.fn<typeof import('node:child_process').spawn>(),
  waitForHelpers: undefined as
    | ((child: ChildProcessWithoutNullStreams) => Promise<void>)
    | undefined,
}))
const parserWorker = vi.hoisted(() => ({ path: '' }))
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(
        filename: ConstructorParameters<typeof actual.Worker>[0],
        options?: ConstructorParameters<typeof actual.Worker>[1],
      ) {
        super(
          String(filename).endsWith('native-json-parser-worker.js') ? parserWorker.path : filename,
          options,
        )
      }
    },
  }
})
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: nativeLaunch.spawn,
}))
// These protocol actors have no OS PID/group. Real Adapter tree release is
// exercised through production spawn in codex-process-tree.test.ts.
vi.mock('../owned-process-group', () => ({
  OwnedProcessGroup: class {
    private child: ChildProcessWithoutNullStreams | undefined
    spawn(command: string, args: string[], options: object): ChildProcessWithoutNullStreams {
      this.child = nativeLaunch.spawn(command, args, {
        ...options,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      }) as ChildProcessWithoutNullStreams
      return this.child
    }
    async close(): Promise<void> {
      const child = this.child
      if (!child) return
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve())
          child.kill()
        })
      }
      await nativeLaunch.waitForHelpers?.(child)
    }
  },
}))

import type { AgentNativeContextRebuildInput, AgentRunInput } from '@pact/agent-runtime'
import type { NormalizedAgentEvent } from '@pact/contracts'

import { collaborationTaskSchema } from '@pact/contracts'

import {
  CODEX_TURN_ACCEPT_TIMEOUT_MS,
  CODEX_THREAD_RPC_TIMEOUT_MS,
  CODEX_TITLE_TIMEOUT_MS,
  CodexAgentAdapter,
  acceptsCodexReroute,
  resolveCodexThreadConfiguration,
  resolveLoadedCodexConfiguration,
} from './codex-agent-adapter.js'
import { CODEX_MAX_FRAME_BYTES } from './codex-app-server-connection.js'
import { codexProcessEnvironment } from './codex-process-environment.js'
import {
  planAuthorization,
  planEnvelope,
  planRunInput,
} from './collaboration-fixture.test-support.js'
import { nativeWorkerFixture } from './native-workers-fixture.test-support.js'

describe('owned Codex loopback environment', () => {
  it('adds only local hosts while preserving external proxy configuration and its source', () => {
    const source = Object.freeze({
      HTTP_PROXY: 'http://proxy.invalid:8080',
      HTTPS_PROXY: 'http://secure-proxy.invalid:8080',
      SOURCE_MARKER: 'retained',
    })
    const environment = codexProcessEnvironment('/owned/native', source, 'darwin')
    expect(environment).toEqual({
      ...source,
      CODEX_HOME: '/owned/native',
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'pact',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    })
    expect(source).not.toHaveProperty('NO_PROXY')
  })
  it.each(['NO_PROXY', 'no_proxy'] as const)(
    'preserves a single %s value for both Unix spellings',
    (key) => {
      const source = Object.freeze({ [key]: ' internal.invalid ,127.0.0.1' })
      const environment = codexProcessEnvironment(undefined, source, 'darwin')
      expect(environment.NO_PROXY).toBe(' internal.invalid ,127.0.0.1,localhost')
      expect(environment.no_proxy).toBe(environment.NO_PROXY)
      expect(source[key]).toBe(' internal.invalid ,127.0.0.1')
    },
  )
  it('preserves distinct Unix values without union and does not duplicate existing hosts', () => {
    const source = Object.freeze({
      NO_PROXY: 'upper.invalid, LOCALHOST ',
      no_proxy: 'lower.invalid,127.0.0.1',
    })
    const environment = codexProcessEnvironment(undefined, source, 'darwin')
    expect(environment.NO_PROXY).toBe('upper.invalid, LOCALHOST ,127.0.0.1')
    expect(environment.no_proxy).toBe('lower.invalid,127.0.0.1,localhost')
    expect(codexProcessEnvironment(undefined, environment, 'darwin')).toEqual(environment)
  })
  it('retains the effective mixed-case Windows value and emits one native variable', () => {
    expect(
      codexProcessEnvironment(undefined, { No_Proxy: 'mixed.invalid' }, 'win32').NO_PROXY,
    ).toBe('mixed.invalid,127.0.0.1,localhost')
    const environment = codexProcessEnvironment(
      undefined,
      {
        NO_PROXY: 'first.invalid',
        No_Proxy: 'shadowed.invalid',
        no_proxy: 'also-shadowed.invalid',
      },
      'win32',
    )
    expect(environment.NO_PROXY).toBe('first.invalid,127.0.0.1,localhost')
    expect(Object.keys(environment).filter((key) => key.toUpperCase() === 'NO_PROXY')).toEqual([
      'NO_PROXY',
    ])
    // Node deduplicates Windows key spellings before dropping undefined values.
    expect(
      codexProcessEnvironment(
        undefined,
        { NO_PROXY: undefined, no_proxy: 'shadowed.invalid' },
        'win32',
      ).NO_PROXY,
    ).toBe('127.0.0.1,localhost')
  })
  it('fails before launch instead of truncating exclusions at byte or item capacity', () => {
    const allowed = 'a'.repeat(8192 - ',127.0.0.1,localhost'.length)
    expect(
      Buffer.byteLength(
        codexProcessEnvironment(undefined, { NO_PROXY: allowed }, 'darwin').NO_PROXY!,
      ),
    ).toBe(8192)
    expect(() => codexProcessEnvironment(undefined, { NO_PROXY: allowed + 'a' }, 'darwin')).toThrow(
      /capacity/u,
    )
    expect(
      codexProcessEnvironment(
        undefined,
        { NO_PROXY: Array.from({ length: 254 }, () => 'a').join(',') },
        'darwin',
      ).NO_PROXY?.split(','),
    ).toHaveLength(256)
    expect(() =>
      codexProcessEnvironment(
        undefined,
        { NO_PROXY: Array.from({ length: 255 }, () => 'a').join(',') },
        'darwin',
      ),
    ).toThrow(/capacity/u)
    expect(() =>
      codexProcessEnvironment(undefined, { NO_PROXY: 'a'.repeat(8193) }, 'darwin'),
    ).toThrow(/8 KiB/u)
    expect(() => codexProcessEnvironment(undefined, { NO_PROXY: 'bad\0entry' }, 'darwin')).toThrow(
      /Invalid/u,
    )
  })
})

let workerFixture: Awaited<ReturnType<typeof nativeWorkerFixture>>
beforeAll(async () => {
  workerFixture = await nativeWorkerFixture(['native-json-parser-worker'])
  parserWorker.path = workerFixture.paths['native-json-parser-worker']!
}, 20_000)
afterAll(async () => {
  await workerFixture?.dispose()
})
import { NATIVE_OWNER_WORKING_BYTES } from './native-working-memory.js'

const nativeHomes: string[] = []

it('preserves a 12 MiB root final carrier before parsing, submits the full plan once and displays only its natural message', async () => {
  const source = planEnvelope('Plan evidence\n' + 'x'.repeat(12 * 1024 * 1024)),
    serialized = JSON.stringify(source),
    input = planRunInput('codex'),
    methods: string[] = [],
    recorded: string[] = [],
    events: NormalizedAgentEvent[] = []
  const child = fakeCodexProcess((request, respond, notify) => {
    const id = Reflect.get(request, 'id'),
      method = String(Reflect.get(request, 'method'))
    methods.push(method)
    if (method === 'initialize') respond({ id, result: {} })
    else if (method === 'thread/start') respond({ id, result: { thread: { id: 'large-thread' } } })
    else if (method === 'turn/start') {
      respond({ id, result: { turn: { id: 'large-turn' } } })
      notify({
        method: 'item/completed',
        params: {
          threadId: 'unrelated-thread',
          turnId: 'large-turn',
          item: {
            id: 'foreign',
            type: 'agentMessage',
            phase: 'final_answer',
            text: JSON.stringify(planEnvelope('Wrong plan')),
          },
        },
      })
      notify({
        method: 'item/completed',
        params: {
          threadId: 'large-thread',
          turnId: 'large-turn',
          item: { id: 'root-final', type: 'agentMessage', phase: 'final_answer', text: serialized },
        },
      })
      notify({
        method: 'turn/completed',
        params: { threadId: 'large-thread', turn: { id: 'large-turn', status: 'completed' } },
      })
    }
  })
  const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
  try {
    await collectRun(
      adapter,
      {
        ...input,
        recordCollaborationCarrierText: (text) => {
          expect(text).toBe(serialized)
          recorded.push('raw')
        },
        recordCollaborationCarrier: (carrier) => {
          expect(recorded).toEqual(['raw'])
          expect(carrier).toEqual(source)
          recorded.push('parsed')
        },
      },
      new AbortController().signal,
      (event) => events.push(event),
    )
    const results = events.filter((event) => event.type === 'collaboration.result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ result: { plan: source.result.plan } })
    expect(
      events.filter((event) => event.type === 'text.completed').map((event) => event.text),
    ).toEqual([source.answer])
    expect(methods.filter((method) => method === 'turn/start')).toHaveLength(1)
    expect(adapter.diagnostics().pendingRequests).toBe(0)
    expect(recorded).toEqual(['raw', 'parsed'])
  } finally {
    await adapter.dispose()
  }
}, 10_000)

it('recovers the Codex final report separately from natural message bytes without a Model Turn', async () => {
  const methods: string[] = [],
    report = {
      submission: 'plan_submission',
      inputResponses: [],
      outcome: 'complete',
      summary: 'Source checked.',
      plan: 'Unique cold plan.',
      todoDeltas: [],
    },
    envelope = {
      version: 'pact-collaboration-envelope-v5',
      answer: 'Natural argument.',
      result: report,
    }
  const child = fakeCodexProcess((request, respond) => {
    const id = Reflect.get(request, 'id'),
      method = String(Reflect.get(request, 'method'))
    methods.push(method)
    if (method === 'initialize') respond({ id, result: {} })
    else if (method === 'thread/read')
      respond({ id, result: { thread: { id: 'cold-thread', status: { type: 'idle' } } } })
    else if (method === 'thread/turns/list')
      respond({
        id,
        result: {
          data: [
            {
              id: 'cold-turn',
              status: 'completed',
              completedAt: 1000,
              startedAt: 900,
              durationMs: 100,
              error: null,
              itemsView: 'none',
              items: [],
            },
          ],
          nextCursor: null,
        },
      })
    else if (method === 'thread/items/list')
      respond({
        id,
        result: {
          data: [
            {
              turnId: 'cold-turn',
              item: {
                id: 'root-final',
                type: 'agentMessage',
                phase: 'final',
                text: JSON.stringify(envelope),
              },
            },
          ],
          nextCursor: null,
        },
      })
  })
  const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
  try {
    const result = await adapter.probeNativeStatus(
      {
        sessionId: randomUUID(),
        agentId: 'codex',
        requestId: randomUUID(),
        runId: randomUUID(),
        nativeSessionId: 'cold-thread',
        nativeTurnId: 'cold-turn',
        bindingGeneration: 1,
        answerFormat: 'collaboration_envelope_v5',
        cwd: '/project',
        model: null,
        effort: null,
      },
      new AbortController().signal,
    )
    expect(result).toMatchObject({
      kind: 'ended',
      outcome: 'completed',
      output: { text: envelope.answer, completeness: 'complete', submittedReport: report },
    })
    expect(methods).not.toContain('turn/start')
    expect(methods).not.toContain('thread/resume')
    expect(adapter.diagnostics().pendingRequests).toBe(0)
  } finally {
    await adapter.dispose()
  }
})

afterEach(async () => {
  vi.useRealTimers()
  nativeLaunch.spawn.mockReset()
  nativeLaunch.waitForHelpers = undefined
  vi.unstubAllEnvs()
  await Promise.all(
    nativeHomes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('Codex foreground command cancellation ownership', () => {
  it.each(['late-completion', 'provisional-handle'] as const)(
    'terminates only the frozen current command despite %s and unrelated native terminals',
    async (mode) => {
      const f = foregroundCommandFixture({ mode })
      try {
        await f.ready()
        f.complete('already-completed')
        await vi.waitFor(() =>
          expect(
            f.events.some(
              (event) =>
                event.type === 'tool.completed' && event.toolCallId === 'already-completed',
            ),
          ).toBe(true),
        )
        f.controller.abort()
        await f.outcome
        expect(f.terminated).toEqual(['own-handle'])
        expect(f.methods.filter((method) => method === 'turn/interrupt')).toHaveLength(1)
        expect(f.pages).toEqual([undefined, '1', '2'])
        expect(f.listLimits).toEqual([1, 1, 1])
        expect(
          f.evidence.mock.calls.some(
            ([entry]) => entry.kind === 'ended' && entry.outcome === 'interrupted',
          ),
        ).toBe(true)
        await vi.waitFor(() => expect(f.adapter.hasActiveBackgroundWork()).toBe(false))
        expect(f.adapter.diagnostics().pendingRequests).toBe(0)
      } finally {
        await f.adapter.dispose()
      }
    },
  )
  it.each(['handle-mismatch', 'oversized-page', 'repeated-cursor', 'missing-handle'] as const)(
    'keeps uncertainty without a broader termination after %s',
    async (mode) => {
      const f = foregroundCommandFixture({ mode })
      try {
        await f.ready()
        f.controller.abort()
        await f.outcome
        expect(f.terminated).toEqual([])
        expect(f.adapter.hasActiveBackgroundWork()).toBe(true)
        expect(f.settled.mock.calls.some(([entry]) => entry.state === 'unknown')).toBe(true)
        expect(f.adapter.diagnostics().pendingRequests).toBe(0)
      } finally {
        await f.adapter.dispose()
      }
    },
  )
  it('never retries a lost termination ACK or uses that write as command completion', async () => {
    vi.useFakeTimers()
    const f = foregroundCommandFixture({ mode: 'lost-ack' })
    try {
      await vi.advanceTimersByTimeAsync(0)
      f.controller.abort()
      await vi.advanceTimersByTimeAsync(2001)
      await f.outcome
      expect(f.terminated).toEqual(['own-handle'])
      expect(f.adapter.hasActiveBackgroundWork()).toBe(true)
      expect(f.adapter.diagnostics().pendingRequests).toBe(0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(f.terminated).toEqual(['own-handle'])
    } finally {
      const disposed = f.adapter.dispose()
      await vi.runAllTimersAsync()
      await disposed
    }
  })
  it('aborts discovery during disposal and sends no termination into a retired connection', async () => {
    const f = foregroundCommandFixture({ mode: 'silent-list' })
    try {
      await f.ready()
      f.controller.abort()
      await vi.waitFor(() => expect(f.pages).toHaveLength(1))
      await f.adapter.dispose()
      await f.outcome
      expect(f.terminated).toEqual([])
      expect(f.adapter.diagnostics().pendingRequests).toBe(0)
    } finally {
      await f.adapter.dispose()
    }
  })
  it('does not terminate work that completed or interacted with an old terminal before Stop', async () => {
    const f = foregroundCommandFixture({ mode: 'completed-before-stop' })
    try {
      await f.ready()
      f.complete('own-command')
      f.complete('already-completed')
      await vi.waitFor(() =>
        expect(
          f.events.some(
            (event) => event.type === 'tool.completed' && event.toolCallId === 'own-command',
          ),
        ).toBe(true),
      )
      f.controller.abort()
      await f.outcome
      expect(f.pages).toEqual([])
      expect(f.terminated).toEqual([])
    } finally {
      await f.adapter.dispose()
    }
  })
})

describe('Codex native launch capabilities', () => {
  it('applies and confirms readonly sandbox, preserves native tool config, reports only root results, and restores normal permission on the same Thread', async () => {
    let peerUrl = '',
      peerServer = '',
      turnCount = 0
    let policy: object = {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
    }
    const policies: object[] = [],
      turns: object[] = [],
      configs: object[] = [],
      declinedPublications: unknown[] = []
    const report = {
      submission: 'plan_submission',
      inputResponses: [],
      outcome: 'complete',
      summary: 'Source inspected.',
      plan: 'An observable plan.',
      todoDeltas: [],
    }
    const child = fakeCodexProcess(
      (request, respond, notify) => {
        const id = Reflect.get(request, 'id'),
          method = Reflect.get(request, 'method'),
          params = Reflect.get(request, 'params') as object
        if (method === 'initialize') respond({ id, result: {} })
        else if (method === 'thread/start') {
          const config = Reflect.get(params, 'config') as object
          configs.push(config)
          const [key, entry] = Object.entries(config).find(([name]) =>
            name.startsWith('mcp_servers.'),
          )!
          peerServer = key.slice('mcp_servers.'.length)
          peerUrl = Reflect.get(entry, 'url') as string
          respond({
            id,
            result: {
              thread: { id: 'readonly-thread' },
              ...policy,
              sandbox: Reflect.get(policy, 'sandboxPolicy'),
            },
          })
        } else if (method === 'turn/start') {
          turns.push(params)
          const turnId = `turn-${++turnCount}`
          respond({ id, result: { turn: { id: turnId } } })
          void (async () => {
            if (turnCount === 1) {
              const rpc = (await fetch(peerUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json', connection: 'close' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'tools/call',
                  params: { name: 'publish_collaboration_result', arguments: report },
                }),
              }).then((response) => response.json())) as object
              declinedPublications.push(Reflect.get(Reflect.get(rpc, 'result'), 'isError'))
              const item = {
                id: 'report-root',
                type: 'mcpToolCall',
                server: peerServer,
                tool: 'publish_collaboration_result',
                arguments: report,
                status: 'completed',
                result: Reflect.get(rpc, 'result'),
                error: null,
              }
              notify({
                method: 'item/completed',
                params: { threadId: 'unrelated-thread', turnId, item },
              })
              notify({
                method: 'item/completed',
                params: { threadId: 'readonly-thread', turnId, item },
              })
            }
            if (turnCount === 1)
              notify({
                method: 'item/completed',
                params: {
                  threadId: 'readonly-thread',
                  turnId,
                  item: {
                    id: 'final-root',
                    type: 'agentMessage',
                    phase: 'final_answer',
                    text: JSON.stringify({
                      version: 'pact-collaboration-envelope-v5',
                      answer: 'Source checked.',
                      result: report,
                    }),
                  },
                },
              })
            notify({
              method: 'turn/completed',
              params: { threadId: 'readonly-thread', turn: { id: turnId, status: 'completed' } },
            })
          })()
        }
      },
      (request, respond, notify) => {
        const id = Reflect.get(request, 'id'),
          method = Reflect.get(request, 'method'),
          params = Reflect.get(request, 'params') as object
        if (method === 'thread/settings/update') {
          policy = {
            approvalPolicy: Reflect.get(params, 'approvalPolicy'),
            approvalsReviewer: Reflect.get(params, 'approvalsReviewer'),
            sandboxPolicy: Reflect.get(params, 'sandboxPolicy'),
          }
          policies.push(policy)
          respond({ id, result: {} })
          notify({
            method: 'thread/settings/updated',
            params: { threadId: 'readonly-thread', threadSettings: policy },
          })
          return true
        }
        if (method === 'thread/resume') {
          configs.push(Reflect.get(params, 'config') as object)
          respond({
            id,
            result: {
              thread: { id: 'readonly-thread' },
              ...policy,
              sandbox: Reflect.get(policy, 'sandboxPolicy'),
            },
          })
          return true
        }
        return false
      },
    )
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child)),
      sessionId = randomUUID(),
      messageId = randomUUID(),
      runId = randomUUID()
    const workflow = collaborationTaskSchema.parse({
      id: randomUUID(),
      sessionId,
      taskMessageId: messageId,
      runId,
      task: 'Make a plan.',
      kind: 'plan',
      revision: 0,
      primary: 'codex',
      drafter: 'codex',
      implementer: 'claude',
      reviewer: 'codex',
      stage: 'draft',
      actor: 'codex',
      status: 'running',
      planVersion: 0,
      discussionRounds: 0,
      discussionHalf: false,
      reviewCycles: 0,
      repairAttempts: 0,
      rereview: false,
      nextCycle: false,
    })
    const input: AgentRunInput = {
      answerFormat: 'collaboration_envelope_v5',
      runId,
      sessionId,
      cwd: '/project',
      model: null,
      effort: null,
      promptEnvelope: {
        version: 'pact-agent-prompt-v1',
        sessionId,
        message: { id: messageId, content: '/plan Make a plan.' },
        comments: [],
        collaboration: workflow,
        collaborationAuthorization: planAuthorization(runId, workflow.id, 'codex'),
      },
    }
    try {
      const first: NormalizedAgentEvent[] = []
      await collectRun(adapter, input, new AbortController().signal, (event) => first.push(event))
      expect(first.filter((event) => event.type === 'collaboration.result')).toHaveLength(1)
      expect(declinedPublications).toEqual([true])
      expect(policies[0]).toEqual({
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      })
      expect(turns[0]).toMatchObject({
        sandboxPolicy: { type: 'readOnly' },
        approvalPolicy: 'never',
      })
      const firstTurn = turns[0],
        firstConfig = configs[0]
      if (!firstTurn || !firstConfig) throw new Error('No admitted native Turn.')
      expect(Reflect.get(firstTurn, 'permissions')).toBeUndefined()
      expect(Object.keys(firstConfig)).toEqual([`mcp_servers.${peerServer}`])
      await vi.waitFor(() => expect(adapter.hasActiveBackgroundWork()).toBe(false))
      const { collaboration: _workflow, ...ordinaryPrompt } = input.promptEnvelope
      await collectRun(adapter, {
        ...input,
        runId: randomUUID(),
        nativeSessionId: 'readonly-thread',
        promptEnvelope: {
          ...ordinaryPrompt,
          message: { id: randomUUID(), content: 'Ordinary task' },
        },
      })
      expect(policies.at(-1)).toEqual({
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'dangerFullAccess' },
      })
      expect(turns).toHaveLength(2)
      expect(turns.every((turn) => Reflect.get(turn, 'threadId') === 'readonly-thread')).toBe(true)
      expect(adapter.diagnostics().pendingRequests).toBe(0)
    } finally {
      await adapter.dispose()
    }
  })
  it.each([
    [
      'host enabled',
      'code_mode_host stable true\ncode_mode_interrupt under development false\n',
      ['--enable', 'code_mode_interrupt', 'app-server'],
    ],
    ['older CLI', 'shell_tool stable true\n', ['app-server']],
    ['host disabled', 'code_mode_host stable false\n', ['app-server']],
    [
      '152-row inventory',
      `${Array.from({ length: 150 }, (_value, index) => `other_${index} stable false\n`).join('')}code_mode_host stable true\ncode_mode_interrupt under development false\n`,
      ['--enable', 'code_mode_interrupt', 'app-server'],
    ],
  ] as const)(
    'uses process-scoped launch arguments for %s and preserves its environment',
    async (_name, inventory, args) => {
      vi.stubEnv('PACT_LAUNCH_WITNESS', 'untouched')
      vi.stubEnv('CODEX_HOME', '/original/codex')
      vi.stubEnv('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'Codex Desktop')
      const child = completedCapabilityActor()
      nativeLaunch.spawn
        .mockImplementationOnce(() => featureProcess(inventory))
        .mockImplementationOnce(() => child)
      const adapter = new CodexAgentAdapter('/owned/codex', undefined, {
        storageRoot: '/owned/native',
      })
      try {
        await collectRun(adapter)
        expect(nativeLaunch.spawn).toHaveBeenCalledTimes(2)
        expect(nativeLaunch.spawn.mock.calls.map((call) => call[1])).toEqual([
          ['features', 'list'],
          args,
        ])
        const probeOptions = nativeLaunch.spawn.mock.calls[0]![2]
        expect(nativeLaunch.spawn.mock.calls[1]![2]).toMatchObject({
          ...probeOptions,
          detached: process.platform !== 'win32',
        })
        expect(nativeLaunch.spawn.mock.calls[1]![2].env).toBe(probeOptions.env)
        expect(probeOptions).toMatchObject({
          cwd: '/project',
          shell: false,
          windowsHide: true,
          env: {
            CODEX_HOME: resolvePath('/owned/native'),
            CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'pact',
            PACT_LAUNCH_WITNESS: 'untouched',
          },
        })
        expect(process.env['CODEX_HOME']).toBe('/original/codex')
        expect(process.env['CODEX_INTERNAL_ORIGINATOR_OVERRIDE']).toBe('Codex Desktop')
        expect(process.env['PACT_LAUNCH_WITNESS']).toBe('untouched')
      } finally {
        await adapter.dispose()
      }
    },
  )

  it.each([
    ['missing interruption', 'code_mode_host stable true\n'],
    ['removed interruption', 'code_mode_host stable true\ncode_mode_interrupt removed false\n'],
    [
      'duplicate host',
      'code_mode_host stable true\ncode_mode_host stable false\ncode_mode_interrupt under development false\n',
    ],
    [
      'duplicate interruption',
      'code_mode_host stable true\ncode_mode_interrupt stable true\ncode_mode_interrupt stable false\n',
    ],
    ['invalid Boolean', 'code_mode_host stable yes\n'],
    ['unknown stage', 'code_mode_host available true\n'],
    ['empty inventory', ' \n'],
    ['row overflow', 'shell_tool stable true\n'.repeat(257)],
  ])('refuses %s before starting an execution actor', async (_name, inventory) => {
    nativeLaunch.spawn.mockImplementationOnce(() => featureProcess(inventory))
    const adapter = new CodexAgentAdapter('/owned/codex')
    try {
      await expect(collectRun(adapter)).rejects.toMatchObject({ kind: 'runtime_incompatible' })
      expect(nativeLaunch.spawn).toHaveBeenCalledOnce()
      expect(adapter.diagnostics().open).toBe(false)
    } finally {
      await adapter.dispose()
    }
  })

  it('bounds the discovery deadline and closes only its zero-input probe', async () => {
    vi.useFakeTimers()
    const probe = featureProcess()
    nativeLaunch.spawn.mockImplementationOnce(() => probe)
    const adapter = new CodexAgentAdapter('/owned/codex')
    const outcome = collectRun(adapter).catch((error: unknown) => error)
    try {
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await outcome).toMatchObject({
        kind: 'runtime_incompatible',
        message: expect.stringContaining('deadline'),
      })
      expect(probe.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
      expect(nativeLaunch.spawn).toHaveBeenCalledOnce()
      expect(probe.stdout.listenerCount('data')).toBe(0)
      expect(probe.stderr.listenerCount('data')).toBe(0)
      expect(probe.listenerCount('close')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await adapter.dispose()
    }
  })

  it.each(['stdout', 'stderr'] as const)(
    'refuses oversized %s and confirms probe exit before release',
    async (stream) => {
      vi.useFakeTimers()
      const probe = featureProcess()
      nativeLaunch.spawn.mockImplementationOnce(() => probe)
      const adapter = new CodexAgentAdapter('/owned/codex')
      const outcome = collectRun(adapter).catch((error: unknown) => error)
      try {
        await vi.advanceTimersByTimeAsync(0)
        probe[stream].write(Buffer.alloc(64 * 1024 + 1, 'a'))
        await vi.advanceTimersByTimeAsync(0)
        expect(await outcome).toMatchObject({
          kind: 'runtime_incompatible',
          message: expect.stringContaining('output limit'),
        })
        expect(probe.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
        expect(nativeLaunch.spawn).toHaveBeenCalledOnce()
        expect(probe.stdout.listenerCount('data')).toBe(0)
        expect(probe.stderr.listenerCount('data')).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        await adapter.dispose()
      }
    },
  )

  it('retains an unconfirmed probe and refuses another actor until its actual close', async () => {
    vi.useFakeTimers()
    const probe = featureProcess()
    Object.assign(probe, { kill: vi.fn<() => boolean>(() => false) })
    nativeLaunch.spawn.mockImplementationOnce(() => probe)
    const adapter = new CodexAgentAdapter('/owned/codex')
    const outcome = collectRun(adapter).catch((error: unknown) => error)
    try {
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await outcome).toMatchObject({
        kind: 'runtime_incompatible',
        message: expect.stringContaining('process exit'),
      })
      await expect(collectRun(adapter)).rejects.toMatchObject({ kind: 'runtime_incompatible' })
      expect(nativeLaunch.spawn).toHaveBeenCalledOnce()
      expect(probe.kill).toHaveBeenCalledOnce()
      await expect(adapter.dispose()).rejects.toThrow('process exit')
      expect(probe.stdout.listenerCount('data')).toBe(0)
      expect(probe.stderr.listenerCount('data')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      probe.emit('close', 0, null)
      await adapter.dispose()
    }
  })

  it('settles concurrent disposal only after the capability actor closes', async () => {
    vi.useFakeTimers()
    const probe = featureProcess()
    Object.assign(probe, { kill: vi.fn<() => boolean>(() => false) })
    nativeLaunch.spawn.mockImplementationOnce(() => probe)
    const adapter = new CodexAgentAdapter('/owned/codex')
    const outcome = collectRun(adapter).catch((error: unknown) => error)
    let disposed = false
    try {
      await vi.advanceTimersByTimeAsync(0)
      const disposal = adapter.dispose().then(() => {
        disposed = true
        return undefined
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(disposed).toBe(false)
      expect(probe.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
      probe.emit('close', 0, null)
      await disposal
      expect(await outcome).toMatchObject({ kind: 'runtime_incompatible' })
      expect(disposed).toBe(true)
      expect(nativeLaunch.spawn).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      probe.emit('close', 0, null)
      await adapter.dispose()
    }
  })

  it('shares only an identical in-flight native startup generation', async () => {
    vi.useFakeTimers()
    const probe = featureProcess()
    nativeLaunch.spawn.mockImplementationOnce(() => probe)
    const adapter = new CodexAgentAdapter('/owned/codex')
    const input = nativeLaunchForkSource()
    const first = adapter
      .prepareNativeFork(input, new AbortController().signal)
      .catch((error: unknown) => error)
    const second = adapter
      .prepareNativeFork(input, new AbortController().signal)
      .catch((error: unknown) => error)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(nativeLaunch.spawn).toHaveBeenCalledOnce()
      await adapter.dispose()
      expect(await first).toMatchObject({ kind: 'runtime_incompatible' })
      expect(await second).toBe(await first)
      expect(nativeLaunch.spawn).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await adapter.dispose()
    }
  })

  it('refuses to share pending startup after its effective environment changes', async () => {
    vi.useFakeTimers()
    vi.stubEnv('PACT_LAUNCH_WITNESS', 'generation-one')
    const probe = featureProcess()
    nativeLaunch.spawn.mockImplementationOnce(() => probe)
    const adapter = new CodexAgentAdapter('/owned/codex')
    const first = adapter
      .prepareNativeFork(nativeLaunchForkSource(), new AbortController().signal)
      .catch((error: unknown) => error)
    try {
      await vi.advanceTimersByTimeAsync(0)
      vi.stubEnv('PACT_LAUNCH_WITNESS', 'generation-two')
      await expect(
        adapter.prepareNativeFork(nativeLaunchForkSource(), new AbortController().signal),
      ).rejects.toMatchObject({
        kind: 'runtime_incompatible',
        message: expect.stringContaining('another native configuration'),
      })
      expect(nativeLaunch.spawn).toHaveBeenCalledOnce()
      expect(nativeLaunch.spawn.mock.calls[0]![2].env!['PACT_LAUNCH_WITNESS']).toBe(
        'generation-one',
      )
      await adapter.dispose()
      expect(await first).toMatchObject({ kind: 'runtime_incompatible' })
      expect(nativeLaunch.spawn).toHaveBeenCalledOnce()
    } finally {
      await adapter.dispose()
    }
  })

  it('discovers the same process-scoped capability for the separate native history actor', async () => {
    const inventory = 'code_mode_host stable true\ncode_mode_interrupt under development false\n'
    nativeLaunch.spawn
      .mockImplementationOnce(() => featureProcess(inventory))
      .mockImplementationOnce(() => completedCapabilityActor())
      .mockImplementationOnce(() => featureProcess(inventory))
      .mockImplementationOnce(() => completedCapabilityActor())
    const adapter = new CodexAgentAdapter('/owned/codex', undefined, {
      storageRoot: '/owned/native',
    })
    try {
      await expect(
        adapter.prepareNativeFork(
          {
            cwd: '/project',
            nativeSessionId: 'thread-1',
            nativeTurnId: 'turn-1',
            runId: 'run-1',
            bindingGeneration: 1,
            throughSequence: 1,
            deliveryCursor: 0,
            responseHash: 'a'.repeat(64),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow('rollout identity')
      expect(nativeLaunch.spawn.mock.calls.map((call) => call[1])).toEqual([
        ['features', 'list'],
        ['--enable', 'code_mode_interrupt', 'app-server'],
        ['features', 'list'],
        ['--enable', 'code_mode_interrupt', 'app-server'],
      ])
      expect(nativeLaunch.spawn.mock.calls[0]![2].env).toEqual(
        nativeLaunch.spawn.mock.calls[2]![2].env,
      )
      expect(nativeLaunch.spawn.mock.calls.every((call) => call[2].cwd === '/project')).toBe(true)
    } finally {
      await adapter.dispose()
    }
  })

  it('keeps the history-reader slot until its helper group has physically closed', async () => {
    const inventory = 'code_mode_host stable false\n'
    const reader = completedCapabilityActor()
    let helperReleased!: () => void
    let reached!: () => void
    const helpers = new Promise<void>((resolve) => {
      helperReleased = resolve
    })
    const rootExited = new Promise<void>((resolve) => {
      reached = resolve
    })
    nativeLaunch.waitForHelpers = async (child) => {
      if (child !== reader) return
      reached()
      await helpers
    }
    nativeLaunch.spawn
      .mockImplementationOnce(() => featureProcess(inventory))
      .mockImplementationOnce(() => completedCapabilityActor())
      .mockImplementationOnce(() => featureProcess(inventory))
      .mockImplementationOnce(() => reader)
      .mockImplementationOnce(() => featureProcess(inventory))
      .mockImplementationOnce(() => completedCapabilityActor())
    const adapter = new CodexAgentAdapter('/owned/codex', undefined, {
      storageRoot: '/owned/native',
    })
    const input = nativeLaunchForkSource()
    const first = adapter
      .prepareNativeFork(input, new AbortController().signal)
      .catch((error: unknown) => error)
    try {
      await rootExited
      await expect(adapter.prepareNativeFork(input, new AbortController().signal)).rejects.toThrow(
        'bounded native history reader is unavailable',
      )
      expect(nativeLaunch.spawn).toHaveBeenCalledTimes(4)
    } finally {
      helperReleased()
      await first
      await adapter.dispose()
    }
  })
})

describe('Codex Agent model metadata', () => {
  it('admits a handoff above the old frame ceiling and refuses working overflow before opening a process', () => {
    const startProcess = vi.fn<() => void>()
    const adapter = new CodexAgentAdapter('/fake/codex', startProcess as never)
    const input: AgentRunInput = {
      runId: 'run-1',
      sessionId: 'session-1',
      cwd: '/project',
      promptEnvelope: {
        version: 'pact-agent-prompt-v1',
        sessionId: 'session-1',
        message: { id: 'message-1', content: 'Review the peer answer' },
        comments: [],
        handoffContext: [
          { messageId: 'source-1', speaker: 'user', content: 'a'.repeat(600_000), comments: [] },
          {
            messageId: 'source-2',
            speaker: 'claude',
            content: 'b'.repeat(600_000),
            comments: [],
          },
        ],
      },
      model: null,
      effort: null,
    }
    expect(() => adapter.preflightPrompt(input)).not.toThrow()
    input.promptEnvelope.handoffContext![1]!.content = 'b'.repeat(NATIVE_OWNER_WORKING_BYTES / 2)
    expect(() => adapter.preflightPrompt(input)).toThrow(
      'Native request preparation capacity is full',
    )
    expect(startProcess).not.toHaveBeenCalled()
  })

  it('uses app-server defaults while retaining an explicit effort', () => {
    expect(
      resolveCodexThreadConfiguration(
        { model: null, effort: 'high' },
        { model: 'gpt-5.6', reasoningEffort: 'medium' },
      ),
    ).toEqual({ model: 'gpt-5.6', effort: 'high' })
  })

  it('uses explicit overrides when reusing a loaded thread', () => {
    expect(
      resolveLoadedCodexConfiguration(
        { model: 'gpt-5.7', effort: 'xhigh' },
        { model: 'gpt-5.6', effort: 'medium' },
      ),
    ).toEqual({ model: 'gpt-5.7', effort: 'xhigh' })
  })

  it('rejects reroutes from a different thread or known turn', () => {
    expect(acceptsCodexReroute('thread-1', 'turn-1', 'thread-2', 'turn-1')).toBe(false)
    expect(acceptsCodexReroute('thread-1', 'turn-1', 'thread-1', 'turn-2')).toBe(false)
    expect(acceptsCodexReroute('thread-1', 'turn-1', 'thread-1', undefined)).toBe(false)
  })
})

describe('Codex Agent lifecycle', () => {
  it
    .skipIf(process.platform !== 'win32')
    .each([
      'valid',
      'null-hooks',
      'missing-hooks',
      'wrong-cwd',
      'target-id',
      'persistent-thread',
      'incomplete-sandbox',
      'contradictory-sandbox',
      'custom-profile',
      'native-mcp',
      'native-plugin',
      'hook',
      'hook-error',
      'changed-config',
      'changed-environment',
      'server-request',
      'unexpected-hook',
      'cancelled',
      'partial-target-ack',
      'probe-deadline',
      'initialization-hook',
      'initialization-request',
    ] as const)(
    'restores unresolved Windows Native defaults only through an isolated verified receipt: %s',
    async (variant) => {
      const home = await mkdtemp(join(tmpdir(), 'pact-windows-default-policy-'))
      nativeHomes.push(home)
      const rawConfig = {
        approval_policy: null,
        approvals_reviewer: null,
        sandbox_mode: null,
        default_permissions: null,
        mcp_servers: {},
        plugins: {},
        hooks: {},
      }
      const succeeds = variant === 'valid' || variant === 'null-hooks'
      if (variant === 'probe-deadline') vi.useFakeTimers()
      if (variant === 'null-hooks') Reflect.set(rawConfig, 'hooks', null)
      if (variant === 'missing-hooks') Reflect.deleteProperty(rawConfig, 'hooks')
      const nativeSandbox = { type: 'readOnly', networkAccess: false }
      if (variant === 'native-mcp')
        Object.assign(rawConfig.mcp_servers, { custom: { command: 'owned-test-only' } })
      if (variant === 'native-plugin')
        Object.assign(rawConfig.plugins, { custom: { enabled: true } })
      const updates: object[] = [],
        probeRequests: object[] = []
      let probeReleased = false,
        releasedAtModelStart: boolean | undefined,
        modelTurns = 0,
        configReads = 0
      const controller = new AbortController()
      const live = fakeCodexProcess(
        (request, respond, notify) => {
          const id = Reflect.get(request, 'id'),
            method = Reflect.get(request, 'method')
          if (method === 'initialize') respond({ id, result: {} })
          else if (method === 'turn/start') {
            releasedAtModelStart = probeReleased
            modelTurns += 1
            respond({ id, result: { turn: { id: 'turn-1' } } })
            notify({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
            })
          }
        },
        (request, respond, notify) => {
          const id = Reflect.get(request, 'id'),
            method = Reflect.get(request, 'method')
          if (method === 'config/read') {
            respond({ id, result: { config: rawConfig } })
            return true
          }
          if (method === 'thread/resume') {
            respond({
              id,
              result: {
                thread: { id: 'thread-1', cwd: '/project' },
                model: 'gpt-test',
                reasoningEffort: 'medium',
                approvalPolicy: 'never',
                approvalsReviewer: 'user',
                sandbox: { type: 'dangerFullAccess' },
              },
            })
            return true
          }
          if (method === 'thread/settings/update') {
            updates.push(Reflect.get(request, 'params'))
            if (variant === 'partial-target-ack') {
              respond({ id, result: {} })
              notify({
                method: 'thread/settings/updated',
                params: {
                  threadId: 'thread-1',
                  threadSettings: {
                    approvalPolicy: 'on-request',
                    approvalsReviewer: 'user',
                    sandboxPolicy: { type: 'readOnly' },
                  },
                },
              })
              return true
            }
          }
          return false
        },
      )
      const inspection = fakeCodexProcess(
        (request, respond, notify) => {
          probeRequests.push(request)
          const id = Reflect.get(request, 'id'),
            method = Reflect.get(request, 'method')
          if (method === 'initialize') {
            if (variant === 'initialization-hook') notify({ method: 'hook/started', params: {} })
            if (variant === 'initialization-request')
              notify({ id: 'early-owned-request', method: 'tool/requestUserInput', params: {} })
            respond({ id, result: {} })
          } else if (method === 'hooks/list')
            respond({
              id,
              result: {
                data: [
                  {
                    cwd: '/project',
                    hooks: variant === 'hook' ? [{ eventName: 'SessionStart', enabled: true }] : [],
                    errors: variant === 'hook-error' ? ['invalid-owned-test-hook'] : [],
                    warnings: [],
                  },
                ],
              },
            })
          else if (method === 'thread/start') {
            if (variant === 'probe-deadline') {
              void vi.advanceTimersByTimeAsync(10_001)
              return
            }
            if (variant === 'server-request') {
              notify({
                id: 'unexpected-owned-request',
                method: 'tool/requestUserInput',
                params: {},
              })
              return
            }
            if (variant === 'unexpected-hook') notify({ method: 'hook/started', params: {} })
            if (variant === 'changed-environment')
              vi.stubEnv('PACT_WINDOWS_DEFAULTS_TEST', 'changed')
            if (variant === 'cancelled') controller.abort()
            respond({
              id,
              result: {
                thread: {
                  id: variant === 'target-id' ? 'thread-1' : 'ephemeral-defaults',
                  cwd: variant === 'wrong-cwd' ? '/elsewhere' : '/project',
                  ephemeral: variant !== 'persistent-thread',
                },
                approvalPolicy: 'on-request',
                approvalsReviewer: 'user',
                sandbox:
                  variant === 'incomplete-sandbox'
                    ? { type: 'readOnly' }
                    : variant === 'contradictory-sandbox'
                      ? { type: 'dangerFullAccess' }
                      : nativeSandbox,
                activePermissionProfile: {
                  id: variant === 'custom-profile' ? 'unproven-custom-profile' : ':read-only',
                  extends: null,
                },
              },
            })
          }
        },
        (request, respond) => {
          if (Reflect.get(request, 'method') !== 'config/read') return false
          probeRequests.push(request)
          configReads += 1
          respond({
            id: Reflect.get(request, 'id'),
            result: {
              config:
                variant === 'changed-config' && configReads > 1
                  ? { ...rawConfig, model: 'configuration-changed' }
                  : rawConfig,
            },
          })
          return true
        },
      )
      inspection.once('exit', () => {
        probeReleased = true
      })
      let spawned = 0
      const adapter = new CodexAgentAdapter(
        '/fake/codex',
        () => (++spawned === 1 ? live : inspection),
        {
          storageRoot: home,
        },
      )
      try {
        const task = collectRun(
          adapter,
          { nativeSessionId: 'thread-1', permissionMode: 'native' },
          controller.signal,
        )
        const outcome = await task.then(
          () => ({ ok: true, kind: undefined }),
          (error: unknown) => ({ ok: false, kind: Reflect.get(error as object, 'kind') }),
        )
        expect(outcome.ok).toBe(succeeds)
        expect(outcome.kind).toBe(
          succeeds ? undefined : variant === 'cancelled' ? 'user_stopped' : 'runtime_incompatible',
        )
        expect(modelTurns).toBe(succeeds ? 1 : 0)
        expect(probeReleased).toBe(true)
        expect(releasedAtModelStart).toBe(succeeds ? true : undefined)
        expect(updates).toEqual(
          succeeds || variant === 'partial-target-ack'
            ? [
                {
                  threadId: 'thread-1',
                  approvalPolicy: 'on-request',
                  approvalsReviewer: 'user',
                  sandboxPolicy: nativeSandbox,
                },
              ]
            : [],
        )
        expect(spawned).toBe(2)
        expect(
          probeRequests.filter((request) => Reflect.get(request, 'method') === 'turn/start'),
        ).toEqual([])
        if (!succeeds) return
        const start = probeRequests.find(
          (request) => Reflect.get(request, 'method') === 'thread/start',
        )!
        expect(Reflect.get(start, 'params')).toEqual({
          cwd: '/project',
          ephemeral: true,
          allowProviderModelFallback: false,
        })
      } finally {
        await adapter.dispose()
      }
    },
  )

  for (const table of ['omitted', 'null', 'custom'] as const) {
    it(`continues Native workspace defaults with ${table} table through a complete same-thread readback`, async () => {
      const methods: string[] = []
      const requests: object[] = []
      const sandbox = {
        type: 'workspaceWrite',
        writableRoots: table === 'custom' ? [resolvePath('/extra')] : [],
        networkAccess: table === 'custom',
        excludeTmpdirEnvVar: table === 'custom',
        excludeSlashTmp: false,
      }
      const child = fakeCodexProcess(
        (request, respond, notify) => {
          const id = Reflect.get(request, 'id')
          if (Reflect.get(request, 'method') === 'initialize') respond({ id, result: {} })
          else if (Reflect.get(request, 'method') === 'turn/start') {
            respond({ id, result: { turn: { id: 'turn-1' } } })
            notify({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
            })
          }
        },
        (request, respond) => {
          const method = Reflect.get(request, 'method')
          if (typeof method === 'string') methods.push(method)
          requests.push(request)
          const id = Reflect.get(request, 'id')
          if (method === 'config/read') {
            respond({
              id,
              result: {
                config: {
                  approval_policy: 'on-request',
                  sandbox_mode: 'workspace-write',
                  ...(table === 'null'
                    ? { sandbox_workspace_write: null }
                    : table === 'custom'
                      ? {
                          sandbox_workspace_write: {
                            writable_roots: [resolvePath('/project'), resolvePath('/extra')],
                            network_access: true,
                            exclude_tmpdir_env_var: true,
                            exclude_slash_tmp: false,
                          },
                        }
                      : {}),
                },
              },
            })
            return true
          }
          if (method === 'thread/resume') {
            respond({
              id,
              result: {
                thread: { id: 'thread-1' },
                model: 'gpt-test',
                reasoningEffort: 'medium',
                approvalPolicy: 'on-request',
                approvalsReviewer: 'user',
                sandbox,
              },
            })
            return true
          }
          return false
        },
      )
      const adapter = new CodexAgentAdapter('/fake/codex', () => child)
      try {
        await collectRun(adapter, { nativeSessionId: 'thread-1', permissionMode: 'native' })
        expect(methods.filter((method) => method === 'turn/start')).toHaveLength(1)
        expect(methods).not.toContain('thread/settings/update')
        const resume = requests.find(
          (request) => Reflect.get(request, 'method') === 'thread/resume',
        )!
        const params = Reflect.get(resume, 'params') as object
        expect(Reflect.get(params, 'threadId')).toBe('thread-1')
        expect(
          Reflect.get(Reflect.get(params, 'config') as object, 'sandbox_workspace_write'),
        ).toEqual(
          table === 'custom'
            ? {
                writable_roots: [resolvePath('/project'), resolvePath('/extra')],
                network_access: true,
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: false,
              }
            : undefined,
        )
      } finally {
        await adapter.dispose()
      }
    })
  }

  it('requires a matching acknowledgement when a Native workspace readback differs from defaults', async () => {
    const methods: string[] = []
    const child = fakeCodexProcess(
      (request, respond, notify) => {
        const id = Reflect.get(request, 'id')
        if (Reflect.get(request, 'method') === 'initialize') respond({ id, result: {} })
        else if (Reflect.get(request, 'method') === 'turn/start') {
          respond({ id, result: { turn: { id: 'turn-1' } } })
          notify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
          })
        }
      },
      (request, respond, notify) => {
        const id = Reflect.get(request, 'id'),
          method = Reflect.get(request, 'method')
        if (typeof method === 'string') methods.push(method)
        if (method === 'config/read') {
          respond({
            id,
            result: {
              config: {
                approval_policy: 'on-request',
                sandbox_mode: 'workspace-write',
                sandbox_workspace_write: null,
              },
            },
          })
          return true
        }
        if (method === 'thread/resume') {
          respond({
            id,
            result: {
              thread: { id: 'thread-1' },
              model: 'gpt-test',
              reasoningEffort: 'medium',
              approvalPolicy: 'on-request',
              approvalsReviewer: 'user',
              sandbox: {
                type: 'workspaceWrite',
                writableRoots: [],
                networkAccess: true,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              },
            },
          })
          return true
        }
        if (method === 'thread/settings/update') {
          // oxlint-disable-next-line vitest/no-conditional-expect -- Assertion observes the actual request boundary before an ACK is emitted.
          expect(methods).not.toContain('turn/start')
          const params = Reflect.get(request, 'params') as object
          const requested = Reflect.get(params, 'sandboxPolicy')
          // oxlint-disable-next-line vitest/no-conditional-expect -- Verify the actual permission update request before returning its native notification.
          expect(requested).toMatchObject({
            type: 'workspaceWrite',
            networkAccess: false,
            writableRoots: [],
          })
          respond({ id, result: {} })
          notify({
            method: 'thread/settings/updated',
            params: {
              threadId: 'thread-1',
              threadSettings: {
                approvalPolicy: 'on-request',
                approvalsReviewer: 'user',
                sandboxPolicy: requested,
              },
            },
          })
          return true
        }
        return false
      },
    )
    const adapter = new CodexAgentAdapter('/fake/codex', () => child)
    try {
      await collectRun(adapter, { nativeSessionId: 'thread-1', permissionMode: 'native' })
      expect(methods.filter((method) => method === 'thread/settings/update')).toHaveLength(1)
      expect(methods.filter((method) => method === 'turn/start')).toHaveLength(1)
      expect(methods.indexOf('turn/start')).toBeGreaterThan(
        methods.indexOf('thread/settings/update'),
      )
    } finally {
      await adapter.dispose()
    }
  })

  it('refuses an incomplete Native readback and a mismatching confirmation before model dispatch', async () => {
    const methods: string[] = []
    const child = fakeCodexProcess(
      (request, respond) => {
        if (Reflect.get(request, 'method') === 'initialize')
          respond({ id: Reflect.get(request, 'id'), result: {} })
      },
      (request, respond, notify) => {
        const id = Reflect.get(request, 'id'),
          method = Reflect.get(request, 'method')
        if (typeof method === 'string') methods.push(method)
        if (method === 'config/read') {
          respond({
            id,
            result: { config: { approval_policy: 'on-request', sandbox_mode: 'workspace-write' } },
          })
          return true
        }
        if (method === 'thread/resume') {
          respond({
            id,
            result: {
              thread: { id: 'thread-1' },
              model: 'gpt-test',
              reasoningEffort: 'medium',
              approvalPolicy: 'on-request',
              approvalsReviewer: 'user',
              sandbox: { type: 'workspaceWrite' },
            },
          })
          return true
        }
        if (method === 'thread/settings/update') {
          respond({ id, result: {} })
          notify({
            method: 'thread/settings/updated',
            params: {
              threadId: 'thread-1',
              threadSettings: {
                approvalPolicy: 'on-request',
                approvalsReviewer: 'user',
                sandboxPolicy: { type: 'dangerFullAccess' },
              },
            },
          })
          return true
        }
        return false
      },
    )
    const adapter = new CodexAgentAdapter('/fake/codex', () => child)
    try {
      await expect(
        collectRun(adapter, { nativeSessionId: 'thread-1', permissionMode: 'native' }),
      ).rejects.toThrow(/did not match/)
      expect(methods).not.toContain('turn/start')
      expect(methods).toContain('thread/settings/update')
    } finally {
      await adapter.dispose()
    }
  })

  it('checks and rebuilds a missing Native Session without starting a model Turn', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'pact-codex-legacy-home-'))
    nativeHomes.push(storageRoot)
    const nativePath = join(storageRoot, 'one.jsonl')
    const methods: string[] = []
    const injected: unknown[] = []
    const child = fakeCodexProcess((request, respond) => {
      const id = Reflect.get(request, 'id')
      const method = Reflect.get(request, 'method') as string
      methods.push(method)
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/read') {
        const threadId = Reflect.get(Reflect.get(request, 'params') as object, 'threadId')
        respond(
          threadId === 'missing-thread'
            ? { id, error: { code: -32_001, message: 'Unknown thread: not found' } }
            : {
                id,
                result: {
                  thread: { id: 'rebuilt-thread', path: nativePath, status: { type: 'idle' } },
                },
              },
        )
      } else if (method === 'thread/start') {
        respond({ id, result: { thread: { id: 'rebuilt-thread' } } })
      } else if (method === 'thread/inject_items') {
        injected.push(
          ...(Reflect.get(Reflect.get(request, 'params') as object, 'items') as unknown[]),
        )
        writeFileSync(
          nativePath,
          [
            { type: 'session_meta', payload: { id: 'rebuilt-thread' } },
            ...injected.map((item) => ({ type: 'response_item', payload: item })),
          ]
            .map((record) => JSON.stringify(record) + '\n')
            .join(''),
        )
        respond({ id, result: {} })
      } else if (method === 'thread/items/list') {
        respond({
          id,
          result: { data: [], nextCursor: null },
        })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => child, { storageRoot })
    try {
      await expect(
        adapter.probeNativeStatus(
          {
            sessionId: 'session-1',
            agentId: 'codex',
            requestId: 'run-1',
            runId: 'run-1',
            bindingGeneration: 1,
            nativeSessionId: 'missing-thread',
            cwd: '/project',
            model: null,
            effort: null,
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ kind: 'missing', source: 'native_error' })
      await expect(
        adapter.rebuildNativeContext(
          {
            rebuildId: 'rebuild-1',
            sessionId: 'session-1',
            cwd: '/project',
            model: null,
            effort: null,
          },
          codexRebuildSource(),
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        nativeSessionId: 'rebuilt-thread',
        initializationWitness: { kind: 'codex_rollout_v1' },
      })
      expect(methods).toContain('thread/read')
      expect(methods).toContain('thread/inject_items')
      expect(methods).not.toContain('turn/start')
      expect(injected).toHaveLength(2)
    } finally {
      await adapter.dispose()
    }
  })

  it.each(['invalid-params', 'before-dispatch', 'disconnect', 'internal-error'] as const)(
    'settles creation only when native startup is definitely absent: %s',
    async (fault) => {
      const report = vi.fn<NonNullable<AgentNativeContextRebuildInput['reportNativeWork']>>()
      const controller = new AbortController()
      const child = fakeCodexProcess((request, respond) => {
        const id = Reflect.get(request, 'id'),
          method = Reflect.get(request, 'method')
        if (method === 'initialize') respond({ id, result: {} })
        else if (method === 'thread/start') {
          if (fault === 'disconnect')
            queueMicrotask(() => {
              Object.assign(child, { exitCode: 1 })
              child.emit('exit', 1, null)
              child.emit('close', 1, null)
            })
          else
            respond({
              id,
              error: {
                code: fault === 'invalid-params' ? -32602 : -32603,
                message: 'Creation rejected',
              },
            })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', () => child)
      try {
        await expect(
          adapter.rebuildNativeContext(
            {
              rebuildId: 'refused-creation',
              sessionId: 'session-1',
              cwd: '/project',
              model: null,
              effort: null,
              reportNativeWork: report,
              onNativeCreationDispatched: async () => {
                if (fault === 'before-dispatch') controller.abort()
              },
            },
            codexRebuildSource(),
            controller.signal,
          ),
        ).rejects.toThrow(/rejected|interrupted|exited/iu)
        const absent = fault === 'invalid-params' || fault === 'before-dispatch'
        expect(report.mock.calls.map(([value]) => value.state)).toEqual(absent ? ['settled'] : [])
        // A dead transport releases memory, while the absent settled report keeps
        // persistent creation work unknown when Conversation records failure.
        expect(adapter.hasActiveBackgroundWork()).toBe(!absent && fault !== 'disconnect')
      } finally {
        await adapter.dispose()
      }
    },
  )

  it('keeps an observed Hook owned across a terminal and settles only its matching completion', async () => {
    const report = vi.fn<NonNullable<AgentRunInput['reportNativeEffects']>>()
    let notify: ((value: object) => void) | undefined
    const child = fakeCodexProcess((request, respond, send) => {
      const id = Reflect.get(request, 'id'),
        method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
      else if (method === 'turn/start') {
        notify = send
        respond({ id, result: { turn: { id: 'turn-1' } } })
        send({
          method: 'hook/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            run: { id: 'hook-1', status: 'running' },
          },
        })
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => child)
    try {
      for await (const event of adapter.run(
        {
          runId: 'run-1',
          sessionId: 'session-1',
          cwd: '/project',
          model: null,
          effort: null,
          reportNativeEffects: report,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId: 'session-1',
            message: { id: 'message-1', content: 'Hello' },
            comments: [],
          },
        },
        new AbortController().signal,
      ))
        void event
      expect(adapter.hasActiveBackgroundWork('run-1')).toBe(true)
      notify!({
        method: 'hook/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'other-turn',
          run: { id: 'hook-1', status: 'completed' },
        },
      })
      await new Promise<void>((resolve) => queueMicrotask(resolve))
      expect(adapter.hasActiveBackgroundWork('run-1')).toBe(true)
      notify!({
        method: 'hook/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          run: { id: 'hook-1', status: 'completed' },
        },
      })
      await vi.waitFor(() => expect(adapter.hasActiveBackgroundWork('run-1')).toBe(false))
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'settled' }))
    } finally {
      await adapter.dispose()
    }
  })

  it('keeps old and new Hook completions with their exact Run owners', async () => {
    const reports = [
      vi.fn<NonNullable<AgentRunInput['reportNativeEffects']>>(),
      vi.fn<NonNullable<AgentRunInput['reportNativeEffects']>>(),
    ]
    let count = 0
    let notify: ((value: object) => void) | undefined
    const child = fakeCodexProcess((request, respond, send) => {
      const id = Reflect.get(request, 'id'),
        method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
      else if (method === 'turn/start') {
        notify = send
        count += 1
        const turnId = `turn-${count}`
        respond({ id, result: { turn: { id: turnId } } })
        send({
          method: 'hook/started',
          params: {
            threadId: 'thread-1',
            turnId: count === 1 ? turnId : null,
            run: { id: `hook-${count}`, status: 'running' },
          },
        })
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } },
        })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => child)
    try {
      for (let i = 0; i < 2; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- The same Adapter must finish each foreground before starting the next Run.
        for await (const event of adapter.run(
          {
            runId: `run-${i + 1}`,
            sessionId: 'session-1',
            ...(i ? { nativeSessionId: 'thread-1' } : {}),
            cwd: '/project',
            model: null,
            effort: null,
            reportNativeEffects: reports[i]!,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: 'session-1',
              message: { id: `message-${i}`, content: 'Hello' },
              comments: [],
            },
          },
          new AbortController().signal,
        ))
          void event
      }
      notify!({
        method: 'hook/completed',
        params: { threadId: 'thread-1', turnId: null, run: { id: 'hook-2', status: 'completed' } },
      })
      await vi.waitFor(() => expect(adapter.hasActiveBackgroundWork('run-2')).toBe(false))
      expect(adapter.hasActiveBackgroundWork('run-1')).toBe(true)
      expect(reports[0]).not.toHaveBeenCalled()
      notify!({
        method: 'hook/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          run: { id: 'hook-1', status: 'completed' },
        },
      })
      await vi.waitFor(() => expect(adapter.hasActiveBackgroundWork()).toBe(false))
      expect(reports[0]).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'settled' }))
      expect(reports[1]).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'settled' }))
    } finally {
      await adapter.dispose()
    }
  })

  it('does not let an unidentified old creation consume the next creation Hook', async () => {
    const oldReport = vi.fn<NonNullable<AgentNativeContextRebuildInput['reportNativeWork']>>()
    const newReport = vi.fn<NonNullable<AgentNativeContextRebuildInput['reportNativeWork']>>()
    let starts = 0
    let notify: ((value: object) => void) | undefined
    const child = fakeCodexProcess((request, respond, send) => {
      const id = Reflect.get(request, 'id'),
        method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') {
        starts += 1
        if (starts === 1) respond({ id, error: { code: -32603, message: 'Creation unconfirmed' } })
        else {
          notify = send
          send({
            method: 'hook/started',
            params: {
              threadId: 'new-thread',
              turnId: null,
              run: { id: 'new-hook', status: 'running' },
            },
          })
          respond({ id, result: { thread: { id: 'new-thread' } } })
        }
      } else if (method === 'thread/read')
        respond({ id, result: { thread: { id: 'new-thread', status: { type: 'idle' } } } })
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => child)
    const base = { sessionId: 'session-1', cwd: '/project', model: null, effort: null }
    try {
      await expect(
        adapter.rebuildNativeContext(
          { ...base, rebuildId: 'old', reportNativeWork: oldReport },
          codexRebuildSource(),
          new AbortController().signal,
        ),
      ).rejects.toThrow('Creation unconfirmed')
      await expect(
        adapter.rebuildNativeContext(
          { ...base, rebuildId: 'new', permissionMode: 'full', reportNativeWork: newReport },
          codexRebuildSource(),
          new AbortController().signal,
        ),
      ).rejects.toThrow(/native.*permission|permission.*mode/iu)
      expect(newReport).not.toHaveBeenCalled()
      notify!({
        method: 'hook/completed',
        params: {
          threadId: 'new-thread',
          turnId: null,
          run: { id: 'new-hook', status: 'completed' },
        },
      })
      await vi.waitFor(() =>
        expect(newReport).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'settled' })),
      )
      expect(oldReport).not.toHaveBeenCalled()
      expect(adapter.hasActiveBackgroundWork('old')).toBe(true)
      expect(adapter.hasActiveBackgroundWork('new')).toBe(false)
    } finally {
      await adapter.dispose()
    }
  })

  it('routes startup MCP input to the current creator while an unidentified old creation remains unknown', async () => {
    const oldInput = vi.fn<NonNullable<AgentRunInput['requestUserInput']>>(async () => ({
      action: 'decline',
    }))
    let answer: ((value: { action: 'decline' }) => void) | undefined
    const newInput = vi.fn<NonNullable<AgentRunInput['requestUserInput']>>(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    const report = vi.fn<NonNullable<AgentNativeContextRebuildInput['reportNativeWork']>>()
    let starts = 0
    const child = fakeCodexProcess((request, respond, send) => {
      const id = Reflect.get(request, 'id'),
        method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') {
        starts += 1
        if (starts === 1) respond({ id, error: { code: -32603, message: 'Creation unconfirmed' } })
        else {
          send({
            id: 'new-input',
            method: 'mcpServer/elicitation/request',
            params: {
              threadId: 'new-thread',
              mode: 'form',
              requestedSchema: { type: 'object', properties: { choice: { type: 'string' } } },
            },
          })
          respond({ id, result: { thread: { id: 'new-thread' } } })
        }
      } else if (method === 'thread/read')
        respond({ id, result: { thread: { id: 'new-thread', status: { type: 'idle' } } } })
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => child)
    const base = { sessionId: 'session-1', cwd: '/project', model: null, effort: null }
    try {
      await expect(
        adapter.rebuildNativeContext(
          { ...base, rebuildId: 'old', requestUserInput: oldInput },
          codexRebuildSource(),
          new AbortController().signal,
        ),
      ).rejects.toThrow('Creation unconfirmed')
      await expect(
        adapter.rebuildNativeContext(
          {
            ...base,
            rebuildId: 'new',
            permissionMode: 'full',
            reportNativeWork: report,
            requestUserInput: newInput,
          },
          codexRebuildSource(),
          new AbortController().signal,
        ),
      ).rejects.toThrow(/native.*permission|permission.*mode/iu)
      expect(oldInput).not.toHaveBeenCalled()
      expect(newInput).toHaveBeenCalledOnce()
      expect(newInput.mock.calls[0]![0].nativeSessionId).toBe('new-thread')
      expect(report).not.toHaveBeenCalled()
      answer!({ action: 'decline' })
      await vi.waitFor(() =>
        expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'settled' })),
      )
      expect(adapter.hasActiveBackgroundWork('old')).toBe(true)
    } finally {
      answer?.({ action: 'decline' })
      await adapter.dispose()
    }
  })

  it('releases every owned child across 100 open/close cycles', async () => {
    let liveChildren = 0
    let highWater = 0
    for (let index = 0; index < 100; index += 1) {
      const child = fakeCodexProcess((request, respond, notify) => {
        const id = Reflect.get(request, 'id')
        const method = Reflect.get(request, 'method')
        if (method === 'initialize') respond({ id, result: {} })
        else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
        else if (method === 'turn/start') {
          respond({ id, result: { turn: { id: 'turn-1' } } })
          notify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
          })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', () => {
        liveChildren += 1
        highWater = Math.max(highWater, liveChildren)
        child.once('exit', () => {
          liveChildren -= 1
        })
        return child
      })
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each process must exit before the next cycle starts.
      await collectRun(adapter)
      // oxlint-disable-next-line eslint/no-await-in-loop -- The lifecycle boundary is an awaited child exit.
      await adapter.dispose()
      expect(adapter.diagnostics()).toMatchObject({ open: false, pendingRequests: 0 })
      expect(liveChildren).toBe(0)
    }
    expect(highWater).toBe(1)
  })

  it('waits for an idle child to exit before disposal releases its process slot', async () => {
    vi.useFakeTimers()
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id')
      const method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
      else if (method === 'turn/start') {
        respond({ id, result: { turn: { id: 'turn-1' } } })
        notify({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        })
      }
    })
    Object.assign(child, { kill: () => true })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    try {
      const completed = collectRun(adapter)
      await vi.advanceTimersByTimeAsync(0)
      await completed
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000)
      let disposed = false
      const disposal = adapter.dispose().then(() => {
        disposed = true
        return undefined
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(disposed).toBe(false)
      child.emit('exit', 0, null)
      await disposal
      expect(disposed).toBe(true)
    } finally {
      child.emit('exit', 0, null)
      await adapter.dispose()
    }
  })

  it('releases a child that already exited by signal before disposal', async () => {
    vi.useFakeTimers()
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id')
      const method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
      else if (method === 'turn/start') {
        respond({ id, result: { turn: { id: 'turn-1' } } })
        notify({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    const completed = collectRun(adapter)
    await vi.advanceTimersByTimeAsync(0)
    await completed
    Object.assign(child, { signalCode: 'SIGTERM' })
    child.emit('exit', null, 'SIGTERM')
    const disposal = adapter.dispose()
    let settled = false
    void disposal.then(() => {
      settled = true
      return undefined
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    await disposal
  })

  it('ignores earlier Turn and foreign Thread notifications before coalescing or settlement', async () => {
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id')
      const method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
      else if (method === 'turn/start') {
        respond({ id, result: { turn: { id: 'T2' } } })
        notify({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-1', turnId: 'T1', itemId: 'old', delta: 'Wrong old text' },
        })
        notify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: 'T1', status: 'failed', error: 'temporary failure' },
          },
        })
        notify({
          method: 'item/completed',
          params: {
            threadId: 'foreign',
            turnId: 'T2',
            item: { id: 'foreign', type: 'agentMessage', text: 'Wrong foreign text' },
          },
        })
        notify({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-1', turnId: 'T2', itemId: 'new', delta: 'Current text' },
        })
        notify({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'T2', status: 'completed' } },
        })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    const events = []
    try {
      for await (const event of adapter.run(
        {
          runId: 'run-2',
          sessionId: 'session-1',
          cwd: '/project',
          model: null,
          effort: null,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId: 'session-1',
            message: { id: 'message-1', content: 'Hello' },
            comments: [],
          },
        },
        new AbortController().signal,
      )) {
        events.push(event)
        if (event.type === 'turn.completed') break
      }
      expect(events.filter((event) => event.type === 'text.delta')).toEqual([
        {
          agentId: 'codex',
          type: 'text.delta',
          turnId: 'T2',
          outputId: 'run-2:assistant',
          text: 'Current text',
        },
      ])
      expect(events.at(-1)).toMatchObject({
        type: 'turn.completed',
        turnId: 'T2',
        outcome: 'completed',
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('projects a peer Proposal only after the App Server returns the loopback structured receipt', async () => {
    let peerUrl: string | undefined
    let peerServer: string | undefined
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id')
      const method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') {
        const params = Reflect.get(request, 'params') as object
        const config = Reflect.get(params, 'config') as object
        const [key, pact] = Object.entries(config).find(([name]) =>
          name.startsWith('mcp_servers.'),
        )!
        peerServer = key.slice('mcp_servers.'.length)
        peerUrl = Reflect.get(pact, 'url') as string
        respond({ id, result: { thread: { id: 'thread-1' } } })
      } else if (method === 'turn/start') {
        respond({ id, result: { turn: { id: 'turn-1' } } })
        void (async () => {
          if (!peerUrl) throw new Error('Missing Pact peer Tool URL.')
          const rpc = (await fetch(peerUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'request_peer_assistance',
                arguments: { target: 'claude', kind: 'review', reason: 'Review this answer.' },
              },
            }),
          }).then((response) => response.json())) as object
          notify({
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: {
                id: 'peer-call',
                type: 'mcpToolCall',
                server: peerServer,
                tool: 'request_peer_assistance',
                status: 'completed',
                arguments: { target: 'claude', kind: 'review', reason: 'Review this answer.' },
                result: Reflect.get(rpc, 'result'),
                error: null,
              },
            },
          })
          notify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
          })
        })()
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    const events = []
    try {
      for await (const event of adapter.run(
        {
          runId: 'run-peer',
          sessionId: 'session-1',
          peerAssistanceAllowed: true,
          cwd: '/project',
          model: null,
          effort: null,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId: 'session-1',
            message: { id: 'message-1', content: 'Review this change' },
            comments: [],
          },
        },
        new AbortController().signal,
      )) {
        events.push(event)
        if (event.type === 'turn.completed') break
      }
      expect(events.filter((event) => event.type === 'peer.assistance.requested')).toMatchObject([
        {
          agentId: 'codex',
          targetAgentId: 'claude',
          kind: 'review',
          reason: 'Review this answer.',
        },
      ])
    } finally {
      await adapter.dispose()
    }
  })

  it('publishes terminal completion without waiting for title enrichment', async () => {
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id')
      const method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') {
        respond({
          id,
          result: { thread: { id: 'thread-1' }, model: 'gpt-test', reasoningEffort: 'medium' },
        })
      } else if (method === 'turn/start') {
        respond({ id, result: { turn: { id: 'turn-1' } } })
        notify({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        })
      }
      // Deliberately leave thread/read unanswered.
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    const events: string[] = []
    const consume = (async () => {
      for await (const event of adapter.run(
        {
          runId: 'run-1',
          sessionId: 'session-1',
          cwd: '/project',
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId: 'session-1',
            message: { id: 'message-1', content: 'Hello' },
            comments: [],
          },
          model: null,
          effort: null,
        },
        new AbortController().signal,
      )) {
        events.push(event.type)
        if (event.type === 'turn.completed') return
      }
    })()

    await expect(
      Promise.race([
        consume.then(() => 'completed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
      ]),
    ).resolves.toBe('completed')
    expect(events).toContain('turn.completed')
    await adapter.dispose()
  })

  it('classifies a silent Turn acknowledgement as unknown delivery', async () => {
    vi.useFakeTimers()
    let turnDispatched = false
    const child = fakeCodexProcess((request, respond) => {
      const id = Reflect.get(request, 'id')
      const method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') {
        respond({ id, result: { thread: { id: 'thread-1' }, model: 'gpt-test' } })
      } else if (method === 'turn/start') turnDispatched = true
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    const consume = collectRun(adapter)
    const outcome = consume.catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(0)
    expect(turnDispatched).toBe(true)
    await vi.advanceTimersByTimeAsync(CODEX_TURN_ACCEPT_TIMEOUT_MS)
    expect(await outcome).toMatchObject({ kind: 'unknown_delivery' })
    expect(adapter.diagnostics().pendingRequests).toBe(0)
    await adapter.dispose()
  })

  it('retains unknown delivery without killing or duplicating its live executor', async () => {
    vi.useFakeTimers()
    let turnStarts = 0
    let children = 0
    let kills = 0
    const child = fakeCodexProcess((request, respond) => {
      const id = Reflect.get(request, 'id')
      const method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
      else if (method === 'turn/start') turnStarts += 1
    })
    Object.assign(child, {
      kill: () => {
        kills += 1
        return true
      },
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => {
      children += 1
      return child
    })
    const outcome = collectRun(adapter).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(turnStarts).toBe(1)
    await vi.advanceTimersByTimeAsync(CODEX_TURN_ACCEPT_TIMEOUT_MS)
    expect(await outcome).toMatchObject({ kind: 'unknown_delivery' })
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(adapter.hasActiveBackgroundWork()).toBe(true)
    expect(adapter.diagnostics()).toMatchObject({ open: true, pendingRequests: 0 })
    expect(kills).toBe(0)
    expect(children).toBe(1)
    expect(turnStarts).toBe(1)
    const disposal = adapter.dispose().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await disposal).toMatchObject({ message: 'Codex process did not exit after SIGKILL.' })
    await expect(adapter.dispose()).rejects.toThrow('did not exit after SIGKILL')
    Object.assign(child, { exitCode: 0 })
    child.emit('exit', 0, null)
  })

  it('does not classify accepted native work as ended because it is silent', async () => {
    vi.useFakeTimers()
    let notifyNative: ((notification: object) => void) | undefined
    let settled = false
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id'),
        method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
      else if (method === 'turn/start') {
        notifyNative = notify
        respond({ id, result: { turn: { id: 'turn-1' } } })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    const consume = collectRun(adapter).then(() => {
      settled = true
      return undefined
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(settled).toBe(false)
      expect(adapter.hasActiveBackgroundWork()).toBe(true)
      expect(adapter.diagnostics().waitingForNotification).toBe(true)
      notifyNative!({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } },
      })
      await vi.advanceTimersByTimeAsync(0)
      await consume
      expect(settled).toBe(true)
      expect(adapter.hasActiveBackgroundWork()).toBe(false)
    } finally {
      await adapter.dispose()
    }
  })

  it('a native check deadline cannot end the underlying accepted task or its owner', async () => {
    vi.useFakeTimers()
    const methods: string[] = []
    let notifyNative: ((notification: object) => void) | undefined
    let settled = false
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id'),
        method = Reflect.get(request, 'method')
      methods.push(String(method))
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
      else if (method === 'turn/start') {
        notifyNative = notify
        respond({ id, result: { turn: { id: 'turn-1' } } })
      }
      // Pure metadata check intentionally does not ACK; it cannot cancel the Turn.
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    const task = collectRun(adapter).then(() => {
      settled = true
      return undefined
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      const check = adapter.probeNativeStatus(
        {
          agentId: 'codex',
          runId: 'run-1',
          requestId: 'run-1',
          sessionId: 'session-1',
          bindingGeneration: 1,
          nativeSessionId: 'thread-1',
          nativeTurnId: 'turn-1',
          cwd: '/project',
          model: null,
          effort: null,
        },
        new AbortController().signal,
      )
      await vi.advanceTimersByTimeAsync(CODEX_THREAD_RPC_TIMEOUT_MS)
      await expect(check).resolves.toMatchObject({ kind: 'no_evidence' })
      expect(settled).toBe(false)
      expect(adapter.hasActiveBackgroundWork()).toBe(true)
      expect(methods).not.toContain('turn/interrupt')
      notifyNative!({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } },
      })
      await vi.advanceTimersByTimeAsync(0)
      await task
      expect(adapter.hasActiveBackgroundWork()).toBe(false)
    } finally {
      await adapter.dispose()
    }
  })

  it('an explicit observation cancellation leaves native work owned until matching terminal evidence', async () => {
    vi.useFakeTimers()
    let notifyNative: ((notification: object) => void) | undefined
    const reports: string[] = []
    const releases: Array<string | undefined> = []
    const evidence: string[] = []
    const controller = new AbortController()
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id'),
        method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
      else if (method === 'turn/start') {
        notifyNative = notify
        respond({ id, result: { turn: { id: 'turn-1' } } })
      } else if (method === 'turn/interrupt') respond({ id, result: {} })
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    const consume = (async () => {
      for await (const event of adapter.run(
        {
          runId: 'run-1',
          sessionId: 'session-1',
          cwd: '/project',
          model: null,
          effort: null,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId: 'session-1',
            message: { id: 'message-1', content: 'Hello' },
            comments: [],
          },
          recordNativeEvidence: (fact) => evidence.push(fact.kind),
          reportNativeEffects: (report) => {
            reports.push(report.state)
            releases.push(report.reason)
          },
        },
        controller.signal,
      ))
        void event
    })().catch((error: unknown) => error)
    try {
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(await consume).toMatchObject({ kind: 'unknown_delivery' })
      expect(adapter.hasActiveBackgroundWork()).toBe(true)
      expect(reports).toContain('unknown')
      notifyNative!({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'interrupted', error: null },
        },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(adapter.hasActiveBackgroundWork()).toBe(false)
      expect(reports.at(-1)).toBe('settled')
      expect(releases.at(-1)).toBe('native_work_drained')
      expect(evidence.at(-1)).toBe('ended')
    } finally {
      await adapter.dispose()
    }
  })

  for (const kind of ['permission', 'question'] as const) {
    it(`withdraws the foreground ${kind} on Stop while retaining its native owner until a terminal receipt`, async () => {
      vi.useFakeTimers()
      const controller = new AbortController()
      const responses: object[] = []
      const interruptions: object[] = []
      const evidence: string[] = []
      let notifyNative: ((notification: object) => void) | undefined
      let interactionSignal: AbortSignal | undefined
      const child = fakeCodexProcess((request, respond, notify) => {
        const id = Reflect.get(request, 'id'),
          method = Reflect.get(request, 'method')
        if (method === 'initialize') respond({ id, result: {} })
        else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
        else if (method === 'turn/start') {
          notifyNative = notify
          respond({ id, result: { turn: { id: 'turn-1' } } })
          notify({
            id: 'foreground-interaction',
            method:
              kind === 'permission'
                ? 'item/commandExecution/requestApproval'
                : 'item/tool/requestUserInput',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'tool-1',
              command: ['pwd'],
              cwd: '/project',
              availableDecisions: ['accept', 'cancel'],
              questions: [{ id: 'choice', question: 'Which target?', options: [{ label: 'A' }] }],
            },
          })
        } else if (method === 'turn/interrupt') {
          interruptions.push(Reflect.get(request, 'params') as object)
          respond({ id, result: {} })
        } else if (id === 'foreground-interaction') responses.push(request)
      })
      const waitForUser = <T>(signal: AbortSignal): Promise<T> => {
        interactionSignal = signal
        return new Promise<T>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Interaction withdrawn.')), {
            once: true,
          })
        })
      }
      const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
      const consume = collectRun(
        adapter,
        {
          requestPermission: (_request, signal) => waitForUser<string>(signal),
          requestUserInput: (_request, signal) => waitForUser(signal),
          recordNativeEvidence: (fact) => evidence.push(fact.kind),
        },
        controller.signal,
      ).catch((error: unknown) => error)
      try {
        await vi.advanceTimersByTimeAsync(0)
        expect(interactionSignal).toBeDefined()
        expect(interactionSignal?.aborted).toBe(false)
        controller.abort()
        await vi.advanceTimersByTimeAsync(0)
        expect(await consume).toMatchObject({ kind: 'unknown_delivery' })
        expect(interactionSignal?.aborted).toBe(true)
        expect(interruptions).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }])
        expect(responses).toHaveLength(1)
        expect(responses[0]).toMatchObject({
          id: 'foreground-interaction',
          error: { code: -32_601 },
        })
        expect(responses[0]).not.toHaveProperty('result')
        expect(adapter.hasActiveBackgroundWork('run-1')).toBe(true)
        expect(evidence).not.toContain('ended')
        notifyNative!({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(adapter.hasActiveBackgroundWork('run-1')).toBe(false)
        expect(evidence.at(-1)).toBe('ended')
      } finally {
        await adapter.dispose()
      }
    })
  }

  it('retains a live foreground approval after observation failure without cancelling or replaying its native task', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const methods: string[] = []
    const responses: object[] = []
    let notifyNative: ((notification: object) => void) | undefined
    let interactionSignal: AbortSignal | undefined
    let allow: (() => void) | undefined
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id'),
        method = Reflect.get(request, 'method')
      if (typeof method === 'string') methods.push(method)
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
      else if (method === 'turn/start') {
        notifyNative = notify
        respond({ id, result: { turn: { id: 'turn-1' } } })
        notify({
          id: 'retained-approval',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'command-1',
            command: ['pwd'],
            cwd: '/project',
            availableDecisions: ['accept', 'cancel'],
          },
        })
      } else if (id === 'retained-approval') responses.push(request)
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    const consume = collectRun(
      adapter,
      {
        requestPermission: (request, signal) => {
          interactionSignal = signal
          const action = request.actions?.find((candidate) => candidate.kind === 'allow')
          if (!action) throw new Error('Missing current-call action')
          return new Promise<string>((resolve) => {
            allow = () => resolve(action.id)
          })
        },
      },
      controller.signal,
    ).catch((error: unknown) => error)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(allow).toBeDefined()
      notifyNative!({
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          message: 'Native stream observation failed.',
        },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(await consume).toMatchObject({ kind: 'unknown_delivery' })
      expect(controller.signal.aborted).toBe(false)
      expect(interactionSignal?.aborted).toBe(false)
      expect(responses).toEqual([])
      expect(adapter.hasActiveBackgroundWork('run-1')).toBe(true)
      expect(methods.filter((method) => method === 'turn/start')).toHaveLength(1)
      expect(methods).not.toContain('turn/interrupt')
      allow!()
      await vi.advanceTimersByTimeAsync(0)
      expect(responses).toHaveLength(1)
      expect(responses[0]).toMatchObject({
        id: 'retained-approval',
        result: { decision: 'accept' },
      })
      notifyNative!({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(adapter.hasActiveBackgroundWork('run-1')).toBe(false)
    } finally {
      await adapter.dispose()
    }
  })

  it('keeps a child approval and Hook independently owned when its foreground Run is stopped', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const interruptions: object[] = []
    const responses: object[] = []
    let notifyNative: ((notification: object) => void) | undefined
    let childSignal: AbortSignal | undefined
    let allow: (() => void) | undefined
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id'),
        method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
      else if (method === 'turn/start') {
        notifyNative = notify
        respond({ id, result: { turn: { id: 'turn-1' } } })
        notify({
          method: 'hook/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            run: { id: 'hook-1', status: 'running' },
          },
        })
        notify({
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              id: 'spawn-1',
              type: 'collabAgentToolCall',
              tool: 'spawnAgent',
              senderThreadId: 'thread-1',
              receiverThreadIds: ['child-1'],
              agentsStates: { 'child-1': { status: 'running' } },
            },
          },
        })
        notify({
          method: 'turn/started',
          params: { threadId: 'child-1', turn: { id: 'child-turn-1' } },
        })
        notify({
          id: 'child-approval',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'child-1',
            turnId: 'child-turn-1',
            itemId: 'child-command',
            command: ['pwd'],
            cwd: '/project',
            availableDecisions: ['accept', 'cancel'],
          },
        })
      } else if (method === 'turn/interrupt') {
        interruptions.push(Reflect.get(request, 'params') as object)
        respond({ id, result: {} })
      } else if (id === 'child-approval') responses.push(request)
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    const consume = collectRun(
      adapter,
      {
        requestPermission: (request, signal) => {
          childSignal = signal
          const action = request.actions?.find((candidate) => candidate.kind === 'allow')
          if (!action) throw new Error('Missing current-call action')
          return new Promise<string>((resolve) => {
            allow = () => resolve(action.id)
          })
        },
      },
      controller.signal,
    ).catch((error: unknown) => error)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(allow).toBeDefined()
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(await consume).toMatchObject({ kind: 'unknown_delivery' })
      expect(childSignal?.aborted).toBe(false)
      expect(responses).toEqual([])
      expect(interruptions).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }])
      notifyNative!({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(adapter.hasActiveBackgroundWork('run-1')).toBe(true)
      expect(childSignal?.aborted).toBe(false)
      allow!()
      await vi.advanceTimersByTimeAsync(0)
      expect(responses).toHaveLength(1)
      expect(responses[0]).toMatchObject({ id: 'child-approval', result: { decision: 'accept' } })
      notifyNative!({
        method: 'turn/completed',
        params: { threadId: 'child-1', turn: { id: 'child-turn-1', status: 'completed' } },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(adapter.hasActiveBackgroundWork('run-1')).toBe(true)
      notifyNative!({
        method: 'hook/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          run: { id: 'hook-1', status: 'completed' },
        },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(adapter.hasActiveBackgroundWork('run-1')).toBe(false)
    } finally {
      await adapter.dispose()
    }
  })

  it('publishes 100 terminal facts within the 100 ms critical-path budget', async () => {
    let turnCount = 0
    let terminalSentAt = 0
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id')
      const method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') {
        respond({ id, result: { thread: { id: 'thread-1' }, model: 'gpt-test' } })
      } else if (method === 'turn/start') {
        turnCount += 1
        const turnId = `turn-${turnCount}`
        respond({ id, result: { turn: { id: turnId } } })
        terminalSentAt = performance.now()
        notify({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } },
        })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    const latencies: number[] = []

    for (let index = 0; index < 100; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- The lifecycle fixture is intentionally sequential.
      for await (const event of adapter.run(
        {
          runId: `run-${index}`,
          sessionId: 'session-1',
          ...(index > 0 ? { nativeSessionId: 'thread-1' } : {}),
          cwd: '/project',
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId: 'session-1',
            message: { id: `message-${index}`, content: 'Hello' },
            comments: [],
          },
          model: null,
          effort: null,
        },
        new AbortController().signal,
      )) {
        if (event.type === 'turn.completed') {
          latencies.push(performance.now() - terminalSentAt)
        }
      }
    }

    const p95 = latencies.toSorted((left, right) => left - right)[94] ?? Number.POSITIVE_INFINITY
    expect(latencies).toHaveLength(100)
    expect(p95).toBeLessThan(100)
    await adapter.dispose()
    expect(adapter.diagnostics()).toMatchObject({
      pendingRequests: 0,
      queuedMessages: 0,
      queuedOutboundFrames: 0,
      open: false,
    })
  })

  it('recovers a reliable completed native Turn by the original client request without sending a task', async () => {
    const methods: string[] = []
    const child = fakeCodexProcess((request, respond) => {
      const id = Reflect.get(request, 'id'),
        method = Reflect.get(request, 'method')
      methods.push(String(method))
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/read') {
        respond({ id, result: { thread: { id: 'thread-1', status: { type: 'notLoaded' } } } })
      } else if (method === 'thread/turns/list') {
        respond({
          id,
          result: {
            data: [
              {
                id: 'turn-recovered',
                status: 'completed',
                startedAt: 1,
                completedAt: 2,
                durationMs: 1,
                error: null,
              },
            ],
            nextCursor: null,
          },
        })
      } else if (method === 'thread/items/list') {
        const params = Reflect.get(request, 'params') as { cursor?: string; limit: number }
        const offset = Number(params.cursor ?? 0)
        respond({
          id,
          result: {
            data: [
              {
                turnId: 'turn-recovered',
                item: { type: 'userMessage', id: 'user-1', clientId: 'run-1', content: [] },
              },
              {
                turnId: 'turn-recovered',
                item: { type: 'agentMessage', id: 'assistant-1', text: 'Recovered response' },
              },
            ].slice(offset, offset + params.limit),
            nextCursor: offset + params.limit < 2 ? String(offset + params.limit) : null,
          },
        })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    try {
      await expect(
        adapter.probeNativeStatus(
          {
            agentId: 'codex',
            runId: 'run-1',
            requestId: 'run-1',
            sessionId: 'session-1',
            bindingGeneration: 1,
            nativeSessionId: 'thread-1',
            cwd: '/project',
            model: null,
            effort: null,
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        kind: 'ended',
        source: 'stored_terminal',
        outcome: 'completed',
        identity: { nativeTurnId: 'turn-recovered', requestId: 'run-1' },
        output: {
          outputId: 'run-1:assistant',
          text: 'Recovered response',
          completeness: 'complete',
        },
      })
      expect(methods).not.toContain('thread/resume')
      expect(methods).not.toContain('turn/start')
    } finally {
      await adapter.dispose()
    }
  })

  it('refuses oversized native status evidence without declaring the request ended', async () => {
    let child: ChildProcessWithoutNullStreams
    child = fakeCodexProcess((request, respond) => {
      const id = Reflect.get(request, 'id'),
        method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/read')
        respond({ id, result: { thread: { id: 'thread-1', status: { type: 'notLoaded' } } } })
      else if (method === 'thread/turns/list') {
        ;(child.stdout as PassThrough).write(Buffer.alloc(CODEX_MAX_FRAME_BYTES + 1, 0x61))
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    try {
      await expect(
        adapter.probeNativeStatus(
          {
            agentId: 'codex',
            runId: 'run-1',
            requestId: 'run-1',
            sessionId: 'session-1',
            bindingGeneration: 1,
            nativeSessionId: 'thread-1',
            nativeTurnId: 'turn-1',
            cwd: '/project',
            model: null,
            effort: null,
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ kind: 'no_evidence' })
      expect(adapter.diagnostics()).toMatchObject({ open: false, pendingRequests: 0 })
    } finally {
      await adapter.dispose()
    }
  })
})

describe('Codex Native display metadata', () => {
  it('keeps the metadata deadline absolute while a real native approval is waiting', async () => {
    let release: (() => void) | undefined
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id'),
        method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
      else if (method === 'turn/start') {
        respond({ id, result: { turn: { id: 'turn-1' } } })
        notify({
          id: 'waiting-approval',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'command-1',
            command: ['pwd'],
            cwd: '/project',
            availableDecisions: ['accept', 'cancel'],
          },
        })
      } else if (id === 'waiting-approval')
        notify({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        })
      // thread/read is silent while the independent permission remains pending.
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    const run = collectRun(adapter, {
      requestPermission: (request) =>
        new Promise((settle) => {
          const action = request.actions?.find((candidate) => candidate.kind === 'allow')
          if (!action) throw new Error('Missing current-call action')
          release = () => settle(action.id)
        }),
    })
    try {
      await vi.waitFor(() => expect(release).toBeDefined())
      vi.useFakeTimers()
      const name = adapter.setNativeTitle(
        {
          nativeSessionId: 'thread-1',
          cwd: '/project',
          title: '[Pact] Project · Saved',
          isCurrent: () => true,
        },
        new AbortController().signal,
      )
      await vi.advanceTimersByTimeAsync(CODEX_TITLE_TIMEOUT_MS)
      expect(await name).toBe('unavailable')
      expect(adapter.diagnostics().pendingRequests).toBe(0)
      release!()
      await run
    } finally {
      release?.()
      const disposed = adapter.dispose()
      await vi.runAllTimersAsync()
      await disposed
    }
  })

  it('never creates a process just to name an unavailable Native context', async () => {
    const create = vi.fn<() => ChildProcessWithoutNullStreams>()
    const adapter = new CodexAgentAdapter('/fake/codex', create)
    try {
      expect(
        await adapter.setNativeTitle(
          {
            nativeSessionId: 'thread-1',
            cwd: '/project',
            title: '[Pact] Project · Title',
            isCurrent: () => true,
          },
          new AbortController().signal,
        ),
      ).toBe('unavailable')
      expect(create).not.toHaveBeenCalled()
    } finally {
      await adapter.dispose()
    }
  })

  it('changes only metadata, skips an identical name, and never imports long prefixed names', async () => {
    const methods: string[] = []
    let name = 'Native first title'
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id'),
        method = String(Reflect.get(request, 'method'))
      methods.push(method)
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start')
        respond({ id, result: { thread: { id: 'thread-1', name } } })
      else if (method === 'turn/start') {
        respond({ id, result: { turn: { id: 'turn-1' } } })
        notify({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        })
      } else if (method === 'thread/read')
        respond({ id, result: { thread: { id: 'thread-1', name } } })
      else if (method === 'thread/name/set') {
        name = Reflect.get(Reflect.get(request, 'params'), 'name')
        respond({ id, result: {} })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    try {
      await collectRun(adapter)
      const signal = new AbortController().signal
      const observation = vi.fn<NonNullable<AgentRunInput['observeNativeTitle']>>()
      expect(
        await adapter.enrichTitle(
          {
            runId: 'run-1',
            sessionId: 'session-1',
            nativeSessionId: 'thread-1',
            cwd: '/project',
            observeNativeTitle: observation,
          },
          signal,
        ),
      ).toBe('Native first title')
      expect(observation).toHaveBeenLastCalledWith('thread-1', 'Native first title')
      const input = {
        nativeSessionId: 'thread-1',
        cwd: '/project',
        title: `[Pact] ${'Project'.repeat(30)} · Saved title`,
        isCurrent: () => true,
      }
      expect(await adapter.setNativeTitle(input, signal)).toBe('synchronized')
      expect(await adapter.setNativeTitle(input, signal)).toBe('synchronized')
      expect(
        await adapter.enrichTitle(
          {
            runId: 'run-1',
            sessionId: 'session-1',
            nativeSessionId: 'thread-1',
            cwd: '/project',
            observeNativeTitle: observation,
          },
          signal,
        ),
      ).toBeUndefined()
      expect(observation).toHaveBeenLastCalledWith('thread-1', undefined)
      expect(methods.filter((method) => method === 'thread/name/set')).toHaveLength(1)
      expect(methods.filter((method) => method === 'turn/start')).toHaveLength(1)
      expect(methods.filter((method) => method === 'thread/start')).toHaveLength(1)
      expect(methods).not.toContain('thread/resume')
      expect(adapter.diagnostics().pendingRequests).toBe(0)
    } finally {
      await adapter.dispose()
    }
  })

  it('keeps an unacknowledged write unknown and blocks another write in that executor', async () => {
    let names = 0
    const child = fakeCodexProcess((request, respond, notify) => {
      const id = Reflect.get(request, 'id'),
        method = Reflect.get(request, 'method')
      if (method === 'initialize') respond({ id, result: {} })
      else if (method === 'thread/start') respond({ id, result: { thread: { id: 'thread-1' } } })
      else if (method === 'turn/start') {
        respond({ id, result: { turn: { id: 'turn-1' } } })
        notify({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        })
      } else if (method === 'thread/read')
        respond({ id, result: { thread: { id: 'thread-1', name: 'Native title' } } })
      else if (method === 'thread/name/set') names += 1 // Delivered; intentionally lose its ACK.
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    try {
      await collectRun(adapter)
      vi.useFakeTimers()
      const input = {
        nativeSessionId: 'thread-1',
        cwd: '/project',
        title: '[Pact] Project · First',
        isCurrent: () => true,
      }
      const outcome = adapter.setNativeTitle(input, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(CODEX_TITLE_TIMEOUT_MS)
      expect(await outcome).toBe('unknown_delivery')
      expect(
        await adapter.setNativeTitle(
          { ...input, title: '[Pact] Project · Latest' },
          new AbortController().signal,
        ),
      ).toBe('unknown_delivery')
      expect(names).toBe(1)
      expect(adapter.diagnostics().pendingRequests).toBe(0)
    } finally {
      const disposed = adapter.dispose()
      await vi.runAllTimersAsync()
      await disposed
    }
  })
})

it('keeps injected live and history process owners in control before EOF or root signals', async () => {
  const owners: Array<{ child: ChildProcessWithoutNullStreams; close: ReturnType<typeof vi.fn> }> =
    []
  const factory = () => {
    const child = completedCapabilityActor()
    const close = vi.fn<() => Promise<void>>(async () => {
      expect(child.stdin.writableEnded).toBe(false)
      const exited = new Promise<void>((done) => child.once('exit', () => done()))
      child.kill()
      await exited
    })
    const owned = { child, close }
    owners.push(owned)
    return owned
  }
  const adapter = new CodexAgentAdapter('/owned/codex', factory, { storageRoot: '/owned/native' })
  try {
    await collectRun(adapter)
    await expect(
      adapter.prepareNativeFork(nativeLaunchForkSource(), new AbortController().signal),
    ).rejects.toThrow(/Native|native|Codex/u)
    expect(owners).toHaveLength(2)
    expect(owners[0]!.close).not.toHaveBeenCalled()
    expect(owners[1]!.close).toHaveBeenCalledOnce()
    await adapter.dispose()
    expect(owners[0]!.close).toHaveBeenCalledOnce()
    expect(owners[1]!.close).toHaveBeenCalledOnce()
  } finally {
    await adapter.dispose()
  }
})

it.each([false, true])(
  'waits for a late owned startup and preserves cleanup failure: %s',
  async (rejectClose) => {
    type Owned = { child: ChildProcessWithoutNullStreams; close: () => Promise<void> }
    let provide: ((value: Owned) => void) | undefined
    let settleClose: (() => void) | undefined
    const pending = new Promise<Owned>((done) => {
      provide = done
    })
    const closeGate = new Promise<void>((done) => {
      settleClose = done
    })
    const factory = vi.fn<() => Promise<Owned>>(() => pending)
    const child = completedCapabilityActor()
    const failure = new Error('Owned fixture physical cleanup is unconfirmed')
    let rpc = false
    child.stdin.on('data', () => {
      rpc = true
    })
    const close = vi.fn<() => Promise<void>>(async () => {
      await closeGate
      if (rejectClose) throw failure
      child.kill()
    })
    const adapter = new CodexAgentAdapter('/owned/codex', factory, { storageRoot: '/owned/native' })
    const run = collectRun(adapter).catch((error: unknown) => error)
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
    let disposed = false
    const disposal = adapter.dispose().then(
      () => {
        disposed = true
        return null
      },
      (error: unknown) => error,
    )
    try {
      provide!({ child, close })
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
      expect(disposed).toBe(false)
      expect(rpc).toBe(false)
      settleClose!()
      expect(await disposal).toBe(rejectClose ? failure : null)
      expect(disposed).toBe(!rejectClose)
      await run
      expect(rpc).toBe(false)
    } finally {
      settleClose!()
      child.kill()
      await run
      await adapter.dispose().catch(() => undefined)
    }
  },
)

it.each([false, true])(
  'reserves pending inspection and still closes its independent live owner: %s',
  async (rejectReaderClose) => {
    type Owned = { child: ChildProcessWithoutNullStreams; close: () => Promise<void> }
    const live = completedCapabilityActor(),
      reader = completedCapabilityActor()
    let provide: ((value: Owned) => void) | undefined
    let settleClose: (() => void) | undefined
    const pending = new Promise<Owned>((done) => {
      provide = done
    })
    const closeGate = new Promise<void>((done) => {
      settleClose = done
    })
    let calls = 0,
      readerRpc = false,
      liveReads = 0
    live.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').trim().split('\n'))
        if (JSON.parse(line).method === 'thread/read') liveReads++
    })
    reader.stdin.on('data', () => {
      readerRpc = true
    })
    const readerClose = vi.fn<() => Promise<void>>(async () => {
      await closeGate
      if (rejectReaderClose) throw new Error('Owned reader physical cleanup is unconfirmed')
      reader.kill()
    })
    const liveClose = vi.fn<() => Promise<void>>(async () => {
      live.kill()
    })
    const factory = (): Owned | Promise<Owned> => {
      calls++
      return calls === 1
        ? {
            child: live,
            close: liveClose,
          }
        : pending
    }
    const adapter = new CodexAgentAdapter('/owned/codex', factory, { storageRoot: '/owned/native' })
    await collectRun(adapter)
    const inspecting = adapter
      .prepareNativeFork(nativeLaunchForkSource(), new AbortController().signal)
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(calls).toBe(2))
    await expect(
      adapter.prepareNativeFork(nativeLaunchForkSource(), new AbortController().signal),
    ).rejects.toThrow('native history reader is unavailable')
    expect(calls).toBe(2)
    let disposed = false
    const beforeDisposalReads = liveReads
    const probing = rejectReaderClose
      ? Promise.resolve(undefined)
      : adapter.probeNativeStatus(
          {
            sessionId: 'session-1',
            agentId: 'codex',
            requestId: 'run-1',
            runId: 'run-1',
            nativeSessionId: 'thread-1',
            nativeTurnId: 'turn-1',
            bindingGeneration: 1,
            cwd: '/project',
            model: null,
            effort: null,
          },
          new AbortController().signal,
        )
    // The already-started probe crosses its cached-connection await before disposal.
    const disposal = Promise.resolve()
      .then(() => adapter.dispose())
      .then(
        () => {
          disposed = true
          return null
        },
        (error: unknown) => error,
      )
    try {
      provide!({ child: reader, close: readerClose })
      await vi.waitFor(() => expect(readerClose).toHaveBeenCalledOnce())
      expect(disposed).toBe(false)
      expect(readerRpc).toBe(false)
      await probing
      expect(liveReads).toBe(beforeDisposalReads)
      const beforeReads = liveReads
      if (!rejectReaderClose) {
        await adapter.probeNativeStatus(
          {
            sessionId: 'session-1',
            agentId: 'codex',
            requestId: 'run-1',
            runId: 'run-1',
            nativeSessionId: 'thread-1',
            nativeTurnId: 'turn-1',
            bindingGeneration: 1,
            cwd: '/project',
            model: null,
            effort: null,
          },
          new AbortController().signal,
        )
      }
      expect(liveReads).toBe(beforeReads)
      settleClose!()
      await inspecting
      const outcome = await disposal
      expect(outcome).toEqual(
        rejectReaderClose ? new Error('Owned reader physical cleanup is unconfirmed') : null,
      )
      expect(liveClose).toHaveBeenCalledOnce()
      expect(disposed).toBe(!rejectReaderClose)
      expect(readerRpc).toBe(false)
    } finally {
      settleClose!()
      live.kill()
      reader.kill()
      await inspecting
      await disposal
      await adapter.dispose().catch(() => undefined)
    }
  },
)

async function collectRun(
  adapter: CodexAgentAdapter,
  extra: Partial<AgentRunInput> = {},
  signal: AbortSignal = new AbortController().signal,
  observe?: (event: NormalizedAgentEvent) => void,
): Promise<void> {
  for await (const event of adapter.run(
    {
      runId: 'run-1',
      sessionId: 'session-1',
      cwd: '/project',
      promptEnvelope: {
        version: 'pact-agent-prompt-v1',
        sessionId: 'session-1',
        message: { id: 'message-1', content: 'Hello' },
        comments: [],
      },
      model: null,
      effort: null,
      ...extra,
    },
    signal,
  )) {
    // Consume until the Adapter settles.
    observe?.(event)
  }
}

function commandStopItem(id: string, processId = 'own-handle', source = 'unifiedExecStartup') {
  return {
    id,
    processId,
    source,
    type: 'commandExecution',
    command: 'identical-command',
    cwd: '/project',
    status: 'inProgress',
  }
}

function commandStopPacket(
  method: string,
  command: object,
  turnId = 'turn-1',
  threadId = 'thread-1',
) {
  return { method, params: { threadId, turnId, item: command } }
}

function foregroundCommandFixture(options: {
  mode:
    | 'late-completion'
    | 'provisional-handle'
    | 'handle-mismatch'
    | 'oversized-page'
    | 'repeated-cursor'
    | 'missing-handle'
    | 'lost-ack'
    | 'silent-list'
    | 'completed-before-stop'
}) {
  const controller = new AbortController()
  const evidence = vi.fn<NonNullable<AgentRunInput['recordNativeEvidence']>>()
  const settled = vi.fn<NonNullable<AgentRunInput['reportNativeEffects']>>()
  const events: NormalizedAgentEvent[] = []
  const methods: string[] = [],
    terminated: string[] = []
  const pages: Array<string | undefined> = [],
    listLimits: number[] = []
  let notifyNative: ((notification: object) => void) | undefined
  const item = commandStopItem,
    packet = commandStopPacket
  const complete = (id: string): void =>
    notifyNative?.(packet('item/completed', { ...item(id), status: 'completed' }))
  const child = fakeCodexProcess((request, respond, notify) => {
    const id = Reflect.get(request, 'id'),
      method = String(Reflect.get(request, 'method'))
    const params: object = Reflect.get(request, 'params') ?? {}
    methods.push(method)
    if (method === 'initialize') respond({ id, result: {} })
    else if (method === 'thread/start')
      respond({ id, result: { thread: { id: 'thread-1' }, model: 'gpt-test' } })
    else if (method === 'turn/start') {
      notifyNative = notify
      respond({ id, result: { turn: { id: 'turn-1' } } })
      notify(packet('item/started', item('old-command', 'old-handle'), 'older-turn'))
      notify(
        packet('item/started', item('child-command', 'child-handle'), 'child-turn', 'child-thread'),
      )
      notify(
        packet('item/started', item('old-interaction', 'old-handle', 'unifiedExecInteraction')),
      )
      notify(
        packet('item/completed', {
          ...item('old-interaction', 'old-handle', 'unifiedExecInteraction'),
          status: 'completed',
        }),
      )
      notify(packet('item/started', item('already-completed', 'completed-handle')))
      complete('already-completed')
      notify(
        packet(
          'item/started',
          options.mode === 'provisional-handle'
            ? { ...item('own-command'), processId: null }
            : item('own-command'),
        ),
      )
    } else if (method === 'turn/interrupt') {
      if (options.mode === 'late-completion') complete('own-command')
      complete('already-completed')
      respond({ id, result: {} })
      notify({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
      })
    } else if (method === 'thread/backgroundTerminals/list') {
      const cursor = Reflect.get(params, 'cursor')
      pages.push(typeof cursor === 'string' ? cursor : undefined)
      listLimits.push(Reflect.get(params, 'limit'))
      if (options.mode === 'silent-list') return
      const rows = [
        {
          itemId: 'old-command',
          processId: 'old-handle',
          command: 'identical-command',
          cwd: '/project',
        },
        {
          itemId: 'already-completed',
          processId: 'completed-handle',
          command: 'identical-command',
          cwd: '/project',
        },
        {
          itemId: 'own-command',
          processId: options.mode === 'handle-mismatch' ? 'wrong-handle' : 'own-handle',
          command: 'identical-command',
          cwd: '/project',
        },
      ]
      const index = typeof cursor === 'string' ? Number(cursor) : 0
      const result =
        options.mode === 'oversized-page'
          ? { data: [{ ...rows[0], command: 'x'.repeat(64 * 1024) }], nextCursor: null }
          : options.mode === 'missing-handle'
            ? { data: [], nextCursor: null }
            : {
                data: [rows[index]],
                nextCursor:
                  options.mode === 'repeated-cursor' ? '1' : index < 2 ? String(index + 1) : null,
              }
      respond({ id, result })
    } else if (method === 'thread/backgroundTerminals/terminate') {
      terminated.push(Reflect.get(params, 'processId'))
      if (options.mode === 'lost-ack') return
      respond({ id, result: { terminated: true } })
      complete('own-command')
    }
  })
  const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
  const outcome = collectRun(
    adapter,
    { recordNativeEvidence: evidence, reportNativeEffects: settled },
    controller.signal,
    (event) => events.push(event),
  ).catch((error: unknown) => error)
  return {
    adapter,
    controller,
    evidence,
    settled,
    events,
    methods,
    terminated,
    pages,
    listLimits,
    outcome,
    complete,
    ready: () =>
      vi.waitFor(() =>
        expect(
          events.some(
            (event) => event.type === 'tool.started' && event.toolCallId === 'own-command',
          ),
        ).toBe(true),
      ),
  }
}

function nativeLaunchForkSource() {
  return {
    cwd: '/project',
    nativeSessionId: 'thread-1',
    nativeTurnId: 'turn-1',
    runId: 'run-1',
    bindingGeneration: 1,
    throughSequence: 1,
    deliveryCursor: 0,
    responseHash: 'a'.repeat(64),
  }
}

function featureProcess(inventory?: string): ChildProcessWithoutNullStreams & {
  stdout: PassThrough
  stderr: PassThrough
  kill: (this: void, signal?: NodeJS.Signals | number) => boolean
} {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>((_signal) => {
      queueMicrotask(() => {
        child.exitCode = 1
        child.emit('exit', 1, 'SIGKILL')
        child.emit('close', 1, 'SIGKILL')
      })
      return true
    }),
  })
  if (inventory !== undefined)
    queueMicrotask(() => {
      child.stdout.write(inventory)
      child.exitCode = 0
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
    })
  return child as unknown as ChildProcessWithoutNullStreams & {
    stdout: PassThrough
    stderr: PassThrough
    kill: (this: void, signal?: NodeJS.Signals | number) => boolean
  }
}

function completedCapabilityActor(): ChildProcessWithoutNullStreams {
  return fakeCodexProcess((request, respond, notify) => {
    const id = Reflect.get(request, 'id'),
      method = Reflect.get(request, 'method')
    if (method === 'initialize') respond({ id, result: {} })
    else if (method === 'thread/start')
      respond({
        id,
        result: { thread: { id: 'thread-1' }, model: 'gpt-test', reasoningEffort: 'medium' },
      })
    else if (method === 'turn/start') {
      respond({ id, result: { turn: { id: 'turn-1' } } })
      notify({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      })
    } else if (method === 'thread/read') respond({ id, result: { thread: { id: 'thread-1' } } })
  })
}

function fakeCodexProcess(
  onRequest: (
    request: object,
    respond: (response: object) => void,
    notify: (notification: object) => void,
  ) => void,
  intercept?: (
    request: object,
    respond: (response: object) => void,
    notify: (notification: object) => void,
  ) => boolean,
): ChildProcessWithoutNullStreams {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(process, {
    spawnReader: () => fakeCodexProcess(onRequest),
    stdin,
    stdout,
    stderr,
    exitCode: null,
    kill: () => {
      queueMicrotask(() => process.emit('exit', 0, null))
      return true
    },
  })
  let input = ''
  stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8')
    while (input.includes('\n')) {
      const newline = input.indexOf('\n')
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      const request = JSON.parse(line) as object
      const method = Reflect.get(request, 'method')
      const params = Reflect.get(request, 'params') as object
      const id = Reflect.get(request, 'id')
      const send = (message: object): void => {
        const result = Reflect.get(message, 'result')
        const payload =
          method === 'thread/start' && result && typeof result === 'object'
            ? {
                ...message,
                result: {
                  approvalPolicy: 'on-request',
                  approvalsReviewer: 'user',
                  sandbox: { type: 'dangerFullAccess' },
                  ...result,
                },
              }
            : message
        queueMicrotask(() => stdout.write(`${JSON.stringify(payload)}\n`))
      }
      // Common fake-native contract, not production fallbacks. Per-test handlers
      // still own task dispatch, terminal notifications and history responses.
      if (intercept?.(request, send, send)) continue
      if (method === 'config/read') {
        send({
          id,
          result: {
            config: {
              approval_policy: 'on-request',
              approvals_reviewer: 'user',
              sandbox_mode: 'danger-full-access',
            },
          },
        })
      } else if (method === 'thread/resume') {
        if (Reflect.get(params, 'excludeTurns') !== true)
          throw new Error('Native resume hydrated old Turns.')
        send({
          id,
          result: {
            thread: { id: Reflect.get(params, 'threadId') },
            model: 'gpt-test',
            reasoningEffort: 'medium',
          },
        })
      } else if (method === 'thread/settings/update') {
        send({ id, result: {} })
        send({
          method: 'thread/settings/updated',
          params: {
            threadId: Reflect.get(params, 'threadId'),
            threadSettings: {
              approvalPolicy: Reflect.get(params, 'approvalPolicy'),
              approvalsReviewer: Reflect.get(params, 'approvalsReviewer'),
              sandboxPolicy: Reflect.get(params, 'sandboxPolicy'),
            },
          },
        })
      } else onRequest(request, send, send)
    }
  })
  return process
}

function forkingFactory(
  child: ChildProcessWithoutNullStreams,
): () => ChildProcessWithoutNullStreams {
  let first = true
  return () => {
    if (first) {
      first = false
      return child
    }
    return Reflect.get(child, 'spawnReader')()
  }
}

async function* codexRebuildSource() {
  yield {
    kind: 'message' as const,
    messageId: 'message-1',
    sequence: 0,
    speaker: 'user' as const,
    state: 'complete' as const,
    part: 0,
    final: true,
    content: 'Original question',
  }
  yield {
    kind: 'message' as const,
    messageId: 'message-2',
    sequence: 1,
    speaker: 'codex' as const,
    state: 'incomplete' as const,
    part: 0,
    final: true,
    content: 'Partial answer',
  }
}
