/* oxlint-disable typescript/no-unsafe-type-assertion, no-await-in-loop -- Protocol test harness drives stdio JSON-RPC frames and sequential async generator steps directly. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentRunInput } from '@pact/agent-runtime'
import type {
  NativeBackgroundReport,
  NativeProbeResult,
  NormalizedAgentEvent,
} from '@pact/contracts'

import { AgyAcpConnectionPool } from '../agy-acp-connection.js'
import { AgyAgentAdapter } from '../agy-agent-adapter.js'
import { AGY_MAX_PENDING_EVENTS, AGY_MAX_PRE_PROMPT_REPLAY_TOOL_IDS } from './types.js'

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface AcpHarness {
  child: ChildProcessWithoutNullStreams
  requests: Array<Record<string, unknown>>
  responses: Array<Record<string, unknown>>
  sendToClient(frame: object): void
  closeStdout(): void
  onClientFrame(handler: (frame: Record<string, unknown>) => void | Promise<void>): void
}

function createAcpHarness(): AcpHarness {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const requests: Array<Record<string, unknown>> = []
  const responses: Array<Record<string, unknown>> = []
  let remainder = ''
  let exitCode: number | null = null
  let signalCode: NodeJS.Signals | null = null
  let handler: ((frame: Record<string, unknown>) => void | Promise<void>) | undefined

  const stdin = new Writable({
    write(chunk: Buffer, _enc, cb) {
      remainder += chunk.toString('utf8')
      let nl = remainder.indexOf('\n')
      while (nl !== -1) {
        const line = remainder.slice(0, nl).trim()
        remainder = remainder.slice(nl + 1)
        if (line) {
          const frame = JSON.parse(line) as Record<string, unknown>
          if (typeof frame.method === 'string' && 'id' in frame) {
            requests.push(frame)
          } else if (typeof frame.method !== 'string') {
            responses.push(frame)
          }
          void handler?.(frame)
        }
        nl = remainder.indexOf('\n')
      }
      cb()
    },
  })

  const childRecord = Object.assign(emitter, {
    pid: 55_100,
    stdout,
    stderr,
    stdin,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(sig: NodeJS.Signals = 'SIGTERM') {
      if (exitCode !== null || signalCode !== null) return true
      signalCode = sig
      exitCode = 0
      childRecord.signalCode = sig
      childRecord.exitCode = 0
      stdout.end()
      emitter.emit('exit', 0, sig)
      emitter.emit('close', 0, sig)
      return true
    },
  })

  return {
    child: childRecord as unknown as ChildProcessWithoutNullStreams,
    requests,
    responses,
    sendToClient(frame: object) {
      stdout.write(`${JSON.stringify(frame)}\n`)
    },
    closeStdout() {
      childRecord.exitCode = 0
      stdout.end()
      emitter.emit('exit', 0, null)
      emitter.emit('close', 0, null)
    },
    onClientFrame(fn) {
      handler = fn
    },
  }
}

async function createEnv(): Promise<{ cwd: string; appDataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pact-agy-audit-'))
  tempDirs.push(root)
  const cwd = join(root, 'workspace')
  const appDataDir = join(root, 'antigravity-cli')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(appDataDir, 'brain'), { recursive: true })
  return { cwd, appDataDir }
}

function makeRunInput(cwd: string, overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  const sessionId = overrides.sessionId ?? randomUUID()
  const runId = overrides.runId ?? randomUUID()
  return {
    sessionId,
    runId,
    cwd,
    model: 'gemini-4-carbon',
    effort: 'high',
    bindingGeneration: 1,
    nativeGeneration: runId,
    promptEnvelope: {
      version: 'pact-agent-prompt-v1',
      sessionId,
      message: { id: randomUUID(), content: 'Audit regression prompt' },
      comments: [],
    },
    ...overrides,
  }
}

function defaultConfigOptions() {
  return [
    { id: 'model', currentValue: 'gemini-4-carbon' },
    { id: 'thought_level', currentValue: 'high' },
  ]
}

async function collectEvents(stream: AsyncIterable<NormalizedAgentEvent>) {
  const out: NormalizedAgentEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

describe('Astra Shard 2 Antigravity regressions (S2-F1..S2-F9)', () => {
  it('S2-F1 & S2-F7: disposes paused iterator cleanly on shared pool and drains root reply after early consumer exit with active daemon', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    let promptCount = 0
    let pendingPrompt2Id: unknown
    const sessionA = randomUUID()
    const sessionB = randomUUID()
    const sessionC = randomUUID()
    const createdSessions = [sessionA, sessionB, sessionC]
    let newIdx = 0

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        const sid = createdSessions[newIdx++] ?? randomUUID()
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { sessionId: sid, configOptions: defaultConfigOptions() },
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { configOptions: defaultConfigOptions() },
        })
      } else if (frame.method === 'session/prompt') {
        promptCount += 1
        const sid = (frame.params as { sessionId: string }).sessionId
        if (promptCount === 1) {
          // S2-F1: end_turn verified with text; consumer will pause at text.completed and dispose().
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Complete reply before dispose.' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-a' },
          })
        } else if (promptCount === 2) {
          // S2-F1 sibling adapter keeps working on same shared pool.
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Sibling answer.' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-b' },
          })
        } else {
          // S2-F7: daemon launches, consumer throws (.return()) BEFORE root reply arrives!
          pendingPrompt2Id = frame.id
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-s2f7',
                name: 'run_command',
                args: { IsDaemon: true, CommandLine: 'npm run dev' },
                status: 'completed',
                rawOutput: { taskId: 'bg-s2f7' },
              },
            },
          })
        }
      }
    })

    const sharedPool = new AgyAcpConnectionPool({
      executablePath: 'agy',
      processFactory: () => harness.child,
    })
    const adapterA = new AgyAgentAdapter({ appDataDir, connectionPool: sharedPool })
    const adapterB = new AgyAgentAdapter({ appDataDir, connectionPool: sharedPool })

    try {
      // Part 1 (S2-F1): pause at text.completed and directly dispose adapterA without resuming.
      const evidenceA: NativeProbeResult[] = []
      const streamA = adapterA.run(
        makeRunInput(cwd, {
          host: {
            lifecycle: { recordNativeEvidence: (ev) => evidenceA.push(ev) },
          },
        }),
        new AbortController().signal,
      )
      const iterA = streamA[Symbol.asyncIterator]()
      while (true) {
        const step = await iterA.next()
        if (step.done) break
        if (step.value.type === 'text.completed') break
      }
      await adapterA.dispose()
      expect(evidenceA).toContainEqual(
        expect.objectContaining({
          kind: 'ended',
          source: 'live_terminal',
          outcome: 'completed',
        }),
      )
      expect(sharedPool.activeLeaseCount).toBe(0)

      // Sibling adapterB continues working normally on the shared pool.
      const eventsB = await collectEvents(
        adapterB.run(makeRunInput(cwd), new AbortController().signal),
      )
      expect(eventsB).toContainEqual(
        expect.objectContaining({ type: 'text.completed', text: 'Sibling answer.' }),
      )

      // Part 2 (S2-F7): consumer calls .return() after daemon starts and BEFORE root reply.
      const evidenceC: NativeProbeResult[] = []
      const effectsC: Array<{ state: string; reason?: string }> = []
      const runCId = randomUUID()
      const streamC = adapterB.run(
        makeRunInput(cwd, {
          runId: runCId,
          host: {
            lifecycle: { recordNativeEvidence: (ev) => evidenceC.push(ev) },
            effects: { reportNativeEffects: (r) => effectsC.push(r) },
          },
        }),
        new AbortController().signal,
      )
      const iterC = streamC[Symbol.asyncIterator]()
      while (true) {
        const step = await iterC.next()
        if (step.done) break
        if (step.value.type === 'tool.completed') {
          await iterC.return?.()
          break
        }
      }
      // Now deliver late root reply followed by background task completion.
      harness.sendToClient({
        jsonrpc: '2.0',
        id: pendingPrompt2Id,
        result: { stopReason: 'end_turn', execution_id: 'exec-c' },
      })
      await vi.waitFor(() => {
        expect(evidenceC).toContainEqual(
          expect.objectContaining({ kind: 'ended', outcome: 'completed' }),
        )
      })
      expect(adapterB.hasActiveBackgroundWork(runCId)).toBe(true)
      harness.sendToClient({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sessionC,
          update: {
            sessionUpdate: 'background_task_completed',
            taskId: 'bg-s2f7',
          },
        },
      })
      await vi.waitFor(() => {
        expect(adapterB.hasActiveBackgroundWork(runCId)).toBe(false)
      })
      expect(effectsC.at(-1)).toMatchObject({ state: 'settled', reason: 'native_work_drained' })
      expect(sharedPool.activeLeaseCount).toBe(0)
    } finally {
      await adapterB.dispose()
      await sharedPool.dispose()
    }
  })

  it('S2-F2 & S2-F3: closes Steer lease immediately on wire RPC resolution at soft cap and revokes pending permission & elicitation proven foreign', async () => {
    const { cwd, appDataDir } = await createEnv()

    // Part 1 (S2-F2): flood pendingEvents to soft cap while consumer is paused, resolve root reply on wire,
    // and assert steer() is immediately rejected with only 1 session/prompt written.
    const harness1 = createAcpHarness()
    const sid1 = randomUUID()
    let prompt1Id: unknown
    harness1.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness1.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        harness1.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { sessionId: sid1, configOptions: defaultConfigOptions() },
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
        harness1.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { configOptions: defaultConfigOptions() },
        })
      } else if (frame.method === 'session/prompt') {
        prompt1Id = frame.id
        // Fill pendingEvents beyond soft cap while consumer hasn't pulled.
        for (let i = 0; i < AGY_MAX_PENDING_EVENTS + 10; i += 1) {
          harness1.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid1,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `c${i}` },
              },
            },
          })
        }
        // Resolve root prompt RPC on wire while pump is paused at soft cap.
        harness1.sendToClient({
          jsonrpc: '2.0',
          id: prompt1Id,
          result: { stopReason: 'end_turn', execution_id: 'exec-softcap' },
        })
      }
    })
    const adapter1 = new AgyAgentAdapter({ appDataDir, processFactory: () => harness1.child })
    try {
      const run1Id = randomUUID()
      const sessionId = randomUUID()
      const stream1 = adapter1.run(
        makeRunInput(cwd, { runId: run1Id, sessionId }),
        new AbortController().signal,
      )
      const iter1 = stream1[Symbol.asyncIterator]()
      // Pull until turn.started so turnAccepted is true, then pause consumer so pump hits soft cap.
      while (true) {
        const step = await iter1.next()
        if (step.done || step.value.type === 'turn.started') break
      }
      await new Promise((r) => setTimeout(r, 40))
      const steerRes = await adapter1.steer(
        {
          runId: run1Id,
          inputId: randomUUID(),
          nativeSessionId: sid1,
          nativeTurnId: run1Id,
          bindingGeneration: 1,
          nativeGeneration: run1Id,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId,
            message: { id: randomUUID(), content: 'Late steer after wire reply' },
            comments: [],
          },
          recordDispatch: () => undefined,
          recordConsumption: () => undefined,
        },
        new AbortController().signal,
      )
      expect(steerRes.status).toBe('rejected')
      expect(harness1.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(1)
      // Drain remaining events cleanly.
      while (!(await iter1.next()).done) {
        // drain
      }
    } finally {
      await adapter1.dispose()
    }

    // Part 2 (S2-F3): pending permission + elicitation carrying exec-foreign before root binds;
    // user_message_chunk proves exec-foreign is foreign -> affirmative user decisions are blocked!
    const harness2 = createAcpHarness()
    const sid2 = randomUUID()
    let prompt2Id: unknown
    const permOpened = Promise.withResolvers<void>()
    const elicitOpened = Promise.withResolvers<void>()
    const releasePermDecision = Promise.withResolvers<string>()
    const releaseElicitDecision = Promise.withResolvers<{
      action: 'accept'
      values: Record<string, string>
    }>()
    harness2.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness2.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/load') {
        harness2.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { sessionId: sid2, configOptions: defaultConfigOptions() },
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
        harness2.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { configOptions: defaultConfigOptions() },
        })
      } else if (frame.method === 'session/prompt') {
        prompt2Id = frame.id
        harness2.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-foreign-1',
          method: 'session/request_permission',
          params: {
            sessionId: sid2,
            toolCall: {
              toolCallId: 'tc-foreign-perm',
              name: 'run_command',
              title: 'Run shell',
              rawInput: { CommandLine: 'ls' },
            },
            options: [
              { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
            ],
            _meta: { execution_id: 'exec-foreign-1' },
          },
        })
        harness2.sendToClient({
          jsonrpc: '2.0',
          id: 'elicit-foreign-1',
          method: 'elicitation/create',
          params: {
            sessionId: sid2,
            mode: 'form',
            message: 'Enter secret value',
            requestedSchema: {
              type: 'object',
              properties: { answer: { type: 'string', title: 'Answer' } },
            },
            _meta: { execution_id: 'exec-foreign-1' },
          },
        })
      }
    })
    const adapter2 = new AgyAgentAdapter({ appDataDir, processFactory: () => harness2.child })
    {
      const runPromise = collectEvents(
        adapter2.run(
          makeRunInput(cwd, {
            nativeSessionId: sid2,
            host: {
              interactions: {
                requestPermission: async (req) => {
                  permOpened.resolve()
                  const allowAction = req.actions?.find((a) => a.kind === 'allow')?.id ?? 'agy-0'
                  await releasePermDecision.promise
                  return allowAction
                },
                requestUserInput: async () => {
                  elicitOpened.resolve()
                  return releaseElicitDecision.promise
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      try {
        await Promise.all([permOpened.promise, elicitOpened.promise])
        // Prove exec-foreign-1 belongs to an unrelated foreign user turn!
        harness2.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid2,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'Completely different foreign user turn' },
              _meta: { execution_id: 'exec-foreign-1' },
            },
          },
        })
        // Wait for the foreign user_message_chunk to be processed & revoke both pending interactions.
        await vi.waitFor(() => {
          expect(harness2.responses.some((r) => r.id === 'perm-foreign-1')).toBe(true)
          expect(harness2.responses.some((r) => r.id === 'elicit-foreign-1')).toBe(true)
        })
        // Even if user resolves late with affirmative decisions, NO second or affirmative response is sent!
        releasePermDecision.resolve('allow_once')
        releaseElicitDecision.resolve({ action: 'accept', values: { answer: 'YES' } })
        await new Promise((r) => setTimeout(r, 20))

        const permResp = harness2.responses.filter((r) => r.id === 'perm-foreign-1')
        const elicitResp = harness2.responses.filter((r) => r.id === 'elicit-foreign-1')
        expect(permResp).toHaveLength(1)
        expect(permResp[0]?.result).toEqual({ outcome: { outcome: 'cancelled' } })
        expect(elicitResp).toHaveLength(1)
        expect(elicitResp[0]?.result).toEqual({ action: 'cancel' })

        harness2.sendToClient({
          jsonrpc: '2.0',
          id: prompt2Id,
          result: { stopReason: 'end_turn', execution_id: 'exec-real-root' },
        })
        await runPromise
      } finally {
        await adapter2.dispose()
        await runPromise.catch(() => undefined)
      }
    }
  })

  it('S2-F4 & S2-F5: routes multi-run daemons strictly by taskId, blocks unattributable outOfTurn from foreground answer, and keeps daemon alive on delayed launch ACK', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    const sid = randomUUID()
    let promptNum = 0
    let finishPrompt3: (() => void) | undefined

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new' || frame.method === 'session/load') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { sessionId: sid, configOptions: defaultConfigOptions() },
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { configOptions: defaultConfigOptions() },
        })
      } else if (frame.method === 'session/prompt') {
        promptNum += 1
        if (promptNum === 1) {
          // Run A: pending launch in foreground; delayed launch ACK arrives post-cutoff (S2-F5)!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-run-a',
                name: 'run_command',
                args: { IsDaemon: true, CommandLine: 'npm run watch-a' },
                status: 'pending',
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-run-a' },
          })
          // Post-cutoff delayed launch ACK carrying rawOutput.taskId: MUST bind alias and keep daemon alive!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-run-a',
                name: 'run_command',
                status: 'completed',
                rawOutput: { taskId: 'bg-task-a' },
                _meta: { execution_id: 'exec-run-a' },
              },
            },
          })
        } else if (promptNum === 2) {
          // Run B: launches its own daemon bg-task-b.
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-run-b',
                name: 'run_command',
                args: { IsDaemon: true, CommandLine: 'npm run watch-b' },
                status: 'completed',
                rawOutput: { taskId: 'bg-task-b' },
                _meta: { execution_id: 'exec-run-b' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-run-b' },
          })
        } else {
          // Run C in foreground: receives unattributable outOfTurn text + real foreground text.
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                outOfTurn: true,
                messageId: 'unattributable-oot-1',
                content: { type: 'text', text: 'STRAY_OUT_OF_TURN' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Clean foreground answer.' },
                _meta: { execution_id: 'exec-run-c' },
              },
            },
          })
          finishPrompt3 = () => {
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn', execution_id: 'exec-run-c' },
            })
          }
        }
      }
    })

    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    const reportsA: NativeBackgroundReport[] = []
    const reportsB: NativeBackgroundReport[] = []
    try {
      const runAId = randomUUID()
      const runBId = randomUUID()
      await collectEvents(
        adapter.run(
          makeRunInput(cwd, {
            runId: runAId,
            host: {
              effects: {
                recordBackgroundReport: async (r) => {
                  reportsA.push(r)
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      await new Promise((r) => setTimeout(r, 30))
      // S2-F5: delayed post-cutoff launch ACK kept Run A active!
      expect(adapter.hasActiveBackgroundWork(runAId)).toBe(true)

      await collectEvents(
        adapter.run(
          makeRunInput(cwd, {
            runId: runBId,
            nativeSessionId: sid,
            host: {
              effects: {
                recordBackgroundReport: async (r) => {
                  reportsB.push(r)
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      expect(adapter.hasActiveBackgroundWork(runAId)).toBe(true)
      expect(adapter.hasActiveBackgroundWork(runBId)).toBe(true)

      // S2-F4: taskId-only completion for bg-task-b MUST route ONLY to Run B, leaving Run A active!
      harness.sendToClient({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'background_task_completed',
            taskId: 'bg-task-b',
            summary: 'Run B daemon finished.',
          },
        },
      })
      await vi.waitFor(() => {
        expect(reportsB).toHaveLength(1)
        expect(adapter.hasActiveBackgroundWork(runBId)).toBe(false)
      })
      expect(reportsA).toHaveLength(0)
      expect(adapter.hasActiveBackgroundWork(runAId)).toBe(true)

      // S2-F4 reverse path: Run C in foreground MUST NOT absorb unattributable outOfTurn chunk!
      const runCPromise = collectEvents(
        adapter.run(makeRunInput(cwd, { nativeSessionId: sid }), new AbortController().signal),
      )
      await vi.waitFor(() => expect(finishPrompt3).toBeTypeOf('function'))
      finishPrompt3!()
      const eventsC = await runCPromise
      expect(eventsC).toContainEqual(
        expect.objectContaining({ type: 'text.completed', text: 'Clean foreground answer.' }),
      )
      expect(eventsC.some((ev) => 'text' in ev && ev.text.includes('STRAY_OUT_OF_TURN'))).toBe(
        false,
      )

      // Complete Run A daemon cleanly.
      harness.sendToClient({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'background_task_completed',
            taskId: 'bg-task-a',
            summary: 'Run A daemon finished.',
          },
        },
      })
      await vi.waitFor(() => {
        expect(adapter.hasActiveBackgroundWork(runAId)).toBe(false)
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('S2-F6 & S1-F3 (Agy): settles once after EOF while final report persists, commits compact ended before immediate post-cutoff report, and settles pure-text Stop truncation', async () => {
    const { cwd, appDataDir } = await createEnv()

    // Part 1 (S2-F6 EOF race + S1-F3 immediate post-cutoff report ordering):
    const harness1 = createAcpHarness()
    const sid1 = randomUUID()
    const reportGate = Promise.withResolvers<void>()
    const reportEntered = Promise.withResolvers<void>()
    const orderLog: string[] = []
    const effects1: Array<{ state: string; reason?: string }> = []
    harness1.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness1.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        harness1.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { sessionId: sid1, configOptions: defaultConfigOptions() },
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
        harness1.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { configOptions: defaultConfigOptions() },
        })
      } else if (frame.method === 'session/prompt') {
        harness1.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid1,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-eof',
              name: 'run_command',
              args: { IsDaemon: true, CommandLine: 'npm test' },
              status: 'completed',
              rawOutput: { taskId: 'bg-eof' },
            },
          },
        })
        // Deliver end_turn AND immediate post-cutoff completion report in the same burst!
        harness1.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn', execution_id: 'exec-eof' },
        })
        harness1.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid1,
            update: {
              sessionUpdate: 'background_task_completed',
              taskId: 'bg-eof',
              summary: 'Final report before EOF.',
            },
          },
        })
      }
    })
    const adapter1 = new AgyAgentAdapter({ appDataDir, processFactory: () => harness1.child })
    try {
      const run1Promise = collectEvents(
        adapter1.run(
          makeRunInput(cwd, {
            host: {
              lifecycle: {
                recordNativeEvidence: (ev) => {
                  if (ev.kind === 'ended') orderLog.push('ended')
                },
              },
              effects: {
                recordBackgroundReport: async () => {
                  orderLog.push('bg_report_start')
                  reportEntered.resolve()
                  await reportGate.promise
                  orderLog.push('bg_report_done')
                },
                reportNativeEffects: (r) => {
                  effects1.push(r)
                  if (r.state === 'settled') orderLog.push('settled')
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      await reportEntered.promise
      // Trigger transport EOF WHILE final report persistence is still suspended!
      harness1.closeStdout()
      await new Promise((r) => setTimeout(r, 20))
      reportGate.resolve()
      await run1Promise
      await vi.waitFor(() => {
        expect(effects1.filter((e) => e.state === 'settled')).toHaveLength(1)
      })
      expect(orderLog.indexOf('ended')).toBeGreaterThanOrEqual(0)
      expect(orderLog.indexOf('ended')).toBeLessThan(orderLog.indexOf('bg_report_start'))
      expect(orderLog.indexOf('bg_report_done')).toBeLessThan(orderLog.indexOf('settled'))
      expect(effects1.some((e) => e.state === 'unknown')).toBe(false)
    } finally {
      await adapter1.dispose()
    }

    // Part 2 (S2-F6 pure-text Stop truncation): settles effects cleanly while keeping partial output.
    const harness2 = createAcpHarness()
    const sid2 = randomUUID()
    let prompt2Id: unknown
    const firstDeltaSeen = Promise.withResolvers<void>()
    harness2.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness2.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        harness2.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { sessionId: sid2, configOptions: defaultConfigOptions() },
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
        harness2.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { configOptions: defaultConfigOptions() },
        })
      } else if (frame.method === 'session/prompt') {
        prompt2Id = frame.id
        harness2.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid2,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Prefix ' },
            },
          },
        })
      } else if (frame.method === 'session/cancel') {
        void firstDeltaSeen.promise.then(() => {
          harness2.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid2,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Dropped after Stop' },
              },
            },
          })
          harness2.sendToClient({
            jsonrpc: '2.0',
            id: prompt2Id,
            result: { stopReason: 'end_turn' },
          })
          return undefined
        })
      }
    })
    const adapter2 = new AgyAgentAdapter({ appDataDir, processFactory: () => harness2.child })
    const effects2: Array<{ state: string; reason?: string }> = []
    try {
      const abortCtrl = new AbortController()
      for await (const ev of adapter2.run(
        makeRunInput(cwd, {
          host: { effects: { reportNativeEffects: (r) => effects2.push(r) } },
        }),
        abortCtrl.signal,
      )) {
        if (ev.type === 'text.delta' && !abortCtrl.signal.aborted) {
          abortCtrl.abort()
          firstDeltaSeen.resolve()
        }
      }
      expect(effects2.at(-1)).toMatchObject({ state: 'settled', reason: 'native_work_drained' })
    } finally {
      await adapter2.dispose()
    }
  })

  it('S2-F8 & S2-F9: preserves seq order across mixed pre-bind execution_ids and blocks evicted >4096-ID split tool completions', async () => {
    const { cwd, appDataDir } = await createEnv()

    // Part 1 (S2-F8): A(exec-mix) + B(no exec) -> root binds to exec-mix => "Alpha Beta" (NOT "BetaAlpha ")!
    const harness1 = createAcpHarness()
    const sid1 = randomUUID()
    let loadCount = 0
    harness1.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness1.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/load') {
        loadCount += 1
        harness1.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { sessionId: sid1, configOptions: defaultConfigOptions() },
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
        harness1.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { configOptions: defaultConfigOptions() },
        })
      } else if (frame.method === 'session/prompt') {
        if (loadCount === 1) {
          harness1.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid1,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Alpha ' },
                _meta: { execution_id: 'exec-mix' },
              },
            },
          })
          harness1.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid1,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Beta' },
              },
            },
          })
          harness1.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-mix' },
          })
        } else {
          // A belongs to foreign exec-old, B has no exec -> root binds to exec-new => ONLY "Beta"!
          harness1.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid1,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'ForeignA ' },
                _meta: { execution_id: 'exec-old' },
              },
            },
          })
          harness1.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid1,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Beta' },
              },
            },
          })
          harness1.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-new' },
          })
        }
      }
    })
    const adapter1 = new AgyAgentAdapter({ appDataDir, processFactory: () => harness1.child })
    try {
      const events1 = await collectEvents(
        adapter1.run(makeRunInput(cwd, { nativeSessionId: sid1 }), new AbortController().signal),
      )
      expect(events1).toContainEqual(
        expect.objectContaining({ type: 'text.completed', text: 'Alpha Beta' }),
      )
      const events2 = await collectEvents(
        adapter1.run(makeRunInput(cwd, { nativeSessionId: sid1 }), new AbortController().signal),
      )
      expect(events2).toContainEqual(
        expect.objectContaining({ type: 'text.completed', text: 'Beta' }),
      )
    } finally {
      await adapter1.dispose()
    }

    // Part 2 (S2-F9): Replay 4097 distinct tool IDs during session/load so hist-0 is evicted;
    // unattributed split completion for hist-0 is blocked while verified current edit records.
    const harness2 = createAcpHarness()
    const sid2 = randomUUID()
    harness2.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness2.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/load') {
        for (let i = 0; i <= AGY_MAX_PRE_PROMPT_REPLAY_TOOL_IDS; i += 1) {
          harness2.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid2,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: `hist-${i}`,
                name: 'edit_file',
                status: 'in_progress',
              },
            },
          })
        }
        harness2.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { sessionId: sid2, configOptions: defaultConfigOptions() },
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
        harness2.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { configOptions: defaultConfigOptions() },
        })
      } else if (frame.method === 'session/prompt') {
        // Evicted hist-0 split completion WITHOUT execution_id or stepIdx: MUST be blocked!
        harness2.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid2,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'hist-0',
              name: 'edit_file',
              status: 'completed',
              args: { Path: join(cwd, 'stale.ts') },
              content: [{ type: 'diff', path: join(cwd, 'stale.ts'), oldText: 'a', newText: 'b' }],
            },
          },
        })
        // Fresh edit WITH verified current execution_id: MUST record cleanly!
        harness2.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid2,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'cur-edit-1',
              name: 'edit_file',
              status: 'completed',
              args: { Path: join(cwd, 'fresh.ts') },
              content: [
                { type: 'diff', path: join(cwd, 'fresh.ts'), oldText: 'old', newText: 'new' },
              ],
              _meta: { execution_id: 'exec-cur-9' },
            },
          },
        })
        harness2.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn', execution_id: 'exec-cur-9' },
        })
      }
    })
    const recordedPaths: string[] = []
    const adapter2 = new AgyAgentAdapter({ appDataDir, processFactory: () => harness2.child })
    try {
      const events = await collectEvents(
        adapter2.run(
          makeRunInput(cwd, {
            nativeSessionId: sid2,
            host: {
              effects: {
                recordFileChange: async (change) => {
                  recordedPaths.push(change.path)
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      expect(events.some((e) => e.type === 'tool.completed' && e.toolCallId === 'hist-0')).toBe(
        false,
      )
      expect(events.some((e) => e.type === 'tool.completed' && e.toolCallId === 'cur-edit-1')).toBe(
        true,
      )
      expect(recordedPaths).not.toContain('stale.ts')
      expect(recordedPaths).toContain('fresh.ts')
    } finally {
      await adapter2.dispose()
    }
  })
})
