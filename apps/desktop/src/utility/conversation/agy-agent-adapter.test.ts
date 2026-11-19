/* oxlint-disable typescript/no-unsafe-type-assertion, no-await-in-loop -- ACP protocol harness models stdio streams, JSON-RPC frames, and sequential stream-step assertions directly. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentNativeForkBoundary,
  AgentNativeForkWitness,
  AgentRunInput,
} from '@pact/agent-runtime'
import type {
  CollaborationTask,
  CollaborationTurnAuthorization,
  NativeBackgroundReport,
  NormalizedAgentEvent,
} from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { AgyAcpConnectionPool } from './agy-acp-connection.js'
import {
  AgyAgentAdapter,
  agyElicitationRequest,
  type AgyNativeStorageClient,
} from './agy-agent-adapter.js'
import { setPromptCutoffSupplement } from './native-image-content.js'

const tempDirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface AcpHarness {
  child: ChildProcessWithoutNullStreams
  requests: Array<Record<string, unknown>>
  responses: Array<Record<string, unknown>>
  notificationsFromClient: Array<Record<string, unknown>>
  sendToClient(frame: object): void
  sendRawStdout(text: string): void
  onClientFrame(handler: (frame: Record<string, unknown>) => void | Promise<void>): void
}

function createAcpHarness(): AcpHarness {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const requests: Array<Record<string, unknown>> = []
  const responses: Array<Record<string, unknown>> = []
  const notificationsFromClient: Array<Record<string, unknown>> = []
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
          } else if (typeof frame.method === 'string') {
            notificationsFromClient.push(frame)
          } else {
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
    pid: 51_510,
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
      emitter.emit('exit', 0, sig)
      emitter.emit('close', 0, sig)
      return true
    },
  })
  const child = childRecord as unknown as ChildProcessWithoutNullStreams

  return {
    child,
    requests,
    responses,
    notificationsFromClient,
    sendToClient(frame: object) {
      stdout.write(`${JSON.stringify(frame)}\n`)
    },
    sendRawStdout(text: string) {
      stdout.write(text)
    },
    onClientFrame(fn) {
      handler = fn
    },
  }
}

async function createEnv(): Promise<{ cwd: string; appDataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pact-agy-adapter-'))
  tempDirs.push(root)
  const cwd = join(root, 'workspace')
  const appDataDir = join(root, 'antigravity-cli')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(appDataDir, 'brain'), { recursive: true })
  return { cwd, appDataDir }
}

function makeBaseRunInput(cwd: string, overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  const sessionId = overrides.sessionId ?? randomUUID()
  const runId = overrides.runId ?? randomUUID()
  return {
    sessionId,
    runId,
    cwd,
    model: 'gemini-4-carbon',
    effort: 'high',
    speed: 'native',
    permissionMode: 'ask',
    promptEnvelope: {
      version: 'pact-agent-prompt-v1',
      sessionId,
      message: { id: randomUUID(), content: 'Inspect repository state.' },
      comments: [],
    },
    ...overrides,
  }
}

function makeCollaborationTask(
  sessionId: string,
  runId: string,
  stage: CollaborationTask['stage'],
  kind: CollaborationTask['kind'] = 'plan',
): { task: CollaborationTask; authorization: CollaborationTurnAuthorization } {
  const taskId = randomUUID()
  const msgId = randomUUID()
  const actor: CollaborationTask['actor'] = 'agy'
  const reviewer: CollaborationTask['reviewer'] = 'codex'
  const authorization: CollaborationTurnAuthorization = {
    runId,
    taskId,
    actor,
    taskRevision: 0,
    stage,
    inputSequence: 0,
  }
  const task: CollaborationTask = {
    protocol: 'native-workflow-v1',
    id: taskId,
    sessionId,
    runId,
    taskMessageId: msgId,
    task: 'Design and verify feature.',
    kind,
    revision: 0,
    owner: stage === 'plan_review' || stage === 'code_review' ? reviewer : actor,
    reviewer: stage === 'plan_review' || stage === 'code_review' ? actor : reviewer,
    actor,
    authorization,
    stage,
    status: 'running',
    automation: 'active',
    inputSequence: 0,
    handledInputSequence: 0,
    planVersion: stage === 'plan' ? 0 : 1,
    discussionRounds: 0,
    reviewCycles: 0,
    repairAttempts: 0,
  }
  return { task, authorization }
}

async function waitUntilCondition(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!predicate()) throw new Error('Waiting for condition')
  })
}

async function collectEvents(
  iterable: AsyncIterable<NormalizedAgentEvent>,
): Promise<NormalizedAgentEvent[]> {
  const out: NormalizedAgentEvent[] = []
  for await (const ev of iterable) out.push(ev)
  return out
}

function defaultSessionNewResult(sessionId = 'sid-agy-1', modeId = 'default') {
  return {
    sessionId,
    modes: {
      currentModeId: modeId,
      availableModes: ['default', 'accept-edits', 'auto', 'plan'],
    },
    models: {
      currentModelId: 'gemini-4-carbon-medium',
      availableModels: ['gemini-4-carbon-medium', 'gemini-4-carbon-high'],
    },
    configOptions: [
      {
        id: 'model',
        currentValue: 'gemini-4-carbon',
        options: [{ value: 'gemini-4-carbon' }, { value: 'gemini-3.8-flash' }],
      },
      {
        id: 'thought_level',
        currentValue: 'medium',
        options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      },
    ],
  }
}

describe('AgyAgentAdapter probe, permissions, and B4 read-only ironclad wall', () => {
  it('verifies minimum CLI version >= 1.5.9 in probe()', async () => {
    const adapterOk = new AgyAgentAdapter({
      probeProcessFactory() {
        const harness = createAcpHarness()
        queueMicrotask(() => {
          harness.sendRawStdout('agy version 1.5.9\n')
          harness.child.kill()
        })
        return { child: harness.child }
      },
    })
    await expect(adapterOk.probe()).resolves.toEqual({
      id: 'agy',
      available: true,
      version: '1.5.9',
    })
    await adapterOk.dispose()

    const adapterOld = new AgyAgentAdapter({
      probeProcessFactory() {
        const harness = createAcpHarness()
        queueMicrotask(() => {
          harness.sendRawStdout('agy version 1.5.8\n')
          harness.child.kill()
        })
        return { child: harness.child }
      },
    })
    const oldRes = await adapterOld.probe()
    expect(oldRes.available).toBe(false)
    expect(oldRes.version).toBe('1.5.8')
    await adapterOld.dispose()
  })

  it('enforces B4 read-only wall across plan/review/respond/reply, auto-allows only verified root Pact MCP tools, rejects workspace edits even when allow is options[0], and retires plan mode before next Run', async () => {
    const { cwd, appDataDir } = await createEnv()
    const scopesSpawned: string[] = []
    const harness = createAcpHarness()
    let mcpDescriptorUrl = ''
    let mcpServerName = ''

    let badMcpIsError: unknown = false
    let promptCount = 0

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        const params = frame.params as Record<string, unknown>
        const servers = params.mcpServers as Array<{ name: string; url: string }>
        if (servers?.[0]) {
          mcpServerName = servers[0].name
          mcpDescriptorUrl = servers[0].url
        }
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-plan-wall', 'accept-edits'),
        })
        return
      }
      if (frame.method === 'session/load') {
        // Emit replayed historical chunk BEFORE returning session/load to prove replay is suppressed!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-plan-wall',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'replayed-msg-0',
              content: { type: 'text', text: 'REPLAYED_HISTORY_MUST_NOT_LEAK' },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-plan-wall', 'plan'),
        })
        return
      }
      if (frame.method === 'session/set_mode') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        return
      }
      if (frame.method === 'session/set_config_option') {
        const p = frame.params as { configId: string; value: string }
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [
              { id: 'model', currentValue: 'gemini-4-carbon' },
              {
                id: 'thought_level',
                currentValue: p.configId === 'thought_level' ? p.value : 'high',
              },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        promptCount += 1
        if (promptCount === 1) {
          // 1. Permission request for verified root Pact MCP tool -> MUST auto-allow ('allow')!
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-mcp-ok',
            method: 'session/request_permission',
            params: {
              sessionId: 'sid-plan-wall',
              toolCall: {
                toolCallId: 'tc-mcp',
                name: `mcp_${mcpServerName}_read_collaboration_source`,
              },
              options: [
                { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
                { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })

          // 2. Permission request for workspace write_file where options[0] is 'allow' -> MUST pick 'deny' ('reject_once'), NEVER options[0]!
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-ws-write',
            method: 'session/request_permission',
            params: {
              sessionId: 'sid-plan-wall',
              toolCall: {
                toolCallId: 'tc-write',
                name: 'write_file',
                args: { Path: join(cwd, 'forbidden.txt'), Content: 'nope' },
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })

          // 3. Permission request for run_command -> MUST pick 'deny'!
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-ws-cmd',
            method: 'session/request_permission',
            params: {
              sessionId: 'sid-plan-wall',
              toolCall: {
                toolCallId: 'tc-cmd',
                name: 'run_command',
                args: { CommandLine: 'touch forbidden_cmd.txt' },
              },
              options: [
                { optionId: 'allow_first', name: 'Allow', kind: 'allow_once' },
                { optionId: 'custom_reject', name: 'Reject', kind: 'reject_once' },
              ],
            },
          })

          // Wait until Adapter answers all 3 permission prompts, then emit Phase-1 brain plan artifact & complete!
          await waitUntilCondition(() => harness.responses.length >= 3)

          // Also invoke MCP read_collaboration_source over HTTP with valid 4-tuple vs foreign root_conversation_id!
          if (mcpDescriptorUrl) {
            const badMcpRes = await fetch(mcpDescriptorUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name: 'read_collaboration_source',
                  arguments: {},
                  _meta: {
                    'antigravity.google/root_conversation_id': 'foreign-sid',
                    progressToken: 'pt-bad',
                  },
                },
              }),
            }).then((r) => r.json() as Promise<Record<string, unknown>>)
            badMcpIsError = (badMcpRes.result as Record<string, unknown>).isError
          }

          const brainPlanPath = join(appDataDir, 'brain', 'sid-plan-wall', 'implementation_plan.md')
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-plan-wall',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-plan-1',
                name: 'write_file',
                title: 'Write implementation plan',
                status: 'completed',
                args: {
                  Path: brainPlanPath,
                  Content: '# Approved Plan\n1. Isolate pools.\n',
                  ArtifactMetadata: {
                    Summary: 'Implementation plan',
                    UserFacing: true,
                    RequestFeedback: true,
                  },
                },
                content: [
                  {
                    type: 'diff',
                    path: brainPlanPath,
                    newText: '# Approved Plan\n1. Isolate pools.\n',
                  },
                ],
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-plan-wall',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Plan is ready for review.' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        } else {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-plan-wall',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Implemented cleanly.' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory(_cwd, _args, scope) {
        scopesSpawned.push(scope)
        return harness.child
      },
    })

    const sessionId = randomUUID()
    const run1Id = randomUUID()
    const { task, authorization } = makeCollaborationTask(sessionId, run1Id, 'plan')
    const capturedPlans: Array<{ nativeId: string; text: string }> = []
    const requestPermissionSpy = vi.fn<NonNullable<AgentRunInput['requestPermission']>>()

    // Even if session permissionMode is 'full', read-only stage MUST use 'standard' connection!
    const run1Input = makeBaseRunInput(cwd, {
      sessionId,
      runId: run1Id,
      permissionMode: 'full',
      speed: 'fast',
      requestPermission: requestPermissionSpy,
      recordWorkflowPlan: (plan) => capturedPlans.push(plan),
      readCollaborationSourcePart: () => ({
        source: 'inputs',
        offset: 0,
        nextOffset: null,
        totalBytes: 2,
        text: '[]',
      }),
      promptEnvelope: {
        version: 'pact-agent-prompt-v1',
        sessionId,
        message: { id: randomUUID(), content: '/plan Build safe adapter' },
        comments: [],
        sourceGrant: { runId: run1Id, grant: 'g-1' },
        collaboration: task,
        collaborationAuthorization: authorization,
      },
    })

    const run1Events = await collectEvents(adapter.run(run1Input, new AbortController().signal))
    expect(scopesSpawned).toEqual(['standard'])
    expect(requestPermissionSpy).not.toHaveBeenCalled()
    expect(badMcpIsError).toBe(true)

    // Confirm modeId='plan' was set BEFORE session/prompt!
    const methodOrder1 = harness.requests.map((r) => r.method)
    expect(methodOrder1.indexOf('session/set_mode')).toBeGreaterThan(-1)
    expect(methodOrder1.indexOf('session/set_mode')).toBeLessThan(
      methodOrder1.indexOf('session/prompt'),
    )
    expect(harness.requests.find((r) => r.method === 'session/set_mode')?.params).toEqual({
      sessionId: 'sid-plan-wall',
      modeId: 'plan',
    })

    // Confirm speed stays 'native' (never claims speed: 'fast')!
    const speedEv = run1Events.find((e) => e.type === 'run.speed.resolved')
    expect(speedEv).toMatchObject({
      type: 'run.speed.resolved',
      requested: 'fast',
    })
    expect(speedEv && 'speed' in speedEv ? speedEv.speed : undefined).toBeUndefined()

    // Confirm exact permission responses: MCP -> 'allow', workspace write -> 'deny', workspace cmd -> 'custom_reject'!
    expect(harness.responses).toEqual([
      {
        jsonrpc: '2.0',
        id: 'perm-mcp-ok',
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      },
      {
        jsonrpc: '2.0',
        id: 'perm-ws-write',
        result: { outcome: { outcome: 'selected', optionId: 'deny' } },
      },
      {
        jsonrpc: '2.0',
        id: 'perm-ws-cmd',
        result: { outcome: { outcome: 'selected', optionId: 'custom_reject' } },
      },
    ])

    // Confirm Phase-1 brain plan candidate was persisted immediately and promoted on end_turn!
    expect(capturedPlans).toEqual([
      {
        nativeId: 'sid-plan-wall:tc-plan-1',
        text: '# Approved Plan\n1. Isolate pools.\n',
      },
    ])
    expect(run1Events).toContainEqual({
      agentId: 'agy',
      type: 'collaboration.plan',
      turnId: run1Id,
      nativeId: 'sid-plan-wall:tc-plan-1',
      text: '# Approved Plan\n1. Isolate pools.\n',
    })

    // Next Run on the same session in non-read-only 'native' mode MUST explicitly retire 'plan' -> 'accept-edits' (initial non-plan mode) and ignore session/load replay!
    const run2Id = randomUUID()
    const run2Input = makeBaseRunInput(cwd, {
      sessionId,
      runId: run2Id,
      nativeSessionId: 'sid-plan-wall',
      permissionMode: 'native',
    })
    const run2Events = await collectEvents(adapter.run(run2Input, new AbortController().signal))
    const setModeCalls = harness.requests.filter((r) => r.method === 'session/set_mode')
    expect(setModeCalls.at(-1)?.params).toEqual({
      sessionId: 'sid-plan-wall',
      modeId: 'accept-edits',
    })
    const run2Text = run2Events
      .filter(
        (e): e is Extract<NormalizedAgentEvent, { type: 'text.completed' }> =>
          e.type === 'text.completed',
      )
      .map((e) => e.text)
      .join('')
    expect(run2Text).toBe('Implemented cleanly.')
    expect(run2Text).not.toContain('REPLAYED_HISTORY_MUST_NOT_LEAK')

    await adapter.dispose()
  })

  it('enforces Ask (no allow_always), Auto (pre-prompt ACK or PermissionModeRejectedError + unsent proof), and Full access (explicitly denying residual permission prompts)', async () => {
    const { cwd, appDataDir } = await createEnv()
    let rejectAutoMode = true
    const fullHarness = createAcpHarness()
    const stdHarness = createAcpHarness()

    const wireHandler = (h: AcpHarness, isFull: boolean) => {
      h.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(isFull ? 'sid-full' : 'sid-std'),
          })
          return
        }
        if (frame.method === 'session/set_mode') {
          const p = frame.params as { modeId: string }
          if (p.modeId === 'auto' && rejectAutoMode) {
            h.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              error: { code: -32_602, message: 'Auto classifier disabled by policy.' },
            })
            return
          }
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          return
        }
        if (frame.method === 'session/set_config_option') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'gemini-4-carbon' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
          return
        }
        if (frame.method === 'session/prompt') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: isFull ? 'perm-residual-full' : 'perm-ask-1',
            method: 'session/request_permission',
            params: {
              sessionId: isFull ? 'sid-full' : 'sid-std',
              toolCall: {
                toolCallId: 'tc-1',
                name: 'run_command',
                title: 'Run echo test',
                args: { CommandLine: 'echo ok' },
              },
              options: [
                { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
                { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
          await waitUntilCondition(() => h.responses.length >= 1)
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })
    }
    wireHandler(stdHarness, false)
    wireHandler(fullHarness, true)

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory(_cwd, _args, scope) {
        return scope === 'full' ? fullHarness.child : stdHarness.child
      },
    })

    // 1. Auto mode rejected by native server BEFORE prompt -> PermissionModeRejectedError and zero session/prompt frames!
    await expect(
      collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, { permissionMode: 'auto' }),
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/Auto classifier disabled/u)
    expect(stdHarness.requests.some((r) => r.method === 'session/prompt')).toBe(false)

    // 2. Ask mode surfaces NativePermissionCard WITHOUT any 'rule' / allow_always option!
    rejectAutoMode = false
    let capturedCardActions: unknown[] = []
    await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          permissionMode: 'ask',
          async requestPermission(req) {
            capturedCardActions = req.actions ?? []
            return 'agy-allow-once'
          },
        }),
        new AbortController().signal,
      ),
    )
    expect(capturedCardActions).toEqual([
      { id: 'agy-allow-once', label: 'Allow once', kind: 'allow' },
      { id: 'agy-reject-once', label: 'Decline and continue', kind: 'decline' },
      { id: 'agy-cancel', label: 'Cancel this turn', kind: 'cancel' },
    ])
    expect(stdHarness.responses.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 'perm-ask-1',
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    })

    // 3. Full access (`requirements.md:517`) explicitly denies residual session/request_permission WITHOUT prompting UI!
    const fullUiSpy = vi.fn<NonNullable<AgentRunInput['requestPermission']>>()
    await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          permissionMode: 'full',
          requestPermission: fullUiSpy,
        }),
        new AbortController().signal,
      ),
    )
    expect(fullUiSpy).not.toHaveBeenCalled()
    expect(fullHarness.responses).toEqual([
      {
        jsonrpc: '2.0',
        id: 'perm-residual-full',
        result: { outcome: { outcome: 'selected', optionId: 'deny' } },
      },
    ])

    await adapter.dispose()
  })
})

describe('AgyAgentAdapter B5 Elicitation, S5 Title/Peer MCP, B8 Steer & Background, and Storage Seam', () => {
  it('routes elicitation/create to NativeInputCard, blocks credential fields, and fences late answers on cancellation', async () => {
    // Credential fields in elicitation schema must be blocked immediately!
    expect(() =>
      agyElicitationRequest({
        mode: 'form',
        message: 'Enter secret',
        requestedSchema: {
          type: 'object',
          properties: { api_key: { type: 'string', title: 'API Key' } },
        },
      }),
    ).toThrow(/Authentication credentials/u)

    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    let triggerSecondElicitation = false

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-elicit'),
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [
              { id: 'model', currentValue: 'gemini-4-carbon' },
              { id: 'thought_level', currentValue: 'high' },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: triggerSecondElicitation ? 'elicit-cancel' : 'elicit-accept',
          method: 'elicitation/create',
          params: {
            sessionId: 'sid-elicit',
            mode: 'form',
            title: 'Architecture choice',
            message: 'Select storage mode',
            requestedSchema: {
              type: 'object',
              properties: {
                storage: {
                  type: 'string',
                  title: 'Storage mode',
                  enum: ['sqlite', 'memory'],
                },
              },
              required: ['storage'],
            },
          },
        })
        await waitUntilCondition(
          () => harness.responses.length >= (triggerSecondElicitation ? 2 : 1),
        )
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: triggerSecondElicitation ? 'cancelled' : 'end_turn' },
        })
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
    })

    const events1 = await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          async requestUserInput(req) {
            expect(req.kind).toBe('form')
            expect(req.fields[0]).toMatchObject({
              id: 'storage',
              type: 'select',
              required: true,
            })
            return { action: 'accept', values: { storage: 'sqlite' } }
          },
        }),
        new AbortController().signal,
      ),
    )
    expect(events1).toContainEqual(
      expect.objectContaining({ type: 'interaction.requested', category: 'question' }),
    )
    expect(harness.responses[0]).toEqual({
      jsonrpc: '2.0',
      id: 'elicit-accept',
      result: { action: 'accept', content: { storage: 'sqlite' } },
    })

    // Now test cancellation while user input is pending: late answer must NOT be sent as 'accept'!
    triggerSecondElicitation = true
    const runAbort = new AbortController()
    await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          async requestUserInput(_req, waitSignal) {
            runAbort.abort()
            await new Promise((_r, rej) => {
              if (waitSignal.aborted) rej(new Error('aborted'))
              else waitSignal.addEventListener('abort', () => rej(new Error('aborted')))
            })
            return { action: 'accept', values: { storage: 'sqlite' } }
          },
        }),
        runAbort.signal,
      ),
    ).catch(() => undefined)

    expect(harness.responses[1]).toEqual({
      jsonrpc: '2.0',
      id: 'elicit-cancel',
      result: { action: 'cancel' },
    })

    await adapter.dispose()
  })

  it('verifies in-Turn steer (step_idx, execution_id) consumption receipts, marks boundary-crossing steers unconfirmed, and deduplicates post-turn Background updates', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    let rootPromptId: string | number | undefined
    let finishRootPrompt: (() => void) | undefined
    let simulateBoundaryCrossingSteer = false
    let mcpUrl = ''
    let mcpName = ''
    let subagentMcpIsError: unknown
    let missingConvMcpIsError: unknown

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        const servers = (frame.params as { mcpServers?: Array<{ name: string; url: string }> })
          .mcpServers
        mcpName = servers?.[0]?.name ?? ''
        mcpUrl = servers?.[0]?.url ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-steer'),
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [
              { id: 'model', currentValue: 'gemini-4-carbon' },
              { id: 'thought_level', currentValue: 'high' },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        const params = frame.params as Record<string, unknown>
        const meta = Reflect.get(params, '_meta') as Record<string, unknown> | undefined
        if (meta?.pactSteerInputId) {
          if (simulateBoundaryCrossingSteer) {
            // Return without step_idx/execution_id receipt while root closes -> boundary-crossing unconfirmed!
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn' },
            })
          } else {
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: {
                stopReason: 'end_turn',
                step_idx: 4,
                execution_id: 'exec-root-1',
              },
            })
          }
          return
        }

        rootPromptId = frame.id as string | number
        // Emit foreground chunk + background daemon launch + Side Chat publish_session_title MCP tool call!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-steer',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'fg-msg-1',
              execution_id: 'exec-root-1',
              trajectory_id: 'sid-steer',
              step_idx: 1,
              content: { type: 'text', text: 'Working on task...' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 5))

        if (mcpUrl) {
          // 1. Nested subagent sharing root_conversation_id MUST be rejected!
          const subRes = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 75,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Subagent hijack title' },
                _meta: {
                  'antigravity.google/root_conversation_id': 'sid-steer',
                  'antigravity.google/conversation_id': 'subagent-sid-99',
                  progressToken: 'pt-sub-1',
                },
              },
            }),
          }).then((r) => r.json() as Promise<Record<string, unknown>>)
          subagentMcpIsError = (subRes.result as Record<string, unknown>).isError

          // 2. Missing conversation_id MUST be rejected!
          const missingConvRes = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 76,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Missing conv title' },
                _meta: {
                  'antigravity.google/root_conversation_id': 'sid-steer',
                  progressToken: 'pt-missing-1',
                },
              },
            }),
          }).then((r) => r.json() as Promise<Record<string, unknown>>)
          missingConvMcpIsError = (missingConvRes.result as Record<string, unknown>).isError

          // 3. Valid root call with structured root trajectory progressToken 'sid-steer:2'
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 77,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Side chat investigation' },
                _meta: {
                  'antigravity.google/root_conversation_id': 'sid-steer',
                  'antigravity.google/conversation_id': 'sid-steer',
                  progressToken: 'sid-steer:2',
                },
              },
            }),
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-steer',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-title-1',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'completed',
                progressToken: 'sid-steer:2',
              },
            },
          })

          // 4. Staged call whose tool_call_update has a MISMATCHED progressToken MUST NOT fall back!
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 78,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Mismatched fallback title' },
                _meta: {
                  'antigravity.google/root_conversation_id': 'sid-steer',
                  'antigravity.google/conversation_id': 'sid-steer',
                  progressToken: 'sid-steer:3',
                },
              },
            }),
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-steer',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-title-mismatch',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'completed',
                progressToken: 'sid-steer:99',
              },
            },
          })
        }

        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-steer',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'bg-task-1',
              name: 'run_command',
              status: 'completed',
              args: { CommandLine: 'npm run watch', IsDaemon: true },
              rawOutput: { taskId: 'bg-task-1' },
            },
          },
        })

        finishRootPrompt = () => {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: rootPromptId,
            result: { stopReason: 'end_turn', execution_id: 'exec-root-1' },
          })
        }
      }
    })

    const backgroundReports: NativeBackgroundReport[] = []
    const effectReports: Array<{ state: string; reason?: string }> = []
    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
    })

    const sessionId = randomUUID()
    const runId = randomUUID()
    const cutoffId = randomUUID()
    const runInput = makeBaseRunInput(cwd, {
      sessionId,
      runId,
      recordBackgroundReport: async (report) => {
        backgroundReports.push(report)
      },
      reportNativeEffects: (r) => effectReports.push(r),
      promptEnvelope: {
        version: 'pact-agent-prompt-v1',
        sessionId,
        requestSessionTitle: true,
        message: { id: randomUUID(), content: 'Start side chat check' },
        comments: [],
      },
    })
    setPromptCutoffSupplement(runInput.promptEnvelope, {
      cutoffIds: [cutoffId],
      inlineTails: [{ cutoffId, text: 'Cutoff inline context' }],
    })

    const eventsPromise = collectEvents(adapter.run(runInput, new AbortController().signal))
    await vi.waitFor(() => {
      expect(finishRootPrompt).toBeTypeOf('function')
    })

    // Valid in-Turn steer with matching (step_idx, execution_id) -> accepted & consumed!
    const consumedSteerIds: string[] = []
    const steer1Id = randomUUID()
    const steerRes = await adapter.steer(
      {
        runId,
        inputId: steer1Id,
        nativeSessionId: 'sid-steer',
        nativeTurnId: runId,
        bindingGeneration: 1,
        nativeGeneration: runId,
        promptEnvelope: {
          version: 'pact-agent-prompt-v1',
          sessionId,
          message: { id: steer1Id, content: 'Follow-up in same turn' },
          comments: [],
        },
        recordDispatch: () => undefined,
        recordConsumption: (id) => consumedSteerIds.push(id),
      },
      new AbortController().signal,
    )
    expect(steerRes).toEqual({ status: 'accepted' })
    expect(consumedSteerIds).toEqual([steer1Id])

    // Verify root prompt stamped `pactRunId` into trailing `"pact-agent-prompt-v1"` JSON line,
    // while Steer prompt kept `"messageId": steer1Id` without `pactRunId`!
    const promptFrames = harness.requests.filter((r) => r.method === 'session/prompt')
    expect(promptFrames).toHaveLength(2)
    const rootPromptText =
      (promptFrames[0]!.params as { prompt: Array<{ type: string; text?: string }> }).prompt[0]
        ?.text ?? ''
    const rootLastJsonIdx = rootPromptText.lastIndexOf('\n{"')
    expect(rootLastJsonIdx).toBeGreaterThan(0)
    const rootLastJson = JSON.parse(rootPromptText.slice(rootLastJsonIdx + 1)) as Record<
      string,
      unknown
    >
    expect(rootLastJson.version).toBe('pact-agent-prompt-v1')
    expect(rootLastJson.pactRunId).toBe(runId)

    const steerPromptText =
      (promptFrames[1]!.params as { prompt: Array<{ type: string; text?: string }> }).prompt[0]
        ?.text ?? ''
    const steerLastJsonIdx = steerPromptText.lastIndexOf('\n{"')
    expect(steerLastJsonIdx).toBeGreaterThan(0)
    const steerLastJson = JSON.parse(steerPromptText.slice(steerLastJsonIdx + 1)) as Record<
      string,
      unknown
    >
    expect(steerLastJson.version).toBe('pact-agent-prompt-v1')
    expect(steerLastJson.messageId).toBe(steer1Id)
    expect(steerLastJson.pactRunId).toBeUndefined()

    finishRootPrompt!()
    const runEvents = await eventsPromise

    // R2: Subagent _meta, missing conversation_id, and mismatched progressToken MUST fail closed!
    expect(subagentMcpIsError).toBe(true)
    expect(missingConvMcpIsError).toBe(true)
    expect(runEvents).toContainEqual({
      agentId: 'agy',
      type: 'session.title.updated',
      title: 'Side chat investigation',
    })
    expect(runEvents.filter((e) => e.type === 'session.title.updated').map((e) => e.title)).toEqual(
      ['Side chat investigation'],
    )

    // Post-turn background updates:
    // 1. Replaying a foreground messageId ('fg-msg-1') MUST be ignored!
    harness.sendToClient({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sid-steer',
        update: {
          sessionUpdate: 'agent_message_chunk',
          outOfTurn: true,
          messageId: 'fg-msg-1',
          content: { type: 'text', text: 'Duplicate foreground text' },
        },
      },
    })
    // 2. Attributable out-of-turn completion update -> recorded ONCE, duplicate ignored!
    const bgUpdate = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sid-steer',
        update: {
          sessionUpdate: 'agent_message_chunk',
          outOfTurn: true,
          messageId: 'bg-complete-msg-9',
          content: { type: 'text', text: 'Background watcher finished build check.' },
        },
      },
    }
    harness.sendToClient(bgUpdate)
    harness.sendToClient(bgUpdate)

    await vi.waitFor(() => {
      expect(backgroundReports).toHaveLength(1)
    })
    expect(backgroundReports[0]).toMatchObject({
      agentId: 'agy',
      runId,
      nativeSessionId: 'sid-steer',
      nativeMessageId: 'bg-complete-msg-9',
      text: 'Background watcher finished build check.',
    })

    // Settle background task so retained lease closes cleanly.
    harness.sendToClient({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sid-steer',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'bg-task-1',
          status: 'completed',
        },
      },
    })

    // Boundary-crossing steer without (step_idx, execution_id) receipt MUST fail as unknown_delivery!
    simulateBoundaryCrossingSteer = true
    const run2Id = randomUUID()
    finishRootPrompt = undefined
    const events2Promise = collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          sessionId,
          runId: run2Id,
          reportNativeEffects: (r) => effectReports.push(r),
        }),
        new AbortController().signal,
      ),
    )
    await vi.waitFor(() => {
      expect(finishRootPrompt).toBeTypeOf('function')
    })

    await expect(
      adapter.steer(
        {
          runId: run2Id,
          inputId: randomUUID(),
          nativeSessionId: 'sid-steer',
          nativeTurnId: run2Id,
          bindingGeneration: 1,
          nativeGeneration: run2Id,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId,
            message: { id: randomUUID(), content: 'Uncertain boundary steer' },
            comments: [],
          },
          recordDispatch: () => undefined,
          recordConsumption: () => undefined,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/without an in-Turn/u)

    finishRootPrompt!()
    await expect(events2Promise).rejects.toThrow(/crossed the Turn boundary/u)
    expect(effectReports.some((r) => r.state === 'unknown')).toBe(true)

    await adapter.dispose()
  })

  it('integrates cleanly with AgyNativeStorageClient for zero-Turn Rebuild and Fork flows, enforcing replay and post-load witness hashes', async () => {
    const { cwd, appDataDir } = await createEnv()
    const allRequests: Array<Record<string, unknown>> = []
    let allocatedCounter = 0
    let omitReplayChunks = false

    const makeVerificationHarness = () => {
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        allRequests.push(frame)
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new') {
          allocatedCounter += 1
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(`sid-shell-${allocatedCounter}`),
          })
          return
        }
        if (frame.method === 'session/load') {
          const p = frame.params as { sessionId: string }
          if (!omitReplayChunks) {
            h.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: p.sessionId,
                update: {
                  sessionUpdate: 'user_message_chunk',
                  content: { type: 'text', text: 'Remember ORBITAL_7319' },
                },
              },
            })
            h.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: p.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Stored ORBITAL_7319.' },
                },
              },
            })
          }
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(p.sessionId),
          })
          return
        }
        if (frame.method === 'session/close') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        }
      })
      return h.child
    }

    const imgBytes = Buffer.from('rebuild-png')
    const imgPath = join(cwd, 'img.png')
    await writeFile(imgPath, imgBytes)
    const imgSha = createHash('sha256').update(imgBytes).digest('hex')
    const imgId = randomUUID()

    const boundary: AgentNativeForkBoundary = {
      nativeSessionId: 'sid-source',
      nativeCutId: 'step-5',
      nativeTurnId: 'exec-1',
      bindingGeneration: 1,
      throughSequence: 2,
      deliveryCursor: 0,
      prefixHash: 'b'.repeat(64),
      prefixRecords: 6,
      prefixBytes: 2048,
    }

    const postLoadRawHash = '9'.repeat(64)
    const postLoadRawBytes = 16_384
    const postLoadRawRecords = 6

    let observedResolvedImagePath: string | undefined
    let postLoadSeedVerified = false
    let confirmColdLoadCalls = 0
    const storageClient: AgyNativeStorageClient = {
      async writeRebuildSeed({ candidateSessionId, chunks }) {
        let count = 0
        for await (const entry of chunks) {
          count += 1
          if (entry.chunk.kind === 'image') {
            observedResolvedImagePath = entry.resolvedImages?.get(imgId)?.path
          }
        }
        expect(['sid-shell-1', 'sid-shell-2']).toContain(candidateSessionId)
        return {
          seedHash: 'c'.repeat(64),
          chunkCount: count,
          stepCount: 2,
          verifiedPrefixBytes: 512,
          verifiedPrefixSha256: 'c'.repeat(64),
          pbSha256: 'c'.repeat(64),
          pbBytes: 512,
        }
      },
      async confirmRebuildColdLoad({ nativeSessionId, sourceHash, pbSha256, pbBytes, stepCount }) {
        confirmColdLoadCalls += 1
        expect(stepCount).toBe(2)
        expect(pbSha256).toBe('c'.repeat(64))
        expect(pbBytes).toBe(512)
        return {
          kind: 'agy_rebuild_v1',
          nativeSessionId,
          sourceHash,
          pbSha256: 'a'.repeat(64),
          pbBytes: 1024,
          stepCount: 2,
          coldLoadVerifiedAt: '2026-11-19T12:00:00.000Z',
        }
      },
      async inspectRebuildSeed({ nativeSessionId, sourceHash }) {
        postLoadSeedVerified = true
        return {
          verified: confirmColdLoadCalls > 0,
          seedHash: 'c'.repeat(64),
          stepCount: 2,
          ...(confirmColdLoadCalls > 0 && sourceHash
            ? {
                initializationWitness: {
                  kind: 'agy_rebuild_v1',
                  nativeSessionId,
                  sourceHash,
                  pbSha256: 'a'.repeat(64),
                  pbBytes: 1024,
                  stepCount: 2,
                  coldLoadVerifiedAt: '2026-11-19T12:00:00.000Z',
                },
              }
            : {}),
        }
      },
      async prepareFork() {
        return boundary
      },
      async writeFork({ candidateSessionId, source }) {
        const witness: AgentNativeForkWitness = {
          version: 'pact-native-fork-v1',
          sourceNativeSessionId: source.nativeSessionId,
          nativeSessionId: candidateSessionId,
          sourceCutId: source.nativeCutId,
          sourcePrefixHash: source.prefixHash,
          candidatePrefixHash: 'd'.repeat(64),
          candidatePrefixRecords: 6,
          idMap: [['sid-source', candidateSessionId]],
          model: 'gemini-4-carbon',
          effort: 'high',
          permissionMode: 'ask',
        }
        return witness
      },
      async inspectFork(input) {
        const witness = input.witness!
        const initializedVerified =
          Boolean(witness.initializedAt) &&
          witness.initializedPrefixHash === postLoadRawHash &&
          witness.initializedPrefixBytes === postLoadRawBytes &&
          witness.initializedPrefixRecords === postLoadRawRecords
        return {
          kind: 'verified',
          result: {
            nativeSessionId: input.nativeSessionId!,
            witness,
          },
          ready: initializedVerified,
          workSettled: true,
          rawHash: postLoadRawHash,
          rawBytes: postLoadRawBytes,
          rawRecords: postLoadRawRecords,
        }
      },
    }

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => makeVerificationHarness(),
      storageClient,
    })

    const signal = new AbortController().signal
    const rebuildId = randomUUID()
    const sessionId = randomUUID()
    const makeSourceChunks = async function* () {
      yield {
        kind: 'image' as const,
        messageId: randomUUID(),
        sequence: 1,
        image: {
          id: imgId,
          name: 'img.png',
          mediaType: 'image/png' as const,
          bytes: imgBytes.byteLength,
          width: 10,
          height: 10,
          sha256: imgSha,
        },
      }
      yield {
        kind: 'message' as const,
        messageId: randomUUID(),
        sequence: 1,
        speaker: 'user' as const,
        state: 'complete' as const,
        part: 0,
        final: true,
        content: 'Remember ORBITAL_7319',
      }
    }

    // 1. Missing replay chunks during cold `session/load` MUST fail closed!
    omitReplayChunks = true
    await expect(
      adapter.rebuildNativeContext(
        {
          rebuildId: randomUUID(),
          sessionId,
          cwd,
          model: 'gemini-4-carbon',
          effort: 'high',
          sourceHash: 'e'.repeat(64),
          async resolveImage(id) {
            return {
              id,
              name: 'img.png',
              mediaType: 'image/png',
              bytes: imgBytes.byteLength,
              width: 10,
              height: 10,
              sha256: imgSha,
              path: imgPath,
            }
          },
        },
        makeSourceChunks(),
        signal,
      ),
    ).rejects.toThrow(/did not replay the expected user and assistant chunks/u)
    // Cold-load verification receipt MUST NOT be sealed when `session/load` fails!
    expect(confirmColdLoadCalls).toBe(0)
    await expect(
      adapter.inspectNativeRebuild(
        {
          rebuildId: randomUUID(),
          sessionId,
          cwd,
          nativeSessionId: 'sid-shell-1',
          model: 'gemini-4-carbon',
          effort: 'high',
          sourceHash: 'e'.repeat(64),
        },
        makeSourceChunks(),
        signal,
      ),
    ).resolves.toBeUndefined()

    // 2. Valid replay + post-load verification seals receipt ONLY AFTER `session/load` + `session/close`!
    omitReplayChunks = false
    const rebuildRes = await adapter.rebuildNativeContext(
      {
        rebuildId,
        sessionId,
        cwd,
        model: 'gemini-4-carbon',
        effort: 'high',
        sourceHash: 'e'.repeat(64),
        async resolveImage(id) {
          return {
            id,
            name: 'img.png',
            mediaType: 'image/png',
            bytes: imgBytes.byteLength,
            width: 10,
            height: 10,
            sha256: imgSha,
            path: imgPath,
          }
        },
      },
      makeSourceChunks(),
      signal,
    )
    expect(rebuildRes.nativeSessionId).toBe('sid-shell-2')
    expect(confirmColdLoadCalls).toBe(1)
    expect(postLoadSeedVerified).toBe(true)
    expect(rebuildRes.initializationWitness).toMatchObject({
      kind: 'agy_rebuild_v1',
      sourceHash: 'e'.repeat(64),
      pbSha256: 'a'.repeat(64),
      pbBytes: 1024,
      stepCount: 2,
      coldLoadVerifiedAt: '2026-11-19T12:00:00.000Z',
    })
    expect(observedResolvedImagePath).toBe(imgPath)
    expect(allRequests.some((r) => r.method === 'session/prompt')).toBe(false)

    const prepared = await adapter.prepareNativeFork(
      {
        cwd,
        nativeSessionId: 'sid-source',
        nativeTurnId: 'exec-1',
        runId: randomUUID(),
        bindingGeneration: 1,
        throughSequence: 2,
        deliveryCursor: 0,
        responseHash: 'f'.repeat(64),
      },
      signal,
    )
    expect(prepared).toEqual(boundary)

    const candidates: Array<{ sid: string; initialized?: string | undefined }> = []
    const forked = await adapter.forkNativeContext(
      {
        operationId: randomUUID(),
        sessionId,
        cwd,
        model: 'gemini-4-carbon',
        effort: 'high',
        permissionMode: 'ask',
        source: boundary,
        onDispatched: async () => undefined,
        onCandidate: async (sid, w) => {
          candidates.push({ sid, initialized: w?.initializedAt })
        },
        reportNativeWork: () => undefined,
      },
      signal,
    )
    expect(forked.nativeSessionId).toBe('sid-shell-3')
    expect(forked.witness.initializedAt).toBeDefined()
    expect(forked.witness.initializedPrefixHash).toBe(postLoadRawHash)
    expect(forked.witness.initializedPrefixBytes).toBe(postLoadRawBytes)
    expect(forked.witness.initializedPrefixRecords).toBe(postLoadRawRecords)
    expect(candidates).toHaveLength(3)

    const inspected = await adapter.inspectNativeFork(
      {
        operationId: randomUUID(),
        sessionId,
        cwd,
        model: 'gemini-4-carbon',
        effort: 'high',
        permissionMode: 'ask',
        source: boundary,
        nativeSessionId: forked.nativeSessionId,
        witness: forked.witness,
        onDispatched: async () => undefined,
        onCandidate: async () => undefined,
        reportNativeWork: () => undefined,
      },
      signal,
    )
    expect(inspected).toMatchObject({ kind: 'verified', ready: true, workSettled: true })

    await adapter.dispose()
  })

  it('preserves coalesced same-chunk tool_call_update file evidence and stamps bounded operationId before session/prompt settles', async () => {
    const { cwd, appDataDir } = await createEnv()
    const targetPath = join(cwd, 'coalesced.ts')
    await writeFile(targetPath, 'export const v = 1\n', 'utf8')

    const harness = createAcpHarness()
    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-coalesced'),
        })
        return
      }
      if (frame.method === 'session/set_mode') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { currentModeId: (frame.params as Record<string, unknown>)?.modeId ?? 'default' },
        })
        return
      }
      if (frame.method === 'session/set_config_option') {
        const params = frame.params as Record<string, unknown>
        const base = defaultSessionNewResult('sid-coalesced')
        for (const opt of base.configOptions) {
          if (opt.id === params.configId) opt.currentValue = String(params.value)
        }
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { configOptions: base.configOptions },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        // Emit tool_call_update + agent_message_chunk + session/prompt response in ONE raw stdout chunk!
        const batch = [
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-coalesced',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-coalesced-1',
                name: 'edit_file',
                title: 'Edit coalesced.ts',
                status: 'completed',
                args: {
                  Path: targetPath,
                  Target: 'export const v = 1\n',
                  Replacement: 'export const v = 2\n',
                },
                content: [
                  {
                    type: 'diff',
                    path: targetPath,
                    oldText: 'export const v = 1\n',
                    newText: 'export const v = 2\n',
                  },
                ],
              },
            },
          }),
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-coalesced',
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: 'msg-coalesced-1',
                content: { type: 'text', text: 'Updated coalesced.ts cleanly.' },
              },
            },
          }),
          JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          }),
        ].join('\n')
        harness.sendRawStdout(`${batch}\n`)
      }
    })

    const recordedChanges: unknown[] = []
    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness,
    })

    const events = await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          recordFileChange: async (change) => {
            recordedChanges.push(change)
          },
        }),
        new AbortController().signal,
      ),
    )

    expect(events.some((ev) => ev.type === 'tool.completed' && ev.toolName === 'edit_file')).toBe(
      true,
    )
    expect(
      events.some(
        (ev) => ev.type === 'text.completed' && ev.text === 'Updated coalesced.ts cleanly.',
      ),
    ).toBe(true)
    expect(recordedChanges).toEqual([
      {
        path: 'coalesced.ts',
        kind: 'modified',
        before: 'export const v = 1\n',
        after: 'export const v = 2\n',
        operationId: 'tc-coalesced-1:0',
      },
    ])

    await adapter.dispose()
  })
})

describe('AgyAgentAdapter Shard-1 protocol, pool, security, and settlement invariants', () => {
  it('shares an external AgyAcpConnectionPool without disposing it on adapter.dispose(), defaults primaryAppDataDir via ANTIGRAVITY_GEMINI_DIR, and records lease-bound executorId with non-terminal cache invalidation', async () => {
    const { cwd } = await createEnv()
    const cwd2Root = await mkdtemp(join(tmpdir(), 'pact-agy-cwd2-'))
    tempDirs.push(cwd2Root)
    const customGeminiRoot = await mkdtemp(join(tmpdir(), 'pact-agy-gemini-env-'))
    tempDirs.push(customGeminiRoot)

    const prevGeminiDir = process.env.ANTIGRAVITY_GEMINI_DIR
    process.env.ANTIGRAVITY_GEMINI_DIR = customGeminiRoot

    let observedStorageAppDataDir = ''
    let coldProbeCalls = 0
    const harnesses = new Map<string, AcpHarness>()

    const wireBasicHarness = (sid: string, failPrompt = false): AcpHarness => {
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: defaultSessionNewResult(sid) })
          return
        }
        if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'gemini-4-carbon' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
          return
        }
        if (frame.method === 'session/prompt') {
          h.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Partial stream before crash' },
              },
            },
          })
          if (failPrompt) {
            h.child.kill('SIGKILL')
          } else {
            h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
          }
        }
      })
      return h
    }

    const sharedPool = new AgyAcpConnectionPool({
      executablePath: 'agy',
      processFactory(spawnCwd) {
        const isSecond = spawnCwd.includes('pact-agy-cwd2-')
        const h = wireBasicHarness(isSecond ? 'sid-cwd2' : 'sid-cwd1', isSecond)
        harnesses.set(isSecond ? 'cwd2' : 'cwd1', h)
        return h.child
      },
    })

    const storageClient: AgyNativeStorageClient = {
      async probeSessionStatus(probeInput) {
        observedStorageAppDataDir = probeInput.appDataDir ?? ''
        coldProbeCalls += 1
        return {
          kind: 'ended',
          source: 'stored_terminal',
          outcome: 'completed',
          identity: {
            sessionId: probeInput.sessionId,
            agentId: 'agy',
            runId: probeInput.runId,
            requestId: probeInput.requestId,
            nativeSessionId: probeInput.nativeSessionId,
            nativeTurnId: probeInput.nativeTurnId,
            bindingGeneration: probeInput.bindingGeneration,
            executorId: probeInput.executorId,
          },
        }
      },
    }

    try {
      const adapterA = new AgyAgentAdapter({ connectionPool: sharedPool, storageClient })
      const adapterB = new AgyAgentAdapter({ connectionPool: sharedPool, storageClient })

      // 1. Run adapterA on cwd1 -> keeps cwd1 connection open as first entry in sharedPool!
      const runAId = randomUUID()
      let runARecordedExecutor = ''
      await collectEvents(
        adapterA.run(
          makeBaseRunInput(cwd, {
            runId: runAId,
            recordExecutor: (execId) => {
              runARecordedExecutor = execId
            },
          }),
          new AbortController().signal,
        ),
      )

      // Dispose adapterA -> sharedPool MUST remain alive for sibling adapterB!
      await adapterA.dispose()
      expect(sharedPool.poolSnapshot().filter((e) => e.open)).toHaveLength(1)

      // 2. Run adapterB on cwd2 (second connection in pool, different executorId from pool.executorId!),
      // crashing mid-turn after recording `running` evidence!
      const runBId = randomUUID()
      const sessionBId = randomUUID()
      let runBRecordedExecutor = ''
      const recordedEvidences: Array<{ kind: string; executorId?: string | undefined }> = []
      await expect(
        collectEvents(
          adapterB.run(
            makeBaseRunInput(cwd2Root, {
              sessionId: sessionBId,
              runId: runBId,
              recordExecutor: (execId) => {
                runBRecordedExecutor = execId
              },
              recordNativeEvidence: (ev) => {
                recordedEvidences.push({ kind: ev.kind, executorId: ev.identity.executorId })
              },
            }),
            new AbortController().signal,
          ),
        ),
      ).rejects.toThrow(/Antigravity|closed|unavailable|exited|crash/iu)

      expect(runBRecordedExecutor).toBeTruthy()
      expect(runBRecordedExecutor).not.toBe(runARecordedExecutor)
      // Recorded live `running` evidence MUST carry cwd2 lease's actual executorId, NOT cwd1's pool.executorId!
      expect(recordedEvidences[0]).toEqual({
        kind: 'running',
        executorId: runBRecordedExecutor,
      })

      // Because the observer exited on crash, stale `running` evidence MUST be invalidated so
      // `probeNativeStatus` falls through to cold SQLite `probeSessionStatus` (and uses ANTIGRAVITY_GEMINI_DIR)!
      const coldStatus = await adapterB.probeNativeStatus(
        {
          target: 'run',
          sessionId: sessionBId,
          agentId: 'agy',
          runId: runBId,
          requestId: randomUUID(),
          cwd: cwd2Root,
          model: 'gemini-4-carbon',
          effort: 'high',
          nativeSessionId: 'sid-cwd2',
          bindingGeneration: 1,
          executorId: runBRecordedExecutor,
        },
        new AbortController().signal,
      )
      expect(coldProbeCalls).toBe(1)
      expect(coldStatus).toMatchObject({
        kind: 'ended',
        source: 'stored_terminal',
        outcome: 'completed',
      })
      expect(observedStorageAppDataDir).toBe(join(customGeminiRoot, 'antigravity-cli'))

      await adapterB.dispose()
      await sharedPool.dispose()
    } finally {
      if (prevGeminiDir === undefined) delete process.env.ANTIGRAVITY_GEMINI_DIR
      else process.env.ANTIGRAVITY_GEMINI_DIR = prevGeminiDir
    }
  })

  it('enforces strict AgyRunMcpServer correlation, submit_input_result schema enum, no tool-name guessing fallback, and Full-access residual permission rejection priority', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    let mcpUrl = ''
    let mcpName = ''
    let submitInputEnum: unknown
    let legacyOnlyConvError: unknown
    let unboundTokenError: unknown
    let foreignTrajTokenError: unknown
    let postReplyMcpError: unknown

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        const servers = (frame.params as { mcpServers?: Array<{ name: string; url: string }> })
          .mcpServers
        mcpName = servers?.[0]?.name ?? ''
        mcpUrl = servers?.[0]?.url ?? ''

        // Inspect `tools/list` schema for `submit_input_result` if present, or test pre-prompt rejection!
        if (mcpUrl) {
          const listRes = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          }).then((r) => r.json() as Promise<Record<string, unknown>>)
          const tools = (listRes.result as { tools?: Array<Record<string, unknown>> })?.tools ?? []
          const submitInputTool = tools.find((t) => t.name === 'submit_input_result')
          if (submitInputTool) {
            const props = (submitInputTool.inputSchema as { properties?: Record<string, unknown> })
              ?.properties
            submitInputEnum = (props?.outcome as { enum?: unknown })?.enum
          }
        }

        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-mcp-strict'),
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [
              { id: 'model', currentValue: 'gemini-4-carbon' },
              { id: 'thought_level', currentValue: 'high' },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        if (mcpUrl && submitInputEnum === undefined) {
          // Full-access run: send residual permission request for an authorized Pact MCP tool name -> MUST be rejected ('deny') BEFORE MCP auto-allow!
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-full-mcp-residual',
            method: 'session/request_permission',
            params: {
              sessionId: 'sid-mcp-strict',
              toolCall: {
                toolCallId: 'tc-full-mcp',
                name: `mcp_${mcpName}_publish_session_title`,
              },
              options: [
                { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
          await waitUntilCondition(() => harness.responses.length >= 1)

          // 1. Legacy `conversation_id` WITHOUT `antigravity.google/conversation_id` -> rejected!
          const r1 = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 10,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Legacy conv fallback' },
                _meta: {
                  'antigravity.google/root_conversation_id': 'sid-mcp-strict',
                  conversation_id: 'sid-mcp-strict',
                  progressToken: 'traj-root:1',
                },
              },
            }),
          }).then((r) => r.json() as Promise<Record<string, unknown>>)
          legacyOnlyConvError = (r1.result as Record<string, unknown>).isError

          // 2. Unstructured unbound `progressToken` -> rejected!
          const r2 = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 11,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Unbound token' },
                _meta: {
                  'antigravity.google/root_conversation_id': 'sid-mcp-strict',
                  'antigravity.google/conversation_id': 'sid-mcp-strict',
                  progressToken: 'arbitrary-unbound-token',
                },
              },
            }),
          }).then((r) => r.json() as Promise<Record<string, unknown>>)
          unboundTokenError = (r2.result as Record<string, unknown>).isError

          // 3. Pin root trajectory via trusted ACP notification, then valid `traj-root:1` stages outcome while `traj-foreign:2` is rejected!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-mcp-strict',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-bind-root',
                name: 'view_file',
                status: 'in_progress',
                progressToken: 'traj-root:1',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 5))
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 12,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Unpromoted without token' },
                _meta: {
                  'antigravity.google/root_conversation_id': 'sid-mcp-strict',
                  'antigravity.google/conversation_id': 'sid-mcp-strict',
                  progressToken: 'traj-root:1',
                },
              },
            }),
          })
          const r3 = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 13,
              method: 'tools/call',
              params: {
                name: 'request_peer_assistance',
                arguments: { target: 'codex', kind: 'review' },
                _meta: {
                  'antigravity.google/root_conversation_id': 'sid-mcp-strict',
                  'antigravity.google/conversation_id': 'sid-mcp-strict',
                  progressToken: 'traj-foreign:2',
                },
              },
            }),
          }).then((r) => r.json() as Promise<Record<string, unknown>>)
          foreignTrajTokenError = (r3.result as Record<string, unknown>).isError

          // 4. Emit `tool_call_update` WITHOUT `progressToken` (and non-matching `toolCallId`) -> MUST NOT promote by tool-name guessing!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-mcp-strict',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-no-progress-token',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'completed',
              },
            },
          })
        }

        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn' },
        })
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
    })

    // Part A: Full-access run testing Finding 2 + Finding 15
    // Hold `waitForRootOutput` until we verify that post-reply MCP calls are rejected BEFORE `mcpServer.close()`!
    let releaseRootOutput: (() => void) | undefined
    const rootOutputGate = new Promise<void>((r) => {
      releaseRootOutput = r
    })
    const fullRunPromise = collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          permissionMode: 'full',
          waitForRootOutput: async () => {
            if (mcpUrl) {
              const rPost = await fetch(mcpUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 14,
                  method: 'tools/call',
                  params: {
                    name: 'request_peer_assistance',
                    arguments: { target: 'codex', kind: 'review' },
                    _meta: {
                      'antigravity.google/root_conversation_id': 'sid-mcp-strict',
                      'antigravity.google/conversation_id': 'sid-mcp-strict',
                      progressToken: 'traj-root:5',
                    },
                  },
                }),
              }).then((r) => r.json() as Promise<Record<string, unknown>>)
              postReplyMcpError = (rPost.result as Record<string, unknown>).isError
            }
            releaseRootOutput?.()
            await rootOutputGate
          },
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId: randomUUID(),
            requestSessionTitle: true,
            message: { id: randomUUID(), content: 'Check MCP strictness in full mode' },
            comments: [],
          },
        }),
        new AbortController().signal,
      ),
    )
    const fullEvents = await fullRunPromise

    // Residual permission prompt in Full access MUST be denied even for `mcp_<serverName>_*`!
    expect(harness.responses[0]).toEqual({
      jsonrpc: '2.0',
      id: 'perm-full-mcp-residual',
      result: { outcome: { outcome: 'selected', optionId: 'deny' } },
    })
    expect(legacyOnlyConvError).toBe(true)
    expect(unboundTokenError).toBe(true)
    expect(foreignTrajTokenError).toBe(true)
    expect(postReplyMcpError).toBe(true)
    // Staged title MUST NOT have been promoted via tool-name guessing!
    expect(fullEvents.some((e) => e.type === 'session.title.updated')).toBe(false)

    // Part B: Collaboration turn with `submit_input_result` enabled -> verify public `tools/list` enum!
    const collabSessionId = randomUUID()
    const collabRunId = randomUUID()
    const { task, authorization } = makeCollaborationTask(collabSessionId, collabRunId, 'plan')
    const stdHarness = createAcpHarness()
    stdHarness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        stdHarness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        const servers = (frame.params as { mcpServers?: Array<{ name: string; url: string }> })
          .mcpServers
        const url = servers?.[0]?.url ?? ''
        if (url) {
          const listRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          }).then((r) => r.json() as Promise<Record<string, unknown>>)
          const tools = (listRes.result as { tools?: Array<Record<string, unknown>> })?.tools ?? []
          const submitInputTool = tools.find((t) => t.name === 'submit_input_result')
          const props = (submitInputTool?.inputSchema as { properties?: Record<string, unknown> })
            ?.properties
          submitInputEnum = (props?.outcome as { enum?: unknown })?.enum
        }
        stdHarness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-input-enum'),
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        stdHarness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [
              { id: 'model', currentValue: 'gemini-4-carbon' },
              { id: 'thought_level', currentValue: 'high' },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        stdHarness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn' },
        })
      }
    })
    const adapterCollab = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => stdHarness.child,
    })
    await collectEvents(
      adapterCollab.run(
        makeBaseRunInput(cwd, {
          sessionId: collabSessionId,
          runId: collabRunId,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId: collabSessionId,
            message: { id: randomUUID(), content: 'Handle pending user input' },
            comments: [],
            collaboration: task,
            collaborationAuthorization: authorization,
          },
        }),
        new AbortController().signal,
      ),
    )
    expect(submitInputEnum).toEqual(['processed', 'needs_user', 'explanation_only'])

    await adapter.dispose()
    await adapterCollab.dispose()
  })

  it('closes Steer lease immediately on root session/prompt reply and isolates root execution_id from early Steer replies', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    let rootPromptId: string | number | undefined
    let steerReplyMode: 'foreign_exec' | 'matching_early_exec' = 'foreign_exec'

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new' || frame.method === 'session/load') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-steer-iso'),
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [
              { id: 'model', currentValue: 'gemini-4-carbon' },
              { id: 'thought_level', currentValue: 'high' },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        const params = frame.params as Record<string, unknown>
        const meta = Reflect.get(params, '_meta') as Record<string, unknown> | undefined
        if (meta?.pactSteerInputId) {
          // Reply BEFORE root `execution_id` has been emitted on any root update!
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              stopReason: 'end_turn',
              step_idx: 2,
              execution_id: steerReplyMode === 'foreign_exec' ? 'exec-rogue-999' : 'exec-true-root',
            },
          })
          return
        }
        rootPromptId = frame.id as string | number
        // Emit chunk WITHOUT `execution_id` so `turnAccepted = true` while `activeRun.executionId` is STILL `undefined`!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-steer-iso',
            update: {
              sessionUpdate: 'agent_message_chunk',
              step_idx: 1,
              content: { type: 'text', text: 'Streaming before execId...' },
            },
          },
        })
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
    })

    // 1. Early Steer reply with `exec-rogue-999` MUST NOT bind `activeRun.executionId`, and MUST fail when root binds `exec-true-root`!
    const sessionId = randomUUID()
    const run1Id = randomUUID()
    const run1Stream = adapter.run(
      makeBaseRunInput(cwd, { sessionId, runId: run1Id }),
      new AbortController().signal,
    )
    const run1Iter = run1Stream[Symbol.asyncIterator]()

    // Advance iterator until `text.delta` arrives (`turnAccepted = true`, consumer paused!)
    let seenDelta = false
    while (!seenDelta) {
      const next = await run1Iter.next()
      if (next.done) break
      if (next.value.type === 'text.delta') seenDelta = true
    }

    const rogueSteerPromise = adapter.steer(
      {
        runId: run1Id,
        inputId: randomUUID(),
        nativeSessionId: 'sid-steer-iso',
        nativeTurnId: run1Id,
        bindingGeneration: 1,
        nativeGeneration: run1Id,
        promptEnvelope: {
          version: 'pact-agent-prompt-v1',
          sessionId,
          message: { id: randomUUID(), content: 'Early steer with rogue exec_id' },
          comments: [],
        },
        recordDispatch: () => undefined,
        recordConsumption: () => undefined,
      },
      new AbortController().signal,
    )

    // Wait until Steer frame was sent, then finish root prompt with `execution_id: 'exec-true-root'`!
    await waitUntilCondition(
      () => harness.requests.filter((r) => r.method === 'session/prompt').length === 2,
    )
    harness.sendToClient({
      jsonrpc: '2.0',
      id: rootPromptId,
      result: { stopReason: 'end_turn', execution_id: 'exec-true-root' },
    })

    await expect(rogueSteerPromise).rejects.toThrow(/without an in-Turn/u)
    await expect(
      (async () => {
        while (!(await run1Iter.next()).done) {
          // drain
        }
      })(),
    ).rejects.toThrow(/crossed the Turn boundary/u)

    // 2. Early Steer reply with matching `exec-true-root` stages until root binds, AND once root `session/prompt`
    // replies, any NEW Steer while foreground consumer is still paused MUST be rejected immediately!
    steerReplyMode = 'matching_early_exec'
    const run2Id = randomUUID()
    const run2Stream = adapter.run(
      makeBaseRunInput(cwd, { sessionId, runId: run2Id, nativeSessionId: 'sid-steer-iso' }),
      new AbortController().signal,
    )
    const run2Iter = run2Stream[Symbol.asyncIterator]()

    seenDelta = false
    while (!seenDelta) {
      const next = await run2Iter.next()
      if (next.done) break
      if (next.value.type === 'text.delta') seenDelta = true
    }

    const validEarlySteerPromise = adapter.steer(
      {
        runId: run2Id,
        inputId: randomUUID(),
        nativeSessionId: 'sid-steer-iso',
        nativeTurnId: run2Id,
        bindingGeneration: 1,
        nativeGeneration: run2Id,
        promptEnvelope: {
          version: 'pact-agent-prompt-v1',
          sessionId,
          message: { id: randomUUID(), content: 'Early steer with matching exec_id' },
          comments: [],
        },
        recordDispatch: () => undefined,
        recordConsumption: () => undefined,
      },
      new AbortController().signal,
    )

    await waitUntilCondition(
      () => harness.requests.filter((r) => r.method === 'session/prompt').length === 4,
    )
    // Send root `session/prompt` reply WHILE `run2Iter` is still paused before draining!
    harness.sendToClient({
      jsonrpc: '2.0',
      id: rootPromptId,
      result: { stopReason: 'end_turn', execution_id: 'exec-true-root' },
    })
    await Promise.resolve()

    // New steer attempted AFTER root `session/prompt` reply (before `run2Iter` resumes!) MUST be rejected immediately!
    const lateSteerRes = await adapter.steer(
      {
        runId: run2Id,
        inputId: randomUUID(),
        nativeSessionId: 'sid-steer-iso',
        nativeTurnId: run2Id,
        bindingGeneration: 1,
        nativeGeneration: run2Id,
        promptEnvelope: {
          version: 'pact-agent-prompt-v1',
          sessionId,
          message: { id: randomUUID(), content: 'Late steer after root reply' },
          comments: [],
        },
        recordDispatch: () => undefined,
        recordConsumption: () => undefined,
      },
      new AbortController().signal,
    )
    expect(lateSteerRes.status).toBe('rejected')
    expect(harness.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(4)

    // Resume `run2Iter` -> binds `exec-true-root`, promotes staged `validEarlySteerPromise`, and completes cleanly!
    const remaining: NormalizedAgentEvent[] = []
    while (true) {
      const step = await run2Iter.next()
      if (step.done) break
      remaining.push(step.value)
    }
    await expect(validEarlySteerPromise).resolves.toEqual({ status: 'accepted' })
    expect(remaining).toContainEqual({
      agentId: 'agy',
      type: 'turn.completed',
      turnId: run2Id,
      outcome: 'completed',
    })

    await adapter.dispose()
  })

  it('bounds physical settlement when child hangs on cancel, never marks unconfirmed work settled or live_terminal, and rejects missing/invalid stopReason', async () => {
    const { cwd, appDataDir } = await createEnv()
    let mode: 'missing_stop_reason' | 'invalid_stop_reason' | 'hung_cancel' = 'missing_stop_reason'
    const harness = createAcpHarness()

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(`sid-${mode}`),
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [
              { id: 'model', currentValue: 'gemini-4-carbon' },
              { id: 'thought_level', currentValue: 'high' },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        if (mode === 'missing_stop_reason') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          return
        }
        if (mode === 'invalid_stop_reason') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'unexpected_vendor_code' },
          })
          return
        }
        // `hung_cancel`: emit chunk (`turnAccepted = true`), then NEVER reply to `session/prompt` or close on `session/cancel`!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: `sid-${mode}`,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Started work before hang...' },
            },
          },
        })
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
    })

    // 1. Missing `stopReason` -> rejects with protocol_error BEFORE synthesizing `turn.started`!
    const missingEffects: string[] = []
    const missingEvents: NormalizedAgentEvent[] = []
    await expect(
      (async () => {
        for await (const ev of adapter.run(
          makeBaseRunInput(cwd, { reportNativeEffects: (r) => missingEffects.push(r.state) }),
          new AbortController().signal,
        )) {
          missingEvents.push(ev)
        }
      })(),
    ).rejects.toThrow(/without a stopReason/u)
    expect(missingEvents.some((e) => e.type === 'turn.started')).toBe(false)
    expect(missingEffects).toContain('unknown')
    expect(missingEffects).not.toContain('settled')

    // 2. Unrecognized `stopReason` -> rejects with protocol_error!
    mode = 'invalid_stop_reason'
    await expect(
      collectEvents(adapter.run(makeBaseRunInput(cwd), new AbortController().signal)),
    ).rejects.toThrow(/unrecognized session\/prompt stopReason/u)

    // 3. Hung child after user cancel -> settles within bounded deadline (~1.5s * 2), reports `unknown` (NEVER `settled`), and NEVER fabricates `live_terminal` / `interrupted`!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mode = 'hung_cancel'
    const cancelCtrl = new AbortController()
    const hungEffects: string[] = []
    const hungEvidenceKinds: string[] = []
    const hungState = { sawDelta: false }

    const hungPromise = (async () => {
      for await (const ev of adapter.run(
        makeBaseRunInput(cwd, {
          reportNativeEffects: (r) => hungEffects.push(r.state),
          recordNativeEvidence: (evidence) => hungEvidenceKinds.push(evidence.kind),
        }),
        cancelCtrl.signal,
      )) {
        if (ev.type === 'text.delta') {
          hungState.sawDelta = true
          cancelCtrl.abort()
        }
      }
    })()
    const caughtHung = hungPromise.catch((e: unknown) => e)
    while (!hungState.sawDelta) {
      await new Promise<void>((r) => setImmediate(r))
    }
    await vi.advanceTimersByTimeAsync(2_000)
    await new Promise<void>((r) => setImmediate(r))
    await vi.advanceTimersByTimeAsync(2_000)
    const hungErr = await caughtHung
    expect(hungErr).toBeInstanceOf(Error)
    expect(hungEffects).toContain('unknown')
    expect(hungEffects).not.toContain('settled')
    expect(hungEvidenceKinds).not.toContain('ended')
    vi.useRealTimers()

    await adapter.dispose()
  })

  it('drains >4,100 session/load replay chunks concurrently, enforces 8 MiB in-flight tool payload cap with immediate completion release, and correlates background toolCallId <-> taskId + background_task_completed', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    let runPhase: 'replay_and_bg' | 'tool_memory_overflow' = 'replay_and_bg'

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/load') {
        // Stream 4,250 notifications (> 4,096 queue cap!) across ticks BEFORE returning `session/load`!
        for (let batch = 0; batch < 17; batch += 1) {
          const lines: string[] = []
          for (let i = 0; i < 250; i += 1) {
            lines.push(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: 'sid-heavy-replay',
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: `REPLAY_${batch}_${i}` },
                  },
                },
              }),
            )
          }
          harness.sendRawStdout(`${lines.join('\n')}\n`)
          await new Promise<void>((r) => setImmediate(r))
        }
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-heavy-replay'),
        })
        return
      }
      if (frame.method === 'session/new') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-tool-mem'),
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [
              { id: 'model', currentValue: 'gemini-4-carbon' },
              { id: 'thought_level', currentValue: 'high' },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        if (runPhase === 'replay_and_bg') {
          // 1. 50 sequential 200 KiB tool calls: each releases its payload on completion (50 * 200 KiB = 10 MiB > 8 MiB, yet <= 200 KiB in-flight at once -> MUST succeed!).
          const twoHundredKiB = 'A'.repeat(200 * 1024)
          for (let idx = 0; idx < 50; idx += 1) {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sid-heavy-replay',
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: `tc-seq-${idx}`,
                  name: 'read_file',
                  status: 'in_progress',
                  rawOutput: { text: twoHundredKiB },
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sid-heavy-replay',
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: `tc-seq-${idx}`,
                  name: 'read_file',
                  status: 'completed',
                },
              },
            })
            if (idx % 10 === 9) {
              await new Promise<void>((r) => setImmediate(r))
            }
          }

          // 2. Failed daemon launch without spawned `taskId` -> MUST clean up immediately!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-heavy-replay',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-failed-daemon',
                name: 'run_command',
                status: 'pending',
                args: { CommandLine: 'bad-daemon', IsDaemon: true },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-heavy-replay',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-failed-daemon',
                name: 'run_command',
                status: 'failed',
              },
            },
          })

          // 3. Real daemon launch: `tool_call` (`tc-daemon-launch`) -> `tool_call_update` (`rawOutput.taskId = 'task-real-77'`)!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-heavy-replay',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-daemon-launch',
                name: 'run_command',
                status: 'pending',
                args: { CommandLine: 'pnpm watch', IsDaemon: true },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-heavy-replay',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-daemon-launch',
                name: 'run_command',
                status: 'completed',
                args: { CommandLine: 'pnpm watch', IsDaemon: true },
                rawOutput: { taskId: 'task-real-77' },
              },
            },
          })

          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-heavy-replay',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Live turn answer.' },
              },
            },
          })
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
          return
        }

        // `tool_memory_overflow`: 45 concurrent uncompleted 200 KiB tool calls (= 9 MiB > 8 MiB cap, < 64 count cap) -> MUST fail with response_too_large!
        const twoHundredKiB = 'B'.repeat(200 * 1024)
        for (let idx = 0; idx < 45; idx += 1) {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-tool-mem',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: `tc-overflow-${idx}`,
                name: 'read_file',
                status: 'in_progress',
                rawOutput: { text: twoHundredKiB },
              },
            },
          })
          if (idx % 10 === 9) {
            await new Promise<void>((r) => setImmediate(r))
          }
        }
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const bgReports: NativeBackgroundReport[] = []
    const effectStates: string[] = []
    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
    })

    const run1Id = randomUUID()
    const events1 = await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          runId: run1Id,
          nativeSessionId: 'sid-heavy-replay',
          reportNativeEffects: (r) => effectStates.push(r.state),
          recordBackgroundReport: async (r) => {
            bgReports.push(r)
          },
        }),
        new AbortController().signal,
      ),
    )

    const liveText = events1
      .filter(
        (e): e is Extract<NormalizedAgentEvent, { type: 'text.completed' }> =>
          e.type === 'text.completed',
      )
      .map((e) => e.text)
      .join('')
    expect(liveText).toBe('Live turn answer.')
    expect(adapter.hasActiveBackgroundWork(run1Id)).toBe(true)

    // Emit ONE `background_task_completed` referencing ONLY `taskId: 'task-real-77'` -> MUST record report AND release correlated `tc-daemon-launch` + lease!
    harness.sendToClient({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sid-heavy-replay',
        update: {
          sessionUpdate: 'background_task_completed',
          taskId: 'task-real-77',
          summary: 'Daemon task-real-77 finished cleanly.',
        },
      },
    })

    await vi.waitFor(() => {
      expect(bgReports).toHaveLength(1)
      expect(adapter.hasActiveBackgroundWork(run1Id)).toBe(false)
    })
    expect(bgReports[0]?.text).toBe('Daemon task-real-77 finished cleanly.')
    expect(effectStates).toContain('settled')
    expect(adapter.poolSnapshot().reduce((s, e) => s + e.activeLeases, 0)).toBe(0)

    // Now verify >8 MiB concurrent in-flight tool states reject with `response_too_large`!
    runPhase = 'tool_memory_overflow'
    await expect(
      collectEvents(adapter.run(makeBaseRunInput(cwd), new AbortController().signal)),
    ).rejects.toThrow(/8 MiB working-memory budget/u)

    await adapter.dispose()
  })

  it('routes init-phase elicitation before session/new settles without marking Turn accepted, enforces model-switch config_option_update & thought_level confirmation, and verifies Plan diff path', async () => {
    const { cwd, appDataDir } = await createEnv()
    let scenario: 'init_elicit_and_bad_plan_diff' | 'unconfirmed_thought_level' =
      'init_elicit_and_bad_plan_diff'
    const harness = createAcpHarness()

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        if (scenario === 'init_elicit_and_bad_plan_diff') {
          // Emit init-phase `elicitation/create` BEFORE `session/new` responds!
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 'elicit-during-init',
            method: 'elicitation/create',
            params: {
              mode: 'url',
              title: 'Sign in during session init',
              message: 'Authorize workspace connector',
              url: 'https://example.com/auth',
            },
          })
          await waitUntilCondition(() => harness.responses.length >= 1)
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              sessionId: 'sid-init-plan',
              modes: { currentModeId: 'default', availableModes: ['default', 'plan'] },
              models: {
                currentModelId: 'gemini-3.8-flash',
                availableModels: ['gemini-3.8-flash', 'gemini-4-carbon'],
              },
              configOptions: [
                {
                  id: 'thought_level',
                  currentValue: 'high',
                  options: [{ value: 'low' }, { value: 'high' }],
                },
              ],
            },
          })
          return
        }

        // `unconfirmed_thought_level`: switching from `gemini-3.8-flash` (which had `thought_level = high`)
        // to `gemini-lite-no-thinking` emits `config_option_update` WITHOUT `thought_level`!
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            sessionId: 'sid-no-thought',
            modes: { currentModeId: 'default', availableModes: ['default'] },
            models: {
              currentModelId: 'gemini-3.8-flash',
              availableModels: ['gemini-3.8-flash', 'gemini-lite-no-thinking'],
            },
            configOptions: [
              {
                id: 'thought_level',
                currentValue: 'high',
                options: [{ value: 'high' }],
              },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/set_mode') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        return
      }
      if (frame.method === 'session/set_model') {
        const p = frame.params as { modelId: string }
        if (p.modelId === 'gemini-4-carbon') {
          // Deliver updated `configOptions` via `config_option_update` notification while `set_model` returns `{}`!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-init-plan',
              update: {
                sessionUpdate: 'config_option_update',
                configOptions: [
                  {
                    id: 'thought_level',
                    currentValue: 'medium',
                    options: [{ value: 'medium' }, { value: 'high' }],
                  },
                ],
              },
            },
          })
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          return
        }
        // `gemini-lite-no-thinking`: emit `config_option_update` with NO `thought_level` option!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-no-thought',
            update: {
              sessionUpdate: 'config_option_update',
              configOptions: [{ id: 'model', currentValue: 'gemini-lite-no-thinking' }],
            },
          },
        })
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        return
      }
      if (frame.method === 'session/set_config_option') {
        const p = frame.params as { configId: string; value: string }
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [{ id: p.configId, currentValue: p.value }],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        // Emit Plan `write_file` where `args.Path` is the authenticated brain plan path,
        // BUT `content[0].path` is a DIFFERENT file (`join(cwd, 'README.md')`) -> MUST mark `planUnavailable`!
        const brainPlanPath = join(appDataDir, 'brain', 'sid-init-plan', 'implementation_plan.md')
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-init-plan',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-mismatched-plan-diff',
              name: 'write_file',
              status: 'completed',
              args: {
                Path: brainPlanPath,
                Content: '# Plan\n',
                ArtifactMetadata: {
                  Summary: 'Plan',
                  UserFacing: true,
                  RequestFeedback: true,
                },
              },
              content: [
                {
                  type: 'diff',
                  path: join(cwd, 'README.md'),
                  newText: '# Spoofed README diff text\n',
                },
              ],
            },
          },
        })
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
    })

    // 1. Init-phase elicitation + model-switch `config_option_update` + mismatched Plan diff path!
    const sessionId = randomUUID()
    const run1Id = randomUUID()
    const { task, authorization } = makeCollaborationTask(sessionId, run1Id, 'plan')
    const dispatchRecords: string[] = []
    let sawInitQuestionBeforeTurnStarted = false
    let turnStartedYet = false
    let planUnavailableCount = 0
    const capturedPlans: unknown[] = []

    const events1: NormalizedAgentEvent[] = []
    for await (const ev of adapter.run(
      makeBaseRunInput(cwd, {
        sessionId,
        runId: run1Id,
        model: 'gemini-4-carbon',
        effort: 'high',
        recordDispatch: (status) => dispatchRecords.push(status),
        recordWorkflowPlan: (p) => capturedPlans.push(p),
        recordWorkflowPlanUnavailable: () => {
          planUnavailableCount += 1
        },
        async requestUserInput(req) {
          expect(req.kind).toBe('url')
          // At the moment init-phase elicitation runs, `session/prompt` has NOT even been sent!
          expect(dispatchRecords).toEqual([])
          return { action: 'accept' }
        },
        promptEnvelope: {
          version: 'pact-agent-prompt-v1',
          sessionId,
          message: { id: randomUUID(), content: '/plan Verify diff path' },
          comments: [],
          collaboration: task,
          collaborationAuthorization: authorization,
        },
      }),
      new AbortController().signal,
    )) {
      events1.push(ev)
      if (ev.type === 'turn.started') turnStartedYet = true
      if (ev.type === 'interaction.requested' && !turnStartedYet) {
        sawInitQuestionBeforeTurnStarted = true
      }
    }

    expect(sawInitQuestionBeforeTurnStarted).toBe(true)
    expect(harness.responses[0]).toEqual({
      jsonrpc: '2.0',
      id: 'elicit-during-init',
      result: { action: 'accept' },
    })
    expect(capturedPlans).toEqual([])
    expect(planUnavailableCount).toBeGreaterThanOrEqual(1)
    expect(events1.some((e) => e.type === 'collaboration.plan')).toBe(false)

    // 2. Switching to a model whose `config_option_update` lacks `thought_level` MUST reject instead of trusting stale `thought_level = high`!
    scenario = 'unconfirmed_thought_level'
    await expect(
      collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            model: 'gemini-lite-no-thinking',
            effort: 'high',
          }),
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/thought_level/u)

    await adapter.dispose()
  })
})

describe('AgyAgentAdapter Round-2 final review regressions', () => {
  it('wires AgyAgentAdapter events, live evidence, Steer consumption, background reports, and native_work_drained into a real ConversationRepository when provider execution_id !== runId', async () => {
    const { cwd, appDataDir } = await createEnv()
    const migrationsFolder = resolve(
      import.meta.dirname,
      '../../../../../packages/persistence/drizzle',
    )
    const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    const harness = createAcpHarness()
    let mode: 'first_frame_exec' | 'final_reply_exec' = 'first_frame_exec'
    let finishRootPrompt: (() => void) | undefined

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new' || frame.method === 'session/load') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-repo-1'),
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [
              { id: 'model', currentValue: 'gemini-4-carbon' },
              { id: 'thought_level', currentValue: 'high' },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        const params = frame.params as Record<string, unknown>
        const meta = Reflect.get(params, '_meta') as Record<string, unknown> | undefined
        if (meta?.pactSteerInputId) {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              stopReason: 'end_turn',
              step_idx: 2,
              execution_id: 'provider-exec-first-frame-001',
            },
          })
          return
        }
        const rpcId = frame.id as string | number
        if (mode === 'first_frame_exec') {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-repo-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                execution_id: 'provider-exec-first-frame-001',
                step_idx: 1,
                content: { type: 'text', text: 'First-frame exec response.' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-repo-1',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'bg-repo-tc-1',
                name: 'run_command',
                status: 'completed',
                execution_id: 'provider-exec-first-frame-001',
                args: { CommandLine: 'npm run dev', IsDaemon: true },
                rawOutput: { taskId: 'bg-repo-task-1' },
              },
            },
          })
          finishRootPrompt = () => {
            harness.sendToClient({
              jsonrpc: '2.0',
              id: rpcId,
              result: {
                stopReason: 'end_turn',
                execution_id: 'provider-exec-first-frame-001',
              },
            })
          }
        } else {
          // Omit `execution_id` during streaming so `turn.started` and `running` evidence fire first!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-repo-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                step_idx: 5,
                content: { type: 'text', text: 'Final-reply exec response.' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: rpcId,
            result: {
              stopReason: 'end_turn',
              execution_id: 'provider-exec-final-reply-002',
            },
          })
        }
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
    })

    try {
      const projectId = randomUUID()
      const sessionId = randomUUID()
      const createdAt = new Date().toISOString()
      const owner = randomUUID()
      db.projectCatalogRepository.add({
        id: projectId,
        name: 'Agy Repo Seam',
        directoryPath: cwd,
        kind: 'directory',
        createdAt,
      })
      db.sessionRepository.create(
        { id: sessionId, projectId, title: 'Agy Repo Seam', createdAt },
        {
          primaryAgentId: 'agy',
          secondaryAgentId: 'codex',
          agents: {
            codex: { model: null, effort: null },
            claude: { model: null, effort: null },
            agy: { model: 'gemini-4-carbon', effort: 'high' },
          },
          maxDiscussionRounds: 6,
          maxReviewCycles: 3,
          maxRepairAttempts: 3,
        },
      )
      const repo = db.conversationRepository

      // --- Case A: provider `execution_id !== run.id` arrives on the FIRST frame + Steer + Background report ---
      const runA = repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Run A with first-frame provider execution_id',
        expectedCommentsRevision: 0,
        commentIds: [],
        agentId: 'agy',
        settingsRevision: 1,
        model: 'gemini-4-carbon',
        effort: 'high',
      }).run
      expect(runA.id).not.toBe('provider-exec-first-frame-001')

      const recordedEvidenceIdsA: string[] = []
      const recordedEffectsA: Array<{ state: string; reason?: string | undefined }> = []
      let bgReportSaved = false

      let steerRequestOpId = ''
      const runAStream = adapter.run(
        makeBaseRunInput(cwd, {
          sessionId,
          runId: runA.id,
          bindingGeneration: runA.bindingGeneration ?? 1,
          nativeGeneration: runA.id,
          model: 'gemini-4-carbon',
          effort: 'high',
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId,
            message: {
              id: runA.userMessageId,
              content: 'Run A with first-frame provider execution_id',
            },
            comments: [],
          },
          recordDispatch: (phase, nativeId, executorId) => {
            repo.recordDispatch(runA.id, phase, nativeId, executorId)
          },
          recordNativeEvidence: (evidence) => {
            if (evidence.identity.nativeTurnId) {
              recordedEvidenceIdsA.push(evidence.identity.nativeTurnId)
            }
            const metadata =
              evidence.kind === 'ended'
                ? {
                    kind: evidence.kind,
                    identity: evidence.identity,
                    source: evidence.source,
                    outcome: evidence.outcome,
                  }
                : evidence
            repo.recordNativeEvidence(metadata, 'retry')
          },
          recordInputConsumption: (id, identity) => {
            repo.recordQueuedSteerConsumption(
              {
                runId: runA.id,
                sessionId,
                bindingGeneration: runA.bindingGeneration ?? 1,
                nativeSessionId: identity.nativeSessionId,
                nativeTurnId: identity.nativeTurnId!,
                executorId: identity.executorId,
              },
              id,
            )
          },
          recordBackgroundReport: async (report) => {
            await repo.recordBackgroundReport(
              report,
              async function* () {
                yield report.text
              },
              new AbortController().signal,
            )
            bgReportSaved = true
          },
          reportNativeEffects: (report) => {
            recordedEffectsA.push({ state: report.state, reason: report.reason })
            repo.recordNativeEffects(runA.id, report.state, report.reason)
          },
        }),
        new AbortController().signal,
      )
      const runAIter = runAStream[Symbol.asyncIterator]()

      // Advance until `tool.completed` has been applied to `repo` (`turn.started` + `running` evidence committed!)
      while (true) {
        const next = await runAIter.next()
        if (next.done) break
        repo.applyEvent(sessionId, runA.id, next.value)
        if (next.value.type === 'tool.completed') break
      }

      // Queue and steer a real message through `ConversationRepository`!
      const steerClientMsgId = randomUUID()
      const body = repo.writeConversationInput(
        { type: 'begin', sessionId, clientMessageId: steerClientMsgId },
        owner,
      )
      repo.writeConversationInput(
        {
          type: 'append',
          sessionId,
          inputId: body.inputId,
          offset: 0,
          text: 'In-turn steer supplement',
        },
        owner,
      )
      repo.writeConversationInput({ type: 'seal', sessionId, inputId: body.inputId }, owner)
      const draftsBeforeSteer = repo.readPage({ scope: 'drafts', sessionId })
      if (draftsBeforeSteer.scope !== 'drafts') throw new Error('Expected drafts page')
      repo.receiveQueuedInput(
        {
          sessionId,
          clientMessageId: steerClientMsgId,
          content: '',
          inputId: body.inputId,
          expectedCommentsRevision: draftsBeforeSteer.commentsRevision,
          commentIds: [],
          route: { type: 'agent', agentId: 'agy' },
        },
        body.inputId,
        'agy',
        owner,
        runA.id,
      )
      const qState = repo.queueState(sessionId)
      const currentRunA = repo.findRun(runA.id)!
      expect(currentRunA.nativeTurnId).toBe(runA.id)
      steerRequestOpId = randomUUID()
      repo.prepareQueuedSteer(
        {
          sessionId,
          inputId: qState.input!.id,
          expectedRevision: qState.revision,
          operationId: steerRequestOpId,
        },
        {
          runId: runA.id,
          bindingGeneration: currentRunA.bindingGeneration ?? 1,
          nativeTurnId: currentRunA.nativeTurnId!,
          executorId: currentRunA.executorId!,
        },
      )

      const steerRes = await adapter.steer(
        {
          runId: runA.id,
          inputId: qState.input!.id,
          nativeSessionId: 'sid-repo-1',
          nativeTurnId: currentRunA.nativeTurnId!,
          bindingGeneration: currentRunA.bindingGeneration ?? 1,
          nativeGeneration: runA.id,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId,
            message: { id: qState.input!.id, content: 'In-turn steer supplement' },
            comments: [],
          },
          recordDispatch: (phase) => {
            if (phase === 'possibly_sent') repo.markQueuedSteerPossiblySent(steerRequestOpId)
          },
          recordConsumption: (id) => {
            repo.recordQueuedSteerConsumption(
              {
                runId: runA.id,
                sessionId,
                bindingGeneration: currentRunA.bindingGeneration ?? 1,
                nativeSessionId: 'sid-repo-1',
                nativeTurnId: runA.id,
                executorId: currentRunA.executorId!,
              },
              id,
            )
          },
        },
        new AbortController().signal,
      )
      expect(steerRes).toEqual({ status: 'accepted' })

      finishRootPrompt!()
      while (true) {
        const next = await runAIter.next()
        if (next.done) break
        repo.applyEvent(sessionId, runA.id, next.value)
      }

      // Emit post-turn background completion -> persists background report AND settles with `native_work_drained`!
      harness.sendToClient({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sid-repo-1',
          update: {
            sessionUpdate: 'background_task_completed',
            taskId: 'bg-repo-task-1',
            toolCallId: 'bg-repo-tc-1',
            text: 'Background dev server finished cleanly.',
          },
        },
      })
      await waitUntilCondition(() => bgReportSaved && recordedEffectsA.at(-1)?.state === 'settled')

      expect(recordedEvidenceIdsA.every((id) => id === runA.id)).toBe(true)
      expect(recordedEffectsA.at(-1)).toEqual({ state: 'settled', reason: 'native_work_drained' })
      const persistedRunA = repo.findRun(runA.id)!
      expect(persistedRunA.status).toBe('completed')
      expect(persistedRunA.nativeTurnId).toBe(runA.id)

      // --- Case B: provider `execution_id !== run.id` arrives ONLY on the final `session/prompt` reply ---
      mode = 'final_reply_exec'
      const draftsBeforeRunB = repo.readPage({ scope: 'drafts', sessionId })
      if (draftsBeforeRunB.scope !== 'drafts') throw new Error('Expected drafts page')
      const runB = repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Run B with final-reply provider execution_id',
        expectedCommentsRevision: draftsBeforeRunB.commentsRevision,
        commentIds: [],
        agentId: 'agy',
        settingsRevision: 1,
        model: 'gemini-4-carbon',
        effort: 'high',
      }).run
      const recordedEvidenceIdsB: string[] = []
      const recordedEffectsB: Array<{ state: string; reason?: string | undefined }> = []

      for await (const ev of adapter.run(
        makeBaseRunInput(cwd, {
          sessionId,
          runId: runB.id,
          nativeSessionId: 'sid-repo-1',
          bindingGeneration: runB.bindingGeneration ?? 1,
          nativeGeneration: runB.id,
          model: 'gemini-4-carbon',
          effort: 'high',
          recordDispatch: (phase, nativeId, executorId) => {
            repo.recordDispatch(runB.id, phase, nativeId, executorId)
          },
          recordNativeEvidence: (evidence) => {
            if (evidence.identity.nativeTurnId) {
              recordedEvidenceIdsB.push(evidence.identity.nativeTurnId)
            }
            const metadata =
              evidence.kind === 'ended'
                ? {
                    kind: evidence.kind,
                    identity: evidence.identity,
                    source: evidence.source,
                    outcome: evidence.outcome,
                  }
                : evidence
            repo.recordNativeEvidence(metadata, 'retry')
          },
          reportNativeEffects: (report) => {
            recordedEffectsB.push({ state: report.state, reason: report.reason })
            repo.recordNativeEffects(runB.id, report.state, report.reason)
          },
        }),
        new AbortController().signal,
      )) {
        repo.applyEvent(sessionId, runB.id, ev)
      }

      expect(recordedEvidenceIdsB).toEqual([runB.id, runB.id])
      expect(recordedEffectsB.at(-1)).toEqual({ state: 'settled', reason: 'native_work_drained' })
      const persistedRunB = repo.findRun(runB.id)!
      expect(persistedRunB.status).toBe('completed')
      expect(persistedRunB.nativeTurnId).toBe(runB.id)
    } finally {
      await adapter.dispose()
      db.close()
    }
  })

  it('routes server requests via shared AgyAcpConnection owner registry across Main, initializing Side Chat, rebuildNativeContext, and initializeNativeFork', async () => {
    const { cwd, appDataDir } = await createEnv()
    let harness = createAcpHarness()
    let releaseSideSessionNew: (() => void) | undefined
    let rebuildTestMode = false

    const wireHarness = (h: AcpHarness): AcpHarness => {
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new') {
          if (rebuildTestMode) {
            h.sendToClient({
              jsonrpc: '2.0',
              id: 'perm-during-rebuild-new',
              method: 'session/request_permission',
              params: {
                toolCall: { toolCallId: 'tc-reb', name: 'read_file', title: 'Read during rebuild' },
                options: [
                  { optionId: 'allow-reb', kind: 'allow_once', name: 'Allow' },
                  { optionId: 'reject-reb', kind: 'reject_once', name: 'Reject' },
                ],
              },
            })
            h.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: defaultSessionNewResult('sid-rebuilt-op'),
            })
            return
          }
          const newCalls = h.requests.filter((r) => r.method === 'session/new').length
          if (newCalls === 1) {
            h.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: defaultSessionNewResult('sid-main-shared'),
            })
          } else {
            releaseSideSessionNew = () => {
              h.sendToClient({
                jsonrpc: '2.0',
                id: frame.id,
                result: defaultSessionNewResult('sid-side-shared'),
              })
            }
          }
          return
        }
        if (frame.method === 'session/load') {
          if (rebuildTestMode) {
            h.sendToClient({
              jsonrpc: '2.0',
              id: 'elicit-during-load',
              method: 'elicitation/create',
              params: {
                sessionId: (frame.params as { sessionId?: string }).sessionId,
                mode: 'url',
                elicitationId: 'el-load-1',
                message: 'Confirm cold load workspace',
                url: 'https://antigravity.google/auth',
              },
            })
          }
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(
              (frame.params as { sessionId?: string }).sessionId ?? 'sid-loaded',
            ),
          })
          return
        }
        if (frame.method === 'session/close') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          return
        }
        if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'gemini-4-carbon' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
          return
        }
        if (frame.method === 'session/prompt') {
          const sid = (frame.params as { sessionId: string }).sessionId
          if (sid === 'sid-main-shared') {
            h.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sid-main-shared',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Main running...' },
                },
              },
            })
            return
          }
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })
      return h
    }
    wireHarness(harness)

    const sharedPool = new AgyAcpConnectionPool({
      executablePath: 'agy',
      processFactory: () => {
        if (harness.child.exitCode !== null) {
          harness = wireHarness(createAcpHarness())
        }
        return harness.child
      },
    })
    const mainAdapter = new AgyAgentAdapter({
      appDataDir,
      connectionPool: sharedPool,
    })
    const sideAdapter = new AgyAgentAdapter({
      appDataDir,
      connectionPool: sharedPool,
    })

    let mainPermCalls = 0
    let sidePermCalls = 0

    const mainAbort = new AbortController()
    const mainStream = mainAdapter.run(
      makeBaseRunInput(cwd, {
        requestPermission: async (req) => {
          mainPermCalls += 1
          return req.actions?.[0]?.id ?? 'agy-cancel'
        },
      }),
      mainAbort.signal,
    )
    const mainIter = mainStream[Symbol.asyncIterator]()

    while (true) {
      const next = await mainIter.next()
      if (next.done || next.value.type === 'text.delta') break
    }

    const sidePromise = collectEvents(
      sideAdapter.run(
        makeBaseRunInput(cwd, {
          requestPermission: async () => {
            sidePermCalls += 1
            return 'allow-side'
          },
        }),
        new AbortController().signal,
      ),
    )
    await waitUntilCondition(() => releaseSideSessionNew !== undefined)

    harness.sendToClient({
      jsonrpc: '2.0',
      id: 'perm-main-while-side-init',
      method: 'session/request_permission',
      params: {
        sessionId: 'sid-main-shared',
        toolCall: { toolCallId: 'tc-main', name: 'run_command', title: 'Run test' },
        options: [
          { optionId: 'allow-main', kind: 'allow_once', name: 'Allow' },
          { optionId: 'reject-main', kind: 'reject_once', name: 'Reject' },
        ],
      },
    })
    harness.sendToClient({
      jsonrpc: '2.0',
      id: 'unscoped-while-two-owners',
      method: 'elicitation/create',
      params: {
        mode: 'url',
        elicitationId: 'el-ambig',
        message: 'Ambiguous unscoped request',
        url: 'https://antigravity.google/auth',
      },
    })

    await waitUntilCondition(
      () =>
        harness.responses.some((r) => r.id === 'perm-main-while-side-init') &&
        harness.responses.some((r) => r.id === 'unscoped-while-two-owners'),
    )
    expect(mainPermCalls).toBe(1)
    expect(sidePermCalls).toBe(0)
    expect(harness.responses.find((r) => r.id === 'perm-main-while-side-init')).toEqual({
      jsonrpc: '2.0',
      id: 'perm-main-while-side-init',
      result: { outcome: { outcome: 'selected', optionId: 'allow-main' } },
    })
    expect(
      (
        harness.responses.find((r) => r.id === 'unscoped-while-two-owners')?.error as {
          code: number
        }
      )?.code,
    ).toBe(-32_601)

    releaseSideSessionNew!()
    await sidePromise
    const mainPromptFrame = harness.requests.find(
      (r) =>
        r.method === 'session/prompt' &&
        (r.params as { sessionId?: string }).sessionId === 'sid-main-shared',
    )!
    harness.sendToClient({
      jsonrpc: '2.0',
      id: mainPromptFrame.id,
      result: { stopReason: 'end_turn' },
    })
    while (!(await mainIter.next()).done) {
      // drain
    }

    rebuildTestMode = true
    let rebuildPermForwarded = 0
    let rebuildElicitForwarded = 0
    const controlStorage: AgyNativeStorageClient = {
      async writeRebuildSeed() {
        return {
          seedHash: 'a'.repeat(64),
          chunkCount: 0,
          stepCount: 0,
          verifiedPrefixBytes: 12,
          verifiedPrefixSha256: 'b'.repeat(64),
        }
      },
    }
    const controlAdapter = new AgyAgentAdapter({
      appDataDir,
      connectionPool: sharedPool,
      storageClient: controlStorage,
    })

    await controlAdapter.rebuildNativeContext(
      {
        rebuildId: randomUUID(),
        sessionId: randomUUID(),
        cwd,
        model: null,
        effort: null,
        requestPermission: async (req) => {
          rebuildPermForwarded += 1
          return req.actions?.[0]?.id ?? 'agy-cancel'
        },
        requestUserInput: async () => {
          rebuildElicitForwarded += 1
          return { action: 'accept' }
        },
      },
      (async function* () {})(),
      new AbortController().signal,
    )
    expect(rebuildPermForwarded).toBe(1)
    expect(rebuildElicitForwarded).toBe(1)

    let forkInitElicitForwarded = 0
    const forkBoundary: AgentNativeForkBoundary = {
      provider: 'agy',
      nativeSessionId: 'sid-fork-src',
      nativeCutId: 'exec-1',
      nativeTurnId: 'exec-1',
      bindingGeneration: 1,
      throughSequence: 2,
      deliveryCursor: 0,
      prefixHash: 'c'.repeat(64),
      prefixBytes: 64,
      prefixRecords: 0,
      agyCut: {
        version: 'pact-agy-fork-cut-v1',
        trajectoryId: 'traj-1',
        executionId: 'exec-1',
        cutStepIdx: 1,
      },
    }
    const forkWitness: AgentNativeForkWitness = {
      version: 'pact-native-fork-v1',
      provider: 'agy',
      sourceNativeSessionId: 'sid-fork-src',
      nativeSessionId: 'sid-fork-cand',
      sourceCutId: 'exec-1',
      sourcePrefixHash: 'c'.repeat(64),
      sourceTrajectoryId: 'traj-1',
      candidateTrajectoryId: 'traj-2',
      candidatePrefixHash: 'c'.repeat(64),
      candidatePrefixRecords: 0,
      idMap: [['sid-fork-src', 'sid-fork-cand']],
      model: 'gemini-4-carbon',
      effort: 'high',
      permissionMode: 'ask',
      agyCut: {
        version: 'pact-agy-fork-cut-v1',
        trajectoryId: 'traj-2',
        executionId: 'exec-1',
        cutStepIdx: 1,
      },
    }
    await controlAdapter.initializeNativeFork(
      {
        operationId: randomUUID(),
        sessionId: randomUUID(),
        cwd,
        model: null,
        effort: null,
        permissionMode: 'ask',
        source: forkBoundary,
        nativeSessionId: 'sid-fork-cand',
        witness: forkWitness,
        onDispatched: async () => undefined,
        onCandidate: async () => undefined,
        reportNativeWork: () => undefined,
        requestUserInput: async () => {
          forkInitElicitForwarded += 1
          return { action: 'accept' }
        },
      },
      new AbortController().signal,
    )
    expect(forkInitElicitForwarded).toBe(1)

    await controlAdapter.dispose()
    await sideAdapter.dispose()
    await mainAdapter.dispose()
    await sharedPool.dispose()
  })

  it('never self-pins AgyRunMcpServer trajectoryId from untrusted HTTP read_collaboration_source or workflow tool calls before ACP binds root trajectory', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    const sessionId = randomUUID()
    const runId = randomUUID()
    const grantId = randomUUID()
    let mcpUrl = ''
    let mcpName = ''
    let preBindSourceError: unknown
    let preBindReviewError: unknown
    let postBindHijackError: unknown
    let postBindValidIsError: unknown

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpUrl = servers?.[0]?.url ?? ''
        mcpName = servers?.[0]?.name ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-no-self-pin'),
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [
              { id: 'model', currentValue: 'gemini-4-carbon' },
              { id: 'thought_level', currentValue: 'high' },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        const rSource = await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'read_collaboration_source',
              arguments: { runId, grant: grantId, source: 'inputs', offset: 0 },
              _meta: {
                'antigravity.google/root_conversation_id': 'sid-no-self-pin',
                'antigravity.google/conversation_id': 'sid-no-self-pin',
                progressToken: 'attacker-traj:1',
              },
            },
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>)
        preBindSourceError = (rSource.result as Record<string, unknown>).isError

        const rReview = await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'submit_review',
              arguments: { verdict: 'accepted' },
              _meta: {
                'antigravity.google/root_conversation_id': 'sid-no-self-pin',
                'antigravity.google/conversation_id': 'sid-no-self-pin',
                progressToken: 'attacker-traj:2',
              },
            },
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>)
        preBindReviewError = (rReview.result as Record<string, unknown>).isError

        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-no-self-pin',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-read-src',
              name: `mcp__${mcpName}__read_collaboration_source`,
              status: 'in_progress',
              progressToken: 'true-root-traj:3',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 5))

        const rHijack = await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'read_collaboration_source',
              arguments: { runId, grant: grantId, source: 'inputs', offset: 0 },
              _meta: {
                'antigravity.google/root_conversation_id': 'sid-no-self-pin',
                'antigravity.google/conversation_id': 'sid-no-self-pin',
                progressToken: 'attacker-traj:4',
              },
            },
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>)
        postBindHijackError = (rHijack.result as Record<string, unknown>).isError

        const rValid = await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: {
              name: 'read_collaboration_source',
              arguments: { runId, grant: grantId, source: 'inputs', offset: 0 },
              _meta: {
                'antigravity.google/root_conversation_id': 'sid-no-self-pin',
                'antigravity.google/conversation_id': 'sid-no-self-pin',
                progressToken: 'true-root-traj:3',
              },
            },
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>)
        postBindValidIsError = (rValid.result as Record<string, unknown>).isError

        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-no-self-pin',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Review complete.' },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn' },
        })
      }
    })

    const { task, authorization } = makeCollaborationTask(sessionId, runId, 'plan_review')
    let legacySourceCalls = 0

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
    })

    await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          sessionId,
          runId,
          readCollaborationSourcePart: () => {
            legacySourceCalls += 1
            return {
              source: 'inputs',
              offset: 0,
              nextOffset: null,
              text: 'Frozen plan source',
            }
          },
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId,
            message: { id: randomUUID(), content: 'Review frozen plan' },
            comments: [],
            collaboration: task,
            collaborationAuthorization: authorization,
            sourceGrant: { runId, grant: grantId },
          },
        }),
        new AbortController().signal,
      ),
    )

    expect(preBindSourceError).toBe(true)
    expect(preBindReviewError).toBe(true)
    expect(postBindHijackError).toBe(true)
    expect(postBindValidIsError).toBeUndefined()
    expect(legacySourceCalls).toBe(1)

    await adapter.dispose()
  })

  it('stages pre-bind updates and drops foreign execution_id chunks without binding root identity, promoting Steer, or appending foreign text', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    let activeRunId = ''

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/load') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-foreign-filter'),
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [
              { id: 'model', currentValue: 'gemini-4-carbon' },
              { id: 'thought_level', currentValue: 'high' },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-foreign-filter',
            update: {
              sessionUpdate: 'user_message_chunk',
              execution_id: 'exec-foreign-old',
              step_idx: 1,
              content: { type: 'text', text: 'Unrelated external CLI prompt' },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-foreign-filter',
            update: {
              sessionUpdate: 'agent_message_chunk',
              execution_id: 'exec-foreign-old',
              step_idx: 2,
              content: { type: 'text', text: 'FOREIGN_POISON_BEFORE_BIND ' },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-foreign-filter',
            update: {
              sessionUpdate: 'user_message_chunk',
              execution_id: 'exec-root-clean',
              step_idx: 3,
              content: {
                type: 'text',
                text: `Verify isolation\n${JSON.stringify({ version: 'pact-agent-prompt-v1', pactRunId: activeRunId })}`,
              },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-foreign-filter',
            update: {
              sessionUpdate: 'agent_message_chunk',
              execution_id: 'exec-foreign-interleaved',
              step_idx: 4,
              content: { type: 'text', text: 'FOREIGN_POISON_AFTER_BIND ' },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-foreign-filter',
            update: {
              sessionUpdate: 'agent_message_chunk',
              execution_id: 'exec-root-clean',
              step_idx: 5,
              content: { type: 'text', text: 'Authentic root reply.' },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn', execution_id: 'exec-root-clean' },
        })
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
    })

    activeRunId = randomUUID()
    const events = await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          runId: activeRunId,
          nativeSessionId: 'sid-foreign-filter',
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId: randomUUID(),
            message: { id: randomUUID(), content: 'Verify isolation' },
            comments: [],
          },
        }),
        new AbortController().signal,
      ),
    )

    const completedText = events.find((e) => e.type === 'text.completed')
    expect(completedText).toMatchObject({
      type: 'text.completed',
      text: 'Authentic root reply.',
    })
    const deltas = events
      .filter(
        (e): e is Extract<NormalizedAgentEvent, { type: 'text.delta' }> => e.type === 'text.delta',
      )
      .map((e) => e.text)
      .join('')
    expect(deltas).toBe('Authentic root reply.')
    expect(deltas).not.toContain('FOREIGN_POISON')

    await adapter.dispose()
  })

  it('preserves verified completed outcome when Stop aborts signal during foreground output drain after end_turn reply', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-stop-drain'),
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [
              { id: 'model', currentValue: 'gemini-4-carbon' },
              { id: 'thought_level', currentValue: 'high' },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sid-stop-drain',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Complete native answer before Stop.' },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn' },
        })
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
    })

    const abortController = new AbortController()
    const terminalEvidence: unknown[] = []
    const effectReports: Array<{ state: string; reason?: string | undefined }> = []

    const events = await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          waitForRootOutput: async () => {
            abortController.abort()
          },
          recordNativeEvidence: (ev) => {
            if (ev.kind === 'ended') terminalEvidence.push(ev)
          },
          reportNativeEffects: (r) => {
            effectReports.push({ state: r.state, reason: r.reason })
          },
        }),
        abortController.signal,
      ),
    )

    const turnCompleted = events.find((e) => e.type === 'turn.completed')
    expect(turnCompleted).toMatchObject({
      type: 'turn.completed',
      outcome: 'completed',
    })
    expect(terminalEvidence).toHaveLength(1)
    expect(terminalEvidence[0]).toMatchObject({
      kind: 'ended',
      source: 'live_terminal',
      outcome: 'completed',
    })
    expect(effectReports.at(-1)).toEqual({
      state: 'settled',
      reason: 'native_work_drained',
    })

    await adapter.dispose()
  })

  it('exposes hasExecutor, marks >64 background tasks unconfirmed without settling, caps deep JSON & oversized progressToken, re-verifies deleted Rebuild disk artifacts, awaits post-reply config_option_update, and omits unknown default effort receipts', async () => {
    const { cwd, appDataDir } = await createEnv()
    let harness = createAcpHarness()
    let mode:
      | 'bg_overflow'
      | 'deep_json'
      | 'oversized_pt'
      | 'rebuild_op'
      | 'post_reply_config'
      | 'unknown_effort' = 'bg_overflow'

    const wireR2Harness = (h: AcpHarness): AcpHarness => {
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new' || frame.method === 'session/load') {
          if (mode === 'rebuild_op') {
            h.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: defaultSessionNewResult(
                (frame.params as { sessionId?: string }).sessionId ?? 'sid-rebuild-r2-6',
              ),
            })
            return
          }
          if (mode === 'post_reply_config') {
            h.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: {
                sessionId: 'sid-post-reply-6',
                models: {
                  currentModelId: 'gemini-old',
                  availableModels: [{ modelId: 'gemini-old' }, { modelId: 'gemini-post-reply' }],
                },
                modes: {
                  currentModeId: 'default',
                  availableModes: [{ id: 'default' }, { id: 'plan' }, { id: 'auto' }],
                },
              },
            })
            return
          }
          if (mode === 'unknown_effort') {
            h.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: {
                sessionId: 'sid-unknown-effort',
                models: { currentModelId: 'gemini-4-carbon' },
                modes: { currentModeId: 'default', availableModes: [{ id: 'default' }] },
              },
            })
            return
          }
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(
              (frame.params as { sessionId?: string }).sessionId ?? 'sid-r2-6',
            ),
          })
          return
        }
        if (frame.method === 'session/close') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          return
        }
        if (frame.method === 'session/set_mode') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          return
        }
        if (frame.method === 'session/set_model') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          setTimeout(() => {
            h.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sid-post-reply-6',
                update: {
                  sessionUpdate: 'config_option_update',
                  configOptions: [
                    { id: 'model', currentValue: 'gemini-post-reply' },
                    { id: 'thought_level', currentValue: 'medium' },
                  ],
                },
              },
            })
          }, 15)
          return
        }
        if (frame.method === 'session/set_config_option') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'gemini-4-carbon' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
          return
        }
        if (frame.method === 'session/prompt') {
          if (mode === 'bg_overflow') {
            for (let i = 1; i <= 65; i += 1) {
              h.sendToClient({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: 'sid-r2-6',
                  update: {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: `bg-tc-${i}`,
                    name: 'run_command',
                    status: 'completed',
                    args: { CommandLine: `daemon-${i}`, IsDaemon: true },
                    rawOutput: { taskId: `bg-task-${i}` },
                  },
                },
              })
            }
            h.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sid-r2-6',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Spawned 65 background tasks.' },
                },
              },
            })
            h.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn' },
            })
            return
          }
          if (mode === 'deep_json') {
            const isStillDeepJson = (): boolean => mode === 'deep_json'
            void (async () => {
              const twoHundredKiB = 'x'.repeat(200 * 1024)
              for (let k = 0; k < 45 && isStillDeepJson(); k += 1) {
                let nested: Record<string, unknown> = { leaf: twoHundredKiB }
                for (let d = 0; d < 10; d += 1) {
                  nested = { child: nested }
                }
                h.sendToClient({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'sid-deep-json',
                    update: {
                      sessionUpdate: 'tool_call',
                      toolCallId: `tc-deep-10-${k}`,
                      name: 'custom_tool',
                      status: 'in_progress',
                      rawOutput: nested,
                    },
                  },
                })
                if (k % 10 === 9) {
                  await new Promise<void>((r) => setImmediate(r))
                }
              }
            })()
            return
          }
          if (mode === 'oversized_pt') {
            const isStillOversizedPt = (): boolean => mode === 'oversized_pt'
            void (async () => {
              const ptChunk = 'p'.repeat(200 * 1024)
              for (let k = 0; k < 45 && isStillOversizedPt(); k += 1) {
                h.sendToClient({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'sid-oversized-pt',
                    update: {
                      sessionUpdate: 'tool_call',
                      toolCallId: `tc-huge-pt-${k}`,
                      name: 'custom_tool',
                      status: 'in_progress',
                      progressToken: ptChunk,
                    },
                  },
                })
                if (k % 10 === 9) {
                  await new Promise<void>((r) => setImmediate(r))
                }
              }
            })()
            return
          }
          h.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: (frame.params as { sessionId: string }).sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Done.' },
              },
            },
          })
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })
      return h
    }
    wireR2Harness(harness)

    let diskReceiptPresent = true
    let inspectCalls = 0
    const storageClient: AgyNativeStorageClient = {
      async writeRebuildSeed() {
        return {
          seedHash: '1'.repeat(64),
          chunkCount: 0,
          stepCount: 0,
          verifiedPrefixBytes: 16,
          verifiedPrefixSha256: '2'.repeat(64),
          pbSha256: '2'.repeat(64),
          pbBytes: 16,
        }
      },
      async inspectRebuildSeed(input) {
        inspectCalls += 1
        if (!diskReceiptPresent) {
          return { verified: false, seedHash: '', stepCount: 0 }
        }
        return {
          verified: true,
          seedHash: '1'.repeat(64),
          stepCount: 2,
          initializationWitness: {
            kind: 'agy_rebuild_v1',
            nativeSessionId: input.nativeSessionId,
            sourceHash: input.sourceHash ?? '3'.repeat(64),
            pbSha256: '2'.repeat(64),
            pbBytes: 16,
            stepCount: 2,
            coldLoadVerifiedAt: new Date().toISOString(),
          },
        }
      },
    }

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => {
        if (harness.child.exitCode !== null) {
          harness = wireR2Harness(createAcpHarness())
        }
        return harness.child
      },
      storageClient,
    })

    const bgEffects: Array<{ state: string; reason?: string | undefined }> = []
    let capturedExecutorId = ''
    await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          recordDispatch: (_p, _sid, execId) => {
            if (execId) capturedExecutorId = execId
          },
          reportNativeEffects: (r) => bgEffects.push({ state: r.state, reason: r.reason }),
        }),
        new AbortController().signal,
      ),
    )
    expect(capturedExecutorId.length).toBeGreaterThan(0)
    expect(adapter.hasExecutor(capturedExecutorId)).toBe(true)
    expect(adapter.hasExecutor('non-existent-executor')).toBe(false)
    expect(bgEffects.some((e) => e.state === 'unknown')).toBe(true)

    for (let i = 1; i <= 64; i += 1) {
      harness.sendToClient({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sid-r2-6',
          update: {
            sessionUpdate: 'background_task_completed',
            taskId: `bg-task-${i}`,
            toolCallId: `bg-tc-${i}`,
          },
        },
      })
    }
    await new Promise((r) => setTimeout(r, 15))
    expect(bgEffects.some((e) => e.state === 'settled')).toBe(false)

    mode = 'deep_json'
    await expect(
      collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, { nativeSessionId: 'sid-deep-json' }),
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/working-memory budget/u)

    mode = 'oversized_pt'
    await expect(
      collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, { nativeSessionId: 'sid-oversized-pt' }),
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/working-memory budget/u)

    mode = 'rebuild_op'
    const rebuildId = randomUUID()
    const sourceHash = '4'.repeat(64)
    const rebuilt = await adapter.rebuildNativeContext(
      {
        rebuildId,
        sessionId: randomUUID(),
        cwd,
        model: null,
        effort: null,
        sourceHash,
      },
      (async function* () {})(),
      new AbortController().signal,
    )
    expect(rebuilt.initializationWitness).toBeDefined()
    const callsBeforeDelete = inspectCalls
    diskReceiptPresent = false

    const reInspected = await adapter.inspectNativeRebuild(
      {
        rebuildId,
        sessionId: randomUUID(),
        cwd,
        model: null,
        effort: null,
        nativeSessionId: rebuilt.nativeSessionId,
        sourceHash,
      },
      (async function* () {})(),
      new AbortController().signal,
    )
    expect(inspectCalls).toBeGreaterThan(callsBeforeDelete)
    expect(reInspected).toBeUndefined()

    const probedBinding = await adapter.probeNativeStatus(
      {
        target: 'initialized_binding',
        sessionId: randomUUID(),
        agentId: 'agy',
        requestId: randomUUID(),
        nativeSessionId: rebuilt.nativeSessionId,
        bindingGeneration: 1,
        cwd,
        model: null,
        effort: null,
        confirmedInitialization: {
          rebuildId,
          sourceHash,
        },
        source: (async function* () {})(),
      },
      new AbortController().signal,
    )
    expect(probedBinding.kind).toBe('no_evidence')

    mode = 'post_reply_config'
    const postReplySettings: unknown[] = []
    const postReplyEvents = await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          model: 'gemini-post-reply',
          effort: null,
          recovery: {
            inputSha256: '5'.repeat(64),
            recordEffectiveSettings: (s) => postReplySettings.push(s),
            recordConfirmedUnsent: () => undefined,
          },
        }),
        new AbortController().signal,
      ),
    )
    expect(postReplyEvents).toContainEqual({
      agentId: 'agy',
      type: 'run.model.resolved',
      model: 'gemini-post-reply',
      effort: 'medium',
    })
    expect(postReplySettings).toHaveLength(1)
    expect(postReplySettings[0]).toMatchObject({
      model: 'gemini-post-reply',
      effort: { known: true, value: 'medium' },
    })

    mode = 'unknown_effort'
    const unknownEffortSettings: unknown[] = []
    await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          model: null,
          effort: null,
          recovery: {
            inputSha256: '6'.repeat(64),
            recordEffectiveSettings: (s) => unknownEffortSettings.push(s),
            recordConfirmedUnsent: () => undefined,
          },
        }),
        new AbortController().signal,
      ),
    )
    expect(unknownEffortSettings).toEqual([])

    await adapter.dispose()
  })
})
