/* oxlint-disable typescript/no-unsafe-type-assertion -- Minimal fake native process exercises the real CodexAgentAdapter protocol seam. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentRunInput, AgentSteerInput } from '@pact/agent-runtime'
import type { NativeProbeResult, NormalizedAgentEvent } from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { AgentExecutionError } from '../agent-execution-error'
import { CodexAgentAdapter } from '../codex-agent-adapter'
import { FrozenSourceReader } from '../frozen-source-reader'
import { CODEX_MAX_REASONING_PREFIX_BYTES, CodexReasoningSummaryTracker } from './types'

type Send = (message: object) => void

interface FakeProcessHarness {
  readonly child: ChildProcessWithoutNullStreams
  readonly sent: Record<string, unknown>[]
  readonly sendToAdapter: Send
}

function createFakeCodexProcess(
  onRequest: (request: Record<string, unknown>, respond: Send, notify: Send) => void,
): FakeProcessHarness {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const sent: Record<string, unknown>[] = []
  const sendToAdapter: Send = (message) => {
    queueMicrotask(() => {
      if (!stdout.destroyed) stdout.write(`${JSON.stringify(message)}\n`)
    })
  }
  Object.assign(child, {
    spawnReader: () => createFakeCodexProcess(onRequest).child,
    stdin,
    stdout,
    stderr,
    exitCode: null,
    kill: () => {
      queueMicrotask(() => {
        Object.assign(child, { exitCode: 0 })
        child.emit('exit', 0, null)
        stdout.end()
        stderr.end()
        child.emit('close', 0, null)
      })
      return true
    },
  })

  let buffer = ''
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    while (buffer.includes('\n')) {
      const idx = buffer.indexOf('\n')
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.trim()) continue
      const request = JSON.parse(line) as Record<string, unknown>
      sent.push(request)
      const method = request.method
      const id = request.id
      if (method === 'initialize') {
        sendToAdapter({ id, result: {} })
      } else if (method === 'config/read') {
        sendToAdapter({
          id,
          result: {
            config: {
              approval_policy: 'on-request',
              approvals_reviewer: 'user',
              sandbox_mode: 'danger-full-access',
            },
          },
        })
      } else if (method === 'thread/settings/update') {
        const params = request.params as Record<string, unknown> | undefined
        sendToAdapter({ id, result: {} })
        sendToAdapter({
          method: 'thread/settings/updated',
          params: {
            threadId: params?.threadId,
            threadSettings: {
              approvalPolicy: params?.approvalPolicy,
              approvalsReviewer: params?.approvalsReviewer,
              sandboxPolicy: params?.sandboxPolicy,
            },
          },
        })
      } else {
        onRequest(request, sendToAdapter, sendToAdapter)
      }
    }
  })

  return { child, sent, sendToAdapter }
}

function defaultThreadStartResult(threadId: string) {
  return {
    model: 'gpt-test',
    reasoningEffort: 'medium',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    thread: { id: threadId },
  }
}

function baseRunInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  const sessionId = overrides.sessionId ?? randomUUID()
  const runId = overrides.runId ?? randomUUID()
  return {
    runId,
    sessionId,
    cwd: '/project',
    model: 'gpt-test',
    effort: 'medium',
    promptEnvelope: {
      version: 'pact-agent-prompt-v1',
      sessionId,
      message: { id: randomUUID(), content: 'Audit regression prompt' },
      comments: [],
    },
    ...overrides,
  }
}

async function flushMicrotasks(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Explicit microtask flush barrier.
    await Promise.resolve()
  }
}

const openAdapters: CodexAgentAdapter[] = []
const openDbs: PactDatabase[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(openAdapters.splice(0).map((adapter) => adapter.dispose()))
  for (const db of openDbs.splice(0)) db.close()
})

async function openTestDatabase() {
  const db = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolve(
      import.meta.dirname,
      '../../../../../../packages/persistence/drizzle',
    ),
  })
  openDbs.push(db)
  const projectId = randomUUID()
  const sessionId = randomUUID()
  const now = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Codex audit fixture',
    directoryPath: '/project',
    kind: 'directory',
    createdAt: now,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Codex audit', createdAt: now },
    {
      primaryAgentId: 'codex',
      secondaryAgentId: 'claude',
      agents: {
        codex: { model: null, effort: null },
        claude: { model: null, effort: null },
        agy: { model: null, effort: null },
      },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  return { db, repo: db.conversationRepository, sessionId }
}

describe('CodexTurnSession Astra Shard 3 audit regressions', () => {
  it('S3-F1a: delivers pre-ACK agentMessage once even when turn/completed arrives while paused at run.speed.resolved', async () => {
    const turnCompletedReady = Promise.withResolvers<void>()
    let notifyRef: Send | undefined
    const harness = createFakeCodexProcess((request, respond, notify) => {
      notifyRef = notify
      if (request.method === 'thread/start') {
        respond({ id: request.id, result: defaultThreadStartResult('th-s3-f1a') })
      } else if (request.method === 'turn/start') {
        // Pre-ACK agentMessage arrives BEFORE turn/start ACK
        notify({
          method: 'item/completed',
          params: {
            threadId: 'th-s3-f1a',
            turnId: 'turn-s3-f1a',
            item: { id: 'msg-1', type: 'agentMessage', text: 'Pre-ACK complete answer.' },
          },
        })
        respond({ id: request.id, result: { turn: { id: 'turn-s3-f1a' } } })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
    openAdapters.push(adapter)

    const evidence: NativeProbeResult[] = []
    const input = baseRunInput({
      host: {
        lifecycle: {
          recordNativeEvidence: (entry) => {
            evidence.push(entry)
          },
        },
      },
    })
    const iterator = adapter.run(input, new AbortController().signal)[Symbol.asyncIterator]()
    const events: NormalizedAgentEvent[] = []

    // Advance until run.speed.resolved and pause foreground there
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Step generator until speed resolution boundary.
      const step = await iterator.next()
      if (step.done) break
      events.push(step.value)
      if (step.value.type === 'run.speed.resolved') {
        notifyRef?.({
          method: 'turn/completed',
          params: {
            threadId: 'th-s3-f1a',
            turn: { id: 'turn-s3-f1a', status: 'completed' },
          },
        })
        turnCompletedReady.resolve()
        // Allow background listener to process turn/completed while foreground is paused
        // oxlint-disable-next-line no-await-in-loop -- Let background observer process terminal before resume.
        await flushMicrotasks(20)
        break
      }
    }
    await turnCompletedReady.promise

    // Resume foreground consumption
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Drain remaining events.
      const step = await iterator.next()
      if (step.done) break
      events.push(step.value)
    }

    const completedTexts = events.filter((event) => event.type === 'text.completed')
    expect(completedTexts).toHaveLength(1)
    expect(completedTexts[0]?.text).toBe('Pre-ACK complete answer.')
    const terminalEvidence = evidence.findLast((entry) => entry.kind === 'ended')
    expect(terminalEvidence?.kind === 'ended' && terminalEvidence.output?.text).toBe(
      'Pre-ACK complete answer.',
    )
    expect(adapter.hasActiveBackgroundWork(input.runId)).toBe(false)
  })

  it('S3-F1b: ignores pre-ACK connection-scoped skills/changed and releases observer on turn/start rejection', async () => {
    vi.useFakeTimers()
    const harness = createFakeCodexProcess((request, respond, notify) => {
      if (request.method === 'thread/start') {
        respond({ id: request.id, result: defaultThreadStartResult('th-s3-f1b') })
      } else if (request.method === 'turn/start') {
        notify({ method: 'skills/changed', params: {} })
        respond({ id: request.id, error: { code: -32_000, message: 'turn rejected' } })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
    openAdapters.push(adapter)

    const uncertain = vi.fn<(reason: string, scope?: 'unlisted' | 'recorded_files') => void>()
    const settled =
      vi.fn<
        (report: {
          runId: string
          generation: string
          state: 'pending' | 'settled' | 'unknown'
          reason?: string
        }) => void
      >()
    const input = baseRunInput({
      host: {
        effects: {
          recordUncertainEffects: uncertain,
          reportNativeEffects: settled,
        },
      },
    })

    const consume = async () => {
      for await (const event of adapter.run(input, new AbortController().signal)) {
        void event
      }
    }
    await expect(consume()).rejects.toThrow(/turn rejected/u)
    await vi.advanceTimersByTimeAsync(35_000)

    expect(adapter.hasActiveBackgroundWork(input.runId)).toBe(false)
    expect(uncertain).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: input.runId,
        state: 'settled',
        reason: 'native_turn_not_started',
      }),
    )
  })

  it('S3-F2: rejects stale pre-ACK Turn requests, unregistered child elicitation, and missing-thread completions while allowing turn-less startup elicitation', async () => {
    let notifyRef: Send | undefined
    const startupElicDone = Promise.withResolvers<void>()
    const oldTurnRejected = Promise.withResolvers<Record<string, unknown>>()
    const childElicRejected = Promise.withResolvers<Record<string, unknown>>()

    const harness = createFakeCodexProcess((request, respond, notify) => {
      notifyRef = notify
      if (request.id === 'startup-elic-1' && 'result' in request) {
        startupElicDone.resolve()
        return
      }
      if (request.id === 'stale-old-turn-req' && 'error' in request) {
        oldTurnRejected.resolve(request)
        return
      }
      if (request.id === 'child-bad-turn-elic' && 'error' in request) {
        childElicRejected.resolve(request)
        return
      }
      if (request.method === 'thread/start') {
        // Legitimate turn-less startup elicitation during thread/start MUST succeed
        notify({
          id: 'startup-elic-1',
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: 'th-s3-f2',
            serverName: 'docs-mcp',
            mode: 'url',
            elicitationId: 'elic-startup',
            url: 'https://example.invalid/startup',
            message: 'Allow startup MCP?',
          },
        })
        void startupElicDone.promise.then(() => {
          respond({ id: request.id, result: defaultThreadStartResult('th-s3-f2') })
          return undefined
        })
      } else if (request.method === 'turn/start') {
        // Stale request from older unretired turn-old BEFORE turn/start ACK
        notify({
          id: 'stale-old-turn-req',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'th-s3-f2',
            turnId: 'turn-old',
            itemId: 'cmd-old',
            command: 'rm -rf /tmp/old',
          },
        })
        // ACK confirms a DIFFERENT turn: turn-new
        respond({ id: request.id, result: { turn: { id: 'turn-new' } } })

        // Spawn a real child thread child-1 with registered child-turn-1
        notify({
          method: 'item/started',
          params: {
            threadId: 'th-s3-f2',
            turnId: 'turn-new',
            item: { id: 'spawn-1', type: 'collabAgentToolCall', tool: 'spawnAgent' },
          },
        })
        notify({
          method: 'thread/started',
          params: { thread: { id: 'child-1', parentThreadId: 'th-s3-f2' } },
        })
        notify({
          method: 'turn/started',
          params: { threadId: 'child-1', turn: { id: 'child-turn-1' } },
        })
        // Unregistered turnId elicitation on known child-1 MUST be rejected
        notify({
          id: 'child-bad-turn-elic',
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: 'child-1',
            turnId: 'foreign-child-turn',
            serverName: 'docs-mcp',
            mode: 'url',
            elicitationId: 'elic-bad-child',
            url: 'https://example.invalid/bad',
            message: 'Unregistered child turn elicitation',
          },
        })
        // turn/completed missing threadId MUST NOT end Run
        notify({
          method: 'turn/completed',
          params: { turn: { id: 'turn-new', status: 'completed' } },
        })
        // Complete child and then deliver valid root answer + valid root turn/completed
        void Promise.all([oldTurnRejected.promise, childElicRejected.promise]).then(() => {
          notify({
            method: 'turn/completed',
            params: { threadId: 'child-1', turn: { id: 'child-turn-1', status: 'completed' } },
          })
          notify({
            method: 'item/completed',
            params: {
              threadId: 'th-s3-f2',
              turnId: 'turn-new',
              item: {
                id: 'spawn-1',
                type: 'collabAgentToolCall',
                tool: 'spawnAgent',
                status: 'completed',
              },
            },
          })
          notify({
            method: 'item/completed',
            params: {
              threadId: 'th-s3-f2',
              turnId: 'turn-new',
              item: { id: 'msg-real', type: 'agentMessage', text: 'Real turn-new answer.' },
            },
          })
          notify({
            method: 'turn/completed',
            params: { threadId: 'th-s3-f2', turn: { id: 'turn-new', status: 'completed' } },
          })
          return undefined
        })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
    openAdapters.push(adapter)

    const requestPermission = vi.fn<() => Promise<string>>(async () => 'allow')
    const requestUserInput = vi.fn<() => Promise<{ action: 'accept' }>>(async () => ({
      action: 'accept' as const,
    }))
    const evidence: NativeProbeResult[] = []
    const input = baseRunInput({
      host: {
        lifecycle: { recordNativeEvidence: (entry) => evidence.push(entry) },
        interactions: { requestPermission, requestUserInput },
      },
    })

    const events: NormalizedAgentEvent[] = []
    for await (const ev of adapter.run(input, new AbortController().signal)) {
      events.push(ev)
    }

    void notifyRef
    expect(requestPermission).not.toHaveBeenCalled()
    // Only the legitimate startup elicitation called requestUserInput; child-bad-turn-elic was rejected
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(evidence.every((entry) => entry.identity.nativeTurnId !== 'turn-old')).toBe(true)
    expect(events.find((e) => e.type === 'text.completed')).toMatchObject({
      turnId: 'turn-new',
      text: 'Real turn-new answer.',
    })
    expect(events.find((e) => e.type === 'turn.completed')).toMatchObject({
      turnId: 'turn-new',
      outcome: 'completed',
    })
  })

  it.each(['resume_foreground', 'close_foreground'] as const)(
    'S3-F3a: records all 9 blocked fileChange completions in exact native order without dropping item #9 (%s)',
    async (mode) => {
      const unblockFirst = Promise.withResolvers<void>()
      let notifyRef: Send | undefined
      const harness = createFakeCodexProcess((request, respond, notify) => {
        notifyRef = notify
        if (request.method === 'thread/start') {
          respond({ id: request.id, result: defaultThreadStartResult(`th-s3-f3-${mode}`) })
        } else if (request.method === 'turn/start') {
          respond({ id: request.id, result: { turn: { id: `turn-s3-f3-${mode}` } } })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
      openAdapters.push(adapter)

      const recordedOps: string[] = []
      const terminalObserved = Promise.withResolvers<void>()
      const settled = Promise.withResolvers<{ state: string; reason?: string }>()
      const input = baseRunInput({
        host: {
          lifecycle: {
            recordNativeEvidence: (entry) => {
              if (entry.kind === 'ended') terminalObserved.resolve()
            },
          },
          effects: {
            recordFileChange: async (change) => {
              if (recordedOps.length === 0) await unblockFirst.promise
              recordedOps.push(change.operationId ?? change.path)
            },
            reportNativeEffects: (report) => {
              if (report.state !== 'pending' && report.reason !== 'native_completion_pending') {
                settled.resolve(report)
              }
            },
          },
        },
      })

      const iterator = adapter.run(input, new AbortController().signal)[Symbol.asyncIterator]()
      while (true) {
        // oxlint-disable-next-line no-await-in-loop -- Step until turn.started.
        const step = await iterator.next()
        if (step.done) break
        if (step.value.type === 'turn.started') break
      }

      // While foreground is paused, deliver 9 distinct fileChange completions AND turn/completed
      for (let i = 1; i <= 9; i += 1) {
        notifyRef?.({
          method: 'item/completed',
          params: {
            threadId: `th-s3-f3-${mode}`,
            turnId: `turn-s3-f3-${mode}`,
            item: {
              id: `fc-${i}`,
              type: 'fileChange',
              status: 'completed',
              changes: [{ path: `/project/file-${i}.ts`, kind: { type: 'update' } }],
            },
          },
        })
      }
      notifyRef?.({
        method: 'turn/completed',
        params: {
          threadId: `th-s3-f3-${mode}`,
          turn: { id: `turn-s3-f3-${mode}`, status: 'completed' },
        },
      })
      await terminalObserved.promise
      unblockFirst.resolve()

      if (mode === 'close_foreground') {
        await iterator.return?.(undefined)
      } else {
        while (true) {
          // oxlint-disable-next-line no-await-in-loop -- Drain foreground to completion.
          const step = await iterator.next()
          if (step.done) break
        }
      }

      const finalReport = await settled.promise
      expect(finalReport.state).toBe('settled')
      expect(recordedOps).toEqual([
        'fc-1:0',
        'fc-2:0',
        'fc-3:0',
        'fc-4:0',
        'fc-5:0',
        'fc-6:0',
        'fc-7:0',
        'fc-8:0',
        'fc-9:0',
      ])
    },
  )

  it('S3-F3b: fails closed on genuine fileChange queue capacity overflow (>64 pending)', async () => {
    const unblockFirst = Promise.withResolvers<void>()
    let notifyRef: Send | undefined
    const harness = createFakeCodexProcess((request, respond, notify) => {
      notifyRef = notify
      if (request.method === 'thread/start') {
        respond({ id: request.id, result: defaultThreadStartResult('th-s3-f3-overflow') })
      } else if (request.method === 'turn/start') {
        respond({ id: request.id, result: { turn: { id: 'turn-s3-f3-overflow' } } })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
    openAdapters.push(adapter)

    const uncertainCalls: Array<{ reason: string; scope?: string | undefined }> = []
    const overflowObserved = Promise.withResolvers<void>()
    const settledReports: Array<{ state: string; reason?: string }> = []
    let firstBlocked = false
    const input = baseRunInput({
      host: {
        effects: {
          recordFileChange: async () => {
            if (!firstBlocked) {
              firstBlocked = true
              await unblockFirst.promise
            }
          },
          recordUncertainEffects: (reason, scope) => {
            uncertainCalls.push({ reason, scope })
            if (scope === 'recorded_files') overflowObserved.resolve()
          },
          reportNativeEffects: (report) => {
            settledReports.push(report)
          },
        },
      },
    })

    const iterator = adapter.run(input, new AbortController().signal)[Symbol.asyncIterator]()
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Step until turn.started.
      const step = await iterator.next()
      if (step.done || step.value.type === 'turn.started') break
    }

    for (let i = 1; i <= 66; i += 1) {
      notifyRef?.({
        method: 'item/completed',
        params: {
          threadId: 'th-s3-f3-overflow',
          turnId: 'turn-s3-f3-overflow',
          item: {
            id: `fc-ov-${i}`,
            type: 'fileChange',
            status: 'completed',
            changes: [{ path: `/project/ov-${i}.ts`, kind: { type: 'update' } }],
          },
        },
      })
    }
    notifyRef?.({
      method: 'turn/completed',
      params: {
        threadId: 'th-s3-f3-overflow',
        turn: { id: 'turn-s3-f3-overflow', status: 'completed' },
      },
    })
    await overflowObserved.promise
    unblockFirst.resolve()
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Drain turn completion.
      const step = await iterator.next()
      if (step.done) break
    }
    await flushMicrotasks(20)

    expect(uncertainCalls.some((call) => call.scope === 'recorded_files')).toBe(true)
    expect(settledReports.some((report) => report.state === 'unknown')).toBe(true)
    expect(settledReports.every((report) => report.state !== 'settled')).toBe(true)
  })

  it('S3-F4: releases pre-write Stop, sends one turn/interrupt on late ACK after post-write Stop, and settles drained when terminal precedes interrupt error', async () => {
    // Part A: Pre-write Stop via canDispatch returning false -> not_sent, observer released immediately
    {
      const harness = createFakeCodexProcess((request, respond) => {
        if (request.method === 'thread/start') {
          respond({ id: request.id, result: defaultThreadStartResult('th-s3-f4a') })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
      openAdapters.push(adapter)

      let recordedSettings: unknown
      const inputA = baseRunInput({
        host: {
          recovery: {
            inputSha256: '0'.repeat(64),
            recordEffectiveSettings: (settings) => {
              recordedSettings = settings
            },
            recordConfirmedUnsent: vi.fn<() => void>(),
            expected: undefined,
          },
        },
      })
      // Run pre-write abort directly at turn/start by aborting right after session.started
      const abortPreWrite = new AbortController()
      const consumePreWrite = async () => {
        for await (const ev of adapter.run(inputA, abortPreWrite.signal)) {
          if (ev.type === 'session.started') abortPreWrite.abort()
        }
      }
      await expect(consumePreWrite()).rejects.toThrow(/interrupted/u)
      void recordedSettings
      expect(harness.sent.filter((msg) => msg.method === 'turn/start')).toHaveLength(0)
      expect(adapter.hasActiveBackgroundWork(inputA.runId)).toBe(false)
    }

    // Part B: Post-write / pre-ACK Stop -> late ACK triggers exactly ONE turn/interrupt
    {
      const turnStartSeen = Promise.withResolvers<{ id: unknown; respond: Send; notify: Send }>()
      const interruptRequests: Record<string, unknown>[] = []
      const harness = createFakeCodexProcess((request, respond, notify) => {
        if (request.method === 'thread/start') {
          respond({ id: request.id, result: defaultThreadStartResult('th-s3-f4b') })
        } else if (request.method === 'turn/start') {
          turnStartSeen.resolve({ id: request.id, respond, notify })
        } else if (request.method === 'turn/interrupt') {
          interruptRequests.push(request)
          respond({ id: request.id, result: {} })
          notify({
            method: 'turn/completed',
            params: { threadId: 'th-s3-f4b', turn: { id: 'turn-late-b', status: 'interrupted' } },
          })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
      openAdapters.push(adapter)

      const settled = Promise.withResolvers<{ state: string; reason?: string }>()
      const abortPostWrite = new AbortController()
      const inputB = baseRunInput({
        host: {
          effects: {
            reportNativeEffects: (report) => {
              if (report.state !== 'pending' && report.reason !== 'native_completion_pending') {
                settled.resolve(report)
              }
            },
          },
        },
      })
      const runPromise = (async () => {
        for await (const event of adapter.run(inputB, abortPostWrite.signal)) {
          void event
        }
      })()

      const pendingTurnStart = await turnStartSeen.promise
      abortPostWrite.abort()
      await expect(runPromise).rejects.toThrow(/confirm its final state/u)
      expect(adapter.hasActiveBackgroundWork(inputB.runId)).toBe(true)

      // Deliver late turn/start ACK AFTER foreground already aborted
      pendingTurnStart.respond({ id: pendingTurnStart.id, result: { turn: { id: 'turn-late-b' } } })
      const finalReport = await settled.promise

      expect(interruptRequests).toHaveLength(1)
      expect(interruptRequests[0]?.params).toMatchObject({
        threadId: 'th-s3-f4b',
        turnId: 'turn-late-b',
      })
      expect(finalReport.state).toBe('settled')
      expect(adapter.hasActiveBackgroundWork(inputB.runId)).toBe(false)
    }

    // Part C: Exact root terminal arrives BEFORE turn/interrupt RPC rejects -> settles native_work_drained
    {
      const harness = createFakeCodexProcess((request, respond, notify) => {
        if (request.method === 'thread/start') {
          respond({ id: request.id, result: defaultThreadStartResult('th-s3-f4c') })
        } else if (request.method === 'turn/start') {
          respond({ id: request.id, result: { turn: { id: 'turn-s3-f4c' } } })
        } else if (request.method === 'turn/interrupt') {
          // Exact root terminal arrives first, THEN turn/interrupt returns error "already finished"
          notify({
            method: 'turn/completed',
            params: { threadId: 'th-s3-f4c', turn: { id: 'turn-s3-f4c', status: 'completed' } },
          })
          queueMicrotask(() => {
            respond({ id: request.id, error: { code: -32_000, message: 'turn already finished' } })
          })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
      openAdapters.push(adapter)

      const settled = Promise.withResolvers<{ state: string; reason?: string }>()
      const abortC = new AbortController()
      const inputC = baseRunInput({
        host: {
          effects: {
            reportNativeEffects: (report) => {
              if (report.state !== 'pending' && report.reason !== 'native_completion_pending') {
                settled.resolve(report)
              }
            },
          },
        },
      })
      const runC = (async () => {
        for await (const ev of adapter.run(inputC, abortC.signal)) {
          if (ev.type === 'turn.started') abortC.abort()
        }
      })()
      await expect(runC).rejects.toThrow(/confirm its final state|interrupted/u)
      const finalReport = await settled.promise
      expect(finalReport).toMatchObject({
        runId: inputC.runId,
        state: 'settled',
        reason: 'native_work_drained',
      })
      expect(adapter.hasActiveBackgroundWork(inputC.runId)).toBe(false)
    }
  })

  it('S3-F5: retiring a real FrozenSourceReader after session.started writes zero turn/start frames and drains cleanly after startup hook completes', async () => {
    const { repo, sessionId } = await openTestDatabase()
    const started = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Frozen batch content for S3-F5.',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    })
    const batch = repo.inputBatchForRun(started.run.id)!
    const grant = randomUUID()
    let active = true
    const reader = new FrozenSourceReader(
      { runId: started.run.id, grant },
      sessionId,
      repo,
      () => active,
      () => batch.id,
      undefined,
      undefined,
      batch.id,
    )

    let notifyRef: Send | undefined
    const harness = createFakeCodexProcess((request, respond, notify) => {
      notifyRef = notify
      if (request.method === 'thread/start') {
        notify({
          method: 'hook/started',
          params: { threadId: 'th-s3-f5', run: { id: 'startup-hook-1', status: 'running' } },
        })
        respond({ id: request.id, result: defaultThreadStartResult('th-s3-f5') })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
    openAdapters.push(adapter)

    const recordConfirmedUnsent = vi.fn<() => void>()
    const input = baseRunInput({
      runId: started.run.id,
      sessionId,
      promptEnvelope: {
        version: 'pact-agent-prompt-v1',
        sessionId,
        sourceGrant: { runId: started.run.id, grant },
        message: { id: randomUUID(), content: 'Frozen batch content for S3-F5.' },
        comments: [],
        requiredInputScopeRef: {
          id: batch.id,
          sha256: '0'.repeat(64),
          bytes: 32,
          chars: 32,
        },
      },
      host: {
        workflow: { sourceReader: reader },
        recovery: {
          inputSha256: '0'.repeat(64),
          recordEffectiveSettings: vi.fn<() => void>(),
          recordConfirmedUnsent,
        },
      },
    })

    const consume = async () => {
      for await (const ev of adapter.run(input, new AbortController().signal)) {
        if (ev.type === 'session.started') {
          active = false
          reader.retire()
        }
      }
    }
    await expect(consume()).rejects.toThrow(/source|retired|current/iu)

    expect(harness.sent.filter((msg) => msg.method === 'turn/start')).toHaveLength(0)
    expect(recordConfirmedUnsent).not.toHaveBeenCalled()
    // Startup hook is still open -> background observer waits for hook completion, then releases
    expect(adapter.hasActiveBackgroundWork(started.run.id)).toBe(true)
    notifyRef?.({
      method: 'hook/completed',
      params: { threadId: 'th-s3-f5', run: { id: 'startup-hook-1', status: 'completed' } },
    })
    await flushMicrotasks(20)
    expect(adapter.hasActiveBackgroundWork(started.run.id)).toBe(false)
  })

  it('S3-F6: persists ended+outcome to SQLite immediately on root turn/completed while turn/steer reply is withheld, and ignores foreign-thread completions', async () => {
    const { repo, sessionId } = await openTestDatabase()
    const started = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Steer persistence regression',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    })

    const steerRequestSeen = Promise.withResolvers<{ id: unknown; respond: Send; notify: Send }>()
    let notifyRef: Send | undefined
    const harness = createFakeCodexProcess((request, respond, notify) => {
      notifyRef = notify
      if (request.method === 'thread/start') {
        respond({ id: request.id, result: defaultThreadStartResult('th-s3-f6') })
      } else if (request.method === 'turn/start') {
        respond({ id: request.id, result: { turn: { id: 'turn-s3-f6' } } })
      } else if (request.method === 'turn/steer') {
        steerRequestSeen.resolve({ id: request.id, respond, notify })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
    openAdapters.push(adapter)

    const consumedInputs: string[] = []
    const compactEndedPersisted = Promise.withResolvers<void>()
    const input = baseRunInput({
      runId: started.run.id,
      sessionId,
      nativeGeneration: started.run.id,
      bindingGeneration: started.run.bindingGeneration ?? 1,
      host: {
        lifecycle: {
          recordExecutor: (executorId) => repo.recordExecutor(started.run.id, executorId),
          recordDispatch: (phase, nativeSessionId, executorId) =>
            repo.recordDispatch(started.run.id, phase, nativeSessionId, executorId),
          recordNativeEvidence: (entry) => {
            repo.recordNativeEvidence(entry)
            if (entry.kind === 'ended') compactEndedPersisted.resolve()
          },
          recordInputConsumption: (inputId) => {
            consumedInputs.push(inputId)
          },
        },
      },
    })

    const iterator = adapter.run(input, new AbortController().signal)[Symbol.asyncIterator]()
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Step until turn.started.
      const step = await iterator.next()
      if (step.done || step.value.type === 'turn.started') break
    }

    const steerInputId = randomUUID()
    const steerInput: AgentSteerInput = {
      runId: started.run.id,
      inputId: steerInputId,
      nativeSessionId: 'th-s3-f6',
      nativeTurnId: 'turn-s3-f6',
      bindingGeneration: 1,
      nativeGeneration: started.run.id,
      recordDispatch: vi.fn<() => void>(),
      recordConsumption: vi.fn<() => void>(),
      promptEnvelope: {
        version: 'pact-agent-prompt-v1',
        sessionId,
        message: { id: steerInputId, content: 'Steer follow-up' },
        comments: [],
      },
    }
    const steerPromise = adapter.steer(steerInput, new AbortController().signal)
    const pendingSteer = await steerRequestSeen.promise

    // Foreign-thread turn/completed MUST NOT block on steeringDone or end Run
    notifyRef?.({
      method: 'turn/completed',
      params: { threadId: 'foreign-thread-s3-f6', turn: { id: 'turn-s3-f6', status: 'completed' } },
    })
    await flushMicrotasks(10)
    expect(repo.findRun(started.run.id)?.nativeOutcome).toBeUndefined()

    // Deliver steer userMessage consumption + final answer + exact root turn/completed BEFORE steer reply resolves
    notifyRef?.({
      method: 'item/completed',
      params: {
        threadId: 'th-s3-f6',
        turnId: 'turn-s3-f6',
        item: { id: 'steer-user-msg', type: 'userMessage', clientId: steerInputId },
      },
    })
    notifyRef?.({
      method: 'item/completed',
      params: {
        threadId: 'th-s3-f6',
        turnId: 'turn-s3-f6',
        item: { id: 'ans-1', type: 'agentMessage', text: 'Final steered answer.' },
      },
    })
    notifyRef?.({
      method: 'turn/completed',
      params: { threadId: 'th-s3-f6', turn: { id: 'turn-s3-f6', status: 'completed' } },
    })
    await compactEndedPersisted.promise

    // BEFORE releasing turn/steer reply, SQLite MUST ALREADY have persisted ended + outcome='completed'
    const persistedBeforeSteerReply = repo.findRun(started.run.id)
    expect(persistedBeforeSteerReply?.nativeOutcome).toBe('completed')

    // Now release turn/steer reply and drain remaining events
    pendingSteer.respond({ id: pendingSteer.id, result: { turnId: 'turn-s3-f6' } })
    const steerResult = await steerPromise
    expect(steerResult.status).toBe('accepted')

    const remainingEvents: NormalizedAgentEvent[] = []
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Drain foreground after steer reply.
      const step = await iterator.next()
      if (step.done) break
      remainingEvents.push(step.value)
    }

    expect(consumedInputs).toEqual([steerInputId])
    const completedTexts = remainingEvents.filter((event) => event.type === 'text.completed')
    expect(completedTexts).toHaveLength(1)
    expect(completedTexts[0]?.text).toBe('Final steered answer.')
  })

  it.each([
    {
      name: 'exact no rollout found maps to context_resume_failed',
      response: { error: { code: -32_600, message: 'no rollout found for thread th-saved' } },
      expectedKind: 'context_resume_failed',
    },
    {
      name: 'JSON-RPC Method not found (-32601) does NOT map to context_resume_failed',
      response: { error: { code: -32_601, message: 'Method not found' } },
      expectedKind: 'protocol_error',
    },
    {
      name: 'mismatched thread.id maps to protocol_error instead of context_resume_failed',
      response: { result: defaultThreadStartResult('th-other-thread') },
      expectedKind: 'protocol_error',
    },
  ] as const)(
    'S3-F7: $name with zero turn/start frames sent',
    async ({ response, expectedKind }) => {
      const harness = createFakeCodexProcess((request, respond) => {
        if (request.method === 'thread/resume') {
          respond({ id: request.id, ...response })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
      openAdapters.push(adapter)

      const input = baseRunInput({ nativeSessionId: 'th-saved' })
      let caught: unknown
      try {
        for await (const event of adapter.run(input, new AbortController().signal)) {
          void event
        }
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(AgentExecutionError)
      expect((caught as AgentExecutionError).kind).toBe(expectedKind)
      expect(harness.sent.filter((msg) => msg.method === 'turn/start')).toHaveLength(0)
    },
  )

  it('S3-Advisory: CodexReasoningSummaryTracker clears pendingPrefix on first non-empty delta and fails closed on >2 MiB prefix', () => {
    const tracker = new CodexReasoningSummaryTracker()
    const oneMiBSpaces = ' '.repeat(1024 * 1024)
    expect(tracker.pushDelta('r1', oneMiBSpaces)).toEqual({ kind: 'buffered' })
    expect(tracker.pushDelta('r1', 'Thought.')).toEqual({
      kind: 'emit',
      text: `${oneMiBSpaces}Thought.`,
    })
    // Prefix bytes were immediately freed on emission, so a new item can buffer another >1 MiB safely
    expect(tracker.pushDelta('r2', ' '.repeat(1500 * 1024))).toEqual({ kind: 'buffered' })
    const overflow = tracker.pushDelta('r2', ' '.repeat(CODEX_MAX_REASONING_PREFIX_BYTES))
    expect(overflow).toMatchObject({
      kind: 'overflow',
      error: expect.objectContaining({ kind: 'response_too_large' }),
    })
  })

  it('A-F1: preserves pre-ACK spawnAgent + child fileChange in arrival order and replays child interaction buffered before child turn/started', async () => {
    const childElicAnswered = Promise.withResolvers<void>()
    const harness = createFakeCodexProcess((request, respond, notify) => {
      if (request.id === 'child-early-elic' && 'result' in request) {
        childElicAnswered.resolve()
        return
      }
      if (request.method === 'thread/start') {
        respond({ id: request.id, result: defaultThreadStartResult('th-af1') })
      } else if (request.method === 'turn/start') {
        // Pre-ACK root spawnAgent + child thread/started + child turn/started + child fileChange
        notify({
          method: 'item/started',
          params: {
            threadId: 'th-af1',
            turnId: 'turn-af1',
            item: { id: 'sp-pre', type: 'collabAgentToolCall', tool: 'spawnAgent' },
          },
        })
        notify({
          method: 'thread/started',
          params: { thread: { id: 'child-af1', parentThreadId: 'th-af1' } },
        })
        notify({
          method: 'turn/started',
          params: { threadId: 'child-af1', turn: { id: 'child-turn-af1' } },
        })
        notify({
          method: 'item/completed',
          params: {
            threadId: 'child-af1',
            turnId: 'child-turn-af1',
            item: {
              id: 'child-fc-1',
              type: 'fileChange',
              status: 'completed',
              changes: [{ path: '/project/child-preack.ts', kind: { type: 'update' } }],
            },
          },
        })
        // Now root ACK arrives AFTER those 4 frames
        respond({ id: request.id, result: { turn: { id: 'turn-af1' } } })

        // Spawn a second child whose elicitation arrives BEFORE its child turn/started
        notify({
          method: 'thread/started',
          params: { thread: { id: 'child-af1-b', parentThreadId: 'th-af1' } },
        })
        notify({
          id: 'child-early-elic',
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: 'child-af1-b',
            turnId: 'child-turn-af1-b',
            serverName: 'docs-mcp',
            mode: 'url',
            elicitationId: 'elic-child-b',
            url: 'https://example.invalid/child-b',
            message: 'Allow child B?',
          },
        })
        // Deliver child-af1-b turn/started with NO subsequent frame until elicitation is answered
        notify({
          method: 'turn/started',
          params: { threadId: 'child-af1-b', turn: { id: 'child-turn-af1-b' } },
        })
        void childElicAnswered.promise.then(() => {
          notify({
            method: 'turn/completed',
            params: { threadId: 'child-af1', turn: { id: 'child-turn-af1', status: 'completed' } },
          })
          notify({
            method: 'turn/completed',
            params: {
              threadId: 'child-af1-b',
              turn: { id: 'child-turn-af1-b', status: 'completed' },
            },
          })
          notify({
            method: 'item/completed',
            params: {
              threadId: 'th-af1',
              turnId: 'turn-af1',
              item: {
                id: 'sp-pre',
                type: 'collabAgentToolCall',
                tool: 'spawnAgent',
                status: 'completed',
                senderThreadId: 'th-af1',
                receiverThreadIds: ['child-af1', 'child-af1-b'],
                agentsStates: {
                  'child-af1': { status: 'completed' },
                  'child-af1-b': { status: 'completed' },
                },
              },
            },
          })
          notify({
            method: 'turn/completed',
            params: { threadId: 'th-af1', turn: { id: 'turn-af1', status: 'completed' } },
          })
          return undefined
        })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
    openAdapters.push(adapter)

    const recordedOps: string[] = []
    const requestUserInput = vi.fn<() => Promise<{ action: 'accept' }>>(async () => ({
      action: 'accept' as const,
    }))
    const input = baseRunInput({
      host: {
        effects: {
          recordFileChange: async (change) => {
            recordedOps.push(change.operationId ?? change.path)
          },
        },
        interactions: { requestUserInput },
      },
    })
    for await (const event of adapter.run(input, new AbortController().signal)) {
      void event
    }
    await vi.waitFor(() => expect(adapter.hasActiveBackgroundWork(input.runId)).toBe(false))
    expect(recordedOps).toEqual(['child-af1:child-fc-1:0'])
    expect(requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('A-F2: rejects turn-scoped mcpServer/elicitation/request during thread/resume before_dispatch while allowing turn-less startup elicitation', async () => {
    const turnlessAnswered = Promise.withResolvers<void>()
    const harness = createFakeCodexProcess((request, respond, notify) => {
      if (request.id === 'startup-turnless-elic' && 'result' in request) {
        turnlessAnswered.resolve()
        return
      }
      if (request.method === 'thread/resume') {
        // Stale elicitation carrying old turnId MUST NOT reach requestUserInput during before_dispatch
        notify({
          id: 'stale-turn-elic',
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: 'th-af2',
            turnId: 'old-turn-from-prev-run',
            serverName: 'docs-mcp',
            mode: 'url',
            elicitationId: 'elic-stale',
            url: 'https://example.invalid/stale',
            message: 'Stale turn elicitation',
          },
        })
        // Legitimate turn-less startup elicitation MUST succeed
        notify({
          id: 'startup-turnless-elic',
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: 'th-af2',
            serverName: 'docs-mcp',
            mode: 'url',
            elicitationId: 'elic-valid',
            url: 'https://example.invalid/valid',
            message: 'Valid startup elicitation',
          },
        })
        void turnlessAnswered.promise.then(() => {
          respond({ id: request.id, result: defaultThreadStartResult('th-af2') })
          return undefined
        })
      } else if (request.method === 'turn/start') {
        respond({ id: request.id, result: { turn: { id: 'turn-af2' } } })
        notify({
          method: 'turn/completed',
          params: { threadId: 'th-af2', turn: { id: 'turn-af2', status: 'completed' } },
        })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
    openAdapters.push(adapter)

    const seenMessages: string[] = []
    const requestUserInput = vi.fn<(req: { message?: string }) => Promise<{ action: 'accept' }>>(
      async (req) => {
        if (typeof req.message === 'string') seenMessages.push(req.message)
        return { action: 'accept' as const }
      },
    )
    const input = baseRunInput({
      nativeSessionId: 'th-af2',
      host: { interactions: { requestUserInput } },
    })
    for await (const event of adapter.run(input, new AbortController().signal)) {
      void event
    }
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(seenMessages).toEqual(['Valid startup elicitation'])
  })

  it('A-F3 & A-F4: binds exact turnId + interrupts once via userMessage echo after post-write Stop, and settles late thread/start reply without sending turn/start', async () => {
    // Part 1 (A-F3): Post-write Stop before ACK -> userMessage echo confirms turnId, persists accepted, sends ONE turn/interrupt; late ACK sends ZERO duplicates.
    {
      const turnStartSeen = Promise.withResolvers<{ id: unknown; respond: Send; notify: Send }>()
      const interruptCalls: Record<string, unknown>[] = []
      const harness = createFakeCodexProcess((request, respond, notify) => {
        if (request.method === 'thread/start') {
          respond({ id: request.id, result: defaultThreadStartResult('th-af3') })
        } else if (request.method === 'turn/start') {
          turnStartSeen.resolve({ id: request.id, respond, notify })
        } else if (request.method === 'turn/interrupt') {
          interruptCalls.push(request)
          respond({ id: request.id, result: {} })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
      openAdapters.push(adapter)

      const dispatches: string[] = []
      const evidence: NativeProbeResult[] = []
      const abort = new AbortController()
      const input = baseRunInput({
        host: {
          lifecycle: {
            recordDispatch: (phase) => dispatches.push(phase),
            recordNativeEvidence: (entry) => evidence.push(entry),
          },
        },
      })
      const runPromise = (async () => {
        for await (const event of adapter.run(input, abort.signal)) {
          void event
        }
      })()
      const pendingTurnStart = await turnStartSeen.promise
      abort.abort()
      await expect(runPromise).rejects.toThrow(/confirm its final state/u)

      // Withhold ACK and send exact matching userMessage echo first
      pendingTurnStart.notify({
        method: 'item/completed',
        params: {
          threadId: 'th-af3',
          turnId: 'turn-af3-echo',
          item: { id: 'u1', type: 'userMessage', clientId: input.runId },
        },
      })
      await vi.waitFor(() => expect(interruptCalls).toHaveLength(1))
      expect(dispatches).toContain('accepted')
      expect(
        evidence.some((e) => e.kind === 'running' && e.identity.nativeTurnId === 'turn-af3-echo'),
      ).toBe(true)

      // Now deliver late ACK for the same turn -> must NOT trigger a second turn/interrupt!
      pendingTurnStart.respond({
        id: pendingTurnStart.id,
        result: { turn: { id: 'turn-af3-echo' } },
      })
      await flushMicrotasks(15)
      expect(interruptCalls).toHaveLength(1)

      pendingTurnStart.notify({
        method: 'turn/completed',
        params: { threadId: 'th-af3', turn: { id: 'turn-af3-echo', status: 'interrupted' } },
      })
      await vi.waitFor(() => expect(adapter.hasActiveBackgroundWork(input.runId)).toBe(false))
    }

    // Part 2 (A-F4): Post-write Stop during thread/start -> late thread/start reply replays startup hook, sends 0 turn/start, and releases once hook completes.
    {
      const threadStartSeen = Promise.withResolvers<{ id: unknown; respond: Send; notify: Send }>()
      const harness = createFakeCodexProcess((request, respond, notify) => {
        if (request.method === 'thread/start') {
          notify({
            method: 'hook/started',
            params: { threadId: 'th-af4', run: { id: 'late-hook-1', status: 'running' } },
          })
          threadStartSeen.resolve({ id: request.id, respond, notify })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
      openAdapters.push(adapter)

      const recordConfirmedUnsent = vi.fn<() => void>()
      const abort = new AbortController()
      const input = baseRunInput({
        host: {
          recovery: {
            inputSha256: '0'.repeat(64),
            recordEffectiveSettings: vi.fn<() => void>(),
            recordConfirmedUnsent,
          },
        },
      })
      const runPromise = (async () => {
        for await (const event of adapter.run(input, abort.signal)) {
          void event
        }
      })()
      const pendingThreadStart = await threadStartSeen.promise
      abort.abort()
      await expect(runPromise).rejects.toThrow(/interrupted/u)

      // Late thread/start reply arrives after foreground already exited
      pendingThreadStart.respond({
        id: pendingThreadStart.id,
        result: defaultThreadStartResult('th-af4'),
      })
      await flushMicrotasks(15)
      expect(harness.sent.filter((m) => m.method === 'turn/start')).toHaveLength(0)
      expect(recordConfirmedUnsent).not.toHaveBeenCalled()
      // Hook is still running -> observer stays active until hook completes
      expect(adapter.hasActiveBackgroundWork(input.runId)).toBe(true)
      pendingThreadStart.notify({
        method: 'hook/completed',
        params: { threadId: 'th-af4', run: { id: 'late-hook-1', status: 'completed' } },
      })
      await vi.waitFor(() => expect(adapter.hasActiveBackgroundWork(input.runId)).toBe(false))
    }
  })

  it('A-F5: hands off already-captured complete answer to recordArchivedEvent when Stop interrupts while foreground is paused on fileChange', async () => {
    const unblockFile = Promise.withResolvers<void>()
    const fileRecordingStarted = Promise.withResolvers<void>()
    const terminalObserved = Promise.withResolvers<void>()
    let notifyRef: Send | undefined
    const harness = createFakeCodexProcess((request, respond, notify) => {
      notifyRef = notify
      if (request.method === 'thread/start') {
        respond({ id: request.id, result: defaultThreadStartResult('th-af5') })
      } else if (request.method === 'turn/start') {
        respond({ id: request.id, result: { turn: { id: 'turn-af5' } } })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
    openAdapters.push(adapter)

    const archived: NormalizedAgentEvent[] = []
    const abort = new AbortController()
    const input = baseRunInput({
      host: {
        lifecycle: {
          recordNativeEvidence: (entry) => {
            if (entry.kind === 'ended') terminalObserved.resolve()
          },
        },
        effects: {
          recordFileChange: async () => {
            fileRecordingStarted.resolve()
            await unblockFile.promise
          },
          recordArchivedEvent: (event) => {
            archived.push(event)
          },
        },
      },
    })

    const foregroundEvents: NormalizedAgentEvent[] = []
    const runPromise = (async () => {
      for await (const ev of adapter.run(input, abort.signal)) {
        foregroundEvents.push(ev)
        if (ev.type === 'turn.started') {
          notifyRef?.({
            method: 'item/completed',
            params: {
              threadId: 'th-af5',
              turnId: 'turn-af5',
              item: {
                id: 'fc-block',
                type: 'fileChange',
                status: 'completed',
                changes: [{ path: '/project/a.ts', kind: { type: 'update' } }],
              },
            },
          })
          notifyRef?.({
            method: 'item/completed',
            params: {
              threadId: 'th-af5',
              turnId: 'turn-af5',
              item: { id: 'ans-af5', type: 'agentMessage', text: 'Authoritative complete answer.' },
            },
          })
          notifyRef?.({
            method: 'turn/completed',
            params: { threadId: 'th-af5', turn: { id: 'turn-af5', status: 'completed' } },
          })
        }
      }
    })()

    await fileRecordingStarted.promise
    await terminalObserved.promise
    // Abort while foreground is blocked awaiting fileChange recording BEFORE reading ans-af5 / turn/completed
    abort.abort()
    unblockFile.resolve()
    await expect(runPromise).rejects.toThrow(/confirm its final state|interrupted/u)
    await vi.waitFor(() => expect(adapter.hasActiveBackgroundWork(input.runId)).toBe(false))

    const archivedText = archived.filter((e) => e.type === 'text.completed')
    expect(archivedText).toHaveLength(1)
    expect(archivedText[0]?.text).toBe('Authoritative complete answer.')
    expect(archived.some((e) => e.type === 'turn.completed' && e.outcome === 'completed')).toBe(
      true,
    )
    expect(foregroundEvents.some((e) => e.type === 'text.completed')).toBe(false)
  })

  it.each([
    {
      name: 'Invalid params missing threadId (-32602) does NOT map to context_resume_failed',
      response: { error: { code: -32_602, message: 'missing threadId parameter' } },
      expectedKind: 'protocol_error',
    },
    {
      name: 'MCP startup session not found does NOT mark saved thread missing',
      response: {
        error: { code: -32_000, message: 'MCP server startup failed: session not found' },
      },
      expectedKind: 'agent_process_crash',
    },
    {
      name: 'Foreign thread after preposition ("thread for th-other") does NOT mark saved thread missing',
      response: {
        error: { code: -32_600, message: 'thread for th-completely-other does not exist' },
      },
      expectedKind: 'agent_process_crash',
    },
    {
      name: 'Foreign rollout after "for id" ("no rollout found for id th-other") does NOT mark saved thread missing',
      response: {
        error: { code: -32_600, message: 'no rollout found for id th-completely-other' },
      },
      expectedKind: 'agent_process_crash',
    },
    {
      name: 'Rollout missing error naming a DIFFERENT thread ID does NOT mark saved thread missing',
      response: {
        error: { code: -32_600, message: 'no rollout found for thread id th-completely-other' },
      },
      expectedKind: 'agent_process_crash',
    },
    {
      name: 'Rollout missing error naming the EXACT saved thread ID maps to context_resume_failed',
      response: { error: { code: -32_600, message: 'no rollout found for thread id th-saved' } },
      expectedKind: 'context_resume_failed',
    },
  ] as const)('A-F8: $name', async ({ response, expectedKind }) => {
    const harness = createFakeCodexProcess((request, respond) => {
      if (request.method === 'thread/resume') {
        respond({ id: request.id, ...response })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
    openAdapters.push(adapter)

    const input = baseRunInput({ nativeSessionId: 'th-saved' })
    let caught: unknown
    try {
      for await (const event of adapter.run(input, new AbortController().signal)) {
        void event
      }
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AgentExecutionError)
    expect((caught as AgentExecutionError).kind).toBe(expectedKind)
    expect(harness.sent.filter((msg) => msg.method === 'turn/start')).toHaveLength(0)
  })

  it('Carbon A-5: evicts stale pre-ACK root_turn requests even when pre-ACK spawnAgent activates spawns, and clears unbound startup_hook on thread/start error', async () => {
    // Part 1: Pre-ACK stale `turn-old` request + pre-ACK `turn-new` spawnAgent -> stale request
    // immediately receives respondError and Run settles immediately (zero 30s hang / zero unknown).
    {
      const effects: Array<{ state: string; reason?: string | undefined }> = []
      const harness = createFakeCodexProcess((request, respond, notify) => {
        if (request.method === 'thread/start') {
          respond({ id: request.id, result: defaultThreadStartResult('th-ca5') })
        } else if (request.method === 'turn/start') {
          // 1) Stale old-turn request arrives pre-ACK on primary thread.
          notify({
            id: 'stale-ca5-req',
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'th-ca5',
              turnId: 'turn-old-ca5',
              itemId: 'cmd-old',
              command: 'echo stale',
            },
          })
          // 2) Pre-ACK spawnAgent for the NEW turn activates `background.spawns`.
          notify({
            method: 'item/started',
            params: {
              threadId: 'th-ca5',
              turnId: 'turn-new-ca5',
              item: {
                id: 'spawn-ca5',
                type: 'collabAgentToolCall',
                tool: 'spawnAgent',
                status: 'inProgress',
                senderThreadId: 'th-ca5',
                receiverThreadIds: ['child-ca5'],
                agentsStates: { 'child-ca5': { status: 'running' } },
              },
            },
          })
          respond({ id: request.id, result: { turn: { id: 'turn-new-ca5' } } })
          notify({
            method: 'item/completed',
            params: {
              threadId: 'th-ca5',
              turnId: 'turn-new-ca5',
              item: {
                id: 'spawn-ca5',
                type: 'collabAgentToolCall',
                tool: 'spawnAgent',
                status: 'completed',
                senderThreadId: 'th-ca5',
                receiverThreadIds: ['child-ca5'],
                agentsStates: { 'child-ca5': { status: 'completed' } },
              },
            },
          })
          notify({
            method: 'turn/completed',
            params: { threadId: 'th-ca5', turn: { id: 'turn-new-ca5', status: 'completed' } },
          })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
      openAdapters.push(adapter)
      const input = baseRunInput({
        host: {
          effects: {
            reportNativeEffects: (r) => effects.push({ state: r.state, reason: r.reason }),
          },
        },
      })
      for await (const ev of adapter.run(input, new AbortController().signal)) {
        void ev
      }
      await vi.waitFor(() => {
        expect(harness.sent.some((m) => m.id === 'stale-ca5-req' && 'error' in m)).toBe(true)
        expect(adapter.hasActiveBackgroundWork(input.runId)).toBe(false)
      })
      expect(effects.some((e) => e.state === 'unknown')).toBe(false)
      expect(effects.at(-1)).toMatchObject({ state: 'settled' })
    }

    // Part 2: thread/start emits hook/started then returns RPC error -> releases immediately with 0 unknown!
    {
      const effects: Array<{ state: string; reason?: string | undefined }> = []
      const harness = createFakeCodexProcess((request, respond, notify) => {
        if (request.method === 'thread/start') {
          notify({
            method: 'hook/started',
            params: { threadId: 'th-ca5-fail', run: { id: 'hook-ca5-fail', status: 'running' } },
          })
          respond({ id: request.id, error: { code: -32_000, message: 'Startup failed cleanly' } })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
      openAdapters.push(adapter)
      const input = baseRunInput({
        host: {
          effects: {
            reportNativeEffects: (r) => effects.push({ state: r.state, reason: r.reason }),
          },
        },
      })
      await expect(
        (async () => {
          for await (const ev of adapter.run(input, new AbortController().signal)) void ev
        })(),
      ).rejects.toThrow(/Startup failed cleanly/u)
      await vi.waitFor(() => expect(adapter.hasActiveBackgroundWork(input.runId)).toBe(false))
      expect(effects.some((e) => e.state === 'unknown')).toBe(false)
    }
  })

  it('Carbon A-6: explicitly rejects before_dispatch non-elicitation execCommandApproval & stale turnId elicitation without leaking into notificationQueue', async () => {
    const requestPermission = vi.fn<() => Promise<string>>(async () => 'allow')
    const requestUserInput = vi.fn<
      () => Promise<{ action: 'accept'; values: Record<string, string> }>
    >(async () => ({ action: 'accept', values: {} }))
    const harness = createFakeCodexProcess((request, respond, notify) => {
      if (request.method === 'thread/resume') {
        // Inject both turn-less legacy execCommandApproval and stale-turnId elicitation BEFORE turn/start!
        notify({
          id: 'before-dispatch-exec',
          method: 'execCommandApproval',
          params: { conversationId: 'th-ca6', callId: 'c1', command: ['rm', '-rf', '/'] },
        })
        notify({
          id: 'before-dispatch-stale-elic',
          method: 'mcpServer/elicitation/request',
          params: { threadId: 'th-ca6', turnId: 'turn-old-ca6', message: 'Stale form' },
        })
        respond({ id: request.id, result: defaultThreadStartResult('th-ca6') })
      } else if (request.method === 'turn/start') {
        respond({ id: request.id, result: { turn: { id: 'turn-ca6' } } })
        notify({
          method: 'item/completed',
          params: {
            threadId: 'th-ca6',
            turnId: 'turn-ca6',
            item: { id: 'msg-ca6', type: 'agentMessage', text: 'Clean answer.' },
          },
        })
        notify({
          method: 'turn/completed',
          params: { threadId: 'th-ca6', turn: { id: 'turn-ca6', status: 'completed' } },
        })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
    openAdapters.push(adapter)
    const input = baseRunInput({
      nativeSessionId: 'th-ca6',
      host: {
        interactions: {
          requestPermission,
          requestUserInput,
        },
      },
    })
    for await (const ev of adapter.run(input, new AbortController().signal)) void ev
    expect(requestPermission).not.toHaveBeenCalled()
    expect(requestUserInput).not.toHaveBeenCalled()
    expect(harness.sent.some((m) => m.id === 'before-dispatch-exec' && 'error' in m)).toBe(true)
    expect(harness.sent.some((m) => m.id === 'before-dispatch-stale-elic' && 'error' in m)).toBe(
      true,
    )
  })

  it('Carbon A-7: archived terminal snapshot replaces streaming prefix in SQLite, and error(willRetry:false) after rootTerminal preserves exact error kind', async () => {
    // Part 1: Real SQLite — streaming prefix `M1` (`state='streaming'`) is replaced by archived complete snapshot `M2`!
    {
      const { repo, sessionId } = await openTestDatabase()
      const started = repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Streaming prefix + archived snapshot replacement',
        expectedCommentsRevision: 0,
        commentIds: [],
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
      })
      const unblockFile = Promise.withResolvers<void>()
      const fileStarted = Promise.withResolvers<void>()
      const terminalObserved = Promise.withResolvers<void>()
      let notifyRef: Send | undefined
      const harness = createFakeCodexProcess((request, respond, notify) => {
        notifyRef = notify
        if (request.method === 'thread/start') {
          respond({ id: request.id, result: defaultThreadStartResult('th-ca7') })
        } else if (request.method === 'turn/start') {
          respond({ id: request.id, result: { turn: { id: 'turn-ca7' } } })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
      openAdapters.push(adapter)
      const abort = new AbortController()
      const input = baseRunInput({
        runId: started.run.id,
        sessionId,
        nativeGeneration: started.run.id,
        bindingGeneration: started.run.bindingGeneration ?? 1,
        host: {
          lifecycle: {
            recordExecutor: (ex) => repo.recordExecutor(started.run.id, ex),
            recordDispatch: (p, sid, ex) => repo.recordDispatch(started.run.id, p, sid, ex),
            recordNativeEvidence: (entry) => {
              repo.recordNativeEvidence(entry)
              if (entry.kind === 'ended') terminalObserved.resolve()
            },
          },
          effects: {
            recordFileChange: async () => {
              fileStarted.resolve()
              await unblockFile.promise
            },
            recordArchivedEvent: (ev) => {
              repo.applyArchivedEvent(sessionId, started.run.id, ev)
            },
          },
        },
      })
      const runPromise = (async () => {
        for await (const ev of adapter.run(input, abort.signal)) {
          repo.applyEvent(sessionId, started.run.id, ev)
          if (ev.type === 'turn.started') {
            notifyRef?.({
              method: 'item/agentMessage/delta',
              params: {
                threadId: 'th-ca7',
                turnId: 'turn-ca7',
                itemId: 'ans-ca7',
                delta: 'Prefix ',
              },
            })
            notifyRef?.({
              method: 'item/completed',
              params: {
                threadId: 'th-ca7',
                turnId: 'turn-ca7',
                item: {
                  id: 'fc-ca7',
                  type: 'fileChange',
                  status: 'completed',
                  changes: [{ path: '/project/a.ts', kind: { type: 'update' } }],
                },
              },
            })
            notifyRef?.({
              method: 'item/completed',
              params: {
                threadId: 'th-ca7',
                turnId: 'turn-ca7',
                item: {
                  id: 'ans-ca7',
                  type: 'agentMessage',
                  text: 'Prefix and full final answer.',
                },
              },
            })
            notifyRef?.({
              method: 'turn/completed',
              params: { threadId: 'th-ca7', turn: { id: 'turn-ca7', status: 'completed' } },
            })
          }
        }
      })()
      await fileStarted.promise
      await terminalObserved.promise
      abort.abort()
      unblockFile.resolve()
      await expect(runPromise).rejects.toThrow(/interrupted/u)
      const page = repo.readPage({ scope: 'messages', sessionId })
      expect(page.scope).toBe('messages')
      if (page.scope !== 'messages') throw new Error('expected messages page')
      const visibleAssistant = page.messages.filter((entry) => entry.message.role === 'assistant')
      expect(visibleAssistant).toHaveLength(1)
      expect(visibleAssistant[0]?.kind).toBe('complete')
      expect(visibleAssistant[0]?.message.state).toBe('complete')
      expect(
        visibleAssistant[0]?.kind === 'complete' ? visibleAssistant[0].message.content : undefined,
      ).toBe('Prefix and full final answer.')
    }

    // Part 2: `error(willRetry:false)` + `turn/completed(failed)` arriving together preserves exact error kind (NOT unknown_delivery)!
    {
      const terminalObserved = Promise.withResolvers<void>()
      const harness = createFakeCodexProcess((request, respond) => {
        if (request.method === 'thread/start') {
          respond({ id: request.id, result: defaultThreadStartResult('th-ca7-err') })
        } else if (request.method === 'turn/start') {
          respond({ id: request.id, result: { turn: { id: 'turn-ca7-err' } } })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
      openAdapters.push(adapter)
      let caught: unknown
      try {
        for await (const ev of adapter.run(
          baseRunInput({
            host: {
              lifecycle: {
                recordNativeEvidence: (entry) => {
                  if (entry.kind === 'ended' && entry.outcome === 'failed') {
                    terminalObserved.resolve()
                  }
                },
              },
            },
          }),
          new AbortController().signal,
        )) {
          if (ev.type === 'turn.started') {
            ;(harness.child.stdout as PassThrough).write(
              `${JSON.stringify({
                method: 'error',
                params: {
                  threadId: 'th-ca7-err',
                  turnId: 'turn-ca7-err',
                  willRetry: false,
                  error: { message: 'Upstream gateway 503', codexErrorInfo: 'other' },
                },
              })}\n${JSON.stringify({
                method: 'turn/completed',
                params: {
                  threadId: 'th-ca7-err',
                  turn: { id: 'turn-ca7-err', status: 'failed' },
                },
              })}\n`,
            )
            await terminalObserved.promise
          }
        }
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(AgentExecutionError)
      expect((caught as AgentExecutionError).kind).toBe('transient_transport')
      expect((caught as AgentExecutionError).message).toContain('Upstream gateway 503')
    }
  })

  it('Carbon R2-A2: thread/resume filters foreign-thread server requests before response without poisoning provisionalThreadId', async () => {
    let userInputCalls = 0
    let permissionCalls = 0
    const harness = createFakeCodexProcess((request, respond, notify) => {
      if (request.method === 'thread/resume') {
        // Before thread/resume responds, foreign-thread turn-less elicitation & execCommandApproval arrive!
        notify({
          id: 'foreign-elic-r2a2',
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: 'th-foreign-r2a2',
            mode: 'form',
            message: 'Foreign thread prompt',
            requestedSchema: {
              type: 'object',
              properties: { key: { type: 'string' } },
            },
          },
        })
        notify({
          id: 'foreign-exec-r2a2',
          method: 'execCommandApproval',
          params: {
            conversationId: 'th-foreign-r2a2',
            command: ['echo', 'foreign'],
          },
        })
        respond({ id: request.id, result: defaultThreadStartResult('th-saved-r2a2') })
      } else if (request.method === 'turn/start') {
        respond({ id: request.id, result: { turn: { id: 'turn-r2a2' } } })
        notify({
          method: 'item/completed',
          params: {
            threadId: 'th-saved-r2a2',
            turnId: 'turn-r2a2',
            item: { id: 'ans-r2a2', type: 'agentMessage', text: 'Resumed cleanly' },
          },
        })
        notify({
          method: 'turn/completed',
          params: {
            threadId: 'th-saved-r2a2',
            turn: { id: 'turn-r2a2', status: 'completed' },
          },
        })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', () => harness.child)
    openAdapters.push(adapter)
    const events: NormalizedAgentEvent[] = []
    for await (const ev of adapter.run(
      baseRunInput({
        nativeSessionId: 'th-saved-r2a2',
        host: {
          interactions: {
            requestUserInput: async () => {
              userInputCalls += 1
              return { action: 'accept', values: { key: 'nope' } }
            },
            requestPermission: async () => {
              permissionCalls += 1
              return 'accept'
            },
          },
        },
      }),
      new AbortController().signal,
    )) {
      events.push(ev)
    }
    expect(userInputCalls).toBe(0)
    expect(permissionCalls).toBe(0)
    // This resuming TurnSession must NOT have claimed/answered or polluted provisionalThreadId with th-foreign-r2a2!
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text.completed', text: 'Resumed cleanly' }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'turn.completed', outcome: 'completed' }),
    )
  })
})
