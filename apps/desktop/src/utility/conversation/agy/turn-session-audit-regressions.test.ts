/* oxlint-disable typescript/no-unsafe-type-assertion, no-await-in-loop -- Protocol test harness drives stdio JSON-RPC frames and sequential async generator steps directly. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  NativeBackgroundReport,
  NativeProbeResult,
  NormalizedAgentEvent,
} from '@pact/contracts'

import { createRunStopAbortReason, type AgentRunInput } from '@pact/agent-runtime'
import { agentRuns, conversationMessages, PactDatabase } from '@pact/persistence'

import { NativeInputWithheldError } from '../agent-execution-error.js'
import { AgyAcpConnectionPool } from '../agy-acp-connection.js'
import { AgyAgentAdapter } from '../agy-agent-adapter.js'
import {
  NATIVE_APP_WORKING_BYTES,
  NATIVE_OWNER_WORKING_BYTES,
  NativeWorkingMemory,
  nativeWorkingMemoryDiagnostics,
} from '../native-working-memory.js'
import { AGY_MAX_PENDING_EVENTS, AGY_MAX_PRE_PROMPT_REPLAY_TOOL_IDS } from './types.js'

const migrationsFolder = resolve(
  import.meta.dirname,
  '../../../../../../packages/persistence/drizzle',
)

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface AcpHarness {
  child: ChildProcessWithoutNullStreams
  requests: Array<Record<string, unknown>>
  responses: Array<Record<string, unknown>>
  notifications: Array<Record<string, unknown>>
  sendToClient(frame: object): void
  closeStdout(): void
  pauseStdin(): void
  resumeStdin(): void
  onClientFrame(handler: (frame: Record<string, unknown>) => void | Promise<void>): void
}

function createAcpHarness(options?: { highWaterMark?: number }): AcpHarness {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const requests: Array<Record<string, unknown>> = []
  const responses: Array<Record<string, unknown>> = []
  const notifications: Array<Record<string, unknown>> = []
  let remainder = ''
  let exitCode: number | null = null
  let signalCode: NodeJS.Signals | null = null
  let handler: ((frame: Record<string, unknown>) => void | Promise<void>) | undefined
  let stdinPaused = false
  const heldCallbacks: Array<() => void> = []

  const stdin = new Writable({
    ...(options?.highWaterMark !== undefined ? { highWaterMark: options.highWaterMark } : {}),
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
          } else if (typeof frame.method === 'string') {
            notifications.push(frame)
          } else {
            responses.push(frame)
          }
          void handler?.(frame)
        }
        nl = remainder.indexOf('\n')
      }
      if (stdinPaused) {
        heldCallbacks.push(cb)
      } else {
        cb()
      }
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
    notifications,
    sendToClient(frame: object) {
      stdout.write(`${JSON.stringify(frame)}\n`)
    },
    closeStdout() {
      childRecord.exitCode = 0
      stdout.end()
      emitter.emit('exit', 0, null)
      emitter.emit('close', 0, null)
    },
    pauseStdin() {
      stdinPaused = true
    },
    resumeStdin() {
      stdinPaused = false
      for (const cb of heldCallbacks.splice(0)) cb()
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

async function createSqliteRunFixture(cwd: string) {
  const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
  const projectId = randomUUID()
  const sessionId = randomUUID()
  const now = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'PactAudit',
    directoryPath: cwd,
    kind: 'directory',
    createdAt: now,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Audit Session', createdAt: now },
    {
      primaryAgentId: 'agy',
      secondaryAgentId: 'codex',
      agents: {
        codex: { model: null, effort: null },
        claude: { model: null, effort: null },
        agy: { model: null, effort: null },
      },
      maxDiscussionRounds: 3,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  const started = db.conversationRepository.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'Audit regression prompt',
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: 'agy',
    settingsRevision: 1,
    model: 'gemini-4-carbon',
    effort: 'high',
  })
  return {
    db,
    sessionId,
    runId: started.run.id,
    bindingGeneration: started.run.bindingGeneration ?? 1,
    close: () => db.close(),
  }
}

function wireRepositoryHost(
  db: PactDatabase,
  extra?: {
    onEvidence?: (ev: NativeProbeResult) => void
    onEffects?: (r: { state: string; reason?: string }) => void
    onBackgroundReport?: (report: NativeBackgroundReport) => void
  },
): NonNullable<AgentRunInput['host']> {
  return {
    lifecycle: {
      recordExecutor: (executorId) => {
        // Bound via beginRun's runId inside caller wrapper below.
        void executorId
      },
      recordDispatch: () => undefined,
      recordNativeEvidence: (ev) => {
        extra?.onEvidence?.(ev)
        db.conversationRepository.recordNativeEvidence(ev)
      },
    },
    effects: {
      recordBackgroundReport: async (report) => {
        extra?.onBackgroundReport?.(report)
        await db.conversationRepository.recordBackgroundReport(
          report,
          () =>
            (async function* () {
              yield report.text
            })(),
          new AbortController().signal,
        )
      },
      recordBackgroundReportUnavailable: (identity) => {
        db.conversationRepository.recordBackgroundReportUnavailable(identity)
      },
      reportNativeEffects: (r) => {
        extra?.onEffects?.(r)
        db.conversationRepository.recordNativeEffects(r.runId, r.state, r.reason)
      },
    },
  }
}

function wireRunRepositoryHost(
  db: PactDatabase,
  runId: string,
  extra?: {
    onEvidence?: (ev: NativeProbeResult) => void
    onEffects?: (r: { state: string; reason?: string }) => void
    onBackgroundReport?: (report: NativeBackgroundReport) => void
  },
): NonNullable<AgentRunInput['host']> {
  const base = wireRepositoryHost(db, extra)
  return {
    ...base,
    lifecycle: {
      ...base.lifecycle,
      recordExecutor: (executorId) => {
        db.conversationRepository.recordExecutor(runId, executorId)
      },
      recordDispatch: (phase, nativeSessionId, executorId) => {
        db.conversationRepository.recordDispatch(runId, phase, nativeSessionId, executorId)
      },
    },
  }
}

describe('Final Astra Audit Antigravity regressions (B-F1..B-F12)', () => {
  it('B-F1: isolates pre-known foreign execution user_message_chunk and prevents contradictory outOfTurn metadata from marking background Run unknown', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    const sid = randomUUID()
    let promptNum = 0

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
          // Run A launches background daemon with execution_id `exec-bg-a`.
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-bf1-a',
                name: 'run_command',
                args: { IsDaemon: true, CommandLine: 'npm run watch' },
                status: 'completed',
                rawOutput: { taskId: 'bg-bf1-a' },
                _meta: { execution_id: 'exec-bg-a' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-bg-a' },
          })
        } else {
          // Run B resumes same session (`exec-bg-a` is pre-populated in knownForeignExecutionIds).
          // 1) Contradictory session metadata on an outOfTurn frame MUST NOT mark Run A unknown!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                outOfTurn: true,
                content: { type: 'text', text: 'CORRUPT_META_OOT' },
                _meta: { sessionId: 'sess-contradiction-other' },
              },
            },
          })
          // 2) Pre-known foreign execution user_message_chunk MUST enter foreignTurnActiveUntilRootBound!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'Pre-known foreign prompt echo' },
                _meta: { execution_id: 'exec-bg-a' },
              },
            },
          })
          // 3) Unscoped text & permission following foreign user_message_chunk MUST stay isolated!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'FOREIGN_LEAK_TEXT' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-bf1-leak',
            method: 'session/request_permission',
            params: {
              sessionId: sid,
              toolCall: {
                toolCallId: 'tc-leak',
                name: 'run_command',
                title: 'Leaked command',
                rawInput: { CommandLine: 'rm -rf /tmp/nope' },
              },
              options: [
                { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
          // 4) Real root scoped text + terminal reply for Run B.
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Clean Run B answer.' },
                _meta: { execution_id: 'exec-run-b' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-run-b' },
          })
        }
      }
    })

    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    const effectsA: Array<{ state: string; reason?: string }> = []
    let permPromptCalls = 0
    try {
      const runAId = randomUUID()
      await collectEvents(
        adapter.run(
          makeRunInput(cwd, {
            runId: runAId,
            host: { effects: { reportNativeEffects: (r) => effectsA.push(r) } },
          }),
          new AbortController().signal,
        ),
      )
      expect(adapter.hasActiveBackgroundWork(runAId)).toBe(true)

      const eventsB = await collectEvents(
        adapter.run(
          makeRunInput(cwd, {
            nativeSessionId: sid,
            host: {
              interactions: {
                requestPermission: async () => {
                  permPromptCalls += 1
                  return 'allow_once'
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      expect(permPromptCalls).toBe(0)
      expect(eventsB.some((ev) => 'text' in ev && ev.text.includes('FOREIGN_LEAK_TEXT'))).toBe(
        false,
      )
      expect(eventsB).toContainEqual(
        expect.objectContaining({ type: 'text.completed', text: 'Clean Run B answer.' }),
      )
      // Run A must still be healthy and NOT marked unknown by contradictory outOfTurn metadata!
      expect(effectsA.some((e) => e.state === 'unknown')).toBe(false)
      expect(adapter.hasActiveBackgroundWork(runAId)).toBe(true)

      harness.sendToClient({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: { sessionUpdate: 'background_task_completed', taskId: 'bg-bf1-a' },
        },
      })
      await vi.waitFor(() => {
        expect(adapter.hasActiveBackgroundWork(runAId)).toBe(false)
      })
      expect(effectsA.at(-1)).toMatchObject({ state: 'settled', reason: 'native_work_drained' })
    } finally {
      await adapter.dispose()
    }
  })

  it('B-F2 & B-F3: enforces physical pre-write fence on permission/elicitation responses and rejects MCP calls after wire root reply at soft cap', async () => {
    const { cwd, appDataDir } = await createEnv()

    // Part 1 (B-F2): Hold stdin backpressure with a blocked dummy write so affirmative permission
    // and elicitation responses wait in OutboundFrameQueue before first byte, then revoke ownership.
    const harness1 = createAcpHarness({ highWaterMark: 1 })
    const sid1 = randomUUID()
    let prompt1Id: unknown
    const permOpened = Promise.withResolvers<void>()
    const elicitOpened = Promise.withResolvers<void>()
    const blockerWriteStarted = Promise.withResolvers<void>()
    const releasePerm = Promise.withResolvers<string>()
    const releaseElicit = Promise.withResolvers<{
      action: 'accept'
      values: Record<string, string>
    }>()

    harness1.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness1.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/load') {
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
        harness1.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-bf2',
          method: 'session/request_permission',
          params: {
            sessionId: sid1,
            toolCall: {
              toolCallId: 'tc-bf2-perm',
              name: 'run_command',
              title: 'Run command',
              rawInput: { CommandLine: 'echo hi' },
            },
            options: [
              { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
            ],
            _meta: { execution_id: 'exec-foreign-bf2' },
          },
        })
        harness1.sendToClient({
          jsonrpc: '2.0',
          id: 'elicit-bf2',
          method: 'elicitation/create',
          params: {
            sessionId: sid1,
            mode: 'form',
            message: 'Secret prompt',
            requestedSchema: {
              type: 'object',
              properties: { token: { type: 'string', title: 'Token' } },
            },
            _meta: { execution_id: 'exec-foreign-bf2' },
          },
        })
      } else if (frame.id === 'perm-blocker') {
        blockerWriteStarted.resolve()
      }
    })

    const adapter1 = new AgyAgentAdapter({ appDataDir, processFactory: () => harness1.child })
    {
      const run1 = collectEvents(
        adapter1.run(
          makeRunInput(cwd, {
            nativeSessionId: sid1,
            host: {
              interactions: {
                requestPermission: async (req) => {
                  permOpened.resolve()
                  const allow = req.actions?.find((a) => a.kind === 'allow')?.id ?? 'agy-0'
                  await releasePerm.promise
                  return allow
                },
                requestUserInput: async () => {
                  elicitOpened.resolve()
                  return releaseElicit.promise
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      try {
        await Promise.all([permOpened.promise, elicitOpened.promise])
        // Pause stdin and trigger a same-session contradicted permission write (handled async by
        // handlePermissionRequest, NOT awaited inside inboundProcessing) to occupy OutboundFrameQueue's
        // active slot before first byte of perm-bf2 & elicit-bf2 while stdout stays unblocked.
        harness1.pauseStdin()
        harness1.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-blocker',
          method: 'session/request_permission',
          params: {
            sessionId: sid1,
            toolCall: { toolCallId: 'tc-blk', name: 'run_command', title: 'Blocker' },
            options: [{ optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }],
            _meta: { sessionId: 'sess-other-blocker' },
          },
        })
        await blockerWriteStarted.promise
        // User approves while ownership is still valid -> both responses queue behind perm-blocker.
        releasePerm.resolve('allow_once')
        releaseElicit.resolve({
          action: 'accept',
          values: { token: 'AFFIRMATIVE_SHOULD_NOT_SEND' },
        })
        await new Promise((r) => setTimeout(r, 25))
        // Assert perm-bf2 & elicit-bf2 were NOT written while stdin was paused behind perm-blocker!
        expect(harness1.responses.map((r) => r.id)).toEqual(['perm-blocker'])
        // Revoke ownership BEFORE resuming stdin!
        harness1.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid1,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'Foreign execution proof' },
              _meta: { execution_id: 'exec-foreign-bf2' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 25))
        harness1.resumeStdin()

        await vi.waitFor(() => {
          expect(harness1.responses.some((r) => r.id === 'perm-bf2')).toBe(true)
          expect(harness1.responses.some((r) => r.id === 'elicit-bf2')).toBe(true)
        })
        const permResponses = harness1.responses.filter((r) => r.id === 'perm-bf2')
        const elicitResponses = harness1.responses.filter((r) => r.id === 'elicit-bf2')
        expect(permResponses).toHaveLength(1)
        expect(permResponses[0]?.result).toEqual({ outcome: { outcome: 'cancelled' } })
        expect(elicitResponses).toHaveLength(1)
        expect(elicitResponses[0]?.result).toEqual({ action: 'cancel' })

        harness1.sendToClient({
          jsonrpc: '2.0',
          id: prompt1Id,
          result: { stopReason: 'end_turn', execution_id: 'exec-real-bf2' },
        })
        await run1
      } finally {
        harness1.resumeStdin()
        await adapter1.dispose()
        await run1.catch(() => undefined)
      }
    }

    // Part 2 (B-F3): During soft-cap pause after wire root reply resolves (`promptRpcCompleted=true`),
    // new HTTP MCP calls are rejected immediately while pre-cutoff ACP facts still project in order.
    const harness2 = createAcpHarness()
    const sid2 = randomUUID()
    let mcpUrl: string | undefined
    let mcpAuthHeader: string | undefined
    let titleSetCalls = 0
    harness2.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness2.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        const params = frame.params as {
          mcpServers?: Array<{
            url?: string
            headers?: Array<{ name: string; value: string }>
          }>
        }
        const srv = params.mcpServers?.[0]
        mcpUrl = srv?.url
        mcpAuthHeader = srv?.headers?.find((h) => h.name.toLowerCase() === 'authorization')?.value
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
        harness2.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid2,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'PRE_CUTOFF_FACT ' },
            },
          },
        })
        for (let i = 0; i < AGY_MAX_PENDING_EVENTS + 10; i += 1) {
          harness2.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid2,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `x${i}` },
              },
            },
          })
        }
        harness2.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn', execution_id: 'exec-bf3' },
        })
      }
    })

    const adapter2 = new AgyAgentAdapter({ appDataDir, processFactory: () => harness2.child })
    try {
      const titleSessionId = randomUUID()
      const stream2 = adapter2.run(
        makeRunInput(cwd, {
          sessionId: titleSessionId,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId: titleSessionId,
            message: { id: randomUUID(), content: 'Audit regression prompt' },
            comments: [],
            requestSessionTitle: true,
          },
          host: {
            workflow: {
              recordOpenPlanFinalIntent: () => {
                titleSetCalls += 1
                return true
              },
            },
          },
        }),
        new AbortController().signal,
      )
      const iter2 = stream2[Symbol.asyncIterator]()
      while (true) {
        const step = await iter2.next()
        if (step.done || step.value.type === 'turn.started') break
      }
      // Wait for wire prompt reply to set promptRpcCompleted = true while pump is paused at soft cap.
      await new Promise((r) => setTimeout(r, 45))
      expect(mcpUrl).toBeTypeOf('string')

      const mcpResp = await fetch(mcpUrl!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(mcpAuthHeader ? { authorization: mcpAuthHeader } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/call',
          params: {
            name: 'set_session_title',
            arguments: { title: 'Post-cutoff stale title' },
            _meta: {
              'antigravity.google/root_conversation_id': sid2,
              'antigravity.google/conversation_id': sid2,
              progressToken: 'traj-bf3:1',
            },
          },
        }),
      })
      const mcpJson = (await mcpResp.json()) as {
        error?: { message?: string }
        result?: { isError?: boolean }
      }
      expect(Boolean(mcpJson.error) || mcpJson.result?.isError === true).toBe(true)
      expect(titleSetCalls).toBe(0)

      const remaining: NormalizedAgentEvent[] = []
      while (true) {
        const step = await iter2.next()
        if (step.done) break
        remaining.push(step.value)
      }
      const completedText = remaining.find((ev) => ev.type === 'text.completed')
      expect(completedText).toBeDefined()
      expect(completedText && 'text' in completedText && completedText.text).toContain(
        'PRE_CUTOFF_FACT ',
      )
      expect(remaining.some((ev) => ev.type === 'session.title.updated')).toBe(false)
    } finally {
      await adapter2.dispose()
    }
  })

  it('B-F5 & B-F7 (part 1): settles verified wire end_turn without session/cancel on soft-cap dispose (shared pool) and settles plain-text Run disposed at text.completed', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    let promptNum = 0
    const sids = [randomUUID(), randomUUID(), randomUUID()]
    let newIdx = 0

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            sessionId: sids[newIdx++] ?? randomUUID(),
            configOptions: defaultConfigOptions(),
          },
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
        const sid = (frame.params as { sessionId: string }).sessionId
        if (promptNum === 1) {
          // Soft-cap flood + wire end_turn while consumer stays paused -> dispose()!
          for (let i = 0; i < AGY_MAX_PENDING_EVENTS + 12; i += 1) {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: `p${i}` },
                },
              },
            })
          }
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-bf5' },
          })
        } else if (promptNum === 2) {
          // Sibling adapter clean turn on shared pool.
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Sibling still works.' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-bf5-sib' },
          })
        } else {
          // Plain-text Run fully drained, paused at text.completed -> dispose() MUST report settled ONCE!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Fully drained plain text.' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-bf7-plain' },
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
    const adapterC = new AgyAgentAdapter({ appDataDir, connectionPool: sharedPool })

    try {
      // Part 1 (B-F5): pause at turn.started during soft cap after wire end_turn, then dispose().
      const evidenceA: NativeProbeResult[] = []
      const effectsA: Array<{ state: string; reason?: string }> = []
      const streamA = adapterA.run(
        makeRunInput(cwd, {
          host: {
            lifecycle: { recordNativeEvidence: (ev) => evidenceA.push(ev) },
            effects: { reportNativeEffects: (r) => effectsA.push(r) },
          },
        }),
        new AbortController().signal,
      )
      const iterA = streamA[Symbol.asyncIterator]()
      while (true) {
        const step = await iterA.next()
        if (step.done || step.value.type === 'turn.started') break
      }
      await new Promise((r) => setTimeout(r, 45))
      await adapterA.dispose()

      expect(harness.notifications.filter((n) => n.method === 'session/cancel')).toHaveLength(0)
      expect(evidenceA).toContainEqual(
        expect.objectContaining({
          kind: 'ended',
          source: 'live_terminal',
          outcome: 'completed',
        }),
      )
      expect(effectsA.some((e) => e.state === 'unknown')).toBe(true)
      expect(effectsA.some((e) => e.state === 'settled')).toBe(false)
      expect(sharedPool.activeLeaseCount).toBe(0)

      // Sibling adapterB still runs cleanly on the same shared pool.
      const eventsB = await collectEvents(
        adapterB.run(makeRunInput(cwd), new AbortController().signal),
      )
      expect(eventsB).toContainEqual(
        expect.objectContaining({ type: 'text.completed', text: 'Sibling still works.' }),
      )

      // Part 2 (B-F7): fully drained plain-text Run disposed at text.completed -> 1 settled, 0 unknown!
      const effectsC: Array<{ state: string; reason?: string }> = []
      const streamC = adapterC.run(
        makeRunInput(cwd, {
          host: { effects: { reportNativeEffects: (r) => effectsC.push(r) } },
        }),
        new AbortController().signal,
      )
      const iterC = streamC[Symbol.asyncIterator]()
      while (true) {
        const step = await iterC.next()
        if (step.done || step.value.type === 'text.completed') break
      }
      await adapterC.dispose()
      expect(effectsC.filter((e) => e.state === 'settled')).toHaveLength(1)
      expect(effectsC.some((e) => e.state === 'unknown')).toBe(false)
      expect(sharedPool.activeLeaseCount).toBe(0)
    } finally {
      await adapterA.dispose()
      await adapterB.dispose()
      await adapterC.dispose()
      await sharedPool.dispose()
    }
  })

  it('B-F4, B-F6 & B-F7 (part 2): preserves daemon-less control drain, monotonic SQLite nativeOutcome on truncated Stop, and awaits blocked file recordings before settling', async () => {
    const { cwd, appDataDir } = await createEnv()

    // Part 1 (B-F4): Daemon-less Run whose consumer exits early (.return() on archive failure)
    // keeps hasActiveBackgroundWork(runId) === true during control drain, persists ended in SQLite,
    // and then settles & releases cleanly.
    {
      const sqlFix = await createSqliteRunFixture(cwd)
      const harness = createAcpHarness()
      const sid = randomUUID()
      let pendingPromptId: unknown
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          pendingPromptId = frame.id
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Chunk before archive failure' },
              },
            },
          })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const effects: Array<{ state: string; reason?: string | undefined }> = []
      try {
        const stream = adapter.run(
          makeRunInput(cwd, {
            sessionId: sqlFix.sessionId,
            runId: sqlFix.runId,
            bindingGeneration: sqlFix.bindingGeneration,
            nativeGeneration: sqlFix.runId,
            host: wireRunRepositoryHost(sqlFix.db, sqlFix.runId, {
              onEffects: (r) => effects.push(r),
            }),
          }),
          new AbortController().signal,
        )
        const iter = stream[Symbol.asyncIterator]()
        while (true) {
          const step = await iter.next()
          if (step.done) break
          if (step.value.type === 'text.delta') {
            await iter.return?.()
            break
          }
        }
        // No daemon exists, yet control drain MUST remain visible as active background work!
        expect(adapter.hasActiveBackgroundWork(sqlFix.runId)).toBe(true)

        harness.sendToClient({
          jsonrpc: '2.0',
          id: pendingPromptId,
          result: { stopReason: 'end_turn', execution_id: 'exec-bf4' },
        })
        await vi.waitFor(() => {
          expect(adapter.hasActiveBackgroundWork(sqlFix.runId)).toBe(false)
        })
        const runRow = sqlFix.db.drizzle
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, sqlFix.runId))
          .get()
        expect(runRow?.dispatchPhase).toBe('ended')
        expect(runRow?.nativeOutcome).toBe('completed')
        expect(effects.at(-1)).toMatchObject({ state: 'settled', reason: 'native_work_drained' })
      } finally {
        await adapter.dispose()
        sqlFix.close()
      }
    }

    // Part 2 (B-F6): Truncated visible prefix + active daemon + verified end_turn -> consumer exits
    // IMMEDIATELY at `turn.completed(failed)`: SQLite keeps `nativeOutcome='completed'` monotonically,
    // assistant Message stays `incomplete`, and subsequent daemon report persists cleanly into SQLite!
    {
      const sqlFix = await createSqliteRunFixture(cwd)
      const harness = createAcpHarness()
      const sid = randomUUID()
      let promptId: unknown
      const deltaSeen = Promise.withResolvers<void>()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          promptId = frame.id
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-bf6',
                name: 'run_command',
                args: { IsDaemon: true, CommandLine: 'npm run build-watch' },
                status: 'completed',
                rawOutput: { taskId: 'bg-bf6' },
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
                content: { type: 'text', text: 'Visible prefix before Stop' },
              },
            },
          })
        } else if (frame.method === 'session/cancel') {
          void deltaSeen.promise.then(() => {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Truncated suffix after Stop' },
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              id: promptId,
              result: { stopReason: 'end_turn', execution_id: 'exec-bf6' },
            })
            return undefined
          })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const abortCtrl = new AbortController()
        const stream = adapter.run(
          makeRunInput(cwd, {
            sessionId: sqlFix.sessionId,
            runId: sqlFix.runId,
            bindingGeneration: sqlFix.bindingGeneration,
            nativeGeneration: sqlFix.runId,
            host: wireRunRepositoryHost(sqlFix.db, sqlFix.runId),
          }),
          abortCtrl.signal,
        )
        const iter = stream[Symbol.asyncIterator]()
        let sawTruncatedFailure = false
        while (true) {
          const step = await iter.next()
          if (step.done) break
          const ev = step.value
          sqlFix.db.conversationRepository.applyEvent(sqlFix.sessionId, sqlFix.runId, ev)
          if (ev.type === 'text.delta' && !abortCtrl.signal.aborted) {
            abortCtrl.abort()
            deltaSeen.resolve()
          }
          if (ev.type === 'turn.completed' && ev.outcome === 'failed') {
            sawTruncatedFailure = true
            // Exit immediately at yield without waiting for any post-yield statement!
            await iter.return?.()
            break
          }
        }
        expect(sawTruncatedFailure).toBe(true)

        const runRow = sqlFix.db.drizzle
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, sqlFix.runId))
          .get()
        expect(runRow?.dispatchPhase).toBe('ended')
        expect(runRow?.nativeOutcome).toBe('completed')

        const assistantMsg = sqlFix.db.drizzle
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.runId, sqlFix.runId))
          .all()
          .find((m) => m.role === 'assistant')
        expect(assistantMsg?.state).toBe('incomplete')

        // Subsequent background report MUST persist cleanly because nativeOutcome stayed `completed`!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'background_task_completed',
              taskId: 'bg-bf6',
              summary: 'Background report persisted after truncated stop.',
            },
          },
        })
        await vi.waitFor(() => {
          expect(adapter.hasActiveBackgroundWork(sqlFix.runId)).toBe(false)
        })
        const allMsgs = sqlFix.db.drizzle
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.sessionId, sqlFix.sessionId))
          .all()
        expect(
          allMsgs.some(
            (m) =>
              m.state === 'complete' &&
              m.content.includes('Background report persisted after truncated stop.'),
          ),
        ).toBe(true)
      } finally {
        await adapter.dispose()
        sqlFix.close()
      }
    }

    // Part 3 (B-F7): Retained daemon completes while a file-change recording is still blocked ->
    // MUST NOT report settled or abort observation until recordingTail finishes!
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      const fileChangeStarted = Promise.withResolvers<void>()
      const releaseFileChange = Promise.withResolvers<void>()
      let fileChangeSignalAborted = false
      const effects: Array<{ state: string; reason?: string | undefined }> = []

      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-bf7-daemon',
                name: 'run_command',
                args: { IsDaemon: true, CommandLine: 'npm run dev' },
                status: 'completed',
                rawOutput: { taskId: 'bg-bf7' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-bf7-edit',
                name: 'edit_file',
                status: 'completed',
                args: { Path: join(cwd, 'slow-file.ts') },
                content: [
                  {
                    type: 'diff',
                    path: join(cwd, 'slow-file.ts'),
                    oldText: 'old',
                    newText: 'new',
                  },
                ],
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-bf7-rec' },
          })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const runId = randomUUID()
        const stream = adapter.run(
          makeRunInput(cwd, {
            runId,
            host: {
              effects: {
                recordFileChange: async (_change, recSignal) => {
                  fileChangeStarted.resolve()
                  await releaseFileChange.promise
                  fileChangeSignalAborted = recSignal?.aborted ?? false
                },
                reportNativeEffects: (r) => effects.push(r),
              },
            },
          }),
          new AbortController().signal,
        )
        const iter = stream[Symbol.asyncIterator]()
        // Exit consumer early after file recording starts (while daemon + recording are both active!).
        while (true) {
          const step = await iter.next()
          if (step.done) break
          if (step.value.type === 'tool.completed' && step.value.toolCallId === 'tc-bf7-edit') {
            await fileChangeStarted.promise
            await iter.return?.()
            break
          }
        }
        // Wait for root end_turn to hand off to retained background observer.
        await new Promise((r) => setTimeout(r, 30))
        // Daemon completes FIRST while file recording is STILL blocked!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'background_task_completed', taskId: 'bg-bf7' },
          },
        })
        await new Promise((r) => setTimeout(r, 35))
        // MUST NOT settle while file recording is still in flight!
        expect(effects.some((e) => e.state === 'settled')).toBe(false)

        releaseFileChange.resolve()
        await vi.waitFor(() => {
          expect(effects.filter((e) => e.state === 'settled')).toHaveLength(1)
        })
        expect(fileChangeSignalAborted).toBe(false)
        expect(effects.some((e) => e.state === 'unknown')).toBe(false)
        expect(adapter.hasActiveBackgroundWork(runId)).toBe(false)
      } finally {
        releaseFileChange.resolve()
        await adapter.dispose()
      }
    }
  })

  it('B-F8 & B-F9: commits compact ended before delayed first daemon ACK report in SQLite, ignores set_mode replay, binds delayed taskId alias, and preserves Med #14 compact completion', async () => {
    const { cwd, appDataDir } = await createEnv()

    // Part 1 (B-F8): Root reply arrives BEFORE any daemon is seen, followed by delayed first launch
    // ACK and immediate report -> SQLite MUST contain exactly 1 complete background report!
    {
      const sqlFix = await createSqliteRunFixture(cwd)
      const harness = createAcpHarness()
      const sid = randomUUID()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Foreground answer.' },
              },
            },
          })
          // Root reply arrives BEFORE any daemon launch frame!
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-bf8' },
          })
          // Delayed first daemon launch ACK + immediate completion report post-cutoff!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-bf8-late',
                name: 'run_command',
                args: { IsDaemon: true, CommandLine: 'npm run worker' },
                status: 'completed',
                rawOutput: { taskId: 'bg-bf8-late' },
                _meta: { execution_id: 'exec-bf8' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'background_task_completed',
                taskId: 'bg-bf8-late',
                summary: 'Late ACK daemon report persisted cleanly.',
                _meta: { execution_id: 'exec-bf8' },
              },
            },
          })
        }
      })

      const bf8BgReports: NativeBackgroundReport[] = []
      const bf8BgErrors: string[] = []
      const rootOutputGate = Promise.withResolvers<void>()
      const rootOutputEntered = Promise.withResolvers<void>()
      const bf8Host = wireRunRepositoryHost(sqlFix.db, sqlFix.runId, {
        onBackgroundReport: (r) => bf8BgReports.push(r),
      })
      bf8Host.lifecycle!.waitForRootOutput = async () => {
        rootOutputEntered.resolve()
        await rootOutputGate.promise
      }
      const origBg = bf8Host.effects!.recordBackgroundReport!
      bf8Host.effects!.recordBackgroundReport = async (r) => {
        try {
          await origBg(r)
        } catch (err) {
          bf8BgErrors.push(err instanceof Error ? err.message : String(err))
          throw err
        }
      }
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const runTask = (async () => {
          for await (const ev of adapter.run(
            makeRunInput(cwd, {
              sessionId: sqlFix.sessionId,
              runId: sqlFix.runId,
              bindingGeneration: sqlFix.bindingGeneration,
              nativeGeneration: sqlFix.runId,
              host: bf8Host,
            }),
            new AbortController().signal,
          )) {
            sqlFix.db.conversationRepository.applyEvent(sqlFix.sessionId, sqlFix.runId, ev)
          }
        })()
        // Wait until root end_turn has settled while finalTerminalEvidenceCommitted has NOT yet run
        // (SQLite is still `accepted` because no daemon existed before root reply). Then let the
        // delayed post-cutoff first launch ACK + immediate report arrive and persist cleanly!
        await rootOutputEntered.promise
        await vi.waitFor(() => {
          expect(bf8BgReports).toHaveLength(1)
        })
        expect(bf8BgErrors).toEqual([])
        rootOutputGate.resolve()
        await runTask
        const reports = sqlFix.db.drizzle
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.sessionId, sqlFix.sessionId))
          .all()
          .filter((m) => m.content.includes('Late ACK daemon report persisted cleanly.'))
        expect(reports).toHaveLength(1)
        expect(reports[0]?.state).toBe('complete')
      } finally {
        rootOutputGate.resolve()
        await adapter.dispose()
        sqlFix.close()
      }
    }

    // Part 2 (B-F9): set_mode trailing replay MUST NOT close active daemon; delayed rawOutput.taskId
    // alias on already-completed launch call MUST bind and allow taskId-only completion; Med #14 stays intact.
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      let promptNum = 0
      let setModeNum = 0
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new' || frame.method === 'session/load') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { sessionId: sid, configOptions: defaultConfigOptions() },
          })
        } else if (frame.method === 'session/set_mode') {
          setModeNum += 1
          if (setModeNum === 2) {
            // Trailing compact replay arriving DURING Run 2's session/set_mode (after session/load)!
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'tc-bf9-alias',
                  status: 'completed',
                },
              },
            })
          }
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { configOptions: defaultConfigOptions() },
          })
        } else if (frame.method === 'session/set_config_option') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { configOptions: defaultConfigOptions() },
          })
        } else if (frame.method === 'session/prompt') {
          promptNum += 1
          if (promptNum === 1) {
            // Run 1 launches daemon WITHOUT rawOutput.taskId initially (completed launch call).
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'tc-bf9-alias',
                  name: 'run_command',
                  args: { IsDaemon: true, CommandLine: 'npm run watch-alias' },
                  status: 'completed',
                  _meta: { execution_id: 'exec-bf9-1' },
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn', execution_id: 'exec-bf9-1' },
            })
          } else if (promptNum === 2) {
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn', execution_id: 'exec-bf9-2' },
            })
          } else {
            // Run 3 (Med #14): daemon without rawOutput.taskId settles via compact tool_call_update.
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'tc-bf9-med14',
                  name: 'run_command',
                  args: { IsDaemon: true, CommandLine: 'npm run med14' },
                  status: 'completed',
                  _meta: { execution_id: 'exec-bf9-3' },
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn', execution_id: 'exec-bf9-3' },
            })
          }
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const reports1: NativeBackgroundReport[] = []
      const reports3: NativeBackgroundReport[] = []
      try {
        const run1Id = randomUUID()
        await collectEvents(
          adapter.run(
            makeRunInput(cwd, {
              runId: run1Id,
              host: {
                effects: {
                  recordBackgroundReport: async (r) => {
                    reports1.push(r)
                  },
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(adapter.hasActiveBackgroundWork(run1Id)).toBe(true)

        // Run 2 triggers set_mode trailing compact replay of tc-bf9-alias -> Run 1 MUST stay active!
        await collectEvents(
          adapter.run(makeRunInput(cwd, { nativeSessionId: sid }), new AbortController().signal),
        )
        expect(adapter.hasActiveBackgroundWork(run1Id)).toBe(true)

        // Now deliver delayed rawOutput.taskId alias on tc-bf9-alias -> binds `bg-bf9-delayed`, stays active.
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-bf9-alias',
              status: 'completed',
              rawOutput: { taskId: 'bg-bf9-delayed' },
              _meta: { execution_id: 'exec-bf9-1' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 25))
        expect(adapter.hasActiveBackgroundWork(run1Id)).toBe(true)

        // TaskId-only completion using the delayed alias settles Run 1 cleanly!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'background_task_completed',
              taskId: 'bg-bf9-delayed',
              summary: 'Settled via delayed alias.',
            },
          },
        })
        await vi.waitFor(() => {
          expect(adapter.hasActiveBackgroundWork(run1Id)).toBe(false)
          expect(reports1).toHaveLength(1)
        })

        // Med #14: Run 3 daemon without rawOutput.taskId settles via compact outOfTurn completion.
        const run3Id = randomUUID()
        await collectEvents(
          adapter.run(
            makeRunInput(cwd, {
              runId: run3Id,
              nativeSessionId: sid,
              host: {
                effects: {
                  recordBackgroundReport: async (r) => {
                    reports3.push(r)
                  },
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(adapter.hasActiveBackgroundWork(run3Id)).toBe(true)
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-bf9-med14',
              messageId: 'med14-report-1',
              status: 'completed',
              outOfTurn: true,
              summary: 'Med 14 compact completion.',
            },
          },
        })
        await vi.waitFor(() => {
          expect(adapter.hasActiveBackgroundWork(run3Id)).toBe(false)
          expect(reports3).toHaveLength(1)
        })
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('B-F10: stages dependent unattributed tool_call_update in >4096-ID replay session and replays it after bind while still blocking evicted history', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    const sid = randomUUID()

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/load') {
        for (let i = 0; i <= AGY_MAX_PRE_PROMPT_REPLAY_TOOL_IDS; i += 1) {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: `hist-${i}`,
                name: 'edit_file',
                status: 'in_progress',
              },
            },
          })
        }
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
        // 1) New tool start WITH execution_id -> staged before bind!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'cur-staged-1',
              name: 'edit_file',
              status: 'in_progress',
              args: { Path: join(cwd, 'staged-fresh.ts') },
              _meta: { execution_id: 'exec-bf10' },
            },
          },
        })
        // 2) Dependent unattributed completion for cur-staged-1 -> MUST stage and replay after bind!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'cur-staged-1',
              name: 'edit_file',
              status: 'completed',
              args: { Path: join(cwd, 'staged-fresh.ts') },
              content: [
                {
                  type: 'diff',
                  path: join(cwd, 'staged-fresh.ts'),
                  oldText: 'before',
                  newText: 'after',
                },
              ],
            },
          },
        })
        // 3) Evicted hist-0 unattributed completion -> MUST STILL be blocked after bind!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'hist-0',
              name: 'edit_file',
              status: 'completed',
              args: { Path: join(cwd, 'evicted-hist.ts') },
              content: [
                {
                  type: 'diff',
                  path: join(cwd, 'evicted-hist.ts'),
                  oldText: 'x',
                  newText: 'y',
                },
              ],
            },
          },
        })
        // 4) Root bind + end_turn for exec-bf10.
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn', execution_id: 'exec-bf10' },
        })
      }
    })

    const recordedPaths: string[] = []
    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      await collectEvents(
        adapter.run(
          makeRunInput(cwd, {
            nativeSessionId: sid,
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
      expect(recordedPaths.filter((p) => p === 'staged-fresh.ts')).toHaveLength(1)
      expect(recordedPaths.filter((p) => p === 'evicted-hist.ts')).toHaveLength(0)
    } finally {
      await adapter.dispose()
    }
  })

  it('B-F11 & B-F12: skips evidence cache on shared working-memory refusal without blocking recordNativeEvidence or text.completed and frees reservations cleanly', async () => {
    const { cwd, appDataDir } = await createEnv()
    const baselineBytes = nativeWorkingMemoryDiagnostics().chargedBytes
    const harness = createAcpHarness()
    const sid = randomUUID()
    const largeAnswer = 'A'.repeat(40_000)
    const ballastOwners: Array<{ release: () => void }> = []
    const ballastApplied = Promise.withResolvers<void>()
    let promptId: unknown

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
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
        promptId = frame.id
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: largeAnswer },
            },
          },
        })
        void ballastApplied.promise.then(() => {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: promptId,
            result: { stopReason: 'end_turn', execution_id: 'exec-bf11' },
          })
          return undefined
        })
      }
    })

    const evidence: NativeProbeResult[] = []
    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      const stream = adapter.run(
        makeRunInput(cwd, {
          host: {
            lifecycle: { recordNativeEvidence: (ev) => evidence.push(ev) },
          },
        }),
        new AbortController().signal,
      )
      const events: NormalizedAgentEvent[] = []
      for await (const ev of stream) {
        events.push(ev)
        if (ev.type === 'text.delta' && ballastOwners.length === 0) {
          // Fill shared business pool leaving <16 KiB headroom so caching the 80 KiB evidence entry
          // hits NativeCapacityError inside evidenceCacheWork.resize()!
          let remaining =
            NATIVE_APP_WORKING_BYTES - (nativeWorkingMemoryDiagnostics().chargedBytes ?? 0) - 8_192
          while (remaining > 0) {
            const chunk = Math.min(remaining, NATIVE_OWNER_WORKING_BYTES)
            const mem = new NativeWorkingMemory('business')
            ballastOwners.push(mem.reserve(chunk))
            remaining -= chunk
          }
          ballastApplied.resolve()
        }
      }
      expect(evidence).toContainEqual(
        expect.objectContaining({
          kind: 'ended',
          source: 'live_terminal',
          outcome: 'completed',
        }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'text.completed', text: largeAnswer }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'turn.completed', outcome: 'completed' }),
      )
    } finally {
      ballastApplied.resolve()
      for (const res of ballastOwners.splice(0)) res.release()
      await adapter.dispose()
    }
    expect(nativeWorkingMemoryDiagnostics().chargedBytes).toBe(baselineBytes)
  })

  it('Carbon B-2: historical-step user_message_chunk still isolates foreign turns and historical-step outOfTurn marks retained runs unknown', async () => {
    const { cwd, appDataDir } = await createEnv()
    const trajId = 'traj-b2-pinned'

    // Part 1: Resumed session pinned at minStepIdx=4 receives stepIdx:1 user_message_chunk with exec-foreign.
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      const runId = randomUUID()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/load') {
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
          // Foreign historical user_message_chunk (stepIdx: 1 < minStepIdx: 4) MUST arm foreign isolation!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'user_message_chunk',
                stepIdx: 1,
                trajectoryId: trajId,
                execution_id: 'exec-foreign-b2',
                content: { type: 'text', text: 'Historical foreign prompt' },
              },
            },
          })
          // Subsequent unscoped chunk during foreign turn MUST be isolated.
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'LEAK_UNSCOPED' },
              },
            },
          })
          // Subsequent chunk carrying exec-foreign-b2 (without stepIdx) MUST NOT hijack binding or leak.
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                execution_id: 'exec-foreign-b2',
                content: { type: 'text', text: 'LEAK_FOREIGN_EXEC' },
              },
            },
          })
          // Real current root turn (stepIdx: 4 >= minStepIdx: 4).
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'user_message_chunk',
                stepIdx: 4,
                trajectoryId: trajId,
                execution_id: 'exec-root-b2',
                content: { type: 'text', text: JSON.stringify({ pactRunId: runId }) },
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
                stepIdx: 4,
                trajectoryId: trajId,
                execution_id: 'exec-root-b2',
                content: { type: 'text', text: 'CLEAN_B2_ANSWER' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-root-b2' },
          })
        }
      })

      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => harness.child,
        storageClient: {
          readTrajectoryIdentity: async () => ({
            status: 'ok',
            trajectoryId: trajId,
            stepCount: 4,
          }),
        },
      })
      try {
        const events = await collectEvents(
          adapter.run(
            makeRunInput(cwd, {
              runId,
              nativeSessionId: sid,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: randomUUID(),
                message: { id: randomUUID(), content: 'Audit prompt B2' },
                comments: [],
                requestSessionTitle: true,
              },
            }),
            new AbortController().signal,
          ),
        )
        const text = events
          .filter(
            (e): e is Extract<NormalizedAgentEvent, { type: 'text.delta' }> =>
              e.type === 'text.delta',
          )
          .map((e) => e.text)
          .join('')
        expect(text).toBe('CLEAN_B2_ANSWER')
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'text.completed', text: 'CLEAN_B2_ANSWER' }),
        )
      } finally {
        await adapter.dispose()
      }
    }

    // Part 2: Retained Run A + Run B (minStepIdx=4) receives outOfTurn:true with stepIdx:1 -> Run A marked unknown!
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      let stepCount = 0
      let promptCount = 0
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
          promptCount += 1
          if (promptCount === 1) {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'bg-launch-b2',
                  name: 'run_command',
                  args: { CommandLine: 'sleep 10', IsDaemon: true },
                  status: 'in_progress',
                  stepIdx: 1,
                  trajectoryId: trajId,
                  execution_id: 'exec-run-a',
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'bg-launch-b2',
                  name: 'run_command',
                  status: 'completed',
                  rawOutput: { taskId: 'task-b2-a' },
                  stepIdx: 1,
                  trajectoryId: trajId,
                  execution_id: 'exec-run-a',
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn', execution_id: 'exec-run-a' },
            })
          } else {
            // Unattributable outOfTurn carrying historical stepIdx: 1 (< Run B minStepIdx: 4)
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  outOfTurn: true,
                  stepIdx: 1,
                  trajectoryId: trajId,
                  content: { type: 'text', text: 'Unattributable historical background update' },
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn', execution_id: 'exec-run-b' },
            })
          }
        }
      })

      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => harness.child,
        storageClient: {
          readTrajectoryIdentity: async () => ({
            status: 'ok',
            trajectoryId: trajId,
            stepCount,
          }),
        },
      })
      const effectsA: Array<{ state: string }> = []
      const runAId = randomUUID()
      try {
        await collectEvents(
          adapter.run(
            makeRunInput(cwd, {
              runId: runAId,
              host: { effects: { reportNativeEffects: (r) => effectsA.push({ state: r.state }) } },
            }),
            new AbortController().signal,
          ),
        )
        expect(adapter.hasActiveBackgroundWork(runAId)).toBe(true)

        stepCount = 4
        await collectEvents(
          adapter.run(
            makeRunInput(cwd, {
              nativeSessionId: sid,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: randomUUID(),
                message: { id: randomUUID(), content: 'Run B' },
                comments: [],
                requestSessionTitle: true,
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(effectsA.some((e) => e.state === 'unknown')).toBe(true)
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('Carbon B-3: adapter.hasActiveBackgroundWork(runId) is already false inside terminal reportNativeEffects across EOF, mid-run unconfirmed drain, and controlDrain emergency', async () => {
    const { cwd, appDataDir } = await createEnv()

    // Part 1: Retained daemon + ACP transport EOF
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      const runId = randomUUID()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'bg-b3-eof',
                name: 'run_command',
                args: { CommandLine: 'sleep 10', IsDaemon: true },
                status: 'in_progress',
                execution_id: 'exec-b3-1',
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'bg-b3-eof',
                name: 'run_command',
                status: 'completed',
                rawOutput: { taskId: 'task-b3-eof' },
                execution_id: 'exec-b3-1',
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', execution_id: 'exec-b3-1' },
          })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const observations: Array<{ state: string; activeInsideCallback: boolean }> = []
      try {
        await collectEvents(
          adapter.run(
            makeRunInput(cwd, {
              runId,
              host: {
                effects: {
                  reportNativeEffects: (r) =>
                    observations.push({
                      state: r.state,
                      activeInsideCallback: adapter.hasActiveBackgroundWork(runId),
                    }),
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(adapter.hasActiveBackgroundWork(runId)).toBe(true)
        harness.closeStdout()
        await vi.waitFor(() => {
          expect(observations.some((o) => o.state === 'unknown')).toBe(true)
        })
        const lastUnknown = observations.findLast((o) => o.state === 'unknown')
        expect(lastUnknown?.activeInsideCallback).toBe(false)
      } finally {
        await adapter.dispose()
      }
    }

    // Part 2: Mid-run backgroundUnconfirmed followed by task drain emits final terminal unknown with hasActiveBackgroundWork===false
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      const runAId = randomUUID()
      let prompts = 0
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
          prompts += 1
          if (prompts === 1) {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'bg-b3-mid',
                  name: 'run_command',
                  args: { CommandLine: 'sleep 10', IsDaemon: true },
                  status: 'in_progress',
                  execution_id: 'exec-b3-a',
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'bg-b3-mid',
                  name: 'run_command',
                  status: 'completed',
                  rawOutput: { taskId: 'task-b3-mid' },
                  execution_id: 'exec-b3-a',
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn', execution_id: 'exec-b3-a' },
            })
          } else {
            // Unattributable outOfTurn sets Run A backgroundUnconfirmed=true mid-run!
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  outOfTurn: true,
                  content: { type: 'text', text: 'Mystery update' },
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn', execution_id: 'exec-b3-b' },
            })
          }
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const observationsA: Array<{ state: string; activeInsideCallback: boolean }> = []
      try {
        await collectEvents(
          adapter.run(
            makeRunInput(cwd, {
              runId: runAId,
              host: {
                effects: {
                  reportNativeEffects: (r) =>
                    observationsA.push({
                      state: r.state,
                      activeInsideCallback: adapter.hasActiveBackgroundWork(runAId),
                    }),
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        await collectEvents(
          adapter.run(makeRunInput(cwd, { nativeSessionId: sid }), new AbortController().signal),
        )
        // Mid-run unknown fired while Run A still owned task-b3-mid!
        expect(observationsA.some((o) => o.state === 'unknown' && o.activeInsideCallback)).toBe(
          true,
        )
        // Now complete task-b3-mid so Run A drains and detaches -> final unknown MUST fire with active===false!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'background_task_completed',
              taskId: 'task-b3-mid',
              execution_id: 'exec-b3-a',
            },
          },
        })
        await vi.waitFor(() => {
          expect(observationsA.some((o) => o.state === 'unknown' && !o.activeInsideCallback)).toBe(
            true,
          )
        })
      } finally {
        await adapter.dispose()
      }
    }

    // Part 3: controlDrainActive emergency dispose reports unknown AFTER detaching activeRun
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      const runId = randomUUID()
      const deltaArrived = Promise.withResolvers<void>()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'partial' },
              },
            },
          })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const observations: Array<{ state: string; activeInsideCallback: boolean }> = []
      const stream = adapter.run(
        makeRunInput(cwd, {
          runId,
          host: {
            effects: {
              reportNativeEffects: (r) =>
                observations.push({
                  state: r.state,
                  activeInsideCallback: adapter.hasActiveBackgroundWork(runId),
                }),
            },
          },
        }),
        new AbortController().signal,
      )
      for await (const ev of stream) {
        if (ev.type === 'text.delta') {
          deltaArrived.resolve()
          break
        }
      }
      await deltaArrived.promise
      expect(adapter.hasActiveBackgroundWork(runId)).toBe(true)
      await adapter.dispose()
      const lastUnknown = observations.findLast((o) => o.state === 'unknown')
      expect(lastUnknown?.activeInsideCallback).toBe(false)
    }
  })

  it('Carbon B-4: agy-cancel sets cancellationPending + deduplicates session/cancel, queued cancel is fenced past promptRpcCompleted, and queued auto-allow is dropped on controlDrainActive', async () => {
    const { cwd, appDataDir } = await createEnv()

    // Part 1: 'agy-cancel' closes steer lease immediately and deduplicates with abort()+dispose() to 1 session/cancel.
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      const runId = randomUUID()
      const permStarted = Promise.withResolvers<void>()
      const releasePerm = Promise.withResolvers<string>()
      let promptId: unknown
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          promptId = frame.id
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-cancel-b4',
            method: 'session/request_permission',
            params: {
              sessionId: sid,
              toolCall: { toolCallId: 'tc-b4-1', name: 'run_command', title: 'Run cmd' },
              options: [
                { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const abort = new AbortController()
      const runPromise = collectEvents(
        adapter.run(
          makeRunInput(cwd, {
            runId,
            host: {
              interactions: {
                requestPermission: async () => {
                  permStarted.resolve()
                  return releasePerm.promise
                },
              },
            },
          }),
          abort.signal,
        ),
      )
      try {
        await permStarted.promise
        releasePerm.resolve('agy-cancel')
        await vi.waitFor(() => {
          expect(harness.notifications.filter((n) => n.method === 'session/cancel')).toHaveLength(1)
        })
        // Steer MUST be refused immediately once 'agy-cancel' latched cancellationPending!
        const lateSteerRes = await adapter.steer(
          {
            runId,
            inputId: randomUUID(),
            nativeSessionId: sid,
            nativeTurnId: runId,
            bindingGeneration: 1,
            nativeGeneration: runId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: randomUUID(),
              message: { id: randomUUID(), content: 'Late steer' },
              comments: [],
            },
            recordDispatch: () => undefined,
            recordConsumption: () => undefined,
          },
          new AbortController().signal,
        )
        expect(lateSteerRes.status).toBe('rejected')
        expect(harness.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(1)
        // Subsequent abort() + dispose() MUST NOT send a second session/cancel!
        abort.abort()
        harness.sendToClient({
          jsonrpc: '2.0',
          id: promptId,
          result: { stopReason: 'cancelled' },
        })
        await runPromise.catch(() => undefined)
        await adapter.dispose()
        expect(harness.notifications.filter((n) => n.method === 'session/cancel')).toHaveLength(1)
      } finally {
        await adapter.dispose()
      }
    }

    // Part 2: Queued Run 1 session/cancel behind paused stdin is dropped once promptRpcCompleted flips before Run 2 starts!
    {
      const harness = createAcpHarness({ highWaterMark: 16 })
      const sid = randomUUID()
      const prompt1Seen = Promise.withResolvers<unknown>()
      const blockerSeen = Promise.withResolvers<void>()
      let prompts = 0
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
          prompts += 1
          if (prompts === 1) {
            prompt1Seen.resolve(frame.id)
          } else {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'RUN2_OK' },
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn', execution_id: 'exec-b4-run2' },
            })
          }
        } else if (frame.id === 'perm-blk-b4-cancel') {
          blockerSeen.resolve()
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const abort1 = new AbortController()
      const run1 = collectEvents(adapter.run(makeRunInput(cwd), abort1.signal))
      try {
        const prompt1Id = await prompt1Seen.promise
        harness.pauseStdin()
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-blk-b4-cancel',
          method: 'session/request_permission',
          params: {
            sessionId: sid,
            toolCall: { toolCallId: 'tc-blk-b4', name: 'run_command', title: 'Blocker' },
            options: [{ optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }],
            _meta: { sessionId: 'sess-foreign-blk' },
          },
        })
        await blockerSeen.promise
        // Abort queues session/cancel behind perm-blk-b4-cancel in OutboundFrameQueue.
        abort1.abort()
        await new Promise((r) => setTimeout(r, 20))
        expect(harness.notifications.filter((n) => n.method === 'session/cancel')).toHaveLength(0)
        // Run 1 finishes on stdout BEFORE stdin resumes -> promptRpcCompleted=true invalidates queued cancel!
        harness.sendToClient({
          jsonrpc: '2.0',
          id: prompt1Id,
          result: { stopReason: 'end_turn', execution_id: 'exec-b4-run1' },
        })
        await run1
        harness.resumeStdin()
        const events2 = await collectEvents(
          adapter.run(makeRunInput(cwd, { nativeSessionId: sid }), new AbortController().signal),
        )
        expect(harness.notifications.filter((n) => n.method === 'session/cancel')).toHaveLength(0)
        expect(events2).toContainEqual(
          expect.objectContaining({ type: 'text.completed', text: 'RUN2_OK' }),
        )
      } finally {
        harness.resumeStdin()
        await adapter.dispose()
      }
    }

    // Part 3: Queued MCP auto-allow behind paused stdin is dropped once consumer enters controlDrainActive!
    {
      const harness = createAcpHarness({ highWaterMark: 16 })
      const sid = randomUUID()
      const blockerSeen = Promise.withResolvers<void>()
      let mcpToolName = 'mcp_pact_peer_publish_session_title'
      let promptId: unknown
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          const params = frame.params as { mcpServers?: Array<{ name?: string }> }
          const srvName = params.mcpServers?.[0]?.name
          if (srvName) mcpToolName = `mcp_${srvName}_publish_session_title`
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
          promptId = frame.id
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'trigger-yield' },
              },
            },
          })
        } else if (frame.id === 'perm-blk-b4-allow') {
          blockerSeen.resolve()
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const sessionId = randomUUID()
      const stream = adapter.run(
        makeRunInput(cwd, {
          sessionId,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId,
            message: { id: randomUUID(), content: 'Auto allow fence test' },
            comments: [],
            requestSessionTitle: true,
          },
        }),
        new AbortController().signal,
      )
      try {
        for await (const ev of stream) {
          if (ev.type === 'text.delta') {
            harness.pauseStdin()
            harness.sendToClient({
              jsonrpc: '2.0',
              id: 'perm-blk-b4-allow',
              method: 'session/request_permission',
              params: {
                sessionId: sid,
                toolCall: { toolCallId: 'tc-blk-allow', name: 'run_command', title: 'Blocker' },
                options: [{ optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }],
                _meta: { sessionId: 'sess-foreign-blk' },
              },
            })
            await blockerSeen.promise
            harness.sendToClient({
              jsonrpc: '2.0',
              id: 'perm-mcp-auto-b4',
              method: 'session/request_permission',
              params: {
                sessionId: sid,
                toolCall: {
                  toolCallId: 'tc-mcp-auto-b4',
                  name: mcpToolName,
                  args: { title: 'Fenced title' },
                },
                options: [
                  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
                ],
              },
            })
            await new Promise((r) => setTimeout(r, 20))
            // Consumer exits early -> enters controlDrainActive (`foregroundReleased = true`) BEFORE stdin resumes!
            break
          }
        }
        harness.resumeStdin()
        await vi.waitFor(() => {
          expect(harness.responses.some((r) => r.id === 'perm-mcp-auto-b4')).toBe(true)
        })
        const autoResp = harness.responses.find((r) => r.id === 'perm-mcp-auto-b4')
        // Queued allow_once MUST be aborted by isFenceCurrent and fall back to cancelled (NEVER allow_once)!
        expect(autoResp?.result).toEqual({ outcome: { outcome: 'cancelled' } })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: promptId,
          result: { stopReason: 'end_turn' },
        })
      } finally {
        harness.resumeStdin()
        await adapter.dispose()
      }
    }
  })

  it('Carbon R2-B1: backpressured session/cancel dispatches across dispose/abort/agy-cancel while fencing post-abort replies without false unknown', async () => {
    const { cwd, appDataDir } = await createEnv()

    // Chain A1: Paused stdin + adapter.dispose() (no server reply) MUST still write 1 session/cancel when stdin resumes!
    {
      const harness = createAcpHarness({ highWaterMark: 16 })
      const sid = randomUUID()
      const promptSeen = Promise.withResolvers<unknown>()
      const blockerSeen = Promise.withResolvers<void>()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          promptSeen.resolve(frame.id)
        } else if (frame.id === 'blk-r2b1-a1') {
          blockerSeen.resolve()
        }
      })
      const sharedPool = new AgyAcpConnectionPool({
        executablePath: 'agy',
        processFactory: () => harness.child,
      })
      const adapter = new AgyAgentAdapter({ appDataDir, connectionPool: sharedPool })
      const run = collectEvents(adapter.run(makeRunInput(cwd), new AbortController().signal)).catch(
        () => [],
      )
      try {
        await promptSeen.promise
        harness.pauseStdin()
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'blk-r2b1-a1',
          method: 'session/request_permission',
          params: {
            sessionId: sid,
            toolCall: { toolCallId: 'tc-blk-a1', name: 'run_command', title: 'Blocker' },
            options: [{ optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }],
            _meta: { sessionId: 'sess-other-a1' },
          },
        })
        await blockerSeen.promise
        const disposePromise = adapter.dispose({ flushDeadlineAt: Date.now() + 2_000 })
        await new Promise((r) => setTimeout(r, 25))
        harness.resumeStdin()
        await disposePromise
        await run
        expect(harness.notifications.filter((n) => n.method === 'session/cancel')).toHaveLength(1)
      } finally {
        harness.resumeStdin()
        await adapter.dispose()
        await sharedPool.dispose()
      }
    }

    // Chain A2: Paused stdin + adapter.dispose() where server replies on stdout AFTER promptRpcAbort -> 0 session/cancel!
    {
      const harness = createAcpHarness({ highWaterMark: 16 })
      const sid = randomUUID()
      const promptSeen = Promise.withResolvers<unknown>()
      const blockerSeen = Promise.withResolvers<void>()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          promptSeen.resolve(frame.id)
        } else if (frame.id === 'blk-r2b1-a2') {
          blockerSeen.resolve()
        }
      })
      const sharedPool = new AgyAcpConnectionPool({
        executablePath: 'agy',
        processFactory: () => harness.child,
      })
      const adapter = new AgyAgentAdapter({ appDataDir, connectionPool: sharedPool })
      const run = collectEvents(adapter.run(makeRunInput(cwd), new AbortController().signal)).catch(
        () => [],
      )
      try {
        const promptId = await promptSeen.promise
        harness.pauseStdin()
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'blk-r2b1-a2',
          method: 'session/request_permission',
          params: {
            sessionId: sid,
            toolCall: { toolCallId: 'tc-blk-a2', name: 'run_command', title: 'Blocker' },
            options: [{ optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }],
            _meta: { sessionId: 'sess-other-a2' },
          },
        })
        await blockerSeen.promise
        const disposePromise = adapter.dispose({ flushDeadlineAt: Date.now() + 2_000 })
        await new Promise((r) => setTimeout(r, 20))
        // Server reply arrives on stdout AFTER promptRpcAbort ran, BEFORE stdin resumes -> physicalOutcome settles!
        harness.sendToClient({
          jsonrpc: '2.0',
          id: promptId,
          result: { stopReason: 'end_turn' },
        })
        await new Promise((r) => setTimeout(r, 20))
        harness.resumeStdin()
        await disposePromise
        await run
        expect(harness.notifications.filter((n) => n.method === 'session/cancel')).toHaveLength(0)
      } finally {
        harness.resumeStdin()
        await adapter.dispose()
        await sharedPool.dispose()
      }
    }

    // Chain B & C: Paused stdin + 'agy-cancel' followed by abort() + dispose() -> still writes 1 session/cancel!
    {
      const harness = createAcpHarness({ highWaterMark: 16 })
      const sid = randomUUID()
      const permStarted = Promise.withResolvers<void>()
      const releasePerm = Promise.withResolvers<string>()
      const blockerSeen = Promise.withResolvers<void>()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-r2b1-c',
            method: 'session/request_permission',
            params: {
              sessionId: sid,
              toolCall: { toolCallId: 'tc-r2b1-c', name: 'run_command', title: 'Run' },
              options: [
                { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
        } else if (frame.id === 'blk-r2b1-c') {
          blockerSeen.resolve()
        }
      })
      const sharedPool = new AgyAcpConnectionPool({
        executablePath: 'agy',
        processFactory: () => harness.child,
      })
      const adapter = new AgyAgentAdapter({ appDataDir, connectionPool: sharedPool })
      const abort = new AbortController()
      const run = collectEvents(
        adapter.run(
          makeRunInput(cwd, {
            host: {
              interactions: {
                requestPermission: async () => {
                  permStarted.resolve()
                  return releasePerm.promise
                },
              },
            },
          }),
          abort.signal,
        ),
      ).catch(() => [])
      try {
        await permStarted.promise
        harness.pauseStdin()
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'blk-r2b1-c',
          method: 'session/request_permission',
          params: {
            sessionId: sid,
            toolCall: { toolCallId: 'tc-blk-c', name: 'run_command', title: 'Blocker' },
            options: [{ optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }],
            _meta: { sessionId: 'sess-other-c' },
          },
        })
        await blockerSeen.promise
        releasePerm.resolve('agy-cancel')
        await new Promise((r) => setTimeout(r, 20))
        abort.abort()
        const disposePromise = adapter.dispose({ flushDeadlineAt: Date.now() + 2_000 })
        await new Promise((r) => setTimeout(r, 20))
        harness.resumeStdin()
        await disposePromise
        await run
        expect(harness.notifications.filter((n) => n.method === 'session/cancel')).toHaveLength(1)
      } finally {
        harness.resumeStdin()
        await adapter.dispose()
        await sharedPool.dispose()
      }
    }

    // Chain D: Paused stdin + abort() + end_turn while waitForRootOutput holds !rootTerminal ->
    // fenced cancel does NOT reportUnknown; final reportNativeEffects is 'settled'!
    {
      const harness = createAcpHarness({ highWaterMark: 16 })
      const sid = randomUUID()
      const promptSeen = Promise.withResolvers<unknown>()
      const blockerSeen = Promise.withResolvers<void>()
      const waitStarted = Promise.withResolvers<void>()
      const releaseWait = Promise.withResolvers<void>()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          promptSeen.resolve(frame.id)
        } else if (frame.id === 'blk-r2b1-d') {
          blockerSeen.resolve()
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const abort = new AbortController()
      const effects: Array<{ state: string }> = []
      const run = collectEvents(
        adapter.run(
          makeRunInput(cwd, {
            host: {
              lifecycle: {
                waitForRootOutput: async () => {
                  waitStarted.resolve()
                  await releaseWait.promise
                },
              },
              effects: { reportNativeEffects: (r) => effects.push({ state: r.state }) },
            },
          }),
          abort.signal,
        ),
      )
      try {
        const promptId = await promptSeen.promise
        harness.pauseStdin()
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'blk-r2b1-d',
          method: 'session/request_permission',
          params: {
            sessionId: sid,
            toolCall: { toolCallId: 'tc-blk-d', name: 'run_command', title: 'Blocker' },
            options: [{ optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }],
            _meta: { sessionId: 'sess-other-d' },
          },
        })
        await blockerSeen.promise
        abort.abort()
        await new Promise((r) => setTimeout(r, 20))
        harness.sendToClient({
          jsonrpc: '2.0',
          id: promptId,
          result: { stopReason: 'end_turn', execution_id: 'exec-r2b1-d' },
        })
        await waitStarted.promise
        // Resume stdin WHILE waitForRootOutput is still paused (`rootTerminal === false`)!
        harness.resumeStdin()
        await new Promise((r) => setTimeout(r, 30))
        releaseWait.resolve()
        await run
        expect(harness.notifications.filter((n) => n.method === 'session/cancel')).toHaveLength(0)
        expect(effects.some((e) => e.state === 'unknown')).toBe(false)
        expect(effects.at(-1)?.state).toBe('settled')
      } finally {
        releaseWait.resolve()
        harness.resumeStdin()
        await adapter.dispose()
      }
    }
  })

  it('Clean User Stop: shares single monotonic deadline, suppresses late reasoning.summary.completed, and maps cancel-caused tool failed to interrupted', async () => {
    const { cwd, appDataDir } = await createEnv()
    // 1. Settled cancel: maps tool failed -> interrupted, suppresses post-Stop reasoning.summary.completed, preserves runtime reuse.
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      const promptSeen = Promise.withResolvers<unknown>()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          promptSeen.resolve(frame.id)
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-agy-stop',
                title: 'Run shell command',
                kind: 'execute',
                status: 'in_progress',
              },
            },
          })
          // Open thought right before Stop so A4 suppression of post-Stop reasoning.summary.completed is exercised.
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'Thinking while tool runs before stop' },
              },
            },
          })
        } else if (frame.method === 'session/cancel') {
          void promptSeen.promise.then((promptId) => {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'tc-agy-stop',
                  status: 'failed',
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              id: promptId,
              result: { stopReason: 'cancelled', execution_id: 'exec-agy-stop' },
            })
            return undefined
          })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const abort = new AbortController()
      const archived: NormalizedAgentEvent[] = []
      const effects: string[] = []
      const runPromise = collectEvents(
        adapter.run(
          makeRunInput(cwd, {
            host: {
              effects: {
                recordArchivedEvent: (ev) => archived.push(ev),
                reportNativeEffects: (r) => effects.push(r.state),
              },
            },
          }),
          abort.signal,
        ),
      )
      try {
        await promptSeen.promise
        await new Promise((r) => setTimeout(r, 20))
        abort.abort(createRunStopAbortReason('user_stop'))
        const events = await runPromise
        const allEvents = [...events, ...archived]
        expect(allEvents.some((e) => e.type === 'reasoning.summary.completed')).toBe(false)
        expect(allEvents).toContainEqual(
          expect.objectContaining({
            type: 'tool.completed',
            toolCallId: 'tc-agy-stop',
            outcome: 'interrupted',
          }),
        )
        expect(effects.at(-1)).toBe('settled')
      } finally {
        await adapter.dispose()
      }
    }

    // 2. Unresponsive prompt after user_stop respects single monotonic deadline (no extra 1.5s overflow).
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      const promptSeen = Promise.withResolvers<void>()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          promptSeen.resolve()
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const abort = new AbortController()
      const timeoutEffects: string[] = []
      const runPromise = collectEvents(
        adapter.run(
          makeRunInput(cwd, {
            host: {
              effects: { reportNativeEffects: (r) => timeoutEffects.push(r.state) },
            },
          }),
          abort.signal,
        ),
      ).catch((error: unknown) => error)
      try {
        await promptSeen.promise
        const startedAt = performance.now()
        abort.abort(createRunStopAbortReason('user_stop', startedAt + 120))
        const error = await runPromise
        const elapsedMs = performance.now() - startedAt
        expect(error).toMatchObject({ kind: 'agent_process_crash' })
        expect(timeoutEffects).toContain('unknown')
        // Must NOT add an extra 1500ms awaitPhysicalCompletionBounded wait past the monotonic deadline!
        expect(elapsedMs).toBeLessThan(900)
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('Plan A+: Agy Carbon F2 reasons, Astra #3 post-Stop hidden answer retention, and B2 10s recordingTail budget', async () => {
    const { cwd, appDataDir } = await createEnv()

    // 1. Carbon F2: 0-byte exit after session.started reports 'workflow_input_withheld' on guard withhold
    // and 'native_turn_not_started' on user_stop before first byte.
    for (const mode of ['withheld', 'user_stop'] as const) {
      const harness = createAcpHarness()
      const sid = randomUUID()
      const abort = new AbortController()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
        } else if (frame.method === 'session/close') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const effects: Array<{ state: string; reason?: string | undefined }> = []
      try {
        await expect(
          (async () => {
            for await (const ev of adapter.run(
              makeRunInput(cwd, {
                host: {
                  recovery: {
                    inputSha256: 'sha-f2',
                    canDispatch: () => mode !== 'withheld',
                    recordEffectiveSettings: () => {},
                    recordConfirmedUnsent: () => {},
                  },
                  effects: {
                    reportNativeEffects: (r) => effects.push(r),
                  },
                },
              }),
              abort.signal,
            )) {
              if (mode === 'user_stop' && ev.type === 'session.started') {
                abort.abort(createRunStopAbortReason('user_stop'))
              }
            }
          })(),
        ).rejects.toThrow(mode === 'withheld' ? /withheld/u : /./u)
        expect(effects.at(-1)).toMatchObject({
          state: 'settled',
          reason: mode === 'withheld' ? 'workflow_input_withheld' : 'native_turn_not_started',
        })
      } finally {
        await adapter.dispose()
      }
    }

    // 2. Astra #3: explicit user_stop freezes foreground delta while retaining valid root suffix in hidden answer.
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      const firstDeltaSeen = Promise.withResolvers<void>()
      let promptId: unknown
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          promptId = frame.id
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Prefix ' },
              },
            },
          })
        } else if (frame.method === 'session/cancel') {
          void firstDeltaSeen.promise.then(() => {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Hidden suffix' },
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              id: promptId,
              result: { stopReason: 'end_turn', execution_id: 'exec-agy-hidden' },
            })
            return undefined
          })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const abort = new AbortController()
      const recordedOutputs: string[] = []
      const foregroundDeltas: string[] = []
      const completedTexts: string[] = []
      try {
        for await (const ev of adapter.run(
          makeRunInput(cwd, {
            host: {
              lifecycle: {
                recordNativeEvidence: (evidence) => {
                  if (evidence.kind === 'ended' && evidence.output?.text) {
                    recordedOutputs.push(evidence.output.text)
                  }
                },
              },
            },
          }),
          abort.signal,
        )) {
          if (ev.type === 'text.delta') {
            foregroundDeltas.push(ev.text)
            if (!abort.signal.aborted) {
              abort.abort(createRunStopAbortReason('user_stop'))
              firstDeltaSeen.resolve()
            }
          } else if (ev.type === 'text.completed') {
            completedTexts.push(ev.text)
          }
        }
        expect(foregroundDeltas).toEqual(['Prefix '])
        expect(completedTexts).toEqual(['Prefix Hidden suffix'])
        expect(recordedOutputs).toEqual(['Prefix Hidden suffix'])
      } finally {
        await adapter.dispose()
      }
    }

    // 3. B2-first-half: prompt returns cancelled quickly while workspace recording blocks past Stop deadline ->
    // foreground exits at Stop deadline with `unknown` while recording finishes safely in background.
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      const recordingStarted = Promise.withResolvers<void>()
      const releaseRecording = Promise.withResolvers<void>()
      let recordingSignalAborted = false
      let promptId: unknown
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
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
          promptId = frame.id
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-slow-rec',
                name: 'edit_file',
                status: 'completed',
                args: { Path: join(cwd, 'slow.txt') },
                content: [
                  {
                    type: 'diff',
                    path: join(cwd, 'slow.txt'),
                    oldText: 'before',
                    newText: 'after',
                  },
                ],
              },
            },
          })
        } else if (frame.method === 'session/cancel') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: promptId,
            result: { stopReason: 'cancelled', execution_id: 'exec-slow-rec' },
          })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const abort = new AbortController()
      const effects: string[] = []
      const runInput = makeRunInput(cwd, {
        host: {
          effects: {
            recordFileChange: async (_change, sig) => {
              sig?.addEventListener('abort', () => {
                recordingSignalAborted = true
              })
              recordingStarted.resolve()
              await releaseRecording.promise
            },
            reportNativeEffects: (r) => effects.push(r.state),
          },
        },
      })
      try {
        const runPromise = collectEvents(adapter.run(runInput, abort.signal))
        await recordingStarted.promise
        const startedAt = performance.now()
        abort.abort(createRunStopAbortReason('user_stop', startedAt + 150))
        await runPromise
        const elapsedMs = performance.now() - startedAt
        expect(elapsedMs).toBeLessThan(900)
        expect(effects).toContain('unknown')
        expect(recordingSignalAborted).toBe(false)
        expect(adapter.hasActiveBackgroundWork(runInput.runId)).toBe(true)
        releaseRecording.resolve()
        await vi.waitFor(() => expect(adapter.hasActiveBackgroundWork(runInput.runId)).toBe(false))
      } finally {
        releaseRecording.resolve()
        await adapter.dispose()
      }
    }
  })

  it('Carbon Final Finding 1: preserves NativeInputWithheldError and workflow_input_withheld across onDispatch and pre-activeRun guards', async () => {
    const { cwd, appDataDir } = await createEnv()

    // Path A: Regular workflow run without host.recovery.canDispatch where recordDispatch('possibly_sent')
    // throws NativeInputWithheldError before first byte is written.
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { sessionId: sid, configOptions: defaultConfigOptions() },
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option' ||
          frame.method === 'session/close'
        ) {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { configOptions: defaultConfigOptions() },
          })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const dispatches: string[] = []
      const effects: Array<{ state: string; reason?: string | undefined }> = []
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeRunInput(cwd, {
                host: {
                  lifecycle: {
                    recordDispatch: (phase) => {
                      dispatches.push(phase)
                      if (phase === 'possibly_sent') {
                        throw new NativeInputWithheldError('Workflow paused before dispatch.')
                      }
                    },
                  },
                  effects: {
                    reportNativeEffects: (r) => effects.push({ state: r.state, reason: r.reason }),
                  },
                },
              }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrowError(NativeInputWithheldError)
        expect(harness.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(0)
        expect(dispatches).toEqual(['possibly_sent', 'rejected'])
        expect(effects.at(-1)).toEqual({ state: 'settled', reason: 'workflow_input_withheld' })
      } finally {
        await adapter.dispose()
      }
    }

    // Path B: Pre-activeRun recovery.expected mismatch throws NativeInputWithheldError, records rejected,
    // and reports settled(workflow_input_withheld) even before activeRun is initialized.
    {
      const harness = createAcpHarness()
      const sid = randomUUID()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { sessionId: sid, configOptions: defaultConfigOptions() },
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option' ||
          frame.method === 'session/close'
        ) {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { configOptions: defaultConfigOptions() },
          })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const dispatches: string[] = []
      const effects: Array<{ state: string; reason?: string | undefined }> = []
      let unsentCount = 0
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeRunInput(cwd, {
                host: {
                  lifecycle: {
                    recordDispatch: (phase) => {
                      dispatches.push(phase)
                    },
                  },
                  recovery: {
                    inputSha256: 'expected-mismatch-sha',
                    expected: {
                      executorId: 'different-executor',
                      nativeSessionId: 'different-sid',
                      settings: {
                        version: 1,
                        provider: 'agy',
                        model: 'gemini-4-carbon',
                        effort: { known: true, value: 'high' },
                        speed: 'native',
                        permissionMode: 'native',
                        configurationSha256: '0'.repeat(64),
                        provenance: 'agy_applied_settings',
                      },
                    },
                    recordEffectiveSettings: () => undefined,
                    recordConfirmedUnsent: () => {
                      unsentCount += 1
                    },
                  },
                  effects: {
                    reportNativeEffects: (r) => effects.push({ state: r.state, reason: r.reason }),
                  },
                },
              }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrowError(NativeInputWithheldError)
        expect(harness.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(0)
        expect(unsentCount).toBe(1)
        expect(dispatches).toContain('rejected')
        expect(effects.at(-1)).toEqual({ state: 'settled', reason: 'workflow_input_withheld' })
      } finally {
        await adapter.dispose()
      }
    }
  })
})
