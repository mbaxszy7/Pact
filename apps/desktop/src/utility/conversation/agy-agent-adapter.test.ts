import Database from 'better-sqlite3'
/* oxlint-disable typescript/no-unsafe-type-assertion, no-await-in-loop -- ACP protocol harness models stdio streams, JSON-RPC frames, and sequential stream-step assertions directly. */
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  resolveAgentCollaborationSourceCapability,
  type AgentCollaborationSourceReader,
  type AgentNativeForkBoundary,
  type AgentNativeForkWitness,
  type AgentRunInput,
} from '@pact/agent-runtime'
import {
  codexCollaborationSourceWireReadSchema,
  collaborationInputResultSchema,
  collaborationPlanRetentionInputSchema,
  collaborationPublishPlanInputSchema,
  collaborationReviewInputSchema,
  collaborationSourceAnyReadSchema,
  collaborationSourceReadResultSchema,
  normalizedAgentEventSchema,
  peerRequestToolInputSchema,
  sessionTitleInputSchema,
  type CollaborationSourceReadResult,
  type CollaborationTask,
  type CollaborationTurnAuthorization,
  type NativeBackgroundReport,
  type NormalizedAgentEvent,
} from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import * as utilityLog from '../../diagnostics/utility-log.js'
import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import { WorkspaceChanges } from '../workspace-changes/workspace-changes.js'
import { AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS, AgyAcpConnectionPool } from './agy-acp-connection.js'
import {
  AgyAgentAdapter,
  agyElicitationRequest,
  buildAgyPactMcpServerName,
  type AgyNativeStorageClient,
} from './agy-agent-adapter.js'
import {
  configureAgyStorageChildScriptForTesting,
  configureDefaultAgyStorageTransport,
  NodeChildProcessAgyStorageTransport,
  type AgyStorageTransport,
} from './agy-storage-runner.js'
import { NativeForkFiles } from './native-fork-files.js'
import { setPromptCutoffSupplement } from './native-image-content.js'
import { nativeWorkerFixture } from './native-workers-fixture.test-support.js'
import {
  NATIVE_APP_WORKING_BYTES,
  NATIVE_OWNER_WORKING_BYTES,
  NativeWorkingMemory,
  nativeWorkingMemoryDiagnostics,
} from './native-working-memory.js'

const forkWorker = vi.hoisted(() => ({
  path: '',
  overridePath: undefined as string | undefined,
  extraWorkerData: undefined as Record<string, unknown> | undefined,
  onSpawn: undefined as ((worker: import('node:worker_threads').Worker) => void) | undefined,
}))
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const isForkWorker = String(filename).endsWith('native-fork-worker.js')
        const targetPath = isForkWorker ? (forkWorker.overridePath ?? forkWorker.path) : filename
        const effectiveOptions =
          isForkWorker && forkWorker.extraWorkerData && options
            ? {
                ...options,
                workerData:
                  options.workerData && typeof options.workerData === 'object'
                    ? { ...options.workerData, ...forkWorker.extraWorkerData }
                    : options.workerData,
              }
            : options
        super(targetPath || filename, effectiveOptions)
        if (isForkWorker) {
          forkWorker.onSpawn?.(this)
        }
      }
    },
  }
})

let workerFixture: Awaited<ReturnType<typeof nativeWorkerFixture>>
beforeAll(async () => {
  workerFixture = await nativeWorkerFixture(['native-fork-worker', 'agy-storage-child'])
  forkWorker.path = workerFixture.paths['native-fork-worker']!
  configureAgyStorageChildScriptForTesting(workerFixture.paths['agy-storage-child'])
}, 30_000)
afterAll(async () => {
  configureAgyStorageChildScriptForTesting(undefined)
  await workerFixture?.dispose()
})

const tempDirs: string[] = []
afterEach(async () => {
  forkWorker.onSpawn = undefined
  forkWorker.overridePath = undefined
  forkWorker.extraWorkerData = undefined
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

async function createDbFixture(
  appDataDir: string,
  nativeSessionId: string,
  trajectoryId: string,
  stepCount: number,
): Promise<void> {
  const convDir = join(appDataDir, 'conversations')
  await mkdir(convDir, { recursive: true })
  const db = new Database(join(convDir, `${nativeSessionId}.db`))
  try {
    db.exec(`
      CREATE TABLE "trajectory_meta" ("trajectory_id" TEXT PRIMARY KEY, "cascade_id" TEXT NOT NULL);
      CREATE TABLE "steps" ("idx" INTEGER PRIMARY KEY);
    `)
    db.prepare('INSERT INTO "trajectory_meta" ("trajectory_id", "cascade_id") VALUES (?, ?)').run(
      trajectoryId,
      nativeSessionId,
    )
    for (let i = 0; i < stepCount; i += 1) {
      db.prepare('INSERT INTO "steps" ("idx") VALUES (?)').run(i)
    }
  } finally {
    db.close()
  }
}

const LEGACY_SOURCE_FN = Symbol('legacySourceFn')
type LegacySourceWrapper = AgentCollaborationSourceReader & {
  [LEGACY_SOURCE_FN]?: (raw: unknown) => CollaborationSourceReadResult
}

function legacySourceReader(
  readFn: (raw: unknown) => CollaborationSourceReadResult,
  identity: { runId: string; grant: string } = { runId: '', grant: '' },
): LegacySourceWrapper {
  const wrapper: LegacySourceWrapper = {
    identity,
    supportedForms: ['legacy'],
    navigation: (target) => ({ ...wrapper.identity, ...target, offset: 0 }),
    read: (raw) => {
      const request = collaborationSourceAnyReadSchema.parse(raw)
      if (request.runId !== wrapper.identity.runId || request.grant !== wrapper.identity.grant) {
        throw new Error('This source capability does not belong to the current root.')
      }
      const page = collaborationSourceReadResultSchema.parse(readFn(raw))
      return {
        submitted: 'legacy',
        request,
        page: {
          ...page,
          binding: {
            submitted: 'legacy',
            callerRunId: wrapper.identity.runId,
            grantSha256: createHash('sha256').update(wrapper.identity.grant).digest('hex'),
            referenceSha256: null,
          },
        },
      }
    },
    retire: () => undefined,
    [LEGACY_SOURCE_FN]: readFn,
  }
  return wrapper
}

function makeBaseRunInput(cwd: string, overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  const sessionId = overrides.sessionId ?? randomUUID()
  const runId = overrides.runId ?? randomUUID()
  const result: AgentRunInput = {
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
  const reader = result.host?.workflow?.sourceReader
  if (reader && LEGACY_SOURCE_FN in reader && result.promptEnvelope.sourceGrant) {
    Object.defineProperty(reader, 'identity', {
      value: result.promptEnvelope.sourceGrant,
      configurable: true,
    })
  }
  return result
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

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectArraySchemasWithoutItems(
  node: unknown,
  path: string,
  missingPaths: string[],
): void {
  if (!isSchemaRecord(node)) return
  if (node.type === 'array') {
    if (!isSchemaRecord(node.items)) {
      missingPaths.push(`${path}.items`)
    } else {
      collectArraySchemasWithoutItems(node.items, `${path}.items`, missingPaths)
    }
  }
  if (isSchemaRecord(node.properties)) {
    for (const [key, propSchema] of Object.entries(node.properties)) {
      collectArraySchemasWithoutItems(propSchema, `${path}.properties.${key}`, missingPaths)
    }
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = node[keyword]
    if (Array.isArray(variants)) {
      for (const [idx, variant] of variants.entries()) {
        collectArraySchemasWithoutItems(variant, `${path}.${keyword}[${idx}]`, missingPaths)
      }
    }
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
    const requestPermissionSpy =
      vi.fn<
        NonNullable<
          NonNullable<NonNullable<AgentRunInput['host']>['interactions']>['requestPermission']
        >
      >()

    // Even if session permissionMode is 'full', read-only stage MUST use 'standard' connection!
    const run1Input = makeBaseRunInput(cwd, {
      sessionId,
      runId: run1Id,
      permissionMode: 'full',
      speed: 'fast',
      promptEnvelope: {
        version: 'pact-agent-prompt-v1',
        sessionId,
        message: { id: randomUUID(), content: '/plan Build safe adapter' },
        comments: [],
        sourceGrant: { runId: run1Id, grant: 'g-1' },
        collaboration: task,
        collaborationAuthorization: authorization,
      },
      host: {
        workflow: {
          recordPlan: (plan) => capturedPlans.push(plan),
          sourceReader: legacySourceReader(() => ({
            source: 'inputs',
            offset: 0,
            nextOffset: null,
            totalBytes: 2,
            text: '[]',
          })),
        },
        interactions: {
          requestPermission: requestPermissionSpy,
        },
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
        if (frame.method === 'session/close') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
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
          host: {
            interactions: {
              async requestPermission(req) {
                capturedCardActions = req.actions ?? []
                return 'agy-allow-once'
              },
            },
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
    const fullUiSpy =
      vi.fn<
        NonNullable<
          NonNullable<NonNullable<AgentRunInput['host']>['interactions']>['requestPermission']
        >
      >()
    await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          permissionMode: 'full',
          host: {
            interactions: {
              requestPermission: fullUiSpy,
            },
          },
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
          host: {
            interactions: {
              async requestUserInput(req) {
                expect(req.kind).toBe('form')
                expect(req.fields[0]).toMatchObject({
                  id: 'storage',
                  type: 'select',
                  required: true,
                })
                return { action: 'accept', values: { storage: 'sqlite' } }
              },
            },
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
          host: {
            interactions: {
              async requestUserInput(_req, waitSignal) {
                runAbort.abort()
                await new Promise((_r, rej) => {
                  if (waitSignal.aborted) rej(new Error('aborted'))
                  else waitSignal.addEventListener('abort', () => rej(new Error('aborted')))
                })
                return { action: 'accept', values: { storage: 'sqlite' } }
              },
            },
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
      promptEnvelope: {
        version: 'pact-agent-prompt-v1',
        sessionId,
        requestSessionTitle: true,
        message: { id: randomUUID(), content: 'Start side chat check' },
        comments: [],
      },
      host: {
        effects: {
          recordBackgroundReport: async (report) => {
            backgroundReports.push(report)
          },
          reportNativeEffects: (r) => effectReports.push(r),
        },
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
          host: {
            effects: {
              reportNativeEffects: (r) => effectReports.push(r),
            },
          },
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
          host: {
            effects: {
              recordFileChange: async (change) => {
                recordedChanges.push(change)
              },
            },
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
            host: {
              lifecycle: {
                recordExecutor: (execId) => {
                  runARecordedExecutor = execId
                },
              },
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
              host: {
                lifecycle: {
                  recordExecutor: (execId) => {
                    runBRecordedExecutor = execId
                  },
                  recordNativeEvidence: (ev) => {
                    recordedEvidences.push({ kind: ev.kind, executorId: ev.identity.executorId })
                  },
                },
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
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId: randomUUID(),
            requestSessionTitle: true,
            message: { id: randomUUID(), content: 'Check MCP strictness in full mode' },
            comments: [],
          },
          host: {
            lifecycle: {
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
            },
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
          makeBaseRunInput(cwd, {
            host: {
              effects: {
                reportNativeEffects: (r) => missingEffects.push(r.state),
              },
            },
          }),
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
          host: {
            lifecycle: {
              recordNativeEvidence: (evidence) => hungEvidenceKinds.push(evidence.kind),
            },
            effects: {
              reportNativeEffects: (r) => hungEffects.push(r.state),
            },
          },
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

  it('allows healthy root session/prompt to think past 30s before first update and settles cleanly on completion or cancel', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    const promptState = { frameId: undefined as string | number | undefined }
    let promptSessionId = 'sid-slow-first-token'
    let cancelMode = false

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        promptSessionId = 'sid-slow-first-token'
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(promptSessionId),
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
        promptState.frameId = frame.id as string | number
        return
      }
      if (frame.method === 'session/cancel' && cancelMode && promptState.frameId !== undefined) {
        const replyId = promptState.frameId
        promptState.frameId = undefined
        harness.sendToClient({
          jsonrpc: '2.0',
          id: replyId,
          result: { stopReason: 'cancelled' },
        })
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
    })

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // 1. Slow first token (> 35s) must NOT self-cancel at 30s and must complete with settled effects.
      const effects1: string[] = []
      const dispatches1: string[] = []
      const run1Promise = collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            host: {
              lifecycle: {
                recordDispatch: (phase) => dispatches1.push(phase),
              },
              effects: {
                reportNativeEffects: (r) => effects1.push(r.state),
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      while (promptState.frameId === undefined) {
        await new Promise<void>((r) => setImmediate(r))
      }
      await vi.advanceTimersByTimeAsync(35_000)
      await new Promise<void>((r) => setImmediate(r))

      expect(
        harness.notificationsFromClient.filter((n) => n.method === 'session/cancel'),
      ).toHaveLength(0)

      harness.sendToClient({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: promptSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Delayed orchestrator answer' },
          },
        },
      })
      harness.sendToClient({
        jsonrpc: '2.0',
        id: promptState.frameId,
        result: { stopReason: 'end_turn' },
      })
      promptState.frameId = undefined

      const events1 = await run1Promise
      expect(events1).toContainEqual(
        expect.objectContaining({ type: 'text.completed', text: 'Delayed orchestrator answer' }),
      )
      expect(events1).toContainEqual(
        expect.objectContaining({ type: 'turn.completed', outcome: 'completed' }),
      )
      expect(dispatches1).toEqual(['possibly_sent', 'accepted'])
      expect(effects1).toContain('settled')
      expect(effects1).not.toContain('unknown')

      // 2. Explicit caller abort while thinking still sends session/cancel and settles cleanly on cancelled reply.
      cancelMode = true
      const abortCtrl = new AbortController()
      const effects2: string[] = []
      const run2Promise = collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            host: {
              effects: {
                reportNativeEffects: (r) => effects2.push(r.state),
              },
            },
          }),
          abortCtrl.signal,
        ),
      )

      while (promptState.frameId === undefined) {
        await new Promise<void>((r) => setImmediate(r))
      }
      abortCtrl.abort()

      const events2 = await run2Promise
      expect(
        harness.notificationsFromClient.filter((n) => n.method === 'session/cancel'),
      ).toHaveLength(1)
      expect(events2).toContainEqual(
        expect.objectContaining({ type: 'turn.completed', outcome: 'interrupted' }),
      )
      expect(effects2).toContain('settled')
      expect(effects2).not.toContain('unknown')
    } finally {
      vi.useRealTimers()
      await adapter.dispose()
    }
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
          host: {
            effects: {
              reportNativeEffects: (r) => effectStates.push(r.state),
              recordBackgroundReport: async (r) => {
                bgReports.push(r)
              },
            },
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
        promptEnvelope: {
          version: 'pact-agent-prompt-v1',
          sessionId,
          message: { id: randomUUID(), content: '/plan Verify diff path' },
          comments: [],
          collaboration: task,
          collaborationAuthorization: authorization,
        },
        host: {
          lifecycle: {
            recordDispatch: (status) => dispatchRecords.push(status),
          },
          workflow: {
            recordPlan: (p) => capturedPlans.push(p),
            recordPlanUnavailable: () => {
              planUnavailableCount += 1
            },
          },
          interactions: {
            async requestUserInput(req) {
              expect(req.kind).toBe('url')
              // At the moment init-phase elicitation runs, `session/prompt` has NOT even been sent!
              expect(dispatchRecords).toEqual([])
              return { action: 'accept' }
            },
          },
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
          host: {
            lifecycle: {
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
            },
            effects: {
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
            },
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
          host: {
            lifecycle: {
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
            },
            effects: {
              reportNativeEffects: (report) => {
                recordedEffectsB.push({ state: report.state, reason: report.reason })
                repo.recordNativeEffects(runB.id, report.state, report.reason)
              },
            },
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
        host: {
          interactions: {
            requestPermission: async (req) => {
              mainPermCalls += 1
              return req.actions?.[0]?.id ?? 'agy-cancel'
            },
          },
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
          host: {
            interactions: {
              requestPermission: async () => {
                sidePermCalls += 1
                return 'allow-side'
              },
            },
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
              rawInput: { runId, grant: grantId, source: 'inputs', offset: 0 },
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
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId,
            message: { id: randomUUID(), content: 'Review frozen plan' },
            comments: [],
            collaboration: task,
            collaborationAuthorization: authorization,
            sourceGrant: { runId, grant: grantId },
          },
          host: {
            workflow: {
              sourceReader: legacySourceReader(() => {
                legacySourceCalls += 1
                return {
                  source: 'inputs',
                  offset: 0,
                  nextOffset: null,
                  text: 'Frozen plan source',
                }
              }),
            },
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
          host: {
            lifecycle: {
              waitForRootOutput: async () => {
                abortController.abort()
              },
              recordNativeEvidence: (ev) => {
                if (ev.kind === 'ended') terminalEvidence.push(ev)
              },
            },
            effects: {
              reportNativeEffects: (r) => {
                effectReports.push({ state: r.state, reason: r.reason })
              },
            },
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
                h.sendToClient({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'sid-oversized-pt',
                    update: {
                      sessionUpdate: 'tool_call_update',
                      toolCallId: `tc-huge-pt-${k}`,
                      name: 'custom_tool',
                      status: 'completed',
                      progressToken: ptChunk,
                    },
                  },
                })
                if (k % 10 === 9) {
                  await new Promise<void>((r) => setImmediate(r))
                }
              }
              h.sendToClient({
                jsonrpc: '2.0',
                id: frame.id,
                result: { stopReason: 'end_turn' },
              })
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
          host: {
            lifecycle: {
              recordDispatch: (_p, _sid, execId) => {
                if (execId) capturedExecutorId = execId
              },
            },
            effects: {
              reportNativeEffects: (r) => bgEffects.push({ state: r.state, reason: r.reason }),
            },
          },
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
    // Let any trailing frame from the aborted `deep_json` loop settle before snapshotting baseline.
    await new Promise((r) => setTimeout(r, 20))
    const beforeOversizedPtBytes = nativeWorkingMemoryDiagnostics().chargedBytes ?? 0
    let maxOversizedPtDelta = 0
    await collectEvents(
      adapter.run(
        makeBaseRunInput(cwd, {
          nativeSessionId: 'sid-oversized-pt',
          host: {
            lifecycle: {
              waitForRootOutput: async () => {
                await new Promise((r) => setTimeout(r, 20))
                maxOversizedPtDelta =
                  (nativeWorkingMemoryDiagnostics().chargedBytes ?? 0) - beforeOversizedPtBytes
              },
            },
          },
        }),
        new AbortController().signal,
      ),
    )
    // Oversized 200 KiB raw progressTokens are rejected BEFORE tool-state storage; retained compact
    // metadata stays tiny (< 64 KiB, never accumulating 9 MiB of raw token strings).
    expect(maxOversizedPtDelta).toBeGreaterThan(0)
    expect(maxOversizedPtDelta).toBeLessThan(64 * 1024)

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
          host: {
            recovery: {
              inputSha256: '5'.repeat(64),
              recordEffectiveSettings: (s) => postReplySettings.push(s),
              recordConfirmedUnsent: () => undefined,
            },
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
          host: {
            recovery: {
              inputSha256: '6'.repeat(64),
              recordEffectiveSettings: (s) => unknownEffortSettings.push(s),
              recordConfirmedUnsent: () => undefined,
            },
          },
        }),
        new AbortController().signal,
      ),
    )
    expect(unknownEffortSettings).toEqual([])

    await adapter.dispose()
  })

  it('ignores stale pre-reply and trailing config_option_update notifications under plan mode, rejects genuine silent substitution, supports {} replies with stale notifications, closes failed fresh pre-prompt sessions, enforces 30s session lifecycle timeout, and bounds MCP tool names <= 64 chars', async () => {
    const { cwd, appDataDir } = await createEnv()

    // 1. Exact Bug 2A repro: plan mode emits stale model="gemini-4-neon" notification while session/set_config_option(model="gemini-pro-orchestrator") is in flight + trailing stale notification afterward!
    {
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
            result: {
              sessionId: 'sid-stale-plan',
              modes: { currentModeId: 'default', availableModes: ['default', 'plan'] },
              models: {
                currentModelId: 'gemini-4-neon-high',
                availableModels: ['gemini-4-neon-high', 'gemini-pro-orchestrator'],
              },
              configOptions: [
                {
                  id: 'model',
                  currentValue: 'gemini-4-neon',
                  options: [{ value: 'gemini-4-neon' }, { value: 'gemini-pro-orchestrator' }],
                },
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
        if (frame.method === 'session/set_mode') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          // Asynchronously emit stale config_option_update right after replying to session/set_mode!
          setTimeout(() => {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sid-stale-plan',
                update: {
                  sessionUpdate: 'config_option_update',
                  configOptions: [
                    { id: 'mode', currentValue: 'plan' },
                    { id: 'model', currentValue: 'gemini-4-neon' },
                    { id: 'thought_level', currentValue: 'high' },
                  ],
                },
              },
            })
          }, 0)
          return
        }
        if (frame.method === 'session/set_config_option') {
          setTimeout(() => {
            // Stale notification arrives concurrently BEFORE reply, reply carries authoritative gemini-pro-orchestrator (no thought_level), then another late stale notification arrives!
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sid-stale-plan',
                update: {
                  sessionUpdate: 'config_option_update',
                  configOptions: [
                    { id: 'mode', currentValue: 'plan' },
                    { id: 'model', currentValue: 'gemini-4-neon' },
                    { id: 'thought_level', currentValue: 'high' },
                  ],
                },
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: {
                configOptions: [
                  { id: 'mode', currentValue: 'plan' },
                  {
                    id: 'model',
                    currentValue: 'gemini-pro-orchestrator',
                    options: [{ value: 'gemini-4-neon' }, { value: 'gemini-pro-orchestrator' }],
                  },
                ],
              },
            })
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sid-stale-plan',
                update: {
                  sessionUpdate: 'config_option_update',
                  configOptions: [
                    { id: 'mode', currentValue: 'plan' },
                    { id: 'model', currentValue: 'gemini-4-neon' },
                    { id: 'thought_level', currentValue: 'high' },
                  ],
                },
              },
            })
          }, 10)
          return
        }
        if (frame.method === 'session/prompt') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const recordedSettings: unknown[] = []
      const planSessionId = randomUUID()
      const planRunId = randomUUID()
      const { task, authorization } = makeCollaborationTask(planSessionId, planRunId, 'plan')
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: planSessionId,
            runId: planRunId,
            model: 'gemini-pro-orchestrator',
            effort: null,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: planSessionId,
              message: { id: randomUUID(), content: 'Draft plan.' },
              comments: [],
              requestSessionTitle: true,
              sourceGrant: {
                runId: planRunId,
                grant: randomUUID(),
              },
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                sourceReader: legacySourceReader(() => ({
                  source: 'inputs',
                  offset: 0,
                  nextOffset: null,
                  text: 'Frozen input source.',
                })),
              },
              recovery: {
                inputSha256: 'a'.repeat(64),
                recordEffectiveSettings: (s) => recordedSettings.push(s),
                recordConfirmedUnsent: () => undefined,
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      expect(events).toContainEqual({
        agentId: 'agy',
        type: 'run.model.resolved',
        model: 'gemini-pro-orchestrator',
        effort: null,
      })
      expect(recordedSettings).toEqual([
        expect.objectContaining({
          model: 'gemini-pro-orchestrator',
          effort: { known: true, value: null },
        }),
      ])

      // Bug 2C check: MCP server name keeps every registered tool name <= 64 chars!
      const newReq = harness.requests.find((r) => r.method === 'session/new')
      const servers = (newReq?.params as { mcpServers?: Array<{ name: string; url: string }> })
        ?.mcpServers
      expect(servers).toHaveLength(1)
      const mcpName = servers![0]!.name
      expect(mcpName).toMatch(/^pact_peer_[a-f0-9]{16}$/u)
      for (const toolName of [
        'read_collaboration_source',
        'publish_session_title',
        'request_peer_assistance',
        'submit_review',
        'submit_input_result',
        'retain_current_plan',
        'publish_plan',
      ]) {
        expect(`mcp_${mcpName}_${toolName}`).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u)
      }
      await adapter.dispose()
    }

    // 2. Genuine silent substitution STILL rejects AND fresh pre-prompt failure closes its 0-turn session while resumed pre-prompt failure does NOT close!
    {
      const harness = createAcpHarness()
      const closedSessionIds: string[] = []
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              sessionId: 'sid-fresh-subst',
              modes: { currentModeId: 'default', availableModes: ['default', 'plan'] },
              configOptions: [
                {
                  id: 'model',
                  currentValue: 'gemini-4-neon',
                  options: [{ value: 'gemini-4-neon' }, { value: 'gemini-pro-orchestrator' }],
                },
              ],
            },
          })
          return
        }
        if (frame.method === 'session/load') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              sessionId: 'sid-resumed-subst',
              modes: { currentModeId: 'default', availableModes: ['default', 'plan'] },
              configOptions: [
                {
                  id: 'model',
                  currentValue: 'gemini-4-neon',
                  options: [{ value: 'gemini-4-neon' }, { value: 'gemini-pro-orchestrator' }],
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
        if (frame.method === 'session/set_config_option') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                {
                  id: 'model',
                  currentValue: 'gemini-4-neon',
                  options: [{ value: 'gemini-4-neon' }, { value: 'gemini-pro-orchestrator' }],
                },
              ],
            },
          })
          return
        }
        if (frame.method === 'session/close') {
          closedSessionIds.push(String((frame.params as { sessionId?: string }).sessionId))
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      await expect(
        collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, { model: 'gemini-pro-orchestrator', effort: null }),
            new AbortController().signal,
          ),
        ),
      ).rejects.toThrow(
        'Antigravity silently substituted model="gemini-4-neon" for requested "gemini-pro-orchestrator".',
      )
      expect(closedSessionIds).toEqual(['sid-fresh-subst'])

      await expect(
        collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              nativeSessionId: 'sid-resumed-subst',
              model: 'gemini-pro-orchestrator',
              effort: null,
            }),
            new AbortController().signal,
          ),
        ),
      ).rejects.toThrow(
        'Antigravity silently substituted model="gemini-4-neon" for requested "gemini-pro-orchestrator".',
      )
      expect(closedSessionIds).toEqual(['sid-fresh-subst'])
      await adapter.dispose()
    }

    // 3. {} reply on session/set_config_option ignores stale pre-reply notification and accepts post-reply matching notification.
    {
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
            result: {
              sessionId: 'sid-empty-reply',
              modes: { currentModeId: 'default', availableModes: ['default', 'plan'] },
              configOptions: [
                {
                  id: 'model',
                  currentValue: 'gemini-4-neon',
                  options: [{ value: 'gemini-4-neon' }, { value: 'gemini-pro-orchestrator' }],
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
        if (frame.method === 'session/set_config_option') {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-empty-reply',
              update: {
                sessionUpdate: 'config_option_update',
                configOptions: [{ id: 'model', currentValue: 'gemini-4-neon' }],
              },
            },
          })
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          setTimeout(() => {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sid-empty-reply',
                update: {
                  sessionUpdate: 'config_option_update',
                  configOptions: [{ id: 'model', currentValue: 'gemini-pro-orchestrator' }],
                },
              },
            })
          }, 15)
          return
        }
        if (frame.method === 'session/prompt') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, { model: 'gemini-pro-orchestrator', effort: null }),
          new AbortController().signal,
        ),
      )
      expect(events).toContainEqual({
        agentId: 'agy',
        type: 'run.model.resolved',
        model: 'gemini-pro-orchestrator',
        effort: null,
      })
      await adapter.dispose()
    }

    // 4. Bug 2B: session/new survives 18s cold cloud startup (> 15s old timeout) and only times out after 30s AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS.
    {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const harness = createAcpHarness()
      let slowNewDelayMs = 18_000
      let sessionNewSeenCount = 0
      const sessionNewWaiters = new Map<number, () => void>()
      const waitForSessionNew = (count: number) =>
        sessionNewSeenCount >= count
          ? Promise.resolve()
          : new Promise<void>((notifyWaiter) => {
              sessionNewWaiters.set(count, notifyWaiter)
            })
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new') {
          sessionNewSeenCount += 1
          sessionNewWaiters.get(sessionNewSeenCount)?.()
          sessionNewWaiters.delete(sessionNewSeenCount)
          if (slowNewDelayMs > 0) {
            setTimeout(() => {
              harness.sendToClient({
                jsonrpc: '2.0',
                id: frame.id,
                result: {
                  sessionId: 'sid-slow-18s',
                  modes: { currentModeId: 'default', availableModes: ['default'] },
                  configOptions: [
                    { id: 'model', currentValue: 'gemini-4-carbon' },
                    { id: 'thought_level', currentValue: 'high' },
                  ],
                },
              })
            }, slowNewDelayMs)
          }
          return
        }
        if (frame.method === 'session/set_mode') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          return
        }
        if (frame.method === 'session/prompt') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      const okPromise = collectEvents(
        adapter.run(makeBaseRunInput(cwd), new AbortController().signal),
      )
      await waitForSessionNew(1)
      await vi.advanceTimersByTimeAsync(18_500)
      const okEvents = await okPromise
      expect(okEvents).toContainEqual(
        expect.objectContaining({ type: 'turn.completed', outcome: 'completed' }),
      )

      // Now never answer session/new -> times out at AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS (30_000ms).
      slowNewDelayMs = -1
      const timeoutPromise = collectEvents(
        adapter.run(makeBaseRunInput(cwd), new AbortController().signal),
      )
      const caughtTimeout = timeoutPromise.catch((e: unknown) => e)
      await waitForSessionNew(2)
      await vi.advanceTimersByTimeAsync(AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS - 1_000)
      await new Promise<void>((r) => setImmediate(r))
      await vi.advanceTimersByTimeAsync(2_000)
      const timeoutErr = await caughtTimeout
      expect(timeoutErr).toBeInstanceOf(Error)
      expect((timeoutErr as Error).message).toContain(
        'Antigravity did not answer session/new before its deadline.',
      )

      vi.useRealTimers()
      await adapter.dispose()
    }
  })

  it('publishes Gemini-compatible array.items and typed schemas for submit_review and read_collaboration_source in tools/list', async () => {
    const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-schema-check-'))
    const cwd = join(appDataDir, 'workspace')
    await mkdir(cwd, { recursive: true })
    const harness = createAcpHarness()

    let listedTools: Array<Record<string, unknown>> = []
    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        const servers = Reflect.get(
          typeof frame.params === 'object' && frame.params !== null ? frame.params : {},
          'mcpServers',
        )
        const url =
          Array.isArray(servers) && typeof servers[0] === 'object' && servers[0] !== null
            ? Reflect.get(servers[0], 'url')
            : undefined
        if (typeof url === 'string' && url.length > 0) {
          const listRes: unknown = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          }).then((response) => response.json())
          const resultObj =
            typeof listRes === 'object' && listRes !== null
              ? Reflect.get(listRes, 'result')
              : undefined
          const toolsVal =
            typeof resultObj === 'object' && resultObj !== null
              ? Reflect.get(resultObj, 'tools')
              : undefined
          if (Array.isArray(toolsVal)) {
            listedTools = toolsVal.filter(
              (entry): entry is Record<string, unknown> =>
                typeof entry === 'object' && entry !== null && !Array.isArray(entry),
            )
          }
        }
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult('sid-plan-review-schemas'),
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
          id: frame.id,
          result: { stopReason: 'end_turn' },
        })
      }
    })

    const sessionId = randomUUID()
    const runId = randomUUID()
    const { task, authorization } = makeCollaborationTask(sessionId, runId, 'plan_review')
    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId,
            runId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId,
              message: { id: randomUUID(), content: 'Review plan.' },
              comments: [],
              sourceGrant: { runId, grant: randomUUID() },
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                sourceReader: legacySourceReader(() => ({
                  source: 'inputs',
                  offset: 0,
                  nextOffset: null,
                  text: 'Frozen input source.',
                })),
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      const submitReview = listedTools.find((t) => t.name === 'submit_review')
      const readSource = listedTools.find((t) => t.name === 'read_collaboration_source')
      expect(submitReview).toBeDefined()
      expect(readSource).toBeDefined()

      const missingArrayItems: string[] = []
      for (const tool of listedTools) {
        const toolName = typeof tool.name === 'string' ? tool.name : 'unknown'
        collectArraySchemasWithoutItems(tool.inputSchema, toolName, missingArrayItems)
      }
      expect(missingArrayItems).toEqual([])

      expect(submitReview).toMatchObject({
        inputSchema: {
          type: 'object',
          properties: {
            verdict: { type: 'string' },
            questions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  prompt: { type: 'string' },
                  selection: { type: 'string' },
                  options: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        label: { type: 'string' },
                        description: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      })

      expect(readSource).toMatchObject({
        inputSchema: {
          type: 'object',
          properties: {
            offset: { type: 'integer' },
            source: { type: 'string' },
          },
        },
      })
    } finally {
      await adapter.dispose()
      await rm(appDataDir, { recursive: true, force: true })
    }
  })

  it('authenticates real agy 1.5.13 Orchestrator MCP calls via SQLite trajectory_meta, correlates active ACP tool_calls across jitter/args, and promotes submit_review without progressToken on completed', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const trueTrajectoryId = randomUUID()
    const convDir = join(appDataDir, 'conversations')
    await mkdir(convDir, { recursive: true })
    const dbPath = join(convDir, `${nativeSessionId}.db`)
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE "trajectory_meta" ("trajectory_id" TEXT PRIMARY KEY, "cascade_id" TEXT NOT NULL);
        CREATE TABLE "steps" ("idx" INTEGER PRIMARY KEY);
      `)
      db.prepare('INSERT INTO "trajectory_meta" ("trajectory_id", "cascade_id") VALUES (?, ?)').run(
        trueTrajectoryId,
        nativeSessionId,
      )
      for (const idx of [0, 1, 2, 3]) {
        db.prepare('INSERT INTO "steps" ("idx") VALUES (?)').run(idx)
      }
    } finally {
      db.close()
    }

    const pactSessionId = randomUUID()
    const runId = randomUUID()
    const grantId = randomUUID()
    const sourceArgs = { runId, grant: grantId, source: 'inputs', offset: 0 }
    const harness = createAcpHarness()
    let mcpUrl = ''
    let mcpName = ''
    let unannouncedSourceError: unknown
    let replayStepError: unknown
    let mismatchedArgError: unknown
    let genuineSourceError: unknown
    let genuineSourceText: unknown
    let jitteredReviewError: unknown
    let promotedReviewError: unknown
    let subagentError: unknown
    let foreignTrajError: unknown

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new' || frame.method === 'session/load') {
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpUrl = servers?.[0]?.url ?? ''
        mcpName = servers?.[0]?.name ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            sessionId: nativeSessionId,
            modes: { currentModeId: 'default', availableModes: ['default', 'plan'] },
            configOptions: [
              { id: 'model', currentValue: 'gemini-4-neon' },
              { id: 'thought_level', currentValue: 'high' },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            configOptions: [
              { id: 'model', currentValue: 'gemini-pro-orchestrator' },
              { id: 'thought_level', currentValue: 'high' },
            ],
          },
        })
        return
      }
      if (frame.method === 'session/prompt') {
        const callHttp = async (
          id: number,
          name: string,
          args: Record<string, unknown>,
          progressToken: string,
          convId = nativeSessionId,
        ) =>
          fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id,
              method: 'tools/call',
              params: {
                name,
                arguments: args,
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': convId,
                  progressToken,
                },
              },
            }),
          }).then(
            (r) =>
              r.json() as Promise<{
                result: { isError?: boolean; content?: Array<{ text?: string }> }
              }>,
          )

        // 1. Unannounced HTTP call with no active ACP tool_call -> rejected!
        unannouncedSourceError = (
          await callHttp(1, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:5`)
        ).result.isError

        // 2. Replayed pre-turn step (< stepCount 4) even with an active ACP tool_call -> rejected!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_300001',
              name: `mcp_${mcpName}_read_collaboration_source`,
              status: 'in_progress',
              args: { ...sourceArgs, toolSummary: 'Read source inputs' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))
        replayStepError = (
          await callHttp(2, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:2`)
        ).result.isError

        // 3. Mismatched semantic argument (HTTP 'accepted' vs ACP 'changes_requested') -> rejected!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_300002',
              name: `mcp_${mcpName}_submit_review`,
              status: 'in_progress',
              args: { verdict: 'changes_requested', toolSummary: 'Submit review' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))
        mismatchedArgError = (
          await callHttp(3, 'submit_review', { verdict: 'accepted' }, `${trueTrajectoryId}:6`)
        ).result.isError
        // Retire call_300002 so later submit_review calls don't contend with it.
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'call_300002',
              name: `mcp_${mcpName}_submit_review`,
              status: 'failed',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))

        // 4. Genuine read_collaboration_source matching call_300001 (with toolSummary stripped) -> succeeds!
        const genuineSourceRes = await callHttp(
          4,
          'read_collaboration_source',
          sourceArgs,
          `${trueTrajectoryId}:5`,
        )
        genuineSourceError = genuineSourceRes.result.isError
        genuineSourceText = JSON.stringify(genuineSourceRes.result.content)
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'call_300001',
              name: `mcp_${mcpName}_read_collaboration_source`,
              status: 'completed',
            },
          },
        })

        // 5a. Stdout-pipe jitter: HTTP submit_review arrives 20ms BEFORE ACP tool_call(in_progress) -> wakes and succeeds, then failed tool_call_update does NOT promote!
        const jitteredHttpPromise = callHttp(
          5,
          'submit_review',
          { verdict: 'changes_requested' },
          `${trueTrajectoryId}:7`,
        )
        await new Promise((r) => setTimeout(r, 20))
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_300003',
              name: `mcp_${mcpName}_submit_review`,
              status: 'in_progress',
              args: { verdict: 'changes_requested', toolSummary: 'Jittered review' },
            },
          },
        })
        jitteredReviewError = (await jitteredHttpPromise).result.isError
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'call_300003',
              name: `mcp_${mcpName}_submit_review`,
              status: 'failed',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))

        // 5b. Second genuine submit_review succeeds AND promotes via tool_call_update(completed) without progressToken!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_300004',
              name: `mcp_${mcpName}_submit_review`,
              status: 'in_progress',
              args: { verdict: 'accepted', toolSummary: 'Accept Plan' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))
        promotedReviewError = (
          await callHttp(6, 'submit_review', { verdict: 'accepted' }, `${trueTrajectoryId}:8`)
        ).result.isError
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'call_300004',
              name: `mcp_${mcpName}_submit_review`,
              status: 'completed',
            },
          },
        })

        // 6. Subagent conversation_id and foreign trajectoryId MUST still be rejected even with an in-flight call!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_300005',
              name: `mcp_${mcpName}_read_collaboration_source`,
              status: 'in_progress',
              args: { ...sourceArgs, toolSummary: 'Valid slot' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))
        subagentError = (
          await callHttp(
            7,
            'read_collaboration_source',
            sourceArgs,
            `${trueTrajectoryId}:9`,
            randomUUID(),
          )
        ).result.isError
        foreignTrajError = (
          await callHttp(8, 'read_collaboration_source', sourceArgs, `${randomUUID()}:9`)
        ).result.isError

        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Plan review completed cleanly.' },
            },
          },
        })

        // 7. Scoped MCP schema read_file permission rules under plan_review (readOnlyStage = true):
        const serverMcpDir = join(appDataDir, 'mcp', mcpName)
        const otherMcpDir = join(appDataDir, 'mcp', 'other_server')
        await mkdir(serverMcpDir, { recursive: true })
        await mkdir(otherMcpDir, { recursive: true })
        await writeFile(
          join(serverMcpDir, 'submit_review.json'),
          '{"name":"submit_review"}',
          'utf8',
        )
        await writeFile(join(otherMcpDir, 'instructions.md'), '# other', 'utf8')
        const outsideSecret = join(cwd, 'outside-secret.txt')
        await writeFile(outsideSecret, 'SECRET', 'utf8')
        await symlink(outsideSecret, join(serverMcpDir, 'evil.json'))

        const sendPermProbe = (rpcId: string, name: string, targetPath: string) => {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: rpcId,
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: {
                toolCallId: `tc-${rpcId}`,
                name,
                args: { Path: targetPath },
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
        }
        sendPermProbe('perm-mcp-enoent', 'read_file', join(serverMcpDir, 'instructions.md'))
        sendPermProbe('perm-mcp-json', 'read_file', join(serverMcpDir, 'submit_review.json'))
        sendPermProbe('perm-mcp-symlink', 'read_file', join(serverMcpDir, 'evil.json'))
        sendPermProbe('perm-mcp-other', 'read_file', join(otherMcpDir, 'instructions.md'))
        sendPermProbe('perm-mcp-write', 'write_file', join(serverMcpDir, 'instructions.md'))
        await waitUntilCondition(() => harness.responses.length >= 5)
        await writeFile(join(serverMcpDir, 'instructions.md'), '# Authorized Pact MCP', 'utf8')
        sendPermProbe('perm-mcp-instructions', 'read_file', join(serverMcpDir, 'instructions.md'))
        await waitUntilCondition(() => harness.responses.length >= 6)

        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn' },
        })
      }
    })

    const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
    const recordedReviews: unknown[] = []
    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            nativeSessionId,
            model: 'gemini-pro-orchestrator',
            effort: null,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: randomUUID(), content: 'Review Plan v1.' },
              comments: [],
              sourceGrant: { runId, grant: grantId },
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                sourceReader: legacySourceReader(() => ({
                  source: 'inputs',
                  offset: 0,
                  nextOffset: null,
                  text: 'Frozen Plan v1.',
                })),
                recordReview: (obs) => recordedReviews.push(obs),
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      expect(unannouncedSourceError).toBe(true)
      expect(replayStepError).toBe(true)
      expect(mismatchedArgError).toBe(true)
      expect(genuineSourceError).toBeUndefined()
      expect(genuineSourceText).toContain('Frozen Plan v1.')
      expect(jitteredReviewError).toBeUndefined()
      expect(promotedReviewError).toBeUndefined()
      expect(subagentError).toBe(true)
      expect(foreignTrajError).toBe(true)
      expect(recordedReviews).toEqual([{ verdict: 'accepted' }])

      const optionForPerm = (permId: string): unknown => {
        const resp = harness.responses.find((r) => r.id === permId)
        const result = resp && typeof resp.result === 'object' ? resp.result : undefined
        const outcome =
          result && typeof Reflect.get(result, 'outcome') === 'object'
            ? (Reflect.get(result, 'outcome') as Record<string, unknown>)
            : undefined
        return outcome?.optionId
      }
      expect(optionForPerm('perm-mcp-enoent')).toBe('deny')
      expect(optionForPerm('perm-mcp-json')).toBe('deny')
      expect(optionForPerm('perm-mcp-instructions')).toBe('deny')
      expect(optionForPerm('perm-mcp-symlink')).toBe('deny')
      expect(optionForPerm('perm-mcp-other')).toBe('deny')
      expect(optionForPerm('perm-mcp-write')).toBe('deny')
    } finally {
      await adapter.dispose()
    }
  })

  it('Check #1: rejects unattributed MCP calls with zero reads/reviews and preserves owner attribution across swapped completion/failure orders', async () => {
    // Part A: Unattributed / ambiguous / conflicting / replayed calls produce ZERO extra source reads and ZERO promotions.
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const trueTrajectoryId = randomUUID()
      await createDbFixture(appDataDir, nativeSessionId, trueTrajectoryId, 1)

      const pactSessionId = randomUUID()
      const runId = randomUUID()
      const grantId = randomUUID()
      const sourceArgs = { runId, grant: grantId, source: 'inputs', offset: 0 }

      let mcpUrl = ''
      let mcpName = ''
      const harness = createAcpHarness()
      const results: Record<string, unknown> = {}

      harness.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new' || frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              sessionId: nativeSessionId,
              modes: { currentModeId: 'default', availableModes: ['default', 'plan'] },
              configOptions: [
                { id: 'model', currentValue: 'gemini-pro-orchestrator' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
          return
        }
        if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'gemini-pro-orchestrator' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
          return
        }
        if (frame.method === 'session/prompt') {
          const callHttp = async (
            id: number,
            name: string,
            args: Record<string, unknown>,
            progressToken: string,
          ) =>
            fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id,
                method: 'tools/call',
                params: {
                  name,
                  arguments: args,
                  _meta: {
                    'antigravity.google/root_conversation_id': nativeSessionId,
                    'antigravity.google/conversation_id': nativeSessionId,
                    progressToken,
                  },
                },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content?: Array<{ text?: string }> }
                }>,
            )

          const sendAcpCall = (
            toolCallId: string,
            rawName: string,
            status: 'in_progress' | 'completed' | 'failed',
            args?: Record<string, unknown>,
            progressToken?: string,
          ) => {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: nativeSessionId,
                update: {
                  sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update',
                  toolCallId,
                  name: rawName,
                  status,
                  ...(args !== undefined ? { args } : {}),
                  ...(progressToken !== undefined ? { progressToken } : {}),
                },
              },
            })
          }

          // 1. Terminal toolCallId cannot authorize subsequent HTTP read.
          sendAcpCall(
            'call-term',
            `mcp_${mcpName}_read_collaboration_source`,
            'in_progress',
            sourceArgs,
          )
          sendAcpCall(
            'call-term',
            `mcp_${mcpName}_read_collaboration_source`,
            'completed',
            sourceArgs,
          )
          await new Promise((r) => setTimeout(r, 10))
          results.terminalErr = (
            await callHttp(1, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:2`)
          ).result.isError

          // 2. Wrong tool on active ACP call (submit_review open, HTTP asks read_collaboration_source).
          sendAcpCall('call-wrong', `mcp_${mcpName}_submit_review`, 'in_progress', {
            verdict: 'accepted',
          })
          await new Promise((r) => setTimeout(r, 10))
          results.wrongToolErr = (
            await callHttp(2, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:3`)
          ).result.isError
          sendAcpCall('call-wrong', `mcp_${mcpName}_submit_review`, 'failed')

          // 3. Non-MCP tool's progressToken cannot authorize Pact MCP HTTP call.
          sendAcpCall(
            'call-non-mcp',
            'view_file',
            'in_progress',
            { Path: '/tmp/a' },
            `${trueTrajectoryId}:4`,
          )
          sendAcpCall('call-rev-guard', `mcp_${mcpName}_submit_review`, 'in_progress', {
            verdict: 'accepted',
          })
          await new Promise((r) => setTimeout(r, 10))
          results.nonMcpTokenErr = (
            await callHttp(3, 'submit_review', { verdict: 'accepted' }, `${trueTrajectoryId}:4`)
          ).result.isError
          sendAcpCall('call-rev-guard', `mcp_${mcpName}_submit_review`, 'failed')
          sendAcpCall('call-non-mcp', 'view_file', 'completed')

          // 4. toolCallId used as progressToken fails closed.
          sendAcpCall('call-id-as-pt', `mcp_${mcpName}_submit_review`, 'in_progress', {
            verdict: 'accepted',
          })
          await new Promise((r) => setTimeout(r, 10))
          results.idAsTokenErr = (
            await callHttp(4, 'submit_review', { verdict: 'accepted' }, 'call-id-as-pt')
          ).result.isError
          sendAcpCall('call-id-as-pt', `mcp_${mcpName}_submit_review`, 'failed')

          // 5. Missing ACP args (only in_progress without args -> waits 150ms & rejects).
          sendAcpCall('call-no-args', `mcp_${mcpName}_read_collaboration_source`, 'in_progress')
          results.missingArgsErr = (
            await callHttp(5, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:5`)
          ).result.isError
          sendAcpCall('call-no-args', `mcp_${mcpName}_read_collaboration_source`, 'failed')

          // 6. Conflicting ACP args before claim.
          sendAcpCall('call-conflict-pre', `mcp_${mcpName}_submit_review`, 'in_progress', {
            verdict: 'changes_requested',
          })
          await new Promise((r) => setTimeout(r, 10))
          results.conflictPreErr = (
            await callHttp(6, 'submit_review', { verdict: 'accepted' }, `${trueTrajectoryId}:6`)
          ).result.isError
          sendAcpCall('call-conflict-pre', `mcp_${mcpName}_submit_review`, 'failed')

          // 7. Conflicting ACP args updated AFTER claim -> revokes staged outcome before completed.
          sendAcpCall('call-conflict-post', `mcp_${mcpName}_submit_review`, 'in_progress', {
            verdict: 'changes_requested',
            toolSummary: 'Revise plan',
          })
          await new Promise((r) => setTimeout(r, 10))
          results.conflictPostHttpOk = (
            await callHttp(
              7,
              'submit_review',
              { verdict: 'changes_requested' },
              `${trueTrajectoryId}:7`,
            )
          ).result.isError
          sendAcpCall('call-conflict-post', `mcp_${mcpName}_submit_review`, 'in_progress', {
            verdict: 'accepted',
          })
          await new Promise((r) => setTimeout(r, 10))
          sendAcpCall('call-conflict-post', `mcp_${mcpName}_submit_review`, 'completed')
          await new Promise((r) => setTimeout(r, 10))

          // 8. Two concurrent active calls with identical args -> ambiguity rejected!
          sendAcpCall(
            'call-ambig-1',
            `mcp_${mcpName}_read_collaboration_source`,
            'in_progress',
            sourceArgs,
          )
          sendAcpCall(
            'call-ambig-2',
            `mcp_${mcpName}_read_collaboration_source`,
            'in_progress',
            sourceArgs,
          )
          await new Promise((r) => setTimeout(r, 10))
          results.ambiguousErr = (
            await callHttp(8, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:8`)
          ).result.isError
          sendAcpCall('call-ambig-1', `mcp_${mcpName}_read_collaboration_source`, 'failed')
          sendAcpCall('call-ambig-2', `mcp_${mcpName}_read_collaboration_source`, 'failed')

          // 9. Duplicate/replayed progressToken rejected while leaving first valid call intact.
          sendAcpCall(
            'call-src-ok',
            `mcp_${mcpName}_read_collaboration_source`,
            'in_progress',
            sourceArgs,
          )
          await new Promise((r) => setTimeout(r, 10))
          results.validSrcErr = (
            await callHttp(9, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:10`)
          ).result.isError
          results.replaySameTokenErr = (
            await callHttp(10, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:10`)
          ).result.isError
          sendAcpCall('call-src-ok', `mcp_${mcpName}_read_collaboration_source`, 'completed')
          await new Promise((r) => setTimeout(r, 10))
          results.replayAfterCompletedErr = (
            await callHttp(11, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:10`)
          ).result.isError

          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Attribution checks done.' },
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

      let sourceReaderCalls = 0
      const recordedReviews: unknown[] = []
      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              nativeSessionId,
              model: 'gemini-pro-orchestrator',
              effort: null,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Check MCP attribution.' },
                comments: [],
                sourceGrant: { runId, grant: grantId },
                collaboration: task,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  sourceReader: legacySourceReader(() => {
                    sourceReaderCalls += 1
                    return { source: 'inputs', offset: 0, nextOffset: null, text: 'Frozen Plan.' }
                  }),
                  recordReview: (obs) => recordedReviews.push(obs),
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(results.terminalErr).toBe(true)
        expect(results.wrongToolErr).toBe(true)
        expect(results.nonMcpTokenErr).toBe(true)
        expect(results.idAsTokenErr).toBe(true)
        expect(results.missingArgsErr).toBe(true)
        expect(results.conflictPreErr).toBe(true)
        expect(results.conflictPostHttpOk).toBeUndefined()
        expect(results.ambiguousErr).toBe(true)
        expect(results.validSrcErr).toBeUndefined()
        expect(results.replaySameTokenErr).toBe(true)
        expect(results.replayAfterCompletedErr).toBe(true)
        expect(sourceReaderCalls).toBe(1)
        expect(recordedReviews).toEqual([])
      } finally {
        await adapter.dispose()
      }
    }

    // Part B: Swapped completion/failure order across two distinct submit_review calls always attributes the surviving call cleanly.
    const orderings = [
      { first: 'completeA', second: 'failB', expected: [{ verdict: 'changes_requested' }] },
      { first: 'failB', second: 'completeA', expected: [{ verdict: 'changes_requested' }] },
      { first: 'failA', second: 'completeB', expected: [{ verdict: 'accepted' }] },
    ] as const

    for (const order of orderings) {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const trueTrajectoryId = randomUUID()
      await createDbFixture(appDataDir, nativeSessionId, trueTrajectoryId, 1)

      const pactSessionId = randomUUID()
      const runId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      let resAError: unknown
      let resBError: unknown
      const harness = createAcpHarness()

      harness.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new' || frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              sessionId: nativeSessionId,
              modes: { currentModeId: 'default', availableModes: ['default', 'plan'] },
              configOptions: [
                { id: 'model', currentValue: 'gemini-pro-orchestrator' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
          return
        }
        if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'gemini-pro-orchestrator' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
          return
        }
        if (frame.method === 'session/prompt') {
          const emitReview = (
            toolCallId: string,
            status: 'in_progress' | 'completed' | 'failed',
            args?: Record<string, unknown>,
          ) => {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: nativeSessionId,
                update: {
                  sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update',
                  toolCallId,
                  name: `mcp_${mcpName}_submit_review`,
                  status,
                  ...(args !== undefined ? { args } : {}),
                },
              },
            })
          }

          emitReview('call-rev-A', 'in_progress', { verdict: 'changes_requested' })
          emitReview('call-rev-B', 'in_progress', { verdict: 'accepted' })
          await new Promise((r) => setTimeout(r, 10))

          const resA = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 21,
              method: 'tools/call',
              params: {
                name: 'submit_review',
                arguments: { verdict: 'changes_requested' },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: `${trueTrajectoryId}:2`,
                },
              },
            }),
          }).then(
            (r) =>
              r.json() as Promise<{
                result: { isError?: boolean; content?: Array<{ text?: string }> }
              }>,
          )
          resAError = resA.result.isError

          const resB = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 22,
              method: 'tools/call',
              params: {
                name: 'submit_review',
                arguments: { verdict: 'accepted' },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: `${trueTrajectoryId}:3`,
                },
              },
            }),
          }).then(
            (r) =>
              r.json() as Promise<{
                result: { isError?: boolean; content?: Array<{ text?: string }> }
              }>,
          )
          resBError = resB.result.isError

          const dispatchStep = (step: string) => {
            if (step === 'completeA') emitReview('call-rev-A', 'completed')
            else if (step === 'failA') emitReview('call-rev-A', 'failed')
            else if (step === 'completeB') emitReview('call-rev-B', 'completed')
            else if (step === 'failB') emitReview('call-rev-B', 'failed')
          }
          dispatchStep(order.first)
          await new Promise((r) => setTimeout(r, 5))
          dispatchStep(order.second)

          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Final review.' },
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

      const recordedReviews: unknown[] = []
      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              nativeSessionId,
              model: 'gemini-pro-orchestrator',
              effort: null,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Review swap.' },
                comments: [],
                collaboration: task,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  recordReview: (obs) => recordedReviews.push(obs),
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(resAError).toBeUndefined()
        expect(resBError).toBeUndefined()
        expect(recordedReviews).toEqual(order.expected)
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('Check #2: rolls back failed publish_plan chunks (+ pipelined dependents) and failed single-shot title/peer/final-chunk quotas so retries succeed cleanly', async () => {
    // Part A: Open-mode publish_plan chunk failure + pipelined chunk invalidation + final chunk failure quota release.
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const trueTrajectoryId = randomUUID()
      await createDbFixture(appDataDir, nativeSessionId, trueTrajectoryId, 1)
      const pactSessionId = randomUUID()
      const runId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      const chunkErrors: unknown[] = []
      const harness = createAcpHarness()

      harness.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new' || frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
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
          const invokePlanChunk = async (
            callId: string,
            id: number,
            step: number,
            args: { text: string; offset: number; complete: boolean },
            outcome: 'completed' | 'failed',
          ) => {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: nativeSessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: callId,
                  name: `mcp_${mcpName}_publish_plan`,
                  status: 'in_progress',
                  args,
                },
              },
            })
            await new Promise((r) => setTimeout(r, 5))
            const res = await fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id,
                method: 'tools/call',
                params: {
                  name: 'publish_plan',
                  arguments: args,
                  _meta: {
                    'antigravity.google/root_conversation_id': nativeSessionId,
                    'antigravity.google/conversation_id': nativeSessionId,
                    progressToken: `${trueTrajectoryId}:${step}`,
                  },
                },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content?: Array<{ text?: string }> }
                }>,
            )
            chunkErrors.push(res.result.isError)
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: nativeSessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: callId,
                  name: `mcp_${mcpName}_publish_plan`,
                  status: outcome,
                },
              },
            })
            await new Promise((r) => setTimeout(r, 5))
          }

          // Chunk 1 succeeds at offset 0 ('# Plan\n').
          await invokePlanChunk(
            'plan-c1',
            1,
            2,
            { text: '# Plan\n', offset: 0, complete: false },
            'completed',
          )

          // Pipeline Chunk 2 (offset 7) AND dependent Chunk 3 (offset 20). Fail Chunk 2 BEFORE completing Chunk 3 -> BOTH invalidated!
          const chunk2Args = { text: 'BAD_CHUNK_2\n\n', offset: 7, complete: false }
          const chunk3Args = { text: 'BAD_DEPENDENT', offset: 20, complete: false }
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'plan-c2-bad',
                name: `mcp_${mcpName}_publish_plan`,
                status: 'in_progress',
                args: chunk2Args,
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'plan-c3-dep',
                name: `mcp_${mcpName}_publish_plan`,
                status: 'in_progress',
                args: chunk3Args,
              },
            },
          })
          await new Promise((r) => setTimeout(r, 5))
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'publish_plan',
                arguments: chunk2Args,
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: `${trueTrajectoryId}:3`,
                },
              },
            }),
          })
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: {
                name: 'publish_plan',
                arguments: chunk3Args,
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: `${trueTrajectoryId}:4`,
                },
              },
            }),
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'plan-c2-bad',
                name: `mcp_${mcpName}_publish_plan`,
                status: 'failed',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 5))
          // Dependent Chunk 3 completes afterward, but MUST already be invalidated!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'plan-c3-dep',
                name: `mcp_${mcpName}_publish_plan`,
                status: 'completed',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 5))

          // Retry intermediate at offset 7 ('Step 1\n').
          await invokePlanChunk(
            'plan-c2-good',
            4,
            5,
            { text: 'Step 1\n', offset: 7, complete: false },
            'completed',
          )

          // Final chunk at offset 14 fails -> releases finalization quota!
          await invokePlanChunk(
            'plan-c4-fail-final',
            5,
            6,
            { text: 'BAD_FINAL', offset: 14, complete: true },
            'failed',
          )

          // Retry final chunk at offset 14 ('Step 2') succeeds!
          await invokePlanChunk(
            'plan-c4-good-final',
            6,
            7,
            { text: 'Step 2', offset: 14, complete: true },
            'completed',
          )

          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })

      const publishedPlans: Array<{ nativeId: string; text: string }> = []
      const { task, authorization } = makeCollaborationTask(
        pactSessionId,
        runId,
        'implement',
        'build',
      )
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              nativeSessionId,
              permissionMode: 'auto',
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Publish chunked plan.' },
                comments: [],
                collaboration: task,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  recordPlan: (plan) => publishedPlans.push(plan),
                  recordOpenPlanFinalIntent: () => true,
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(chunkErrors.every((e) => e === undefined)).toBe(true)
        expect(publishedPlans).toHaveLength(1)
        expect(publishedPlans[0]!.text).toBe('# Plan\nStep 1\nStep 2')
      } finally {
        await adapter.dispose()
      }
    }

    // Part B: Failed publish_session_title and failed request_peer_assistance release single-shot quotas for retries.
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const trueTrajectoryId = randomUUID()
      await createDbFixture(appDataDir, nativeSessionId, trueTrajectoryId, 1)
      const pactSessionId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      const singleShotErrors: unknown[] = []
      const harness = createAcpHarness()

      harness.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new' || frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
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
          const runSingleShot = async (
            callId: string,
            id: number,
            step: number,
            toolName: 'publish_session_title' | 'request_peer_assistance',
            args: Record<string, unknown>,
            outcome: 'completed' | 'failed',
          ) => {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: nativeSessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: callId,
                  name: `mcp_${mcpName}_${toolName}`,
                  status: 'in_progress',
                  args,
                },
              },
            })
            await new Promise((r) => setTimeout(r, 5))
            const res = await fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id,
                method: 'tools/call',
                params: {
                  name: toolName,
                  arguments: args,
                  _meta: {
                    'antigravity.google/root_conversation_id': nativeSessionId,
                    'antigravity.google/conversation_id': nativeSessionId,
                    progressToken: `${trueTrajectoryId}:${step}`,
                  },
                },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content?: Array<{ text?: string }> }
                }>,
            )
            singleShotErrors.push(res.result.isError)
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: nativeSessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: callId,
                  name: `mcp_${mcpName}_${toolName}`,
                  status: outcome,
                },
              },
            })
            await new Promise((r) => setTimeout(r, 5))
          }

          await runSingleShot(
            'title-fail',
            1,
            1,
            'publish_session_title',
            { title: 'Failed title' },
            'failed',
          )
          await runSingleShot(
            'title-retry',
            2,
            2,
            'publish_session_title',
            { title: 'Confirmed retry title' },
            'completed',
          )

          await runSingleShot(
            'peer-fail',
            3,
            3,
            'request_peer_assistance',
            { target: 'codex', kind: 'review' },
            'failed',
          )
          await runSingleShot(
            'peer-retry',
            4,
            4,
            'request_peer_assistance',
            { target: 'codex', kind: 'challenge', reason: 'Retry challenge' },
            'completed',
          )

          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const events = await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              nativeSessionId,
              permissionMode: 'auto',
              peerAssistanceAllowed: true,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                requestSessionTitle: true,
                message: { id: randomUUID(), content: 'Test single-shot retry quotas.' },
                comments: [],
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(singleShotErrors.every((e) => e === undefined)).toBe(true)
        const titleEvents = events.filter((e) => e.type === 'session.title.updated')
        expect(titleEvents).toHaveLength(1)
        expect((titleEvents[0] as { title: string }).title).toBe('Confirmed retry title')
        const peerEvents = events.filter((e) => e.type === 'peer.assistance.requested')
        expect(peerEvents).toHaveLength(1)
        expect((peerEvents[0] as { kind: string }).kind).toBe('challenge')
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('Check #3 (C4): deterministically rejects all read_file requests under readOnlyStage (zero schema auto-allow), keeps MCP instructions self-sufficient, and preserves Ask/Full/late permission rules', async () => {
    // Part A: Under readOnlyStage, EVERY read_file request (including valid <appDataDir>/mcp/<server>/<tool>.json & instructions.md) is denied; MCP instructions self-sufficiently declare tools without inducing read_file.
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const pactSessionId = randomUUID()
      const runId = randomUUID()
      let mcpName = ''
      let mcpUrl = ''
      let initInstructions = ''
      let promptSystemAppend = ''
      let holdAfterReplyResolve: (() => void) | undefined
      const holdAfterReplyGate = new Promise<void>((r) => {
        holdAfterReplyResolve = r
      })
      const harness = createAcpHarness()

      harness.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new' || frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          if (mcpUrl) {
            const initRes = (await fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
            }).then((r) => r.json())) as { result?: { instructions?: string } }
            initInstructions = initRes.result?.instructions ?? ''
          }
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
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
          const meta = Reflect.get(frame.params as object, '_meta') as
            | { antigravity?: { systemPrompt?: { append?: string } } }
            | undefined
          promptSystemAppend = meta?.antigravity?.systemPrompt?.append ?? ''

          const serverMcpDir = join(appDataDir, 'mcp', mcpName)
          const outsideDir = join(cwd, 'outside-mcp-alias')
          await mkdir(serverMcpDir, { recursive: true })
          await mkdir(outsideDir, { recursive: true })
          const validJsonPath = join(serverMcpDir, 'submit_review.json')
          const instructionsPath = join(serverMcpDir, 'instructions.md')
          await writeFile(validJsonPath, '{"name":"submit_review"}', 'utf8')
          await writeFile(instructionsPath, '# Instructions', 'utf8')
          await writeFile(
            join(serverMcpDir, 'unregistered.json'),
            '{"name":"unregistered"}',
            'utf8',
          )
          await writeFile(
            join(serverMcpDir, 'read_collaboration_source.json'),
            '{"name":"wrong_tool"}',
            'utf8',
          )
          await writeFile(
            join(outsideDir, 'submit_review.json'),
            '{"name":"submit_review"}',
            'utf8',
          )
          const aliasDir = join(appDataDir, 'mcp', 'alias_server')
          await symlink(serverMcpDir, aliasDir)

          const sendPerm = (rpcId: string, tcId: string, targetPath: string) => {
            harness.sendToClient({
              jsonrpc: '2.0',
              id: rpcId,
              method: 'session/request_permission',
              params: {
                sessionId: nativeSessionId,
                toolCall: { toolCallId: tcId, name: 'read_file', args: { Path: targetPath } },
                options: [
                  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
                ],
              },
            })
          }

          sendPerm('p-instructions', 'tc-instructions', instructionsPath)
          sendPerm('p-dotdot', 'tc-dotdot', `${serverMcpDir}/../${mcpName}/submit_review.json`)
          sendPerm('p-alias', 'tc-alias', join(aliasDir, 'submit_review.json'))
          sendPerm('p-unreg', 'tc-unreg', join(serverMcpDir, 'unregistered.json'))
          sendPerm(
            'p-mismatch-name',
            'tc-mismatch',
            join(serverMcpDir, 'read_collaboration_source.json'),
          )
          sendPerm('p-ok', 'tc-ok', validJsonPath)
          await waitUntilCondition(() => harness.responses.length >= 6)

          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })

      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              nativeSessionId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Inspect schema perms.' },
                comments: [],
                collaboration: task,
                collaborationAuthorization: authorization,
              },
              host: {
                lifecycle: {
                  waitForRootOutput: async () => {
                    // Late schema read_file AFTER root prompt reply MUST also be denied!
                    harness.sendToClient({
                      jsonrpc: '2.0',
                      id: 'p-late',
                      method: 'session/request_permission',
                      params: {
                        sessionId: nativeSessionId,
                        toolCall: {
                          toolCallId: 'tc-late',
                          name: 'read_file',
                          args: { Path: join(appDataDir, 'mcp', mcpName, 'submit_review.json') },
                        },
                        options: [
                          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
                        ],
                      },
                    })
                    await waitUntilCondition(() => harness.responses.some((r) => r.id === 'p-late'))
                    holdAfterReplyResolve?.()
                    await holdAfterReplyGate
                  },
                },
              },
            }),
            new AbortController().signal,
          ),
        )

        expect(initInstructions).toContain(`mcp_${mcpName}_submit_review`)
        expect(initInstructions).toContain('never call read_file on <appDataDir>/mcp')
        expect(promptSystemAppend).toContain(`mcp_${mcpName}_submit_review`)
        expect(promptSystemAppend).not.toContain('Inspect their schemas via read_file')

        const optionFor = (id: string) =>
          (
            (
              harness.responses.find((r) => r.id === id)?.result as {
                outcome?: { optionId?: unknown }
              }
            )?.outcome ?? {}
          ).optionId
        expect(optionFor('p-instructions')).toBe('deny')
        expect(optionFor('p-dotdot')).toBe('deny')
        expect(optionFor('p-alias')).toBe('deny')
        expect(optionFor('p-unreg')).toBe('deny')
        expect(optionFor('p-mismatch-name')).toBe('deny')
        expect(optionFor('p-ok')).toBe('deny')
        expect(optionFor('p-late')).toBe('deny')

        // Normal ask mode receiving schema read_file routes to requestPermission (not auto-allowed).
        let askPermCalled = 0
        const askHarness = createAcpHarness()
        let askMcpName = ''
        askHarness.onClientFrame(async (frame) => {
          if (frame.method === 'initialize') {
            askHarness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { protocolVersion: 1 },
            })
            return
          }
          if (frame.method === 'session/new') {
            const servers = (frame.params as { mcpServers?: Array<{ name: string }> }).mcpServers
            askMcpName = servers?.[0]?.name ?? ''
            askHarness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: defaultSessionNewResult('sid-ask-mode'),
            })
            return
          }
          if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
            askHarness.sendToClient({
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
            const dir = join(appDataDir, 'mcp', askMcpName)
            await mkdir(dir, { recursive: true })
            await writeFile(join(dir, 'instructions.md'), '# ask', 'utf8')
            askHarness.sendToClient({
              jsonrpc: '2.0',
              id: 'p-ask-schema',
              method: 'session/request_permission',
              params: {
                sessionId: 'sid-ask-mode',
                toolCall: {
                  toolCallId: 'tc-ask-schema',
                  name: 'read_file',
                  args: { Path: join(dir, 'instructions.md') },
                },
                options: [
                  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
                ],
              },
            })
            await waitUntilCondition(() =>
              askHarness.responses.some((r) => r.id === 'p-ask-schema'),
            )
            askHarness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn' },
            })
          }
        })
        const askAdapter = new AgyAgentAdapter({
          appDataDir,
          processFactory: () => askHarness.child,
        })
        try {
          await collectEvents(
            askAdapter.run(
              makeBaseRunInput(cwd, {
                permissionMode: 'ask',
                host: {
                  interactions: {
                    requestPermission: async (_req) => {
                      askPermCalled += 1
                      return 'deny'
                    },
                  },
                },
              }),
              new AbortController().signal,
            ),
          )
          expect(askPermCalled).toBe(1)
        } finally {
          await askAdapter.dispose()
        }
      } finally {
        await adapter.dispose()
      }
    }

    // Part B: Full access residual read_file permission request is also deterministically denied without surfacing user card.
    {
      const { cwd, appDataDir } = await createEnv()
      const fullHarness = createAcpHarness()
      let fullPermCardCalled = 0
      fullHarness.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          fullHarness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new') {
          fullHarness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult('sid-full-read'),
          })
          return
        }
        if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
          fullHarness.sendToClient({
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
          fullHarness.sendToClient({
            jsonrpc: '2.0',
            id: 'p-full-read',
            method: 'session/request_permission',
            params: {
              sessionId: 'sid-full-read',
              toolCall: {
                toolCallId: 'tc-full-read',
                name: 'read_file',
                args: { Path: join(appDataDir, 'mcp', 'server', 'instructions.md') },
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
          await waitUntilCondition(() => fullHarness.responses.some((r) => r.id === 'p-full-read'))
          fullHarness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })
      const fullAdapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => fullHarness.child,
      })
      try {
        await collectEvents(
          fullAdapter.run(
            makeBaseRunInput(cwd, {
              permissionMode: 'full',
              host: {
                interactions: {
                  requestPermission: async () => {
                    fullPermCardCalled += 1
                    return 'allow'
                  },
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        const fullOutcome = (
          fullHarness.responses.find((r) => r.id === 'p-full-read')?.result as {
            outcome?: { optionId?: unknown }
          }
        )?.outcome?.optionId
        expect(fullOutcome).toBe('deny')
        expect(fullPermCardCalled).toBe(0)
      } finally {
        await fullAdapter.dispose()
      }
    }
  })

  it('Check #4 (adapter): retries pre-prompt transient_churn and freezes turn-start stepCount so post-prompt identity load never overwrites minStepIdx', async () => {
    // Subcase A: pre-prompt returns transient_churn twice, then ok (stepCount: 4) -> freezes boundary at 4.
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const trueTrajectoryId = randomUUID()
      const pactSessionId = randomUUID()
      const runId = randomUUID()
      let attempts = 0
      let step3Err: unknown
      let step4Err: unknown
      let mcpUrl = ''
      let mcpName = ''
      const harness = createAcpHarness()

      harness.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/new' || frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
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
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-bound-retry',
                name: `mcp_${mcpName}_submit_review`,
                status: 'in_progress',
                args: { verdict: 'accepted' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          step3Err = (
            await fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name: 'submit_review',
                  arguments: { verdict: 'accepted' },
                  _meta: {
                    'antigravity.google/root_conversation_id': nativeSessionId,
                    'antigravity.google/conversation_id': nativeSessionId,
                    progressToken: `${trueTrajectoryId}:3`,
                  },
                },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content?: Array<{ text?: string }> }
                }>,
            )
          ).result.isError
          step4Err = (
            await fetch(mcpUrl, {
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
                    'antigravity.google/root_conversation_id': nativeSessionId,
                    'antigravity.google/conversation_id': nativeSessionId,
                    progressToken: `${trueTrajectoryId}:4`,
                  },
                },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content?: Array<{ text?: string }> }
                }>,
            )
          ).result.isError
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-bound-retry',
                name: `mcp_${mcpName}_submit_review`,
                status: 'completed',
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

      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
      const recordedReviews: unknown[] = []
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => harness.child,
        storageClient: {
          async readTrajectoryIdentity() {
            attempts += 1
            if (attempts <= 2) return { status: 'transient_churn' }
            return { status: 'ok', trajectoryId: trueTrajectoryId, stepCount: 4 }
          },
        },
      })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              nativeSessionId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Retry WAL churn.' },
                comments: [],
                collaboration: task,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  recordReview: (obs) => recordedReviews.push(obs),
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(attempts).toBe(3)
        expect(step3Err).toBe(true)
        expect(step4Err).toBeUndefined()
        expect(recordedReviews).toEqual([{ verdict: 'accepted' }])
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase B1 (S1-#11): Fresh session receiving pre-prompt `missing` fails closed BEFORE session/prompt!
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const trueTrajectoryId = randomUUID()
      const pactSessionId = randomUUID()
      const runId = randomUUID()
      let identityCalls = 0
      let promptSent = false
      const unsentProofs: unknown[] = []
      const harness = createAcpHarness()

      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/close') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/prompt') {
          promptSent = true
        }
      })

      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
      const recordedReviews: unknown[] = []
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => harness.child,
        storageClient: {
          async readTrajectoryIdentity() {
            identityCalls += 1
            if (identityCalls === 1) return { status: 'missing' }
            return { status: 'ok', trajectoryId: trueTrajectoryId, stepCount: 10 }
          },
        },
      })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, {
                sessionId: pactSessionId,
                runId,
                promptEnvelope: {
                  version: 'pact-agent-prompt-v1',
                  sessionId: pactSessionId,
                  message: { id: randomUUID(), content: 'Fresh missing fails closed.' },
                  comments: [],
                  collaboration: task,
                  collaborationAuthorization: authorization,
                },
                host: {
                  workflow: {
                    recordReview: (obs) => recordedReviews.push(obs),
                  },
                  recovery: {
                    inputSha256: 'd'.repeat(64),
                    recordEffectiveSettings: () => undefined,
                    recordConfirmedUnsent: (proof) => unsentProofs.push(proof),
                  },
                },
              }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(/new session is missing before prompt dispatch/iu)
        expect(identityCalls).toBe(1)
        expect(promptSent).toBe(false)
        expect(unsentProofs).toEqual([{ kind: 'host_before_root_start' }])
        expect(recordedReviews).toEqual([])
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase B2 (S1-#11): Fresh session receiving `no_storage_root` disables lazy DB pin and pins via ACP only!
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const lateDiskTrajectoryId = randomUUID()
      const acpTrajectoryId = randomUUID()
      const pactSessionId = randomUUID()
      const runId = randomUUID()
      let identityCalls = 0
      let lateDbErr: unknown
      let acpPinnedStep2Err: unknown
      let mcpUrl = ''
      let mcpName = ''
      const harness = createAcpHarness()

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
            result: defaultSessionNewResult(nativeSessionId),
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
          // 1. Without ACP trajectory pin, HTTP MUST NOT lazily read or adopt lateDiskTrajectoryId!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-no-pin',
                name: `mcp_${mcpName}_submit_review`,
                status: 'in_progress',
                args: { verdict: 'changes_requested' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          lateDbErr = (
            await fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name: 'submit_review',
                  arguments: { verdict: 'changes_requested' },
                  _meta: {
                    'antigravity.google/root_conversation_id': nativeSessionId,
                    'antigravity.google/conversation_id': nativeSessionId,
                    progressToken: `${lateDiskTrajectoryId}:1`,
                  },
                },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content?: Array<{ text?: string }> }
                }>,
            )
          ).result.isError
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-no-pin',
                name: `mcp_${mcpName}_submit_review`,
                status: 'failed',
              },
            },
          })

          // 2. Once ACP pins the root trajectory, step 2 succeeds against zero-turn boundary 0!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-acp-pin',
                name: `mcp_${mcpName}_submit_review`,
                status: 'in_progress',
                trajectoryId: acpTrajectoryId,
                args: { verdict: 'accepted' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          acpPinnedStep2Err = (
            await fetch(mcpUrl, {
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
                    'antigravity.google/root_conversation_id': nativeSessionId,
                    'antigravity.google/conversation_id': nativeSessionId,
                    progressToken: `${acpTrajectoryId}:2`,
                  },
                },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content?: Array<{ text?: string }> }
                }>,
            )
          ).result.isError
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-acp-pin',
                name: `mcp_${mcpName}_submit_review`,
                status: 'completed',
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

      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
      const recordedReviews: unknown[] = []
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => harness.child,
        storageClient: {
          async readTrajectoryIdentity() {
            identityCalls += 1
            if (identityCalls === 1) return { status: 'no_storage_root' }
            return { status: 'ok', trajectoryId: lateDiskTrajectoryId, stepCount: 10 }
          },
        },
      })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Fresh no_storage_root ACP bootstrap.' },
                comments: [],
                collaboration: task,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  recordReview: (obs) => recordedReviews.push(obs),
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(identityCalls).toBe(1)
        expect(lateDbErr).toBe(true)
        expect(acpPinnedStep2Err).toBeUndefined()
        expect(recordedReviews).toEqual([{ verdict: 'accepted' }])
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('Check #5: serves >64 MiB DB online MCP tools without blocking concurrent Run cancellation and keeps repeated large-arg correlation bounded', async () => {
    const { cwd, appDataDir } = await createEnv()
    const convDir = join(appDataDir, 'conversations')
    await mkdir(convDir, { recursive: true })

    const sid1 = randomUUID()
    const traj1 = randomUUID()
    const dbPath1 = join(convDir, `${sid1}.db`)
    const largeBlob = Buffer.alloc(1_600_000, 0x55)
    const writer = new Database(dbPath1)
    let reader: Database.Database | undefined
    try {
      writer.pragma('page_size = 32768')
      writer.pragma('journal_mode = WAL')
      writer.pragma('wal_autocheckpoint = 0')
      writer.exec(`
        CREATE TABLE "trajectory_meta" ("trajectory_id" TEXT PRIMARY KEY, "cascade_id" TEXT NOT NULL);
        CREATE TABLE "steps" ("idx" INTEGER PRIMARY KEY, "step_payload" BLOB);
      `)
      writer
        .prepare('INSERT INTO "trajectory_meta" ("trajectory_id", "cascade_id") VALUES (?, ?)')
        .run(traj1, sid1)
      const ins = writer.prepare('INSERT INTO "steps" ("idx", "step_payload") VALUES (?, ?)')
      const batch = writer.transaction(() => {
        for (let i = 0; i < 44; i += 1) ins.run(i, largeBlob)
      })
      batch()
      writer.pragma('wal_checkpoint(TRUNCATE)')

      reader = new Database(dbPath1, { readonly: true })
      reader.prepare('SELECT COUNT(*) FROM "steps"').get()
      ins.run(44, largeBlob)
      ins.run(45, largeBlob)
    } finally {
      writer.close()
      reader?.close()
    }
    await rm(`${dbPath1}-shm`, { force: true })
    expect((await stat(dbPath1)).size).toBeGreaterThan(64 * 1024 * 1024)

    const grantId = randomUUID()
    const pactSession1 = randomUUID()
    const runId1 = randomUUID()
    const largeChunkText = 'P'.repeat(6 * 1024)
    const hugeToolSummary = 'S'.repeat(200 * 1024)
    const harness1 = createAcpHarness()
    let mcpUrl1 = ''
    let mcpName1 = ''
    const check5ChunkErrors: unknown[] = []
    let check5SrcError: unknown
    let promptGateResolve: (() => void) | undefined
    const promptGate = new Promise<void>((r) => {
      promptGateResolve = r
    })

    harness1.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness1.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new' || frame.method === 'session/load') {
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpUrl1 = servers?.[0]?.url ?? ''
        mcpName1 = servers?.[0]?.name ?? ''
        harness1.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(sid1),
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        harness1.sendToClient({
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
        promptGateResolve?.()
        // Run 45 sequential publish_plan chunks of ~6 KiB each with 200 KiB toolSummary -> cumulative ACP args > 9 MiB!
        for (let i = 0; i < 45; i += 1) {
          const offset = i * largeChunkText.length
          const isFinal = i === 44
          const callId = `big-chunk-${i}`
          const httpArgs = { text: largeChunkText, offset, complete: isFinal }
          harness1.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid1,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: callId,
                name: `mcp_${mcpName1}_publish_plan`,
                status: 'in_progress',
                args: { ...httpArgs, toolSummary: hugeToolSummary },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 2))
          const res = await fetch(mcpUrl1, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: i + 1,
              method: 'tools/call',
              params: {
                name: 'publish_plan',
                arguments: httpArgs,
                _meta: {
                  'antigravity.google/root_conversation_id': sid1,
                  'antigravity.google/conversation_id': sid1,
                  progressToken: `${traj1}:${46 + i}`,
                },
              },
            }),
          }).then(
            (r) =>
              r.json() as Promise<{
                result: { isError?: boolean; content?: Array<{ text?: string }> }
              }>,
          )
          check5ChunkErrors.push(res.result.isError)
          harness1.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid1,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: callId,
                name: `mcp_${mcpName1}_publish_plan`,
                status: 'completed',
              },
            },
          })
        }
        // Also verify online source read over >64 MiB trajectory boundary!
        const srcArgs = { runId: runId1, grant: grantId, source: 'inputs', offset: 0 }
        harness1.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid1,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'big-src-read',
              name: `mcp_${mcpName1}_read_collaboration_source`,
              status: 'in_progress',
              args: { ...srcArgs, toolSummary: hugeToolSummary },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 5))
        const srcRes = await fetch(mcpUrl1, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 99,
            method: 'tools/call',
            params: {
              name: 'read_collaboration_source',
              arguments: srcArgs,
              _meta: {
                'antigravity.google/root_conversation_id': sid1,
                'antigravity.google/conversation_id': sid1,
                progressToken: `${traj1}:91`,
              },
            },
          }),
        }).then(
          (r) =>
            r.json() as Promise<{
              result: { isError?: boolean; content?: Array<{ text?: string }> }
            }>,
        )
        check5SrcError = srcRes.result.isError ? srcRes.result : undefined
        harness1.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid1,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'big-src-read',
              name: `mcp_${mcpName1}_read_collaboration_source`,
              status: 'completed',
            },
          },
        })
        harness1.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn' },
        })
      }
    })

    // Run 2 on a second adapter/connection tests concurrent cancellation responsiveness while Run 1 serves >64 MiB DB!
    const harness2 = createAcpHarness()
    const run2Abort = new AbortController()
    harness2.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness2.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        harness2.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(randomUUID()),
        })
        return
      }
      if (frame.method === 'session/set_mode' || frame.method === 'session/set_config_option') {
        harness2.sendToClient({
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
        harness2.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: (frame.params as { sessionId: string }).sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'partial' },
            },
          },
        })
        setTimeout(() => run2Abort.abort(), 15)
        return
      }
      if (frame.method === 'session/cancel') {
        const promptFrame = harness2.requests.find((r) => r.method === 'session/prompt')
        if (promptFrame) {
          harness2.sendToClient({
            jsonrpc: '2.0',
            id: promptFrame.id,
            result: { stopReason: 'cancelled' },
          })
        }
      }
    })

    const barrierDir = await mkdtemp(join(tmpdir(), 'pact-agy-worker-barrier-'))
    tempDirs.push(barrierDir)
    const appDataDir2 = join(barrierDir, 'app-data-run2')
    await mkdir(appDataDir2, { recursive: true })

    let childEnteredBarrier = false
    let childResumedBarrier = false
    let releaseBarrier!: () => void
    const barrierGate = new Promise<void>((r) => {
      releaseBarrier = r
    })
    let workerSpawnedCount = 0
    let childPid: number | undefined
    let workerExited = false
    let activeWorkerReservations = 0
    // oxlint-disable-next-line typescript/unbound-method -- Invoked with actual NativeWorkingMemory receiver below.
    const origReserve = NativeWorkingMemory.prototype.reserve
    const reserveSpy = vi
      .spyOn(NativeWorkingMemory.prototype, 'reserve')
      .mockImplementation(function (this: NativeWorkingMemory, bytes: number) {
        const res = origReserve.call(this, bytes)
        if (bytes === NATIVE_OWNER_WORKING_BYTES) {
          activeWorkerReservations += 1
          let released = false
          const origRelease = res.release.bind(res)
          res.release = () => {
            if (!released) {
              released = true
              activeWorkerReservations = Math.max(0, activeWorkerReservations - 1)
            }
            origRelease()
          }
        }
        return res
      })

    const baseTransport = new NodeChildProcessAgyStorageTransport()
    const gatedTransport: AgyStorageTransport = {
      generation: baseTransport.generation,
      async open(req) {
        workerSpawnedCount += 1
        const session = await baseTransport.open(req)
        const isFirst = workerSpawnedCount === 1
        if (isFirst) {
          childPid = session.pid
          void session.exited.finally(() => {
            workerExited = true
          })
        }
        if (!isFirst) {
          return session
        }
        return {
          ...session,
          port: {
            onMessage: (listener) => session.port.onMessage(listener),
            close: () => session.port.close(),
            postMessage: (msg) => {
              childEnteredBarrier = true
              void barrierGate.then(() => {
                childResumedBarrier = true
                session.port.postMessage(msg)
                return undefined
              })
            },
          },
        }
      },
      dispose: () => baseTransport.dispose(),
    }
    configureDefaultAgyStorageTransport(gatedTransport)

    const publishedLargePlans: string[] = []
    const { task, authorization } = makeCollaborationTask(
      pactSession1,
      runId1,
      'implement',
      'build',
    )
    const baselineChargedBytes = nativeWorkingMemoryDiagnostics().chargedBytes ?? 0
    const adapter1 = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness1.child,
    })
    const adapter2 = new AgyAgentAdapter({
      appDataDir: appDataDir2,
      processFactory: () => harness2.child,
    })
    try {
      const run1Promise = collectEvents(
        adapter1.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSession1,
            runId: runId1,
            nativeSessionId: sid1,
            permissionMode: 'auto',
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSession1,
              message: { id: randomUUID(), content: 'Serve large DB + 45 chunks.' },
              comments: [],
              sourceGrant: { runId: runId1, grant: grantId },
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                sourceReader: legacySourceReader(() => ({
                  source: 'inputs',
                  offset: 0,
                  nextOffset: null,
                  text: 'Large DB source.',
                })),
                recordPlan: (p) => publishedLargePlans.push(p.text),
                recordOpenPlanFinalIntent: () => true,
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      // Wait until the real isolated OS child process is live and parked inside the >64 MiB SQLite job!
      await waitUntilCondition(() => childEnteredBarrier)
      expect(childPid).toBeTypeOf('number')
      expect(childPid).not.toBe(process.pid)
      expect(childResumedBarrier).toBe(false)
      expect(workerExited).toBe(false)
      expect(activeWorkerReservations).toBe(1)
      expect(
        (nativeWorkingMemoryDiagnostics().chargedBytes ?? 0) - baselineChargedBytes,
      ).toBeGreaterThanOrEqual(NATIVE_OWNER_WORKING_BYTES)

      const cancelStartedAt = performance.now()
      const run2Events = await collectEvents(
        adapter2.run(
          makeBaseRunInput(cwd, {
            model: 'gemini-4-carbon',
            effort: 'high',
          }),
          run2Abort.signal,
        ),
      )
      const cancelElapsedMs = performance.now() - cancelStartedAt
      // Run 2 cancellation MUST complete while the real child process is STILL live
      // and its 128 MiB NativeForkFiles reservation is still held!
      expect(childResumedBarrier).toBe(false)
      expect(workerExited).toBe(false)
      expect(activeWorkerReservations).toBe(1)
      expect(
        (nativeWorkingMemoryDiagnostics().chargedBytes ?? 0) - baselineChargedBytes,
      ).toBeGreaterThanOrEqual(NATIVE_OWNER_WORKING_BYTES)
      expect(cancelElapsedMs).toBeLessThan(1_000)
      expect(run2Events.at(-1)).toMatchObject({ type: 'turn.completed', outcome: 'interrupted' })

      // Release the barrier so the real isolated child finishes its >64 MiB SQLite read and exits.
      releaseBarrier()
      await promptGate
      expect(workerSpawnedCount).toBeGreaterThanOrEqual(1)

      const run1Events = await run1Promise
      expect(childResumedBarrier).toBe(true)
      await waitUntilCondition(() => workerExited && activeWorkerReservations === 0)
      expect(check5ChunkErrors.every((e) => e === undefined)).toBe(true)
      expect(check5SrcError).toBeUndefined()
      expect(run1Events.at(-1)).toMatchObject({ type: 'turn.completed', outcome: 'completed' })
      expect(publishedLargePlans).toEqual([largeChunkText.repeat(45)])
    } finally {
      releaseBarrier()
      configureDefaultAgyStorageTransport(undefined)
      baseTransport.dispose()
      reserveSpy.mockRestore()
      await Promise.all([adapter1.dispose(), adapter2.dispose()])
    }
    expect(nativeWorkingMemoryDiagnostics().chargedBytes ?? 0).toBe(baselineChargedBytes)
  })

  it('Check #6: rejects third-model conflict during session/set_model and prevents stale model effort reuse or fabricated recovery receipts', async () => {
    const newResult = {
      sessionId: 'sid-set-model-check',
      modes: { currentModeId: 'default', availableModes: ['default'] },
      models: {
        currentModelId: 'model-a',
        availableModels: ['model-a', 'model-b', 'model-c'],
      },
      configOptions: [
        { id: 'model', currentValue: 'model-a', options: [{ value: 'model-a' }] },
        {
          id: 'thought_level',
          currentValue: 'high',
          options: [{ value: 'low' }, { value: 'high' }],
        },
      ],
    }

    // 1. Third-model conflict in set_model reply configOptions fails BEFORE session/prompt.
    {
      const { cwd, appDataDir } = await createEnv()
      let promptSeen = false
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: newResult })
        } else if (frame.method === 'session/set_mode') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_model') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'model-c' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
        } else if (frame.method === 'session/close') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/prompt') {
          promptSeen = true
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, { model: 'model-b', effort: null }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(/silently substituted model="model-c"/iu)
        expect(promptSeen).toBe(false)
      } finally {
        await adapter.dispose()
      }
    }

    // 2. Third-model conflict in async config_option_update notification fails BEFORE session/prompt.
    {
      const { cwd, appDataDir } = await createEnv()
      let promptSeen = false
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: newResult })
        } else if (frame.method === 'session/set_mode') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_model') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          setTimeout(() => {
            h.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sid-set-model-check',
                update: {
                  sessionUpdate: 'config_option_update',
                  configOptions: [{ id: 'model', currentValue: 'model-c' }],
                },
              },
            })
          }, 10)
        } else if (frame.method === 'session/close') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/prompt') {
          promptSeen = true
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, { model: 'model-b', effort: null }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(/silently substituted model="model-c"/iu)
        expect(promptSeen).toBe(false)
      } finally {
        await adapter.dispose()
      }
    }

    // 3. set_model `{}` + stale Model A (`high`) + model-less (`high`):
    //    - effort: 'high' MUST STILL invoke session/set_config_option('thought_level', 'high')
    //    - effort: null MUST NOT emit a fabricated recovery receipt for { model: 'model-b', effort: 'high' }.
    for (const testCase of [
      {
        effort: 'high' as const,
        expectedSetThoughtCount: 1,
        expectedSettings: [
          expect.objectContaining({
            model: 'model-b',
            effort: { known: true, value: 'high' },
          }),
        ],
      },
      { effort: null, expectedSetThoughtCount: 0, expectedSettings: [] },
    ]) {
      const effortMode = testCase.effort
      const { cwd, appDataDir } = await createEnv()
      let setThoughtCount = 0
      const recordedSettings: unknown[] = []
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: newResult })
        } else if (frame.method === 'session/set_mode') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_model') {
          h.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-set-model-check',
              update: {
                sessionUpdate: 'config_option_update',
                configOptions: [
                  { id: 'model', currentValue: 'model-a' },
                  { id: 'thought_level', currentValue: 'high' },
                ],
              },
            },
          })
          h.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sid-set-model-check',
              update: {
                sessionUpdate: 'config_option_update',
                configOptions: [{ id: 'thought_level', currentValue: 'high' }],
              },
            },
          })
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_config_option') {
          setThoughtCount += 1
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'model-b' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
        } else if (frame.method === 'session/prompt') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              model: 'model-b',
              effort: effortMode,
              host: {
                recovery: {
                  inputSha256: 'c'.repeat(64),
                  recordEffectiveSettings: (s) => recordedSettings.push(s),
                  recordConfirmedUnsent: () => undefined,
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(setThoughtCount).toBe(testCase.expectedSetThoughtCount)
        expect(recordedSettings).toEqual(testCase.expectedSettings)
      } finally {
        await adapter.dispose()
      }
    }

    // 4. C6 (F11): Missing `model` configOption in session/new during model switch MUST still treat model-less
    //    `config_option_update([{ id: 'thought_level', currentValue: 'high' }])` as unattributed!
    for (const testCase of [
      {
        effort: 'high' as const,
        expectedSetThoughtCount: 1,
        expectedSettings: [
          expect.objectContaining({
            model: 'model-b',
            effort: { known: true, value: 'high' },
          }),
        ],
      },
      { effort: null, expectedSetThoughtCount: 0, expectedSettings: [] },
    ]) {
      const { cwd, appDataDir } = await createEnv()
      let setThoughtCount = 0
      const recordedSettings: unknown[] = []
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              sessionId: 'sid-no-model-opt',
              modes: { currentModeId: 'default', availableModes: ['default'] },
              models: { currentModelId: 'model-a', availableModels: ['model-a', 'model-b'] },
              configOptions: [
                {
                  id: 'thought_level',
                  currentValue: 'high',
                  options: [{ value: 'low' }, { value: 'high' }],
                },
              ],
            },
          })
        } else if (frame.method === 'session/set_mode') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_model') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          setTimeout(() => {
            h.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sid-no-model-opt',
                update: {
                  sessionUpdate: 'config_option_update',
                  configOptions: [{ id: 'thought_level', currentValue: 'high' }],
                },
              },
            })
          }, 5)
        } else if (frame.method === 'session/set_config_option') {
          setThoughtCount += 1
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { configOptions: [{ id: 'thought_level', currentValue: 'high' }] },
          })
        } else if (frame.method === 'session/prompt') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              model: 'model-b',
              effort: testCase.effort,
              host: {
                recovery: {
                  inputSha256: 'c'.repeat(64),
                  recordEffectiveSettings: (s) => recordedSettings.push(s),
                  recordConfirmedUnsent: () => undefined,
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(setThoughtCount).toBe(testCase.expectedSetThoughtCount)
        expect(recordedSettings).toEqual(testCase.expectedSettings)
      } finally {
        await adapter.dispose()
      }
    }

    // 5. C6 (F11): Prefix concrete model IDs (`model-a` vs `model-a-pro`) MUST reject exact mismatch in set_model reply
    //    AND reject undeclared prefix family in configOptions!
    for (const setModelReply of [
      { modelId: 'model-a' },
      { configOptions: [{ id: 'model', currentValue: 'model-a' }] },
    ]) {
      const { cwd, appDataDir } = await createEnv()
      let promptSeen = false
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              sessionId: 'sid-prefix-model',
              modes: { currentModeId: 'default', availableModes: ['default'] },
              models: {
                currentModelId: 'model-a',
                availableModels: ['model-a', 'model-a-pro'],
              },
              configOptions: [],
            },
          })
        } else if (frame.method === 'session/set_mode') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_model') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: setModelReply })
        } else if (frame.method === 'session/close') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/prompt') {
          promptSeen = true
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, { model: 'model-a-pro', effort: null }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(/silently substituted model="model-a"/iu)
        expect(promptSeen).toBe(false)
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('Check #7: closes fresh zero-Turn session once on physical not_sent, skips resumed or physically-sent failures, and records unconfirmed close errors', async () => {
    // 1. Fresh session + physical not_sent after promptEnteredTransport -> session/close called ONCE.
    {
      const { cwd, appDataDir } = await createEnv()
      let closeCount = 0
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult('sid-zt-fresh'),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/close') {
          closeCount += 1
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, {
                host: {
                  recovery: {
                    inputSha256: 'd'.repeat(64),
                    canDispatch: () => false,
                    recordEffectiveSettings: () => undefined,
                    recordConfirmedUnsent: () => undefined,
                  },
                },
              }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(/withheld/iu)
        expect(closeCount).toBe(1)
        expect(adapter.unconfirmedClosedSessionCount).toBe(0)
      } finally {
        await adapter.dispose()
      }
    }

    // 2. Resumed session + physical not_sent -> NEVER triggers zero-Turn session/close.
    {
      const { cwd, appDataDir } = await createEnv()
      let closeCount = 0
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/load') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult('sid-zt-resumed'),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/close') {
          closeCount += 1
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, {
                nativeSessionId: 'sid-zt-resumed',
                host: {
                  recovery: {
                    inputSha256: 'e'.repeat(64),
                    canDispatch: () => false,
                    recordEffectiveSettings: () => undefined,
                    recordConfirmedUnsent: () => undefined,
                  },
                },
              }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(/withheld/iu)
        expect(closeCount).toBe(0)
      } finally {
        await adapter.dispose()
      }
    }

    // 3. Fresh session where prompt bytes WERE physically sent -> NEVER triggers zero-Turn session/close.
    {
      const { cwd, appDataDir } = await createEnv()
      let closeCount = 0
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult('sid-zt-sent'),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32000, message: 'Server execution error after prompt dispatch' },
          })
        } else if (frame.method === 'session/close') {
          closeCount += 1
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await expect(
          collectEvents(adapter.run(makeBaseRunInput(cwd), new AbortController().signal)),
        ).rejects.toThrow(/Server execution error/iu)
        expect(closeCount).toBe(0)
      } finally {
        await adapter.dispose()
      }
    }

    // 4. Fresh session where session/close returns JSON-RPC error -> records unconfirmed state & nativeMethod diagnostic.
    {
      const { cwd, appDataDir } = await createEnv()
      const diagSpy = vi.spyOn(utilityLog, 'recordDiagnostic')
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult('sid-zt-close-err'),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/close') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32603, message: 'close failed' },
          })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, {
                host: {
                  recovery: {
                    inputSha256: 'f'.repeat(64),
                    canDispatch: () => false,
                    recordEffectiveSettings: () => undefined,
                    recordConfirmedUnsent: () => undefined,
                  },
                },
              }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(/withheld/iu)
        expect(adapter.unconfirmedClosedSessionCount).toBe(1)
        expect(adapter.hasUnconfirmedClosedSession('sid-zt-close-err')).toBe(true)
        expect(diagSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: 'native_check',
            phase: 'failed',
            nativeMethod: 'session/close',
            failureSource: 'native_rpc_rejection',
          }),
        )
      } finally {
        diagSpy.mockRestore()
        await adapter.dispose()
      }
    }

    // 5. C7 (F13): Fresh session where session/close returns malformed packet missing `result` -> records unconfirmed close & protocol_error diagnostic without clearing ledger.
    {
      const { cwd, appDataDir } = await createEnv()
      const diagSpy = vi.spyOn(utilityLog, 'recordDiagnostic')
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult('sid-zt-close-malformed'),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/close') {
          // Malformed JSON-RPC response lacking `result`!
          h.sendToClient({ jsonrpc: '2.0', id: frame.id })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, {
                host: {
                  recovery: {
                    inputSha256: 'a'.repeat(64),
                    canDispatch: () => false,
                    recordEffectiveSettings: () => undefined,
                    recordConfirmedUnsent: () => undefined,
                  },
                },
              }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(/withheld/iu)
        expect(adapter.unconfirmedClosedSessionCount).toBe(1)
        expect(adapter.hasUnconfirmedClosedSession('sid-zt-close-malformed')).toBe(true)
        expect(diagSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: 'native_check',
            phase: 'failed',
            nativeMethod: 'session/close',
            failureSource: 'transport_failure',
            code: 'protocol_error',
          }),
        )
      } finally {
        diagSpy.mockRestore()
        await adapter.dispose()
      }
    }
  })

  it('C1 (F6): early first HTTP call on ACP-pinned normal model migrates atomically from token:<pt> to call:<id>, promoting on completed and releasing single-shot quota on failed/conflict', async () => {
    // Subcase A: Early HTTP publish_session_title + request_peer_assistance -> >150ms provisional token:<pt> -> late ACP in_progress migrates to call:<id> -> completed promotes both!
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const pactSessionId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      let earlyTitleErr: unknown
      const harness = createAcpHarness()

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
            result: defaultSessionNewResult(nativeSessionId),
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
          // Pin root trajectory via ACP non-MCP update (normal model, trajectoryIdSource === 'acp').
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-non-mcp-pin',
                name: 'view_file',
                status: 'completed',
                progressToken: 'traj-normal:0',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))

          // First HTTP call arrives BEFORE ACP in_progress (waits 150ms and stages provisionally as token:traj-normal:1).
          const titleRes = (await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Migrated Early Title' },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: 'traj-normal:1',
                },
              },
            }),
          }).then((r) => r.json())) as { result: Record<string, unknown> }
          earlyTitleErr = titleRes.result.isError

          // Late ACP in_progress arrives WITHOUT progressToken -> atomically migrates token:traj-normal:1 -> call:tc-early-title!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-early-title',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'in_progress',
                args: { title: 'Migrated Early Title' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          // Completing call:tc-early-title (without progressToken) promotes the migrated title!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-early-title',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'completed',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const events = await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              permissionMode: 'auto',
              peerAssistanceAllowed: true,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                requestSessionTitle: true,
                message: { id: randomUUID(), content: 'Early HTTP migration test.' },
                comments: [],
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(earlyTitleErr).toBeUndefined()
        const titles = events.filter((e) => e.type === 'session.title.updated')
        expect(titles).toHaveLength(1)
        expect((titles[0] as { title: string }).title).toBe('Migrated Early Title')
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase B: Early HTTP request_peer_assistance -> late ACP in_progress migrates -> failed releases single-shot quota so retry succeeds!
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const pactSessionId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      let firstPeerErr: unknown
      let retryErr: unknown
      const harness = createAcpHarness()

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
            result: defaultSessionNewResult(nativeSessionId),
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
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-pin-b',
                name: 'view_file',
                status: 'completed',
                progressToken: 'traj-norm-b:0',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))

          const firstPeer = (await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'request_peer_assistance',
                arguments: { target: 'codex', kind: 'review' },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: 'traj-norm-b:1',
                },
              },
            }),
          }).then((r) => r.json())) as { result: Record<string, unknown> }
          firstPeerErr = firstPeer.result.isError

          // Late in_progress migrates token:traj-norm-b:1 -> call:tc-peer-fail, then fails!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-peer-fail',
                name: `mcp_${mcpName}_request_peer_assistance`,
                status: 'in_progress',
                args: { target: 'codex', kind: 'review' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 5))
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-peer-fail',
                name: `mcp_${mcpName}_request_peer_assistance`,
                status: 'failed',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 5))

          // Retry peer assistance MUST succeed because failed migrated call released single-shot quota!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-peer-retry',
                name: `mcp_${mcpName}_request_peer_assistance`,
                status: 'in_progress',
                args: { target: 'codex', kind: 'challenge', reason: 'Retry after migrated fail' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 5))
          const retryPeer = (await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'request_peer_assistance',
                arguments: {
                  target: 'codex',
                  kind: 'challenge',
                  reason: 'Retry after migrated fail',
                },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: 'traj-norm-b:2',
                },
              },
            }),
          }).then((r) => r.json())) as { result: Record<string, unknown> }
          retryErr = retryPeer.result.isError
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-peer-retry',
                name: `mcp_${mcpName}_request_peer_assistance`,
                status: 'completed',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const events = await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              permissionMode: 'auto',
              peerAssistanceAllowed: true,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Early HTTP failed migration retry test.' },
                comments: [],
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(firstPeerErr).toBeUndefined()
        expect(retryErr).toBeUndefined()
        const peerEvents = events.filter((e) => e.type === 'peer.assistance.requested')
        expect(peerEvents).toHaveLength(1)
        expect((peerEvents[0] as { kind: string }).kind).toBe('challenge')
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('C2 (F4/F5/F7/F8): enforces canonical token dedupe (traj:007 vs traj:7), explicit-token arg gate, 1-exact+1-subset ambiguity, wait-window non-MCP abort, irreversible terminal lifecycle, and 4096 tokenLedger fail-closed cap', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const trueTrajectoryId = randomUUID()
    await createDbFixture(appDataDir, nativeSessionId, trueTrajectoryId, 1)

    const pactSessionId = randomUUID()
    const runId = randomUUID()
    const grantId = randomUUID()
    const sourceArgs = { runId, grant: grantId, source: 'inputs', offset: 0 }

    let mcpUrl = ''
    let mcpName = ''
    const results: Record<string, unknown> = {}
    let waitAbortDurationMs = 999
    const harness = createAcpHarness()

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new' || frame.method === 'session/load') {
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpUrl = servers?.[0]?.url ?? ''
        mcpName = servers?.[0]?.name ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
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
        const callHttp = async (
          id: number,
          name: string,
          args: Record<string, unknown>,
          progressToken: string,
        ) =>
          fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id,
              method: 'tools/call',
              params: {
                name,
                arguments: args,
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken,
                },
              },
            }),
          }).then(
            (r) =>
              r.json() as Promise<{
                result: { isError?: boolean; content?: Array<{ text?: string }> }
              }>,
          )

        const sendAcp = (
          toolCallId: string,
          rawName: string,
          status: 'in_progress' | 'completed' | 'failed',
          args?: Record<string, unknown>,
          progressToken?: string,
        ) => {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update',
                toolCallId,
                name: rawName,
                status,
                ...(args !== undefined ? { args } : {}),
                ...(progressToken !== undefined ? { progressToken } : {}),
              },
            },
          })
        }

        // 1. F4: Leading-zero token `traj:007` rejected AND non-MCP `traj:008` blocks canonical `traj:8`!
        sendAcp('c2-src-1', `mcp_${mcpName}_read_collaboration_source`, 'in_progress', sourceArgs)
        await new Promise((r) => setTimeout(r, 5))
        results.leadingZeroFirstErr = (
          await callHttp(1, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:007`)
        ).result.isError
        results.canonical7Ok = (
          await callHttp(2, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:7`)
        ).result.isError
        sendAcp('c2-src-1', `mcp_${mcpName}_read_collaboration_source`, 'completed', sourceArgs)
        await new Promise((r) => setTimeout(r, 5))

        sendAcp('c2-src-2', `mcp_${mcpName}_read_collaboration_source`, 'in_progress', sourceArgs)
        await new Promise((r) => setTimeout(r, 5))
        results.leadingZeroReplayErr = (
          await callHttp(3, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:007`)
        ).result.isError
        sendAcp('c2-nonmcp-008', 'view_file', 'in_progress', undefined, `${trueTrajectoryId}:008`)
        await new Promise((r) => setTimeout(r, 5))
        results.canonicalNonMcpBlockedErr = (
          await callHttp(4, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:8`)
        ).result.isError
        sendAcp('c2-src-2', `mcp_${mcpName}_read_collaboration_source`, 'failed')
        sendAcp('c2-nonmcp-008', 'view_file', 'completed')

        // 2. F5: Explicit token with missing ACP args on read_collaboration_source waits 150ms and rejects (0 reads)!
        sendAcp(
          'c2-explicit-noargs',
          `mcp_${mcpName}_read_collaboration_source`,
          'in_progress',
          undefined,
          `${trueTrajectoryId}:9`,
        )
        await new Promise((r) => setTimeout(r, 5))
        results.explicitMissingArgsErr = (
          await callHttp(5, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:9`)
        ).result.isError
        sendAcp('c2-explicit-noargs', `mcp_${mcpName}_read_collaboration_source`, 'failed')

        // 3. F5: 1 exact + 1 subset (extra non-semantic key) concurrent active calls -> rejected as ambiguous (0 reads)!
        sendAcp('c2-exact', `mcp_${mcpName}_read_collaboration_source`, 'in_progress', sourceArgs)
        sendAcp('c2-subset', `mcp_${mcpName}_read_collaboration_source`, 'in_progress', {
          ...sourceArgs,
          extraUiLabel: 'subset-candidate',
        })
        await new Promise((r) => setTimeout(r, 5))
        results.exactPlusSubsetAmbigErr = (
          await callHttp(6, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:10`)
        ).result.isError
        sendAcp('c2-exact', `mcp_${mcpName}_read_collaboration_source`, 'failed')
        sendAcp('c2-subset', `mcp_${mcpName}_read_collaboration_source`, 'failed')

        // 4. F7: Non-MCP token arrives DURING the 150ms HTTP wait window -> wakes waiter immediately & rejects (0 reads)!
        const waitStart = performance.now()
        const waitHttpPromise = callHttp(
          7,
          'read_collaboration_source',
          sourceArgs,
          `${trueTrajectoryId}:11`,
        )
        await new Promise((r) => setTimeout(r, 15))
        sendAcp('c2-nonmcp-race', 'view_file', 'in_progress', undefined, `${trueTrajectoryId}:11`)
        results.waitNonMcpRaceErr = (await waitHttpPromise).result.isError
        waitAbortDurationMs = performance.now() - waitStart
        sendAcp('c2-nonmcp-race', 'view_file', 'completed')

        // 5. F8: Late session/request_permission after terminal completed NEVER reopens call; permission without allow_once NEVER registers pending!
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-reopen-terminal',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: {
              toolCallId: 'c2-src-1',
              name: `mcp_${mcpName}_read_collaboration_source`,
              args: sourceArgs,
            },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-no-allow-once',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: {
              toolCallId: 'c2-no-allow-once',
              name: `mcp_${mcpName}_read_collaboration_source`,
              args: sourceArgs,
            },
            options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
          },
        })
        await waitUntilCondition(() => harness.responses.length >= 2)
        results.reopenTerminalHttpErr = (
          await callHttp(8, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:12`)
        ).result.isError

        // 6. F7: Saturating tokenLedger (4096 cap) sets irreversible fail-closed latch!
        for (let i = 0; i < 4_105; i += 1) {
          sendAcp(`nm-${i % 16}`, 'view_file', 'completed', undefined, `k:${i}`)
        }
        await new Promise((r) => setTimeout(r, 30))
        sendAcp(
          'c2-after-cap',
          `mcp_${mcpName}_read_collaboration_source`,
          'in_progress',
          sourceArgs,
        )
        await new Promise((r) => setTimeout(r, 5))
        results.after4096CapErr = (
          await callHttp(9, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:9999`)
        ).result.isError
        sendAcp('c2-after-cap', `mcp_${mcpName}_read_collaboration_source`, 'failed')

        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn' },
        })
      }
    })

    let sourceReaderCalls = 0
    const recordedReviews: unknown[] = []
    const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            nativeSessionId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: randomUUID(), content: 'C2 correlator invariants.' },
              comments: [],
              sourceGrant: { runId, grant: grantId },
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                sourceReader: legacySourceReader(() => {
                  sourceReaderCalls += 1
                  return { source: 'inputs', offset: 0, nextOffset: null, text: 'Frozen source.' }
                }),
                recordReview: (obs) => recordedReviews.push(obs),
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      expect(results.leadingZeroFirstErr).toBe(true)
      expect(results.canonical7Ok).toBeUndefined()
      expect(results.leadingZeroReplayErr).toBe(true)
      expect(results.canonicalNonMcpBlockedErr).toBe(true)
      expect(results.explicitMissingArgsErr).toBe(true)
      expect(results.exactPlusSubsetAmbigErr).toBe(true)
      expect(results.waitNonMcpRaceErr).toBe(true)
      expect(waitAbortDurationMs).toBeLessThan(120)
      expect(results.reopenTerminalHttpErr).toBe(true)
      expect(results.after4096CapErr).toBe(true)
      // Strictly ONLY the single valid canonical `traj:7` call invoked sourceReader!
      expect(sourceReaderCalls).toBe(1)
      expect(recordedReviews).toEqual([])
    } finally {
      await adapter.dispose()
    }
  })

  it('C3 (F9): out-of-order publish_plan confirmation anchors planNativeId to the final complete:true chunk toolCallId', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const trueTrajectoryId = randomUUID()
    await createDbFixture(appDataDir, nativeSessionId, trueTrajectoryId, 1)

    const pactSessionId = randomUUID()
    const runId = randomUUID()
    let mcpUrl = ''
    let mcpName = ''
    const c3ChunkErrors: unknown[] = []
    const harness = createAcpHarness()

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new' || frame.method === 'session/load') {
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpUrl = servers?.[0]?.url ?? ''
        mcpName = servers?.[0]?.name ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
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
        const chunk1 = { text: '# Plan\n', offset: 0, complete: false }
        const chunk2 = { text: 'Final body', offset: 7, complete: true }

        // Open both chunks concurrently on ACP
        for (const [id, args] of [
          ['tc-start', chunk1],
          ['tc-end', chunk2],
        ] as const) {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: id,
                name: `mcp_${mcpName}_publish_plan`,
                status: 'in_progress',
                args,
              },
            },
          })
        }
        await new Promise((r) => setTimeout(r, 5))

        // Stage and confirm chunk 1 (`tc-start`) first (preceding chunks must complete before finalizing),
        // then stage and confirm final chunk (`tc-end`) and verify planNativeId anchors to `tc-end` (not `tc-start`).
        const res1 = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'publish_plan',
              arguments: chunk1,
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: `${trueTrajectoryId}:2`,
              },
            },
          }),
        }).then((r) => r.json())) as { result: Record<string, unknown> }
        c3ChunkErrors.push(res1.result.isError)

        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-start',
              name: `mcp_${mcpName}_publish_plan`,
              status: 'completed',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 5))

        const res2 = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'publish_plan',
              arguments: chunk2,
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: `${trueTrajectoryId}:3`,
              },
            },
          }),
        }).then((r) => r.json())) as { result: Record<string, unknown> }
        c3ChunkErrors.push(res2.result.isError)

        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-end',
              name: `mcp_${mcpName}_publish_plan`,
              status: 'completed',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 5))
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Published updated plan.' },
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

    const publishedPlans: Array<{ nativeId: string; text: string }> = []
    const recordedEvidence: unknown[] = []
    const { task, authorization } = makeCollaborationTask(
      pactSessionId,
      runId,
      'implement',
      'build',
    )
    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            nativeSessionId,
            permissionMode: 'auto',
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: randomUUID(), content: 'Out of order publish_plan.' },
              comments: [],
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              lifecycle: {
                recordNativeEvidence: (ev) => recordedEvidence.push(ev),
              },
              workflow: {
                recordPlan: (p) => publishedPlans.push(p),
                recordOpenPlanFinalIntent: () => true,
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      expect(c3ChunkErrors).toEqual([undefined, undefined])
      expect(publishedPlans).toEqual([
        { nativeId: `${nativeSessionId}:tc-end`, text: '# Plan\nFinal body' },
      ])
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'collaboration.plan',
          nativeId: `${nativeSessionId}:tc-end`,
          text: '# Plan\nFinal body',
        }),
      )
      const terminalEv = recordedEvidence.find(
        (ev) =>
          typeof ev === 'object' &&
          ev !== null &&
          (ev as { source?: string }).source === 'live_terminal',
      ) as { output?: { plan?: { nativeId?: string; text?: string } } } | undefined
      expect(terminalEv?.output?.plan).toEqual({
        nativeId: `${nativeSessionId}:tc-end`,
        text: '# Plan\nFinal body',
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('C8 (F10) & F16: enforces 256 KiB correlation budget, closes MCP synchronously on root Turn exit even with active background tasks, and gates pre-prompt storage failures before session/prompt', async () => {
    // Part A: Active background task at root Turn exit STILL closes MCP server synchronously in finally!
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const pactSessionId = randomUUID()
      let mcpUrl = ''
      const harness = createAcpHarness()

      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string }> }).mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          // Spawn an active background daemon task so activeBackgroundTasks.size > 0 at root Turn exit!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'bg-daemon-1',
                name: 'run_command',
                status: 'in_progress',
                args: { CommandLine: 'npm run dev', IsDaemon: true },
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

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              permissionMode: 'auto',
              peerAssistanceAllowed: true,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                requestSessionTitle: true,
                message: { id: randomUUID(), content: 'Launch background task.' },
                comments: [],
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(adapter.hasActiveBackgroundWork()).toBe(true)
        // MCP server MUST already be physically closed immediately after root Turn exit!
        expect(mcpUrl).not.toBe('')
        let postExitMcpClosed = false
        try {
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
          })
        } catch {
          postExitMcpClosed = true
        }
        expect(postExitMcpClosed).toBe(true)
      } finally {
        await adapter.dispose()
      }
    }

    // Part B: C8 exact 256 KiB correlation budget counting 1024B toolCallId, 300B token, and dual ~6 KiB fingerprints fails closed!
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const trueTrajectoryId = randomUUID()
      await createDbFixture(appDataDir, nativeSessionId, trueTrajectoryId, 1)

      const pactSessionId = randomUUID()
      const runId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      let overflowRejected = false
      const harness = createAcpHarness()

      harness.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new' || frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          // Each open ACP call has a 1024B toolCallId + ~60 fingerprint keys (~7.5 KiB each): ~40 open calls exceed 256 KiB!
          const heavyArgs: Record<string, unknown> = { verdict: 'accepted' }
          for (let k = 0; k < 58; k += 1) {
            heavyArgs[`meta_key_${String(k).padStart(2, '0')}_${'x'.repeat(20)}`] = k
          }
          for (let i = 0; i < 45; i += 1) {
            const longId = `id-${String(i).padStart(3, '0')}-${'a'.repeat(1010)}`
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: nativeSessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: longId,
                  name: `mcp_${mcpName}_submit_review`,
                  status: 'in_progress',
                  args: heavyArgs,
                  progressToken: `${trueTrajectoryId}:${i + 10}`,
                },
              },
            })
          }
          await new Promise((r) => setTimeout(r, 25))
          // The 44th call was rejected/revoked at the 256 KiB correlation budget!
          const overflowRes = (await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'submit_review',
                arguments: { verdict: 'accepted' },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: `${trueTrajectoryId}:54`,
                },
              },
            }),
          }).then((r) => r.json())) as { result: Record<string, unknown> }
          overflowRejected = overflowRes.result.isError === true
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })

      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              nativeSessionId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Correlation 256 KiB cap.' },
                comments: [],
                collaboration: task,
                collaborationAuthorization: authorization,
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(overflowRejected).toBe(true)
      } finally {
        await adapter.dispose()
      }
    }

    // Part C: F16 pre-prompt dispatch gate fails closed with host_before_root_start proof BEFORE session/prompt!
    for (const badStatus of [
      'missing',
      'invalid',
      'budget_exceeded',
      'worker_error',
      'timeout',
    ] as const) {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const pactSessionId = randomUUID()
      const runId = randomUUID()
      let promptSent = false
      const unsentProofs: unknown[] = []
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/load') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          promptSent = true
        }
      })
      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => h.child,
        storageClient: {
          readTrajectoryIdentity: async () => ({
            status: badStatus,
            reason: `forced-${badStatus}`,
          }),
        },
      })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, {
                sessionId: pactSessionId,
                runId,
                nativeSessionId,
                promptEnvelope: {
                  version: 'pact-agent-prompt-v1',
                  sessionId: pactSessionId,
                  message: { id: randomUUID(), content: `Pre-prompt gate ${badStatus}` },
                  comments: [],
                  collaboration: task,
                  collaborationAuthorization: authorization,
                },
                host: {
                  recovery: {
                    inputSha256: 'b'.repeat(64),
                    recordEffectiveSettings: () => undefined,
                    recordConfirmedUnsent: (proof) => unsentProofs.push(proof),
                  },
                },
              }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(new RegExp(`forced-${badStatus}`, 'u'))
        expect(promptSent).toBe(false)
        expect(unsentProofs).toEqual([{ kind: 'host_before_root_start' }])
      } finally {
        await adapter.dispose()
      }
    }

    // Part D: F16 resumed session receiving `no_storage_root` proceeds in mock ACP mode AND disables lazy runtime DB pinning!
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const lateTrajId = randomUUID()
      const pactSessionId = randomUUID()
      const runId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      let readCalls = 0
      let lateDbAttemptedError: unknown
      const h = createAcpHarness()
      h.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          // Even if an active ACP call exists without trajectoryId, HTTP MUST NOT lazily read/pin the late-appearing DB!
          h.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-late-db',
                name: `mcp_${mcpName}_submit_review`,
                status: 'in_progress',
                args: { verdict: 'accepted' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 5))
          const res = (await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'submit_review',
                arguments: { verdict: 'accepted' },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: `${lateTrajId}:0`,
                },
              },
            }),
          }).then((r) => r.json())) as { result: Record<string, unknown> }
          lateDbAttemptedError = res.result.isError
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })
      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => h.child,
        storageClient: {
          readTrajectoryIdentity: async () => {
            readCalls += 1
            if (readCalls === 1) return { status: 'no_storage_root' }
            return { status: 'ok', trajectoryId: lateTrajId, stepCount: 0 }
          },
        },
      })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              nativeSessionId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'No storage root disables lazy DB pin.' },
                comments: [],
                collaboration: task,
                collaborationAuthorization: authorization,
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(readCalls).toBe(1)
        expect(lateDbAttemptedError).toBe(true)
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('R2-W2 Check #1 (S1-#1, #2, #3): blocks TOCTOU revocation between waiter resolution and use, unstructured root tokens, denied-first IDs, and evicted terminal IDs', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const trueTrajectoryId = randomUUID()
    await createDbFixture(appDataDir, nativeSessionId, trueTrajectoryId, 1)

    const pactSessionId = randomUUID()
    const runId = randomUUID()
    const grantId = randomUUID()
    const sourceArgs = { runId, grant: grantId, source: 'inputs', offset: 0 }
    let mcpUrl = ''
    let mcpName = ''
    let sourceReaderCalls = 0
    const recordedReviews: unknown[] = []
    const results: Record<string, unknown> = {}
    const harness = createAcpHarness()

    const callHttp = (
      id: number,
      name: string,
      args: Record<string, unknown>,
      progressToken: string,
    ) =>
      fetch(mcpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: {
              'antigravity.google/root_conversation_id': nativeSessionId,
              'antigravity.google/conversation_id': nativeSessionId,
              progressToken,
            },
          },
        }),
      }).then(
        (r) =>
          r.json() as Promise<{
            result: { isError?: boolean; content?: Array<{ text?: string }> }
          }>,
      )

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/load') {
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpUrl = servers?.[0]?.url ?? ''
        mcpName = servers?.[0]?.name ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
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
        // 1. S1-#1 TOCTOU (source read): HTTP parks in waiter; same stdout chunk admits via allow_once
        //    (synchronously waking & committing the claim!) and immediately revokes via reject_once
        //    BEFORE callTool resumes -> MUST fail in revalidateLiveClaim with post-claim revocation message!
        const toctouSrcPromise = callHttp(
          1,
          'read_collaboration_source',
          sourceArgs,
          `${trueTrajectoryId}:10`,
        )
        await new Promise((r) => setTimeout(r, 15))
        harness.sendRawStdout(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 'perm-toctou-allow-src',
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: {
                toolCallId: 'tc-toctou-src',
                name: `mcp_${mcpName}_read_collaboration_source`,
                args: sourceArgs,
                progressToken: `${trueTrajectoryId}:10`,
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })}\n${JSON.stringify({
            jsonrpc: '2.0',
            id: 'perm-toctou-revoke-src',
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: {
                toolCallId: 'tc-toctou-src',
                name: `mcp_${mcpName}_read_collaboration_source`,
                args: sourceArgs,
                progressToken: `${trueTrajectoryId}:10`,
              },
              options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
            },
          })}\n`,
        )
        const toctouSrcResp = await toctouSrcPromise
        results.toctouSrcErr = toctouSrcResp.result.isError
        results.toctouSrcText = toctouSrcResp.result.content?.[0]?.text

        // 2. S1-#1 TOCTOU (staged submit_review): same stdout chunk admits & commits claim then immediately revokes it!
        const toctouRevPromise = callHttp(
          2,
          'submit_review',
          { verdict: 'accepted' },
          `${trueTrajectoryId}:11`,
        )
        await new Promise((r) => setTimeout(r, 15))
        harness.sendRawStdout(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 'perm-toctou-allow-rev',
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: {
                toolCallId: 'tc-toctou-rev',
                name: `mcp_${mcpName}_submit_review`,
                args: { verdict: 'accepted' },
                progressToken: `${trueTrajectoryId}:11`,
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })}\n${JSON.stringify({
            jsonrpc: '2.0',
            id: 'perm-toctou-revoke-rev',
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: {
                toolCallId: 'tc-toctou-rev',
                name: `mcp_${mcpName}_submit_review`,
                args: { verdict: 'accepted' },
                progressToken: `${trueTrajectoryId}:11`,
              },
              options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
            },
          })}\n`,
        )
        const toctouRevResp = await toctouRevPromise
        results.toctouRevErr = toctouRevResp.result.isError
        results.toctouRevText = toctouRevResp.result.content?.[0]?.text
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-toctou-rev',
              name: `mcp_${mcpName}_submit_review`,
              status: 'completed',
            },
          },
        })

        // 3. S1-#2: Unstructured/opaque token MUST be rejected even when an explicit ACP call advertises it!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-opaque-src',
              name: `mcp_${mcpName}_read_collaboration_source`,
              status: 'in_progress',
              args: sourceArgs,
              progressToken: 'opaque-unstructured-token',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))
        results.opaqueSrcErr = (
          await callHttp(3, 'read_collaboration_source', sourceArgs, 'opaque-unstructured-token')
        ).result.isError
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-opaque-src',
              name: `mcp_${mcpName}_read_collaboration_source`,
              status: 'failed',
            },
          },
        })

        // 4. S1-#3a: Denied permission BEFORE any tool_call update records a tombstone so a late pending update NEVER reopens it!
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-denied-before-update',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: {
              toolCallId: 'tc-denied-first',
              name: `mcp_${mcpName}_read_collaboration_source`,
              args: sourceArgs,
            },
            options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
          },
        })
        await waitUntilCondition(() =>
          harness.responses.some((r) => r.id === 'perm-denied-before-update'),
        )
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-denied-first',
              name: `mcp_${mcpName}_read_collaboration_source`,
              status: 'in_progress',
              args: sourceArgs,
              progressToken: `${trueTrajectoryId}:12`,
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))
        results.deniedFirstReopenErr = (
          await callHttp(4, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:12`)
        ).result.isError

        // 5. S1-#3b: Evicted terminal call ID retains tombstone so a late pending update NEVER reopens it!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-evict-target',
              name: `mcp_${mcpName}_submit_review`,
              status: 'completed',
              args: { verdict: 'accepted' },
            },
          },
        })
        // Fill 256 subsequent completed/open slots to force eviction of `tc-evict-target` into tombstones.
        for (let i = 0; i < 258; i += 1) {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: `tc-fill-${i}`,
                name: `mcp_${mcpName}_submit_review`,
                status: 'completed',
              },
            },
          })
        }
        await new Promise((r) => setTimeout(r, 25))
        // Now send a late pending update for the evicted ID `tc-evict-target` -> MUST be blocked by tombstone!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-evict-target',
              name: `mcp_${mcpName}_submit_review`,
              status: 'in_progress',
              args: { verdict: 'accepted' },
              progressToken: `${trueTrajectoryId}:13`,
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))
        results.evictedReopenErr = (
          await callHttp(5, 'submit_review', { verdict: 'accepted' }, `${trueTrajectoryId}:13`)
        ).result.isError

        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn' },
        })
      }
    })

    const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            nativeSessionId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: randomUUID(), content: 'Check #1 invariants.' },
              comments: [],
              sourceGrant: { runId, grant: grantId },
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                sourceReader: legacySourceReader(() => {
                  sourceReaderCalls += 1
                  return { source: 'inputs', offset: 0, nextOffset: null, text: 'Forbidden read.' }
                }),
                recordReview: (obs) => recordedReviews.push(obs),
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      expect(results.toctouSrcErr).toBe(true)
      expect(results.toctouSrcText).toMatch(/revoked or superseded before execution/iu)
      expect(results.toctouRevErr).toBe(true)
      expect(results.toctouRevText).toMatch(/revoked or superseded before execution/iu)
      expect(harness.responses.find((r) => r.id === 'perm-toctou-allow-src')?.result).toMatchObject(
        { outcome: { optionId: 'allow' } },
      )
      expect(
        harness.responses.find((r) => r.id === 'perm-toctou-revoke-src')?.result,
      ).toMatchObject({ outcome: { optionId: 'deny' } })
      expect(harness.responses.find((r) => r.id === 'perm-toctou-allow-rev')?.result).toMatchObject(
        { outcome: { optionId: 'allow' } },
      )
      expect(
        harness.responses.find((r) => r.id === 'perm-toctou-revoke-rev')?.result,
      ).toMatchObject({ outcome: { optionId: 'deny' } })
      expect(results.opaqueSrcErr).toBe(true)
      expect(results.deniedFirstReopenErr).toBe(true)
      expect(results.evictedReopenErr).toBe(true)
      expect(sourceReaderCalls).toBe(0)
      expect(recordedReviews).toEqual([])
    } finally {
      await adapter.dispose()
    }
  })

  it('R2-W2 Check #2 (S1-#4, #5, #6): fails closed on 256-slot saturation, revokes conflicting explicit token after claim, and honors declared ACP permission kind over optionId aliases', async () => {
    // Part A: S1-#4 saturation + S1-#6 conflicting kind vs optionId aliases
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const trueTrajectoryId = randomUUID()
      await createDbFixture(appDataDir, nativeSessionId, trueTrajectoryId, 1)

      const pactSessionId = randomUUID()
      const runId = randomUUID()
      const grantId = randomUUID()
      const sourceArgs = { runId, grant: grantId, source: 'inputs', offset: 0 }
      let mcpUrl = ''
      let mcpName = ''
      let sourceReaderCalls = 0
      let satHttpErr: unknown
      let conflictingAliasHttpErr: unknown
      const harness = createAcpHarness()

      harness.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
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
          // 1. S1-#6: Read-only non-MCP tool where optionId='deny' has declared kind='allow_once' -> MUST cancel, NEVER select 'deny'!
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-ro-allow-aliased-deny',
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: {
                toolCallId: 'tc-ro-bad',
                name: 'write_file',
                args: { Path: join(cwd, 'x.txt'), Content: 'bad' },
              },
              options: [{ optionId: 'deny', name: 'Allow disguised as deny', kind: 'allow_once' }],
            },
          })

          // 2. S1-#6: Authorized MCP tool where optionId='allow_once' has declared kind='reject_once' -> MUST NOT allow or register candidate!
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-mcp-reject-aliased-allow',
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: {
                toolCallId: 'tc-mcp-reject-alias',
                name: `mcp_${mcpName}_read_collaboration_source`,
                args: sourceArgs,
              },
              options: [
                { optionId: 'allow_once', name: 'Reject disguised as allow', kind: 'reject_once' },
              ],
            },
          })
          await waitUntilCondition(() => harness.responses.length >= 2)
          conflictingAliasHttpErr = (
            await fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name: 'read_collaboration_source',
                  arguments: sourceArgs,
                  _meta: {
                    'antigravity.google/root_conversation_id': nativeSessionId,
                    'antigravity.google/conversation_id': nativeSessionId,
                    progressToken: `${trueTrajectoryId}:5`,
                  },
                },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content?: Array<{ text?: string }> }
                }>,
            )
          ).result.isError

          // 3. S1-#4: Fill all 256 open ACP slots (1 compatible read_collaboration_source + 255 open submit_review),
          //    then send a 257th compatible read_collaboration_source permission request -> MUST deny & fail closed on tokenless match!
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-compat-1',
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: {
                toolCallId: 'tc-compat-1',
                name: `mcp_${mcpName}_read_collaboration_source`,
                args: sourceArgs,
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
          for (let i = 0; i < 255; i += 1) {
            harness.sendToClient({
              jsonrpc: '2.0',
              id: `perm-pad-${i}`,
              method: 'session/request_permission',
              params: {
                sessionId: nativeSessionId,
                toolCall: {
                  toolCallId: `tc-pad-${i}`,
                  name: `mcp_${mcpName}_submit_review`,
                },
                options: [
                  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
                ],
              },
            })
          }
          await waitUntilCondition(() => harness.responses.length >= 258)

          // 257th open candidate (second compatible read_collaboration_source) cannot be tracked -> MUST be denied!
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-compat-2-saturated',
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: {
                toolCallId: 'tc-compat-2',
                name: `mcp_${mcpName}_read_collaboration_source`,
                args: sourceArgs,
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
          await waitUntilCondition(() =>
            harness.responses.some((r) => r.id === 'perm-compat-2-saturated'),
          )

          // Tokenless HTTP call MUST NOT treat `tc-compat-1` as unique now that a compatible candidate was dropped!
          satHttpErr = (
            await fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                  name: 'read_collaboration_source',
                  arguments: sourceArgs,
                  _meta: {
                    'antigravity.google/root_conversation_id': nativeSessionId,
                    'antigravity.google/conversation_id': nativeSessionId,
                    progressToken: `${trueTrajectoryId}:6`,
                  },
                },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content?: Array<{ text?: string }> }
                }>,
            )
          ).result.isError

          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }
      })

      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              nativeSessionId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Saturation and permission kind check.' },
                comments: [],
                sourceGrant: { runId, grant: grantId },
                collaboration: task,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  sourceReader: legacySourceReader(() => {
                    sourceReaderCalls += 1
                    return { source: 'inputs', offset: 0, nextOffset: null, text: 'Forbidden.' }
                  }),
                },
              },
            }),
            new AbortController().signal,
          ),
        )

        const respFor = (id: string) => harness.responses.find((r) => r.id === id)?.result
        expect(respFor('perm-ro-allow-aliased-deny')).toEqual({
          outcome: { outcome: 'cancelled' },
        })
        expect(respFor('perm-mcp-reject-aliased-allow')).toEqual({
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        })
        expect(conflictingAliasHttpErr).toBe(true)
        expect(respFor('perm-compat-2-saturated')).toEqual({
          outcome: { outcome: 'selected', optionId: 'deny' },
        })
        expect(satHttpErr).toBe(true)
        expect(sourceReaderCalls).toBe(0)
      } finally {
        await adapter.dispose()
      }
    }

    // Part B: S1-#5 late contradictory explicit token after fingerprint claim revokes & frees single-use slot!
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const trueTrajectoryId = randomUUID()
      await createDbFixture(appDataDir, nativeSessionId, trueTrajectoryId, 1)

      const pactSessionId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      let firstTitleErr: unknown
      let secondTitleErr: unknown
      const harness = createAcpHarness()

      harness.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
          return
        }
        if (frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
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
          // Tokenless ACP call claimed by HTTP under traj:10, then receives conflicting explicit token traj:99!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-title-conflict',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'in_progress',
                args: { title: 'Conflicted Title' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          firstTitleErr = (
            await fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name: 'publish_session_title',
                  arguments: { title: 'Conflicted Title' },
                  _meta: {
                    'antigravity.google/root_conversation_id': nativeSessionId,
                    'antigravity.google/conversation_id': nativeSessionId,
                    progressToken: `${trueTrajectoryId}:10`,
                  },
                },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content?: Array<{ text?: string }> }
                }>,
            )
          ).result.isError
          // Late permission frame supplies contradictory explicit token traj:99 -> MUST revoke & release title slot!
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-conflict-token',
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: {
                toolCallId: 'tc-title-conflict',
                name: `mcp_${mcpName}_publish_session_title`,
                args: { title: 'Conflicted Title' },
                progressToken: `${trueTrajectoryId}:99`,
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
          await waitUntilCondition(() =>
            harness.responses.some((r) => r.id === 'perm-conflict-token'),
          )
          // Subsequent tokenless completion MUST NOT promote 'Conflicted Title'!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-title-conflict',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'completed',
              },
            },
          })
          // Fresh valid title call proves single-use title slot was freed!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-title-good',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'in_progress',
                args: { title: 'Clean Replacement Title' },
                progressToken: `${trueTrajectoryId}:11`,
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          secondTitleErr = (
            await fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                  name: 'publish_session_title',
                  arguments: { title: 'Clean Replacement Title' },
                  _meta: {
                    'antigravity.google/root_conversation_id': nativeSessionId,
                    'antigravity.google/conversation_id': nativeSessionId,
                    progressToken: `${trueTrajectoryId}:11`,
                  },
                },
              }),
            }).then(
              (r) =>
                r.json() as Promise<{
                  result: { isError?: boolean; content?: Array<{ text?: string }> }
                }>,
            )
          ).result.isError
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-title-good',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'completed',
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

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const events = await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              nativeSessionId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                requestSessionTitle: true,
                message: { id: randomUUID(), content: 'Conflicting explicit token.' },
                comments: [],
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(firstTitleErr).toBeUndefined()
        expect(secondTitleErr).toBeUndefined()
        expect(harness.responses.find((r) => r.id === 'perm-conflict-token')?.result).toEqual({
          outcome: { outcome: 'selected', optionId: 'deny' },
        })
        const titles = events.filter((e) => e.type === 'session.title.updated')
        expect(titles).toEqual([
          { agentId: 'agy', type: 'session.title.updated', title: 'Clean Replacement Title' },
        ])
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('R2-W2 Check #3 (S1-#12, #13, #14): waits within 150ms for first-call ACP root pin, allows provisional tool after unrelated completed call, and frees single-use slot on terminal-only cancelled', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const acpTrajId = randomUUID()
    const pactSessionId = randomUUID()
    let mcpUrl = ''
    let mcpName = ''
    let earlyHttpErr: unknown
    let cancelledProvisionalErr: unknown
    let reusedTitleErr: unknown
    let secondProvisionalPeerErr: unknown
    const harness = createAcpHarness()

    const callHttp = (
      id: number,
      name: string,
      args: Record<string, unknown>,
      progressToken: string,
    ) =>
      fetch(mcpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: {
              'antigravity.google/root_conversation_id': nativeSessionId,
              'antigravity.google/conversation_id': nativeSessionId,
              progressToken,
            },
          },
        }),
      }).then(
        (r) =>
          r.json() as Promise<{
            result: { isError?: boolean; content?: Array<{ text?: string }> }
          }>,
      )

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
          result: defaultSessionNewResult(nativeSessionId),
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
        // 1. S1-#12: First HTTP call arrives BEFORE ACP pins root trajectory (no_storage_root -> no disk pin).
        //    ACP delivers matching trajectory pin + unkeyed tool_call 25ms later (inside 150ms window) -> succeeds!
        const earlyPromise = callHttp(
          1,
          'publish_session_title',
          { title: 'Cancelled Provisional Title' },
          `${acpTrajId}:1`,
        )
        setTimeout(() => {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                trajectoryId: acpTrajId,
                content: { type: 'text', text: 'Pinning trajectory inside 150ms window.' },
              },
            },
          })
        }, 25)
        // Because no pre-terminal tool_call arrived, after 150ms this stages provisionally as `token:${acpTrajId}:1`!
        cancelledProvisionalErr = (await earlyPromise).result.isError
        earlyHttpErr = cancelledProvisionalErr

        // 2. S1-#14: Terminal-only `cancelled` clears provisional `token:<pt>` AND immediately frees the title slot!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-prov-cancelled',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'cancelled',
              progressToken: `${acpTrajId}:1`,
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))

        // Immediately reuse the freed title slot with an unkeyed pre-terminal call that completes!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-title-unkeyed',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'in_progress',
              args: { title: 'Reused After Cancel' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))
        reusedTitleErr = (
          await callHttp(
            2,
            'publish_session_title',
            { title: 'Reused After Cancel' },
            `${acpTrajId}:2`,
          )
        ).result.isError
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-title-unkeyed',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'completed',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))

        // 3. S1-#13: After the unrelated unkeyed `tc-title-unkeyed` completed, a SECOND provisional tool
        //    (`request_peer_assistance` with NO pre-terminal update) MUST NOT be blocked by the completed call!
        secondProvisionalPeerErr = (
          await callHttp(
            3,
            'request_peer_assistance',
            { target: 'codex', kind: 'fact_check', reason: 'Second provisional tool.' },
            `${acpTrajId}:3`,
          )
        ).result.isError
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-peer-prov',
              name: `mcp_${mcpName}_request_peer_assistance`,
              status: 'completed',
              progressToken: `${acpTrajId}:3`,
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

    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            peerAssistanceAllowed: true,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              requestSessionTitle: true,
              message: { id: randomUUID(), content: 'Check #3 invariants.' },
              comments: [],
            },
          }),
          new AbortController().signal,
        ),
      )

      expect(earlyHttpErr).toBeUndefined()
      expect(cancelledProvisionalErr).toBeUndefined()
      expect(reusedTitleErr).toBeUndefined()
      expect(secondProvisionalPeerErr).toBeUndefined()
      expect(
        events.some(
          (e) =>
            e.type === 'tool.completed' &&
            e.toolCallId === 'tc-prov-cancelled' &&
            e.outcome === 'failed',
        ),
      ).toBe(true)
      expect(events.filter((e) => e.type === 'session.title.updated')).toEqual([
        { agentId: 'agy', type: 'session.title.updated', title: 'Reused After Cancel' },
      ])
      expect(events.filter((e) => e.type === 'peer.assistance.requested')).toHaveLength(1)
    } finally {
      await adapter.dispose()
    }

    // Subcase: S1-#12 contradictory ACP trajectory pin arriving inside 150ms rejects IMMEDIATELY!
    {
      const { cwd: cwd2, appDataDir: appDataDir2 } = await createEnv()
      const sid2 = randomUUID()
      const realTraj = randomUUID()
      const wrongTraj = randomUUID()
      let mcpUrl2 = ''
      let fastRejectMs = 0
      let wrongTrajErr: unknown
      const h2 = createAcpHarness()
      h2.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          h2.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string }> }).mcpServers
          mcpUrl2 = servers?.[0]?.url ?? ''
          h2.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(sid2),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
          h2.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'gemini-4-carbon' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
        } else if (frame.method === 'session/prompt') {
          const t0 = performance.now()
          const p = fetch(mcpUrl2, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Wrong Trajectory' },
                _meta: {
                  'antigravity.google/root_conversation_id': sid2,
                  'antigravity.google/conversation_id': sid2,
                  progressToken: `${wrongTraj}:1`,
                },
              },
            }),
          }).then(
            (r) =>
              r.json() as Promise<{
                result: { isError?: boolean; content?: Array<{ text?: string }> }
              }>,
          )
          setTimeout(() => {
            h2.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid2,
                update: {
                  sessionUpdate: 'agent_thought_chunk',
                  trajectoryId: realTraj,
                  content: { type: 'text', text: 'Pinning real trajectory.' },
                },
              },
            })
          }, 15)
          wrongTrajErr = (await p).result.isError
          fastRejectMs = performance.now() - t0
          h2.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })
      const adapter2 = new AgyAgentAdapter({
        appDataDir: appDataDir2,
        processFactory: () => h2.child,
      })
      try {
        await collectEvents(
          adapter2.run(
            makeBaseRunInput(cwd2, {
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: randomUUID(),
                requestSessionTitle: true,
                message: { id: randomUUID(), content: 'Contradictory pin fast reject.' },
                comments: [],
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(wrongTrajErr).toBe(true)
        expect(fastRejectMs).toBeLessThan(120)
      } finally {
        await adapter2.dispose()
      }
    }
  })

  it('R2-W2 Check #4 (S1-#7): rejects model-less async effort update after empty effort RPC reply during model switch without recording known settings', async () => {
    const { cwd, appDataDir } = await createEnv()
    const newResult = {
      sessionId: 'sid-effort-switch-attr',
      modes: { currentModeId: 'default', availableModes: ['default'] },
      models: {
        currentModelId: 'model-a',
        availableModels: ['model-a', 'model-b'],
      },
      configOptions: [
        { id: 'model', currentValue: 'model-a', options: [{ value: 'model-a' }] },
        {
          id: 'thought_level',
          currentValue: 'low',
          options: [{ value: 'low' }, { value: 'high' }],
        },
      ],
    }

    // 1. Negative case: empty effort RPC reply + model-less async effort update -> MUST reject & store 0 receipts!
    {
      const recordedSettings: unknown[] = []
      let promptSeen = false
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: newResult })
        } else if (frame.method === 'session/set_mode') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_model') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_config_option') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          setTimeout(() => {
            h.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sid-effort-switch-attr',
                update: {
                  sessionUpdate: 'config_option_update',
                  configOptions: [{ id: 'thought_level', currentValue: 'high' }],
                },
              },
            })
          }, 5)
        } else if (frame.method === 'session/close') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/prompt') {
          promptSeen = true
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, {
                model: 'model-b',
                effort: 'high',
                host: {
                  recovery: {
                    inputSha256: 'e'.repeat(64),
                    recordEffectiveSettings: (s) => recordedSettings.push(s),
                    recordConfirmedUnsent: () => undefined,
                  },
                },
              }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(/did not confirm thought_level="high"/iu)
        expect(promptSeen).toBe(false)
        expect(recordedSettings).toEqual([])
      } finally {
        await adapter.dispose()
      }
    }

    // 2. Positive case: empty effort RPC reply + model-attributed async update carrying model='model-b' -> succeeds!
    {
      const recordedSettings: unknown[] = []
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: newResult })
        } else if (frame.method === 'session/set_mode') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_model') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_config_option') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
          setTimeout(() => {
            h.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sid-effort-switch-attr',
                update: {
                  sessionUpdate: 'config_option_update',
                  configOptions: [
                    { id: 'model', currentValue: 'model-b' },
                    { id: 'thought_level', currentValue: 'high' },
                  ],
                },
              },
            })
          }, 5)
        } else if (frame.method === 'session/prompt') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              model: 'model-b',
              effort: 'high',
              host: {
                recovery: {
                  inputSha256: 'e'.repeat(64),
                  recordEffectiveSettings: (s) => recordedSettings.push(s),
                  recordConfirmedUnsent: () => undefined,
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(recordedSettings).toEqual([
          expect.objectContaining({
            model: 'model-b',
            effort: { known: true, value: 'high' },
          }),
        ])
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('R2-W2 Check #5 (S1-#9, #10, #15, #16): enforces 256 KiB metadata ceiling on held-byte counters, keeps promoted Markdown charged until settlement, and persists 1024B finalToolCallId through real repository', async () => {
    const { cwd, appDataDir } = await createEnv()
    const migrationsFolder = resolve(
      import.meta.dirname,
      '../../../../../packages/persistence/drizzle',
    )
    const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    const nativeSessionId = randomUUID()
    const trueTrajectoryId = randomUUID()
    await createDbFixture(appDataDir, nativeSessionId, trueTrajectoryId, 1)

    const projectId = randomUUID()
    const pactSessionId = randomUUID()
    const createdAt = new Date().toISOString()
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'R2W2 Check5',
      directoryPath: cwd,
      kind: 'directory',
      createdAt,
    })
    db.sessionRepository.create(
      { id: pactSessionId, projectId, title: 'Bounded Plan ID & Memory', createdAt },
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
    const { task: initialTask } = makeCollaborationTask(
      pactSessionId,
      randomUUID(),
      'implement',
      'build',
    )
    const started = repo.beginRun({
      sessionId: pactSessionId,
      clientMessageId: initialTask.taskMessageId,
      content: 'Publish an open plan with a 1024-byte finalToolCallId.',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'agy',
      settingsRevision: 1,
      model: 'gemini-4-carbon',
      effort: 'high',
      collaboration: initialTask,
    })
    const runId = started.run.id
    const repoTask = repo.collaborationPromptState(repo.collaboration(pactSessionId)!)
    const repoAuth = repo.collaborationTurnAuthorization(runId)!

    const baselineBytes = nativeWorkingMemoryDiagnostics().chargedBytes ?? 0
    let maxBytesDuringRejectedStorm = 0
    let bytesAfterPlanPromotedWhileRunActive = 0
    let mcpUrl = ''
    let mcpName = ''
    const longestCallId = `f${'c'.repeat(1023)}`
    expect(longestCallId.length).toBe(1024)
    const planChunkA = `# Plan Section A\n${'A'.repeat(40 * 1024)}`
    const planChunkB = `\n# Plan Section B\n${'B'.repeat(40 * 1024)}`
    const harness = createAcpHarness()

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/load') {
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpUrl = servers?.[0]?.url ?? ''
        mcpName = servers?.[0]?.name ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
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
        // 1. Send 235 calls with 1024B IDs and rejected oversized progressTokens (100 KiB each = 23.5 MiB total!)
        //    to verify S1-#9 & S1-#10 reject raw tokens before storage and enforce the 256 KiB metadata cap.
        const hugeInvalidPt = 'z'.repeat(100 * 1024)
        for (let i = 0; i < 235; i += 1) {
          const bigId = `rej-${String(i).padStart(3, '0')}-${'r'.repeat(1015)}`
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: bigId,
                name: `mcp_${mcpName}_publish_plan`,
                status: 'completed',
                progressToken: hugeInvalidPt,
              },
            },
          })
          if (i % 40 === 39) {
            await new Promise((r) => setImmediate(r))
            maxBytesDuringRejectedStorm = Math.max(
              maxBytesDuringRejectedStorm,
              (nativeWorkingMemoryDiagnostics().chargedBytes ?? 0) - baselineBytes,
            )
          }
        }
        await new Promise((r) => setTimeout(r, 15))
        maxBytesDuringRejectedStorm = Math.max(
          maxBytesDuringRejectedStorm,
          (nativeWorkingMemoryDiagnostics().chargedBytes ?? 0) - baselineBytes,
        )

        // 2. Stage & promote an 80 KiB 2-chunk open plan whose final chunk uses a 1024-byte `toolCallId`!
        const chunk1Args = { text: planChunkA, offset: 0, complete: false }
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'plan-chunk-1',
              name: `mcp_${mcpName}_publish_plan`,
              status: 'in_progress',
              args: chunk1Args,
              progressToken: `${trueTrajectoryId}:20`,
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))
        await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'publish_plan',
              arguments: chunk1Args,
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: `${trueTrajectoryId}:20`,
              },
            },
          }),
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'plan-chunk-1',
              name: `mcp_${mcpName}_publish_plan`,
              status: 'completed',
            },
          },
        })

        const chunk2Args = {
          text: planChunkB,
          offset: Buffer.byteLength(planChunkA, 'utf8'),
          complete: true,
        }
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: longestCallId,
              name: `mcp_${mcpName}_publish_plan`,
              status: 'in_progress',
              args: chunk2Args,
              progressToken: `${trueTrajectoryId}:21`,
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))
        await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'publish_plan',
              arguments: chunk2Args,
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: `${trueTrajectoryId}:21`,
              },
            },
          }),
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: longestCallId,
              name: `mcp_${mcpName}_publish_plan`,
              status: 'completed',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 20))
        // Retained publishedOpenPlan Markdown MUST remain charged while Run is still active!
        bytesAfterPlanPromotedWhileRunActive =
          (nativeWorkingMemoryDiagnostics().chargedBytes ?? 0) - baselineBytes

        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn' },
        })
      }
    })

    const recordedPlans: Array<{ nativeId: string; text: string }> = []
    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            nativeSessionId,
            permissionMode: 'auto',
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: started.run.userMessageId, content: 'Publish 1024B ID plan.' },
              comments: [],
              collaboration: repoTask,
              collaborationAuthorization: repoAuth,
            },
            host: {
              workflow: {
                recordPlan: (plan) => {
                  recordedPlans.push(plan)
                  repo.recordWorkflowPlan(runId, plan)
                },
                recordOpenPlanFinalIntent: () => true,
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      // 235 rejected calls + 64 retained compact tool states stay strictly below 256 KiB metadata cap + compact tool stubs!
      expect(maxBytesDuringRejectedStorm).toBeLessThan(256 * 1024)
      // Retained 80 KiB Markdown MUST stay charged until Run settles!
      expect(bytesAfterPlanPromotedWhileRunActive).toBeGreaterThanOrEqual(80 * 1024)
      expect(recordedPlans).toHaveLength(1)
      expect(recordedPlans[0]!.nativeId.length).toBeLessThanOrEqual(1024)
      expect(recordedPlans[0]!.text).toBe(planChunkA + planChunkB)
      const planEvent = events.find((e) => e.type === 'collaboration.plan')
      expect(planEvent).toBeDefined()
      expect(() => normalizedAgentEventSchema.parse(planEvent)).not.toThrow()
    } finally {
      await adapter.dispose()
      db.close()
    }
    // After Run + dispose settle, held working memory returns completely to baseline!
    expect(nativeWorkingMemoryDiagnostics().chargedBytes ?? 0).toBe(baselineBytes)

    // Subcase (S1-#19 & S1-#15): Clean isolated Run with ZERO preceding rejected calls measuring the
    // exact promotion delta of mixed-Unicode Markdown (UTF-8 ~42 KiB, conservative UTF-16 >= 84 KiB).
    // Removing or weakening the retained Markdown reservation MUST make this assertion fail!
    {
      const { cwd: cwdIso, appDataDir: appDataDirIso } = await createEnv()
      const sidIso = randomUUID()
      const trajIso = randomUUID()
      await createDbFixture(appDataDirIso, sidIso, trajIso, 1)
      const isoSessionId = randomUUID()
      const isoRunId = randomUUID()
      const { task: isoTask, authorization: isoAuth } = makeCollaborationTask(
        isoSessionId,
        isoRunId,
        'collaborate',
        'build',
      )
      const mixedUnicodePlan = `# Mixed Plan 中\n${'A'.repeat(42 * 1024)}`
      expect(Buffer.byteLength(mixedUnicodePlan, 'utf8')).toBeLessThan(45 * 1024)
      expect(mixedUnicodePlan.length * 2).toBeGreaterThan(84 * 1024)

      let isoMcpUrl = ''
      let isoMcpName = ''
      let bytesBeforePlan = 0
      let bytesAfterPlan = 0
      const hIso = createAcpHarness()
      hIso.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          hIso.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          isoMcpUrl = servers?.[0]?.url ?? ''
          isoMcpName = servers?.[0]?.name ?? ''
          hIso.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(sidIso),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
          hIso.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'gemini-4-carbon' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
        } else if (frame.method === 'session/prompt') {
          await new Promise((r) => setTimeout(r, 10))
          bytesBeforePlan = nativeWorkingMemoryDiagnostics().chargedBytes ?? 0
          const args = { text: mixedUnicodePlan, offset: 0, complete: true }
          hIso.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sidIso,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'iso-plan-call',
                name: `mcp_${isoMcpName}_publish_plan`,
                status: 'in_progress',
                args,
                progressToken: `${trajIso}:5`,
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          await fetch(isoMcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'publish_plan',
                arguments: args,
                _meta: {
                  'antigravity.google/root_conversation_id': sidIso,
                  'antigravity.google/conversation_id': sidIso,
                  progressToken: `${trajIso}:5`,
                },
              },
            }),
          })
          hIso.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sidIso,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'iso-plan-call',
                name: `mcp_${isoMcpName}_publish_plan`,
                status: 'completed',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 20))
          bytesAfterPlan = nativeWorkingMemoryDiagnostics().chargedBytes ?? 0
          hIso.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })
      const isoBaseline = nativeWorkingMemoryDiagnostics().chargedBytes ?? 0
      const adapterIso = new AgyAgentAdapter({
        appDataDir: appDataDirIso,
        processFactory: () => hIso.child,
      })
      try {
        await collectEvents(
          adapterIso.run(
            makeBaseRunInput(cwdIso, {
              sessionId: isoSessionId,
              runId: isoRunId,
              nativeSessionId: sidIso,
              permissionMode: 'auto',
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: isoSessionId,
                message: { id: randomUUID(), content: 'Clean isolated UTF-16 plan delta.' },
                comments: [],
                collaboration: isoTask,
                collaborationAuthorization: isoAuth,
              },
              host: {
                workflow: {
                  recordOpenPlanFinalIntent: () => true,
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        // Conservative UTF-16 string charge (`text.length * 2 + 64`) exceeds 84 KiB (2x the ~42 KiB UTF-8 size).
        expect(bytesAfterPlan - bytesBeforePlan).toBeGreaterThanOrEqual(mixedUnicodePlan.length * 2)
      } finally {
        await adapterIso.dispose()
      }
      expect(nativeWorkingMemoryDiagnostics().chargedBytes ?? 0).toBe(isoBaseline)
    }

    // Subcase: S1-#10 saturating 256 KiB metadata cap with 230 1024B-ID heavy-arg open calls NEVER
    // bypasses the 256 KiB metadata ceiling via unreserved revoked stubs!
    {
      const { cwd: cwdSat, appDataDir: appDataDirSat } = await createEnv()
      const sidSat = randomUUID()
      const trajSat = randomUUID()
      await createDbFixture(appDataDirSat, sidSat, trajSat, 1)
      const satBaseline = nativeWorkingMemoryDiagnostics().chargedBytes ?? 0
      let satMaxMetadataDelta = 0
      let satMcpName = ''
      const hSat = createAcpHarness()
      hSat.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          hSat.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ name: string }> }).mcpServers
          satMcpName = servers?.[0]?.name ?? ''
          hSat.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(sidSat),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
          hSat.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'gemini-4-carbon' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
        } else if (frame.method === 'session/prompt') {
          const heavyArgs: Record<string, unknown> = { verdict: 'accepted' }
          for (let k = 0; k < 58; k += 1) {
            heavyArgs[`k_${String(k).padStart(2, '0')}_${'x'.repeat(20)}`] = k
          }
          // Send 230 permission requests in paced batches (each with a 1024B toolCallId + heavy args)
          // so outbound frame reservations drain while correlator hits 256 KiB early and rejects/retires
          // all remaining ~195 calls without exceeding 256 KiB!
          for (let i = 0; i < 230; i += 1) {
            hSat.sendToClient({
              jsonrpc: '2.0',
              id: `perm-sat-mem-${i}`,
              method: 'session/request_permission',
              params: {
                sessionId: sidSat,
                toolCall: {
                  toolCallId: `sat-${String(i).padStart(3, '0')}-${'s'.repeat(1015)}`,
                  name: `mcp_${satMcpName}_submit_review`,
                  args: heavyArgs,
                },
                options: [
                  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
                ],
              },
            })
            if ((i + 1) % 16 === 0 || i === 229) {
              const targetCount = i + 1
              await waitUntilCondition(() => hSat.responses.length >= targetCount)
            }
          }
          satMaxMetadataDelta = (nativeWorkingMemoryDiagnostics().chargedBytes ?? 0) - satBaseline
          hSat.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })
      const satSessionId = randomUUID()
      const satRunId = randomUUID()
      const { task: satTask, authorization: satAuth } = makeCollaborationTask(
        satSessionId,
        satRunId,
        'plan_review',
      )
      const adapterSat = new AgyAgentAdapter({
        appDataDir: appDataDirSat,
        processFactory: () => hSat.child,
      })
      try {
        await collectEvents(
          adapterSat.run(
            makeBaseRunInput(cwdSat, {
              sessionId: satSessionId,
              runId: satRunId,
              nativeSessionId: sidSat,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: satSessionId,
                message: { id: randomUUID(), content: '256 KiB strict admission ceiling.' },
                comments: [],
                collaboration: satTask,
                collaborationAuthorization: satAuth,
              },
            }),
            new AbortController().signal,
          ),
        )
        // Only correlator reservation is charged (permission requests don't populate tools map),
        // so held bytes MUST stay strictly <= 256 KiB (+ small evidence cache)!
        expect(satMaxMetadataDelta).toBeLessThanOrEqual(256 * 1024 + 4096)
        const deniedCount = hSat.responses.filter(
          (r) =>
            (r.result as { outcome?: { optionId?: string } } | undefined)?.outcome?.optionId ===
            'deny',
        ).length
        expect(deniedCount).toBeGreaterThan(150)
      } finally {
        await adapterSat.dispose()
      }
      expect(nativeWorkingMemoryDiagnostics().chargedBytes ?? 0).toBe(satBaseline)
    }
  })

  it('R2-W2 Check #6 (S1-#11, #18): enforces fresh negative disk-proof gates and spawns zero workers after dispose() during churn backoff', async () => {
    // Part A: Fresh session negative disk-proof statuses ALL fail closed before session/prompt!
    for (const badStatus of [
      'missing',
      'invalid',
      'budget_exceeded',
      'worker_error',
      'timeout',
    ] as const) {
      const { cwd, appDataDir } = await createEnv()
      const pactSessionId = randomUUID()
      const runId = randomUUID()
      let promptSent = false
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(randomUUID()),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/close') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/prompt') {
          promptSent = true
        }
      })
      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => h.child,
        storageClient: {
          readTrajectoryIdentity: async () => ({
            status: badStatus,
            reason: `fresh-${badStatus}`,
          }),
        },
      })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, {
                sessionId: pactSessionId,
                runId,
                promptEnvelope: {
                  version: 'pact-agent-prompt-v1',
                  sessionId: pactSessionId,
                  message: { id: randomUUID(), content: `Fresh gate ${badStatus}` },
                  comments: [],
                  collaboration: task,
                  collaborationAuthorization: authorization,
                },
              }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(new RegExp(`fresh-${badStatus}`, 'u'))
        expect(promptSent).toBe(false)
      } finally {
        await adapter.dispose()
      }
    }

    // Part B: S1-#18 dispose() during transient_churn retry backoff spawns ZERO subsequent child processes!
    {
      const { cwd, appDataDir } = await createEnv()
      const convDir = join(appDataDir, 'conversations')
      await mkdir(convDir, { recursive: true })
      const sid = randomUUID()

      let workerSpawns = 0
      let validatedChurnObservedResolve: (() => void) | undefined
      const validatedChurnObserved = new Promise<void>((r) => {
        validatedChurnObservedResolve = r
      })
      // oxlint-disable-next-line typescript/unbound-method -- Invoked with actual NativeForkFiles receiver below.
      const origReadIdentity = NativeForkFiles.prototype.readAgyTrajectoryIdentity
      const readIdentitySpy = vi
        .spyOn(NativeForkFiles.prototype, 'readAgyTrajectoryIdentity')
        .mockImplementation(async function (this: NativeForkFiles, req, sig) {
          const result = await origReadIdentity.call(this, req, sig)
          if (result.status === 'transient_churn') {
            // Defer one microtask so the adapter receives the validated churn result and enters its 25ms backoff sleep.
            queueMicrotask(() => validatedChurnObservedResolve?.())
          }
          return result
        })

      const churnTransport: AgyStorageTransport = {
        generation: randomUUID(),
        async open(req) {
          workerSpawns += 1
          let listener: ((message: unknown) => void) | undefined
          let resolveExited!: (event: {
            type: 'agy-storage.closed.event'
            jobKey: typeof req.jobKey
            exitCode: number | null
            signal: string | null
            timedOut: boolean
            cancelled: boolean
          }) => void
          const exited = new Promise<{
            type: 'agy-storage.closed.event'
            jobKey: typeof req.jobKey
            exitCode: number | null
            signal: string | null
            timedOut: boolean
            cancelled: boolean
          }>((r) => {
            resolveExited = r
          })
          return {
            port: {
              onMessage: (fn) => {
                listener = fn
              },
              postMessage: () => {
                queueMicrotask(() => {
                  listener?.({
                    type: 'result',
                    jobKey: req.jobKey,
                    action: 'read-agy-trajectory-identity',
                    result: {
                      nativeSessionId: sid,
                      status: 'transient_churn',
                      reason: 'simulated-churn',
                    },
                  })
                  resolveExited({
                    type: 'agy-storage.closed.event',
                    jobKey: req.jobKey,
                    exitCode: 0,
                    signal: null,
                    timedOut: false,
                    cancelled: false,
                  })
                })
              },
              close: () => undefined,
            },
            exited,
            cancel: () => {
              resolveExited({
                type: 'agy-storage.closed.event',
                jobKey: req.jobKey,
                exitCode: null,
                signal: 'SIGKILL',
                timedOut: false,
                cancelled: true,
              })
            },
          }
        },
      }
      configureDefaultAgyStorageTransport(churnTransport)

      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/load') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(sid),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        }
      })

      const pactSessionId = randomUUID()
      const runId = randomUUID()
      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        const runPromise = collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              nativeSessionId: sid,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Dispose during churn backoff.' },
                comments: [],
                collaboration: task,
                collaborationAuthorization: authorization,
              },
            }),
            new AbortController().signal,
          ),
        )
        // Wait until the first child returns a VALIDATED transient_churn result and adapter enters backoff!
        await validatedChurnObserved
        expect(workerSpawns).toBe(1)
        await adapter.dispose()
        await expect(runPromise).rejects.toThrow(/shutting down|disposed|cancelled/iu)
        // Wait longer than the full backoff schedule (25+50+100+200ms) -> ZERO second children spawned!
        await new Promise((r) => setTimeout(r, 150))
        expect(workerSpawns).toBe(1)
      } finally {
        readIdentitySpy.mockRestore()
        configureDefaultAgyStorageTransport(undefined)
        await adapter.dispose()
      }
    }
  })

  it('R2-W2 Check #7 (S1-#8, #19, #20): persists candidateSessionId & reports unknown on unconfirmed Fork/Rebuild close, closes after failed cold replay, and bounds fresh cleanup close during sibling permission wait', async () => {
    // Part A: S1-#8 Rebuild unconfirmed close -> persists candidateSessionId via onNativeSessionCreated and reports 'unknown'!
    {
      const { cwd, appDataDir } = await createEnv()
      const allocatedSid = `sid-rebuild-unconfirmed-${randomUUID()}`
      let writeSeedCalls = 0
      const createdIds: string[] = []
      const workReports: unknown[] = []
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(allocatedSid),
          })
        } else if (frame.method === 'session/close') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32_000, message: 'close rejected' },
          })
        }
      })
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => h.child,
        storageClient: {
          writeRebuildSeed: async () => {
            writeSeedCalls += 1
            return {
              seedHash: 'a'.repeat(64),
              chunkCount: 0,
              stepCount: 2,
              verifiedPrefixBytes: 10,
              verifiedPrefixSha256: 'b'.repeat(64),
            }
          },
        },
      })
      try {
        await expect(
          adapter.rebuildNativeContext(
            {
              rebuildId: randomUUID(),
              sessionId: randomUUID(),
              cwd,
              model: null,
              effort: null,
              sourceHash: '1'.repeat(64),
              onNativeSessionCreated: async (id) => {
                createdIds.push(id)
              },
              reportNativeWork: (report) => {
                workReports.push(report)
              },
            },
            (async function* () {})(),
            new AbortController().signal,
          ),
        ).rejects.toThrow(/failed to close the zero-Turn session shell cleanly/iu)
        expect(createdIds).toEqual([allocatedSid])
        expect(writeSeedCalls).toBe(0)
        expect(workReports).toEqual([
          expect.objectContaining({
            nativeSessionId: allocatedSid,
            state: 'unknown',
          }),
        ])
      } finally {
        await adapter.dispose()
      }
    }

    // Part B: S1-#8 Fork unconfirmed close -> persists candidateSessionId via onCandidate and reports 'unknown'!
    {
      const { cwd, appDataDir } = await createEnv()
      const allocatedSid = `sid-fork-unconfirmed-${randomUUID()}`
      let writeForkCalls = 0
      const candidates: string[] = []
      const workReports: unknown[] = []
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(allocatedSid),
          })
        } else if (frame.method === 'session/close') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32_000, message: 'close rejected' },
          })
        }
      })
      const sourceBoundary: AgentNativeForkBoundary = {
        nativeSessionId: randomUUID(),
        nativeCutId: 'cut-1',
        nativeTurnId: 'exec-1',
        bindingGeneration: 1,
        throughSequence: 2,
        deliveryCursor: 0,
        prefixHash: 'a'.repeat(64),
        prefixBytes: 128,
        prefixRecords: 2,
      }
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => h.child,
        storageClient: {
          writeFork: async () => {
            writeForkCalls += 1
            throw new Error('should not write fork after unconfirmed close')
          },
        },
      })
      try {
        await expect(
          adapter.forkNativeContext(
            {
              operationId: randomUUID(),
              sessionId: randomUUID(),
              cwd,
              model: null,
              effort: null,
              permissionMode: 'ask',
              source: sourceBoundary,
              onDispatched: async () => undefined,
              onCandidate: async (id) => {
                candidates.push(id)
              },
              reportNativeWork: (report) => {
                workReports.push(report)
              },
            },
            new AbortController().signal,
          ),
        ).rejects.toThrow(/failed to close the zero-Turn session shell cleanly/iu)
        expect(candidates).toEqual([allocatedSid])
        expect(writeForkCalls).toBe(0)
        expect(workReports).toEqual([expect.objectContaining({ state: 'unknown' })])
      } finally {
        await adapter.dispose()
      }
    }

    // Part C: S1-#19 Cold session/load replay validation failure STILL calls session/close exactly once!
    for (const failMode of ['missing_chunks', 'forbidden_tool'] as const) {
      const { cwd, appDataDir } = await createEnv()
      const candidateSid = `sid-cold-replay-${failMode}`
      let closeCalls = 0
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/load') {
          if (failMode === 'forbidden_tool') {
            h.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: candidateSid,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'tc-live-bad',
                  name: 'run_command',
                  status: 'in_progress',
                },
              },
            })
          }
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(candidateSid),
          })
        } else if (frame.method === 'session/close') {
          closeCalls += 1
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        }
      })
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => h.child,
        storageClient: {
          writeRebuildSeed: async () => ({
            seedHash: 'a'.repeat(64),
            chunkCount: 1,
            stepCount: 2,
            verifiedPrefixBytes: 64,
            verifiedPrefixSha256: 'b'.repeat(64),
          }),
        },
      })
      try {
        await expect(
          adapter.rebuildNativeContext(
            {
              rebuildId: randomUUID(),
              sessionId: randomUUID(),
              nativeSessionId: candidateSid,
              cwd,
              model: null,
              effort: null,
              sourceHash: '2'.repeat(64),
            },
            (async function* () {})(),
            new AbortController().signal,
          ),
        ).rejects.toThrow(
          failMode === 'forbidden_tool'
            ? /unexpectedly emitted live tool execution updates/iu
            : /did not replay the expected user and assistant chunks/iu,
        )
        expect(closeCalls).toBe(1)
      } finally {
        await adapter.dispose()
      }
    }

    // Part D: S1-#20 Fresh-session 1.5s cleanup session/close completes promptly during sibling permission wait!
    {
      const { cwd, appDataDir } = await createEnv()
      const sid1 = 'sid-sibling-perm-holder'
      const sid2 = 'sid-fresh-cleanup-bounded'
      let permGateResolve: ((decision: string) => void) | undefined
      const permGate = new Promise<string>((r) => {
        permGateResolve = r
      })
      let permEnteredResolve: (() => void) | undefined
      const permEntered = new Promise<void>((r) => {
        permEnteredResolve = r
      })
      let newCount = 0
      let prompt1Id: unknown
      let close2Received = false
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          newCount += 1
          const sid = newCount === 1 ? sid1 : sid2
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(sid),
          })
        } else if (frame.method === 'session/set_mode') {
          const p = frame.params as { sessionId?: string }
          if (p.sessionId === sid2) {
            // Fail Run 2 BEFORE session/prompt so its finally block invokes 1.5s cleanup closeSession!
            h.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              error: { code: -32_000, message: 'reject sid2 mode' },
            })
            return
          }
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_config_option') {
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
        } else if (frame.method === 'session/prompt') {
          prompt1Id = frame.id
          h.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-sibling-hold',
            method: 'session/request_permission',
            params: {
              sessionId: sid1,
              toolCall: { toolCallId: 'tc-sib', name: 'run_command', args: { CommandLine: 'ls' } },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
        } else if (frame.method === 'session/close') {
          const p = frame.params as { sessionId?: string }
          if (p.sessionId === sid2) {
            close2Received = true
            // Intentionally NEVER reply to session/close for sid2!
          }
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        const run1Promise = collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              permissionMode: 'ask',
              host: {
                interactions: {
                  requestPermission: async () => {
                    permEnteredResolve?.()
                    const decision = await permGate
                    setTimeout(() => {
                      h.sendToClient({
                        jsonrpc: '2.0',
                        id: prompt1Id,
                        result: { stopReason: 'end_turn' },
                      })
                    }, 10)
                    return decision
                  },
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        await permEntered

        // While Run 1 holds connection-wide permissionWait, Run 2 fails pre-prompt and runs 1.5s cleanup close!
        const startedAt = performance.now()
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, { permissionMode: 'ask' }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(/reject sid2 mode|rejected permission mode/iu)
        const elapsedMs = performance.now() - startedAt
        expect(close2Received).toBe(true)
        expect(elapsedMs).toBeGreaterThanOrEqual(1_300)
        expect(elapsedMs).toBeLessThan(3_500)
        expect(adapter.hasUnconfirmedClosedSession(sid2)).toBe(true)

        // Release Run 1's sibling permission wait -> completes cleanly without interruption!
        permGateResolve?.('agy-allow-once')
        const run1Events = await run1Promise
        expect(run1Events.at(-1)).toMatchObject({ type: 'turn.completed', outcome: 'completed' })
      } finally {
        permGateResolve?.('agy-cancel')
        await adapter.dispose()
      }
    }
  })

  it('R2-W2 Check #8 (S1-#17): aligns initialize.instructions and systemAppend signatures with tools/list and real @pact/contracts schemas', async () => {
    const { cwd, appDataDir } = await createEnv()
    const pactSessionId = randomUUID()
    const runId = randomUUID()
    const grantId = randomUUID()
    let initInstructions = ''
    let newSystemAppend = ''
    let promptSystemAppend = ''
    let promptFirstBlock = ''
    let mcpName = ''
    const harness = createAcpHarness()

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        const meta = Reflect.get(frame.params as object, '_meta') as
          | { antigravity?: { systemPrompt?: { append?: string } } }
          | undefined
        newSystemAppend = meta?.antigravity?.systemPrompt?.append ?? ''
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        const mcpUrl = servers?.[0]?.url ?? ''
        mcpName = servers?.[0]?.name ?? ''
        const initRes = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        }).then((r) => r.json())) as { result?: { instructions?: string } }
        initInstructions = initRes.result?.instructions ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(randomUUID()),
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
        const meta = Reflect.get(frame.params as object, '_meta') as
          | { antigravity?: { systemPrompt?: { append?: string } } }
          | undefined
        promptSystemAppend = meta?.antigravity?.systemPrompt?.append ?? ''
        promptFirstBlock =
          (frame.params as { prompt?: Array<{ type?: string; text?: string }> }).prompt?.[0]
            ?.text ?? ''
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              requestSessionTitle: true,
              message: { id: randomUUID(), content: 'Verify tool usage signatures.' },
              comments: [],
              sourceGrant: { runId, grant: grantId },
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                sourceReader: legacySourceReader(() => ({
                  source: 'inputs',
                  offset: 0,
                  nextOffset: null,
                  text: 'source',
                })),
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      for (const surface of [initInstructions, promptSystemAppend]) {
        expect(surface).toContain(
          `mcp_${mcpName}_submit_review({ verdict: "accepted"|"changes_requested"|"needs_user"|"incomplete", questions?: [{ prompt: string, selection: "single"|"multiple", options?: [{ label: string, description?: string }] }] })`,
        )
        expect(surface).toContain(
          `mcp_${mcpName}_read_collaboration_source({ runId: uuid, grant: uuid, source: "document"|"batch"|"inputs"|"handoff_sources"|"cutoff", offset: integer`,
        )
        expect(surface).not.toContain('choices?')
        expect(surface).not.toContain('offset?,')
      }
      expect(initInstructions).not.toContain('sourceReference')
      expect(initInstructions).not.toContain('native-root-v1')
      expect(newSystemAppend).toBe(promptSystemAppend)
      expect(promptSystemAppend).toContain(initInstructions)
      expect(promptSystemAppend).toContain('Do NOT invoke run_command')
      expect(promptFirstBlock.startsWith('Pact host instructions for this turn:\n')).toBe(true)
      expect(promptFirstBlock).toContain('Do NOT invoke run_command')
      expect(promptFirstBlock).toContain(
        `mcp_${mcpName}_submit_review({ verdict: "accepted"|"changes_requested"|"needs_user"|"incomplete"`,
      )
      const trailingPromptJson = JSON.parse(
        promptFirstBlock.slice(promptFirstBlock.lastIndexOf('\n') + 1),
      ) as Record<string, unknown>
      expect(trailingPromptJson).toMatchObject({
        version: 'pact-agent-prompt-v1',
        sessionId: pactSessionId,
        pactRunId: runId,
      })

      // Validate representative payloads from each displayed signature against real @pact/contracts schemas!
      expect(
        collaborationReviewInputSchema.safeParse({
          verdict: 'needs_user',
          questions: [
            {
              prompt: 'Choose rollout mode',
              selection: 'single',
              options: [
                { label: 'Canary', description: 'Gradual traffic shift' },
                { label: 'Immediate' },
              ],
            },
          ],
        }).success,
      ).toBe(true)
      expect(collaborationReviewInputSchema.safeParse({ verdict: 'incomplete' }).success).toBe(true)
      // Old broken shape (`choices` instead of `selection`+`options`) MUST fail strict contract!
      expect(
        collaborationReviewInputSchema.safeParse({
          verdict: 'needs_user',
          questions: [{ prompt: 'Old shape', choices: ['A', 'B'] }],
        }).success,
      ).toBe(false)

      expect(
        collaborationInputResultSchema.safeParse({
          outcome: 'needs_user',
          questions: [
            {
              prompt: 'Select targets',
              selection: 'multiple',
              options: [{ label: 'Desktop' }, { label: 'CLI' }],
            },
          ],
        }).success,
      ).toBe(true)
      expect(collaborationInputResultSchema.safeParse({ outcome: 'processed' }).success).toBe(true)

      expect(
        codexCollaborationSourceWireReadSchema.safeParse({
          sourceReference: 'ref-plan-v1',
          offset: 0,
        }).success,
      ).toBe(true)
      expect(
        codexCollaborationSourceWireReadSchema.safeParse({
          runId,
          grant: grantId,
          source: 'inputs',
          offset: 0,
        }).success,
      ).toBe(true)
      // Omitting required `offset` MUST fail strict schema!
      expect(
        codexCollaborationSourceWireReadSchema.safeParse({ sourceReference: 'ref-plan-v1' })
          .success,
      ).toBe(false)

      expect(sessionTitleInputSchema.safeParse({ title: 'Aligned Contract Title' }).success).toBe(
        true,
      )
      expect(
        peerRequestToolInputSchema.safeParse({ target: 'codex', kind: 'review', reason: 'Check' })
          .success,
      ).toBe(true)
      expect(collaborationPlanRetentionInputSchema.safeParse({}).success).toBe(true)
      expect(
        collaborationPublishPlanInputSchema.safeParse({
          text: '# Plan',
          offset: 0,
          complete: true,
        }).success,
      ).toBe(true)
    } finally {
      await adapter.dispose()
    }
  })

  it('delivers collaboration and read-only rules via session/load _meta and workflow promptBlocks[0] while preserving trailing pactRunId JSON on code_review', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const pactSessionId = randomUUID()
    const runId = randomUUID()
    const grantId = randomUUID()
    let loadSystemAppend = ''
    let promptSystemAppend = ''
    let promptFirstBlock = ''
    let mcpName = ''
    const harness = createAcpHarness()

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/load') {
        const meta = Reflect.get(frame.params as object, '_meta') as
          | { antigravity?: { systemPrompt?: { append?: string } } }
          | undefined
        loadSystemAppend = meta?.antigravity?.systemPrompt?.append ?? ''
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpName = servers?.[0]?.name ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
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
        const meta = Reflect.get(frame.params as object, '_meta') as
          | { antigravity?: { systemPrompt?: { append?: string } } }
          | undefined
        promptSystemAppend = meta?.antigravity?.systemPrompt?.append ?? ''
        promptFirstBlock =
          (frame.params as { prompt?: Array<{ type?: string; text?: string }> }).prompt?.[0]
            ?.text ?? ''
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'code_review')
    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: { readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }) },
    })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            nativeSessionId,
            sessionId: pactSessionId,
            runId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: randomUUID(), content: 'Review the latest code changes.' },
              comments: [],
              sourceGrant: { runId, grant: grantId },
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                sourceReader: legacySourceReader(() => ({
                  source: 'inputs',
                  offset: 0,
                  nextOffset: null,
                  text: 'source',
                })),
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      expect(loadSystemAppend).toBe(promptSystemAppend)
      expect(loadSystemAppend).toContain('Do NOT invoke run_command')
      expect(loadSystemAppend).toContain(
        `mcp_${mcpName}_submit_review({ verdict: "accepted"|"changes_requested"|"needs_user"|"incomplete"`,
      )
      expect(promptFirstBlock.startsWith('Pact host instructions for this turn:\n')).toBe(true)
      expect(promptFirstBlock).toContain('Do NOT invoke run_command')
      expect(promptFirstBlock).toContain(
        `mcp_${mcpName}_submit_review({ verdict: "accepted"|"changes_requested"|"needs_user"|"incomplete"`,
      )
      const trailingPromptJson = JSON.parse(
        promptFirstBlock.slice(promptFirstBlock.lastIndexOf('\n') + 1),
      ) as Record<string, unknown>
      expect(trailingPromptJson).toMatchObject({
        version: 'pact-agent-prompt-v1',
        sessionId: pactSessionId,
        pactRunId: runId,
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('R3-Check #1 (S1-#1): batches single-frame root proof + competing token ownership before waking waiters and invalidates both sides of heldByAnother', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const trueTrajectoryId = randomUUID()
    const pactSessionId = randomUUID()
    const runId = randomUUID()
    const grantId = randomUUID()
    const sourceArgs = { runId, grant: grantId, source: 'inputs', offset: 0 }
    const otherSourceArgs = { runId, grant: grantId, source: 'batch', offset: 0 }
    let mcpUrl = ''
    let mcpName = ''
    let sourceReaderCalls = 0
    let singleFrameErr: unknown
    let singleFrameText = ''
    let heldByAnotherErr: unknown
    const harness = createAcpHarness()

    const callHttp = async (id: number, name: string, args: unknown, progressToken: string) => {
      const resp = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: {
              'antigravity.google/root_conversation_id': nativeSessionId,
              'antigravity.google/conversation_id': nativeSessionId,
              progressToken,
            },
          },
        }),
      })
      return (await resp.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> }
      }
    }

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpUrl = servers?.[0]?.url ?? ''
        mcpName = servers?.[0]?.name ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        // 1. Open one tokenless source call BEFORE root trajectory proof is pinned (storageClient returns no_storage_root).
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-open-tokenless',
              name: `mcp_${mcpName}_read_collaboration_source`,
              status: 'in_progress',
              args: sourceArgs,
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        // 2. Park an HTTP source read waiting for root trajectory proof with token T = trueTrajectoryId:10.
        const waitingSrc = callHttp(
          1,
          'read_collaboration_source',
          sourceArgs,
          `${trueTrajectoryId}:10`,
        )
        await new Promise((r) => setTimeout(r, 15))
        // 3. Single ACP frame BOTH supplies trajectoryId (via structured progressToken) AND assigns that
        //    exact token to a DIFFERENT competing call (`tc-competing` with different args)!
        //    Waiter MUST NOT wake before `tc-competing` is registered, so it MUST NOT steal `tc-open-tokenless`!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-competing',
              name: `mcp_${mcpName}_read_collaboration_source`,
              status: 'in_progress',
              args: otherSourceArgs,
              progressToken: `${trueTrajectoryId}:10`,
            },
          },
        })
        const singleResp = await waitingSrc
        singleFrameErr = singleResp.result.isError
        singleFrameText = singleResp.result.content[0]?.text ?? ''

        // 4. Bidirectional heldByAnother invalidation:
        //    Park an HTTP call with token T2 = trueTrajectoryId:11 while `tc-open-tokenless` is open;
        //    send two frames in the SAME stdout chunk: first `tc-holder` claims T2 via allow_once (waking & committing HTTP
        //    on `tc-holder`), then `tc-rivals` claims the SAME token T2 (heldByAnother!) -> MUST retire BOTH `tc-holder`
        //    and `tc-rivals` and invalidate T2 so revalidateLiveClaim rejects!
        const rivalSrc = callHttp(
          2,
          'read_collaboration_source',
          otherSourceArgs,
          `${trueTrajectoryId}:11`,
        )
        await new Promise((r) => setTimeout(r, 15))
        harness.sendRawStdout(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 'perm-holder-t2',
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: {
                toolCallId: 'tc-holder-t2',
                name: `mcp_${mcpName}_read_collaboration_source`,
                args: otherSourceArgs,
                progressToken: `${trueTrajectoryId}:11`,
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })}\n${JSON.stringify({
            jsonrpc: '2.0',
            id: 'perm-rival-t2',
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: {
                toolCallId: 'tc-rival-t2',
                name: `mcp_${mcpName}_read_collaboration_source`,
                args: otherSourceArgs,
                progressToken: `${trueTrajectoryId}:11`,
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })}\n`,
        )
        heldByAnotherErr = (await rivalSrc).result.isError

        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: {
        readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }),
      },
    })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: randomUUID(), content: 'R3 S1-#1 single-frame wake order.' },
              comments: [],
              sourceGrant: { runId, grant: grantId },
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                sourceReader: legacySourceReader(() => {
                  sourceReaderCalls += 1
                  return { source: 'inputs', offset: 0, nextOffset: null, text: 'Must never read!' }
                }),
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      expect(singleFrameErr).toBe(true)
      expect(singleFrameText).toMatch(/conflict|does not match/iu)
      expect(heldByAnotherErr).toBe(true)
      expect(sourceReaderCalls).toBe(0)
    } finally {
      await adapter.dispose()
    }
  })

  it('R3-Check #2 (S1-#2, S1-#3): retires capacity-denied IDs & denied/Full-access tokens, enforces UTF-8 ID limit, and blocks evicted duplicate terminal promotion', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const trueTrajectoryId = randomUUID()
    const pactSessionId = randomUUID()
    const runId = randomUUID()
    const grantId = randomUUID()
    const sourceArgs = { runId, grant: grantId, source: 'inputs', offset: 0 }
    let mcpUrl = ''
    let mcpName = ''
    let sourceReaderCalls = 0
    const recordedReviews: unknown[] = []
    let deniedTokenReuseErr: unknown
    let capacityDeniedReopenErr: unknown
    let prov1Err: unknown
    const multibyteOversizedId = '😀'.repeat(300) // length = 600 <= 1024, UTF-8 bytes = 1200 > 1024
    expect(multibyteOversizedId.length).toBeLessThanOrEqual(1024)
    expect(Buffer.byteLength(multibyteOversizedId, 'utf8')).toBeGreaterThan(1024)
    const harness = createAcpHarness()

    const callHttp = async (id: number, name: string, args: unknown, progressToken: string) => {
      const resp = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: {
              'antigravity.google/root_conversation_id': nativeSessionId,
              'antigravity.google/conversation_id': nativeSessionId,
              progressToken,
            },
          },
        }),
      })
      return (await resp.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> }
      }
    }

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpUrl = servers?.[0]?.url ?? ''
        mcpName = servers?.[0]?.name ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        // Pin ACP trajectory via a benign update (trajectoryIdSource === 'acp').
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              trajectoryId: trueTrajectoryId,
              content: { type: 'text', text: 'Pinning trajectory.' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))

        // 1. S1-#2a: Multibyte ID (length 300 <= 1024 chars, UTF-8 1200 > 1024 bytes) CANNOT promote provisional outcome!
        const prov1 = await callHttp(
          1,
          'submit_review',
          { verdict: 'accepted' },
          `${trueTrajectoryId}:20`,
        )
        prov1Err = prov1.result.isError
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: multibyteOversizedId,
              name: `mcp_${mcpName}_submit_review`,
              status: 'completed',
              args: { verdict: 'accepted' },
              progressToken: `${trueTrajectoryId}:20`,
            },
          },
        })

        // 2. S1-#2b: Duplicate terminal-only ID re-entering AFTER 64-entry projection cache eviction
        //    CANNOT promote a provisional outcome!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-dup-term-evict',
              name: `mcp_${mcpName}_submit_review`,
              status: 'completed',
            },
          },
        })
        for (let i = 0; i < 66; i += 1) {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: `tc-proj-fill-${i}`,
                name: 'read_file',
                status: 'completed',
              },
            },
          })
        }
        await new Promise((r) => setTimeout(r, 20))
        // Now re-send `tc-dup-term-evict` carrying the staged provisional token -> MUST NOT promote!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-dup-term-evict',
              name: `mcp_${mcpName}_submit_review`,
              status: 'completed',
              args: { verdict: 'accepted' },
              progressToken: `${trueTrajectoryId}:20`,
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))

        // 3. S1-#3a: Permission refusal retires BOTH toolCallId AND progressToken (token cannot authorize another open tokenless call!).
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-tokenless-other',
              name: `mcp_${mcpName}_read_collaboration_source`,
              status: 'in_progress',
              args: sourceArgs,
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-refuse-both',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: {
              toolCallId: 'tc-refused-with-pt',
              name: `mcp_${mcpName}_read_collaboration_source`,
              args: sourceArgs,
              progressToken: `${trueTrajectoryId}:21`,
            },
            options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
          },
        })
        await waitUntilCondition(() => harness.responses.some((r) => r.id === 'perm-refuse-both'))
        deniedTokenReuseErr = (
          await callHttp(2, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:21`)
        ).result.isError

        // 4. S1-#3b: 256-slot capacity-denied ID stays retired AFTER a slot frees!
        // Fill remaining open slots up to 256 via permission requests (without bloating 64-entry projection map).
        for (let i = 0; i < 256; i += 1) {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: `perm-fill-open-${i}`,
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: {
                toolCallId: `tc-open-slot-${i}`,
                name: `mcp_${mcpName}_submit_review`,
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
          if ((i + 1) % 16 === 0 || i === 255) {
            const lastId = `perm-fill-open-${i}`
            await waitUntilCondition(() => harness.responses.some((r) => r.id === lastId))
          }
        }
        // 257th call MUST be denied due to 256-slot saturation AND tombstoned!
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-cap-denied',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: {
              toolCallId: 'tc-cap-denied-target',
              name: `mcp_${mcpName}_read_collaboration_source`,
              args: sourceArgs,
              progressToken: `${trueTrajectoryId}:22`,
            },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        })
        await waitUntilCondition(() => harness.responses.some((r) => r.id === 'perm-cap-denied'))
        // Free one open slot (`tc-open-slot-0` -> completed).
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-open-slot-0',
              name: `mcp_${mcpName}_submit_review`,
              status: 'completed',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        // Now attempt to reopen `tc-cap-denied-target` with a fresh explicit token -> MUST stay retired!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-cap-denied-target',
              name: `mcp_${mcpName}_read_collaboration_source`,
              status: 'in_progress',
              args: sourceArgs,
              progressToken: `${trueTrajectoryId}:23`,
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        capacityDeniedReopenErr = (
          await callHttp(3, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:23`)
        ).result.isError

        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: {
        readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }),
      },
    })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: randomUUID(), content: 'R3 S1-#2 & S1-#3 invariants.' },
              comments: [],
              sourceGrant: { runId, grant: grantId },
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                sourceReader: legacySourceReader(() => {
                  sourceReaderCalls += 1
                  return { source: 'inputs', offset: 0, nextOffset: null, text: 'Forbidden!' }
                }),
                recordReview: (obs) => recordedReviews.push(obs),
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      expect(prov1Err).not.toBe(true)
      expect(recordedReviews).toEqual([])
      expect(deniedTokenReuseErr).toBe(true)
      expect(harness.responses.find((r) => r.id === 'perm-cap-denied')?.result).toMatchObject({
        outcome: { optionId: 'deny' },
      })
      expect(capacityDeniedReopenErr).toBe(true)
      expect(sourceReaderCalls).toBe(0)
    } finally {
      await adapter.dispose()
    }

    // Subcase (S1-#3c): Full-access refusal records revocation of BOTH toolCallId and progressToken!
    {
      const { cwd: cwdFull, appDataDir: appDataDirFull } = await createEnv()
      const sidFull = randomUUID()
      const trajFull = randomUUID()
      await createDbFixture(appDataDirFull, sidFull, trajFull, 1)
      const fullRunId = randomUUID()
      const fullGrantId = randomUUID()
      const fullSrcArgs = { runId: fullRunId, grant: fullGrantId, source: 'inputs', offset: 0 }
      let fullMcpUrl = ''
      let fullMcpName = ''
      let fullSrcCalls = 0
      let fullReopenErr: unknown
      const hFull = createAcpHarness()
      hFull.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          hFull.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          fullMcpUrl = servers?.[0]?.url ?? ''
          fullMcpName = servers?.[0]?.name ?? ''
          hFull.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(sidFull),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
          hFull.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'gemini-4-carbon' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
        } else if (frame.method === 'session/prompt') {
          hFull.sendToClient({
            jsonrpc: '2.0',
            id: 'perm-full-refuse',
            method: 'session/request_permission',
            params: {
              sessionId: sidFull,
              toolCall: {
                toolCallId: 'tc-full-refused',
                name: `mcp_${fullMcpName}_read_collaboration_source`,
                args: fullSrcArgs,
                progressToken: `${trajFull}:5`,
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
          await waitUntilCondition(() => hFull.responses.some((r) => r.id === 'perm-full-refuse'))
          // Subsequent explicit update for the Full-access refused ID MUST stay retired!
          hFull.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sidFull,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-full-refused',
                name: `mcp_${fullMcpName}_read_collaboration_source`,
                status: 'in_progress',
                args: fullSrcArgs,
                progressToken: `${trajFull}:6`,
              },
            },
          })
          await new Promise((r) => setTimeout(r, 15))
          const resp = await fetch(fullMcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'read_collaboration_source',
                arguments: fullSrcArgs,
                _meta: {
                  'antigravity.google/root_conversation_id': sidFull,
                  'antigravity.google/conversation_id': sidFull,
                  progressToken: `${trajFull}:6`,
                },
              },
            }),
          })
          fullReopenErr = ((await resp.json()) as { result: { isError?: boolean } }).result.isError
          hFull.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })
      const adapterFull = new AgyAgentAdapter({
        appDataDir: appDataDirFull,
        processFactory: () => hFull.child,
      })
      try {
        await collectEvents(
          adapterFull.run(
            makeBaseRunInput(cwdFull, {
              runId: fullRunId,
              nativeSessionId: sidFull,
              permissionMode: 'full',
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: randomUUID(),
                message: { id: randomUUID(), content: 'Full-access refusal revokes ID.' },
                comments: [],
                sourceGrant: { runId: fullRunId, grant: fullGrantId },
              },
              host: {
                workflow: {
                  sourceReader: legacySourceReader(() => {
                    fullSrcCalls += 1
                    return { source: 'inputs', offset: 0, nextOffset: null, text: 'Forbidden!' }
                  }),
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(hFull.responses.find((r) => r.id === 'perm-full-refuse')?.result).toMatchObject({
          outcome: { optionId: 'deny' },
        })
        expect(fullReopenErr).toBe(true)
        expect(fullSrcCalls).toBe(0)
      } finally {
        await adapterFull.dispose()
      }
    }
  })

  it('R3-Check #3 (S1-#4, S1-#10, S1-#11, S1-#12): revokes tool-name changes, denies invalid/conflicting permissions, cleans refused provisional duplicates, and immediately rejects non-MCP tokens before root proof', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const trueTrajectoryId = randomUUID()
    const pactSessionId = randomUUID()
    const runId = randomUUID()
    const grantId = randomUUID()
    const sourceArgs = { runId, grant: grantId, source: 'inputs', offset: 0 }
    let mcpUrl = ''
    let mcpName = ''
    let sourceReaderCalls = 0
    let nonMcpWaitElapsedMs = 999
    let nonMcpWaitErr: unknown
    let toolChangeToNonPactErr: unknown
    let toolChangeToOtherPactErr: unknown
    let provPeerErr: unknown
    let title1Err: unknown
    let dupTitleErr: unknown
    const harness = createAcpHarness()

    const callHttp = async (id: number, name: string, args: unknown, progressToken: string) => {
      const resp = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: {
              'antigravity.google/root_conversation_id': nativeSessionId,
              'antigravity.google/conversation_id': nativeSessionId,
              progressToken,
            },
          },
        }),
      })
      return (await resp.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> }
      }
    }

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpUrl = servers?.[0]?.url ?? ''
        mcpName = servers?.[0]?.name ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        // 1. S1-#12: Non-MCP token observed while root trajectory proof is STILL missing -> rejects immediately (< 80ms, not 150ms)!
        const startedAt = performance.now()
        const nonMcpPromise = callHttp(
          1,
          'read_collaboration_source',
          sourceArgs,
          `${trueTrajectoryId}:1`,
        )
        await new Promise((r) => setTimeout(r, 10))
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-non-mcp-fast-reject',
              name: 'read_file',
              status: 'in_progress',
              progressToken: `${trueTrajectoryId}:1`,
            },
          },
        })
        const nonMcpResp = await nonMcpPromise
        nonMcpWaitElapsedMs = performance.now() - startedAt
        nonMcpWaitErr = nonMcpResp.result.isError

        // 2. S1-#10a: Permission request with missing or non-string toolCallId MUST be denied (never allow_once)!
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-missing-id',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: {
              name: `mcp_${mcpName}_read_collaboration_source`,
              args: sourceArgs,
            },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-numeric-id',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: {
              toolCallId: 99_999,
              name: `mcp_${mcpName}_read_collaboration_source`,
              args: sourceArgs,
            },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        })
        await waitUntilCondition(
          () =>
            harness.responses.some((r) => r.id === 'perm-missing-id') &&
            harness.responses.some((r) => r.id === 'perm-numeric-id'),
        )

        // Pin ACP trajectory so remaining sub-checks can operate.
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              trajectoryId: trueTrajectoryId,
              content: { type: 'text', text: 'Trajectory pinned.' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))

        // 3. S1-#4a: Registered `read_collaboration_source` call switches to non-Pact `read_file` WITHOUT a token -> revoked!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-switch-non-pact',
              name: `mcp_${mcpName}_read_collaboration_source`,
              status: 'in_progress',
              args: sourceArgs,
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-switch-non-pact',
              name: 'read_file',
              status: 'completed',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        toolChangeToNonPactErr = (
          await callHttp(2, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:2`)
        ).result.isError

        // 4. S1-#4b: Registered `read_collaboration_source` switches to another Pact tool (`publish_session_title`) -> revoked!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-switch-other-pact',
              name: `mcp_${mcpName}_read_collaboration_source`,
              status: 'in_progress',
              args: sourceArgs,
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-switch-other-pact',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'in_progress',
              args: { title: 'Spoofed' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        toolChangeToOtherPactErr = (
          await callHttp(3, 'read_collaboration_source', sourceArgs, `${trueTrajectoryId}:3`)
        ).result.isError

        // 5. S1-#10b: Provisional migration conflict on permission request propagates denial instead of allow_once!
        const provPeer = await callHttp(
          4,
          'request_peer_assistance',
          { target: 'codex', kind: 'review' },
          `${trueTrajectoryId}:4`,
        )
        provPeerErr = provPeer.result.isError
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-mig-conflict',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: {
              toolCallId: 'tc-mig-conflict',
              name: `mcp_${mcpName}_publish_session_title`,
              args: { title: 'Wrong tool for token :4' },
              progressToken: `${trueTrajectoryId}:4`,
            },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        })
        await waitUntilCondition(() => harness.responses.some((r) => r.id === 'perm-mig-conflict'))

        // 6. S1-#11: First provisional title stages; second identical title is refused by quota and MUST clean up
        //    its provisional fingerprint so a later tokenless ACP update migrates & promotes the valid first title!
        const title1 = await callHttp(
          5,
          'publish_session_title',
          { title: 'Valid First Title' },
          `${trueTrajectoryId}:5`,
        )
        title1Err = title1.result.isError
        const title2 = await callHttp(
          6,
          'publish_session_title',
          { title: 'Valid First Title' },
          `${trueTrajectoryId}:6`,
        )
        dupTitleErr = title2.result.isError
        // Tokenless ACP `in_progress` + `completed` for `Valid First Title` MUST match only title1 and promote it!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-title-tokenless',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'in_progress',
              args: { title: 'Valid First Title' },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-title-tokenless',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'completed',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))

        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: {
        readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }),
      },
    })
    try {
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: randomUUID(), content: 'R3 S1-#4, #10, #11, #12 checks.' },
              comments: [],
              requestSessionTitle: true,
              sourceGrant: { runId, grant: grantId },
            },
            host: {
              workflow: {
                sourceReader: legacySourceReader(() => {
                  sourceReaderCalls += 1
                  return { source: 'inputs', offset: 0, nextOffset: null, text: 'Forbidden!' }
                }),
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      expect(nonMcpWaitErr).toBe(true)
      expect(nonMcpWaitElapsedMs).toBeLessThan(120)
      expect(harness.responses.find((r) => r.id === 'perm-missing-id')?.result).toMatchObject({
        outcome: { optionId: 'deny' },
      })
      expect(harness.responses.find((r) => r.id === 'perm-numeric-id')?.result).toMatchObject({
        outcome: { optionId: 'deny' },
      })
      expect(harness.responses.find((r) => r.id === 'perm-mig-conflict')?.result).toMatchObject({
        outcome: { optionId: 'deny' },
      })
      expect(toolChangeToNonPactErr).toBe(true)
      expect(toolChangeToOtherPactErr).toBe(true)
      expect(provPeerErr).not.toBe(true)
      expect(title1Err).not.toBe(true)
      expect(sourceReaderCalls).toBe(0)
      expect(dupTitleErr).toBe(true)
      expect(events).toContainEqual({
        agentId: 'agy',
        type: 'session.title.updated',
        title: 'Valid First Title',
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('R3-Check #4 (S1-#5, S1-#6): excludes model-less async options during set_config_option(model) switch and lets latest attributable effort mismatch clear an earlier match', async () => {
    // Subcase A (S1-#5): Switching model via `session/set_config_option('model', ...)` with empty RPC reply
    // + model-less async `config_option_update` carrying prior model's `thought_level: 'low'` MUST exclude it
    // from both match and fallback paths (so adapter DOES call `set_config_option('thought_level', 'low')`,
    // and when no effort is requested, does NOT fabricate `recordedSettings`!).
    {
      const { cwd, appDataDir } = await createEnv()
      const sid = randomUUID()
      const configCalls: Array<{ configId: string; value: string }> = []
      const recordedSettings: unknown[] = []
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              sessionId: sid,
              configOptions: [
                {
                  id: 'model',
                  currentValue: 'model-a',
                  options: [{ value: 'model-a' }, { value: 'model-b' }],
                },
                {
                  id: 'thought_level',
                  currentValue: 'low',
                  options: [{ value: 'low' }, { value: 'high' }],
                },
              ],
            },
          })
        } else if (frame.method === 'session/set_mode') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_config_option') {
          const p = frame.params as { configId: string; value: string }
          configCalls.push({ configId: p.configId, value: p.value })
          // Send a model-less async notification with prior model's `thought_level: 'low'`, then empty RPC reply `{}`!
          h.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'config_option_update',
                configOptions: [{ id: 'thought_level', currentValue: 'low' }],
              },
            },
          })
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/prompt') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              model: 'model-b',
              effort: null,
              host: {
                recovery: {
                  inputSha256: 'a'.repeat(64),
                  recordEffectiveSettings: (settings) => recordedSettings.push(settings),
                  recordConfirmedUnsent: () => undefined,
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(configCalls).toEqual([{ configId: 'model', value: 'model-b' }])
        // Because the model-less notification was excluded, model-b's effort is unknown -> ZERO fabricated recovery receipts!
        expect(recordedSettings).toEqual([])
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase B (S1-#6): Two attributable notifications for the target model (`high` then `low`) before an
    // empty `session/set_config_option('thought_level', 'high')` ack -> latest mismatch (`low`) clears earlier match!
    {
      const { cwd, appDataDir } = await createEnv()
      const sid = randomUUID()
      let promptSent = false
      const recordedSettings: unknown[] = []
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              sessionId: sid,
              configOptions: [
                {
                  id: 'model',
                  currentValue: 'model-b',
                  options: [{ value: 'model-b' }],
                },
                {
                  id: 'thought_level',
                  currentValue: 'low',
                  options: [{ value: 'low' }, { value: 'high' }],
                },
              ],
            },
          })
        } else if (frame.method === 'session/set_mode') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_config_option') {
          // Emit matching `high`, then immediately supersede it with `low` on the SAME target model, then empty `{}` ack!
          h.sendRawStdout(
            `${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'config_option_update',
                  configOptions: [
                    { id: 'model', currentValue: 'model-b' },
                    { id: 'thought_level', currentValue: 'high' },
                  ],
                },
              },
            })}\n${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'config_option_update',
                  configOptions: [
                    { id: 'model', currentValue: 'model-b' },
                    { id: 'thought_level', currentValue: 'low' },
                  ],
                },
              },
            })}\n${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })}\n`,
          )
        } else if (frame.method === 'session/close') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/prompt') {
          promptSent = true
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, {
                model: 'model-b',
                effort: 'high',
                host: {
                  recovery: {
                    inputSha256: 'b'.repeat(64),
                    recordEffectiveSettings: (settings) => recordedSettings.push(settings),
                    recordConfirmedUnsent: () => undefined,
                  },
                },
              }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(/silently substituted thought_level="low"/iu)
        expect(promptSent).toBe(false)
        expect(recordedSettings).toEqual([])
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('R3-Check #5 (S1-#7, S1-#13): reports unknown when Fork/Rebuild session/new drops after transport dispatch vs settled on positive non-delivery, and closes shell when candidate persistence throws', async () => {
    // Subcase A (S1-#7): Rebuild & Fork `session/new` enters transport then connection crashes/aborts with NO reply -> MUST report 'unknown'!
    for (const opKind of ['rebuild', 'fork'] as const) {
      const { cwd, appDataDir } = await createEnv()
      const workReports: Array<{ state: string; nativeSessionId?: string }> = []
      const abort = new AbortController()
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          // Frame was physically delivered to native process (`onDispatch` fired), now abort before reply arrives!
          abort.abort()
        }
      })
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => h.child,
        storageClient: {
          writeRebuildSeed: async () => {
            throw new Error('Should not reach writeRebuildSeed')
          },
          writeFork: async () => {
            throw new Error('Should not reach writeFork')
          },
        },
      })
      try {
        const opPromise =
          opKind === 'rebuild'
            ? adapter.rebuildNativeContext(
                {
                  sessionId: randomUUID(),
                  rebuildId: randomUUID(),
                  cwd,
                  model: null,
                  effort: null,
                  permissionMode: 'ask',
                  onNativeCreationDispatched: async () => undefined,
                  reportNativeWork: (r) => workReports.push(r),
                },
                (async function* () {
                  // empty
                })(),
                abort.signal,
              )
            : adapter.forkNativeContext(
                {
                  operationId: randomUUID(),
                  sessionId: randomUUID(),
                  cwd,
                  model: null,
                  effort: null,
                  permissionMode: 'ask',
                  source: {
                    nativeSessionId: randomUUID(),
                    nativeCutId: 'cut-r3-a',
                    nativeTurnId: 'exec-r3-a',
                    bindingGeneration: 1,
                    throughSequence: 2,
                    deliveryCursor: 0,
                    prefixHash: 'a'.repeat(64),
                    prefixBytes: 128,
                    prefixRecords: 1,
                  },
                  onDispatched: async () => undefined,
                  onCandidate: async () => undefined,
                  reportNativeWork: (r) => workReports.push(r),
                },
                abort.signal,
              )
        await expect(opPromise).rejects.toThrow(
          /abort|cancel|closed|shutting down|interrupted|failed/iu,
        )
        expect(workReports).toHaveLength(1)
        expect(workReports[0]?.state).toBe('unknown')
        expect(workReports[0]?.nativeSessionId).toBeUndefined()
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase B (S1-#7 positive non-delivery): Native server positively rejects `session/new` with JSON-RPC error -> 'settled'!
    {
      const { cwd, appDataDir } = await createEnv()
      const workReports: Array<{ state: string }> = []
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32_602, message: 'rejected session/new' },
          })
        }
      })
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => h.child,
        storageClient: {
          writeRebuildSeed: async () => {
            throw new Error('Should not reach writeRebuildSeed')
          },
        },
      })
      try {
        await expect(
          adapter.rebuildNativeContext(
            {
              sessionId: randomUUID(),
              rebuildId: randomUUID(),
              cwd,
              model: null,
              effort: null,
              permissionMode: 'ask',
              onNativeCreationDispatched: async () => undefined,
              reportNativeWork: (r) => workReports.push(r),
            },
            (async function* () {
              // empty
            })(),
            new AbortController().signal,
          ),
        ).rejects.toThrow(/rejected session\/new|failed to allocate|rejected/iu)
        expect(workReports).toHaveLength(1)
        expect(workReports[0]?.state).toBe('settled')
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase C (S1-#13): `onCandidate` (Fork) throws after `session/new` yields valid ID -> adapter STILL runs
    // one bounded `session/close` attempt AND preserves the original callback exception!
    {
      const { cwd, appDataDir } = await createEnv()
      const allocatedSid = `sid-fork-cb-throw-${randomUUID()}`
      const closedIds: string[] = []
      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(allocatedSid),
          })
        } else if (frame.method === 'session/close') {
          closedIds.push(String((frame.params as { sessionId?: string }).sessionId))
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        }
      })
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => h.child,
        storageClient: {
          writeFork: async () => {
            throw new Error('Should not reach writeFork')
          },
        },
      })
      try {
        await expect(
          adapter.forkNativeContext(
            {
              operationId: randomUUID(),
              sessionId: randomUUID(),
              cwd,
              model: null,
              effort: null,
              permissionMode: 'ask',
              source: {
                nativeSessionId: randomUUID(),
                nativeCutId: 'cut-r3-c',
                nativeTurnId: 'exec-r3-c',
                bindingGeneration: 1,
                throughSequence: 2,
                deliveryCursor: 0,
                prefixHash: 'b'.repeat(64),
                prefixBytes: 128,
                prefixRecords: 1,
              },
              onDispatched: async () => undefined,
              onCandidate: async () => {
                throw new Error('candidate persistence owner superseded')
              },
              reportNativeWork: () => undefined,
            },
            new AbortController().signal,
          ),
        ).rejects.toThrow('candidate persistence owner superseded')
        expect(closedIds).toEqual([allocatedSid])
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('R3-Check #6 (S1-#8, S1-#9, S1-#14): refuses final plan chunk when conversion memory is exhausted, propagates post-ack publication failure, bounds out-of-order long call IDs, and budgets foreground dedup keys', async () => {
    // Subcase A (S1-#8): Exhaust shared working memory leaving room for buffer (< 3x conversion workspace) ->
    // HTTP `publish_plan({ complete: true })` MUST reject instead of falsely acknowledging!
    {
      const { cwd, appDataDir } = await createEnv()
      const sid = randomUUID()
      const traj = randomUUID()
      await createDbFixture(appDataDir, sid, traj, 1)
      const sessionId = randomUUID()
      const runId = randomUUID()
      const { task, authorization } = makeCollaborationTask(
        sessionId,
        runId,
        'collaborate',
        'build',
      )
      let mcpUrl = ''
      let mcpName = ''
      let finalChunkHttpResult: { isError?: boolean; content: Array<{ text: string }> } | undefined
      const h = createAcpHarness()
      const pressureReservations: Array<ReturnType<NativeWorkingMemory['reserve']>> = []

      h.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/load') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(sid),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          const planText = `# Heavy Plan\n${'X'.repeat(40 * 1024)}`
          const args = { text: planText, offset: 0, complete: true }
          h.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-plan-oom',
                name: `mcp_${mcpName}_publish_plan`,
                status: 'in_progress',
                args,
                progressToken: `${traj}:10`,
              },
            },
          })
          await new Promise((r) => setTimeout(r, 15))
          // Fill shared working memory leaving only ~80 KiB free (enough for 40 KiB UTF-8 buffer, NOT enough for
          // 40 KiB buffer + 120 KiB conversion workspace = 160 KiB!).
          const used = nativeWorkingMemoryDiagnostics().chargedBytes ?? 0
          let remainingToClaim = Math.max(0, NATIVE_APP_WORKING_BYTES - used - 80 * 1024)
          while (remainingToClaim > 0) {
            const slice = Math.min(remainingToClaim, NATIVE_OWNER_WORKING_BYTES)
            pressureReservations.push(new NativeWorkingMemory().reserve(slice))
            remainingToClaim -= slice
          }
          const resp = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'publish_plan',
                arguments: args,
                _meta: {
                  'antigravity.google/root_conversation_id': sid,
                  'antigravity.google/conversation_id': sid,
                  progressToken: `${traj}:10`,
                },
              },
            }),
          })
          finalChunkHttpResult = (
            (await resp.json()) as {
              result: { isError?: boolean; content: Array<{ text: string }> }
            }
          ).result
          for (const res of pressureReservations) res.release()
          pressureReservations.length = 0
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId,
              runId,
              nativeSessionId: sid,
              permissionMode: 'auto',
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId,
                message: { id: randomUUID(), content: 'Refuse final chunk under memory pressure.' },
                comments: [],
                collaboration: task,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  recordOpenPlanFinalIntent: () => true,
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(finalChunkHttpResult?.isError).toBe(true)
        expect(finalChunkHttpResult?.content[0]?.text).toMatch(/memory budget exceeded/iu)
      } finally {
        for (const res of pressureReservations) res.release()
        await adapter.dispose()
      }
    }

    // Subcase B (S1-#14 & S1-#9): Out-of-order provisional plan chunks (chunk 1 complete confirmed with 1024B ID
    // before chunk 0 confirms) + oversized >512-char foreground messageId excluded from dedup reservation while
    // valid dedup keys charge and release cleanly with the background observer!
    {
      const { cwd, appDataDir } = await createEnv()
      const sid = randomUUID()
      const traj = randomUUID()
      const sessionId = randomUUID()
      const runId = randomUUID()
      const { task, authorization } = makeCollaborationTask(
        sessionId,
        runId,
        'collaborate',
        'build',
      )
      let mcpUrl = ''
      let mcpName = ''
      const baseline = nativeWorkingMemoryDiagnostics().chargedBytes ?? 0
      let bytesBeforeOversizedMsgId = 0
      let bytesAfterOversizedMsgId = 0
      let bytesAfterValidDedupIds = 0
      const recordedPlans: Array<{ nativeId: string; text: string }> = []
      const longFinalId = `final-${'z'.repeat(1018)}`
      const h = createAcpHarness()

      h.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(sid),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          // First pin ACP trajectory & trigger turn.started evidence (no messageId) before taking baseline.
          h.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                trajectoryId: traj,
                content: { type: 'text', text: 'Pin.' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 15))
          bytesBeforeOversizedMsgId =
            (nativeWorkingMemoryDiagnostics().chargedBytes ?? 0) - baseline
          // Send an oversized 20 KiB messageId (> 512-char / 1024-byte cap) -> MUST charge ZERO dedup bytes!
          h.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: 'm'.repeat(20 * 1024),
                content: { type: 'text', text: 'Oversized ID.' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 15))
          bytesAfterOversizedMsgId = (nativeWorkingMemoryDiagnostics().chargedBytes ?? 0) - baseline

          // Send 40 valid 500-char dedup messageIds -> MUST charge foregroundDedupMemoryReservation (> 40 KiB)!
          for (let i = 0; i < 40; i += 1) {
            h.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  messageId: `valid-msg-${String(i).padStart(3, '0')}-${'v'.repeat(480)}`,
                  content: { type: 'text', text: '.' },
                },
              },
            })
          }
          await new Promise((r) => setTimeout(r, 15))
          bytesAfterValidDedupIds = (nativeWorkingMemoryDiagnostics().chargedBytes ?? 0) - baseline

          // Stage 2 out-of-order provisional plan chunks: chunk 0 then chunk 1 (complete: true),
          // confirm chunk 1 FIRST with a 1024-byte final call ID, then confirm chunk 0!
          const chunk0Text = '# Out-of-order Chunk 0\n'
          const chunk1Text = 'Out-of-order Chunk 1 body.'
          const callPlan = async (id: number, args: object, pt: string) =>
            fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id,
                method: 'tools/call',
                params: {
                  name: 'publish_plan',
                  arguments: args,
                  _meta: {
                    'antigravity.google/root_conversation_id': sid,
                    'antigravity.google/conversation_id': sid,
                    progressToken: pt,
                  },
                },
              }),
            })
          await callPlan(1, { text: chunk0Text, offset: 0, complete: false }, `${traj}:20`)
          // Confirm intermediate chunk 0 first with a 1024-byte toolCallId (preceding chunks must complete before finalizing).
          h.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: `inter-${'y'.repeat(1018)}`,
                name: `mcp_${mcpName}_publish_plan`,
                status: 'completed',
                args: { text: chunk0Text, offset: 0, complete: false },
                progressToken: `${traj}:20`,
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          await callPlan(
            2,
            { text: chunk1Text, offset: Buffer.byteLength(chunk0Text, 'utf8'), complete: true },
            `${traj}:21`,
          )
          // Confirm final chunk with a 1024-byte toolCallId!
          h.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: longFinalId,
                name: `mcp_${mcpName}_publish_plan`,
                status: 'completed',
                args: {
                  text: chunk1Text,
                  offset: Buffer.byteLength(chunk0Text, 'utf8'),
                  complete: true,
                },
                progressToken: `${traj}:21`,
              },
            },
          })
          await new Promise((r) => setTimeout(r, 20))
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })

      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => h.child,
        storageClient: {
          readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }),
        },
      })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId,
              runId,
              permissionMode: 'auto',
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId,
                message: { id: randomUUID(), content: 'Out-of-order chunks + dedup budget.' },
                comments: [],
                collaboration: task,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  recordPlan: (p) => recordedPlans.push(p),
                  recordOpenPlanFinalIntent: () => true,
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        // Oversized 20 KiB messageId (~40 KiB UTF-16) was rejected before insertion (< 1 KiB noise from text evidence).
        expect(bytesAfterOversizedMsgId - bytesBeforeOversizedMsgId).toBeLessThan(1024)
        // 40 valid ~494-char dedup keys charged conservatively (>= 38 KiB).
        expect(bytesAfterValidDedupIds - bytesAfterOversizedMsgId).toBeGreaterThanOrEqual(38 * 1024)
        expect(recordedPlans).toHaveLength(1)
        const expectedFinalNativeId = `${sid}:sha256:${createHash('sha256').update(`${sid}\0${longFinalId}`, 'utf8').digest('hex')}`
        expect(recordedPlans[0]?.nativeId).toBe(expectedFinalNativeId)
        expect(recordedPlans[0]?.text).toBe('# Out-of-order Chunk 0\nOut-of-order Chunk 1 body.')
      } finally {
        await adapter.dispose()
      }
      expect(nativeWorkingMemoryDiagnostics().chargedBytes ?? 0).toBe(baseline)
    }
  })

  it('R3-Check #7 (S1-#16, S1-#17, S1-#20): releases external pool lease on already-aborted background observer, joins concurrent dispose() to physical settlement with failure propagation, and aligns peer & input-result instructions with runtime schemas', async () => {
    // Subcase A (S1-#16): Disposal aborts a run with active background tasks while its finalizer awaits
    // MCP server close -> retained-background branch sees `observation.signal.aborted` and immediately
    // releases the lease on an externally owned AgyAcpConnectionPool!
    {
      const { cwd, appDataDir } = await createEnv()
      const sid = randomUUID()
      const h = createAcpHarness()
      let promptFrameId: unknown
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(sid),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          promptFrameId = frame.id
          // Launch an unresolved background daemon task so `activeBackgroundTasks.size > 0` at end of turn!
          h.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'bg-daemon-1',
                name: 'run_command',
                status: 'completed',
                args: { CommandLine: 'sleep 60', IsDaemon: true },
                rawOutput: { taskId: 'task-bg-1' },
              },
            },
          })
          // End the foreground turn while background task is still active!
          setTimeout(() => {
            h.sendToClient({
              jsonrpc: '2.0',
              id: promptFrameId,
              result: { stopReason: 'end_turn' },
            })
          }, 15)
        }
      })

      const externalPool = new AgyAcpConnectionPool({
        executablePath: 'agy',
        processFactory: () => h.child,
      })
      const adapter = new AgyAgentAdapter({
        appDataDir,
        connectionPool: externalPool,
      })
      try {
        // Trigger `adapter.dispose()` right when `turn.completed` yields (just as `finally` begins awaiting `mcpServer.close()`)!
        let disposePromise: Promise<void> | undefined
        for await (const ev of adapter.run(
          makeBaseRunInput(cwd, {
            permissionMode: 'auto',
          }),
          new AbortController().signal,
        )) {
          if (ev.type === 'turn.completed') {
            disposePromise = adapter.dispose()
          }
        }
        await disposePromise
        // External pool MUST have 0 active leases after already-aborted `cleanupRetained()` runs!
        expect(externalPool.activeLeaseCount).toBe(0)
      } finally {
        await adapter.dispose()
        await externalPool.dispose()
      }
    }

    // Subcase B (S1-#17): Concurrent `adapter.dispose()` callers share the SAME in-flight disposal promise,
    // wait for physical `NativeForkFiles.dispose()` settlement, and propagate a non-ignored termination failure!
    {
      const { cwd, appDataDir } = await createEnv()
      const sid = randomUUID()
      const traj = randomUUID()
      await createDbFixture(appDataDir, sid, traj, 1)
      let releaseForkDispose!: () => void
      let rejectNextForkDispose = true
      let forkDisposeCalls = 0
      const forkDisposeSpy = vi
        .spyOn(NativeForkFiles.prototype, 'dispose')
        .mockImplementation(async function (this: NativeForkFiles) {
          forkDisposeCalls += 1
          if (rejectNextForkDispose) {
            await new Promise<void>((r) => {
              releaseForkDispose = r
            })
            throw new Error('simulated worker termination failure')
          }
        })

      const h = createAcpHarness()
      h.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/load') {
          h.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(sid),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          h.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })

      const pactSessionId = randomUUID()
      const runId = randomUUID()
      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => h.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              nativeSessionId: sid,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Allocate ownedForkFiles for dispose test.' },
                comments: [],
                collaboration: task,
                collaborationAuthorization: authorization,
              },
            }),
            new AbortController().signal,
          ),
        )
        // Start TWO concurrent `adapter.dispose()` calls!
        const d1 = adapter.dispose()
        const d2 = adapter.dispose()
        await waitUntilCondition(() => typeof releaseForkDispose === 'function')
        expect(forkDisposeCalls).toBe(1)
        // Release the failing disposal -> BOTH concurrent callers MUST observe the termination error!
        releaseForkDispose()
        await expect(d1).rejects.toThrow('simulated worker termination failure')
        await expect(d2).rejects.toThrow('simulated worker termination failure')
        // Because `activeOwnedForkFiles` retained the unsettled handle on failure, a retry `dispose()` retries it!
        rejectNextForkDispose = false
        await adapter.dispose()
        expect(forkDisposeCalls).toBe(2)
      } finally {
        forkDisposeSpy.mockRestore()
        await adapter.dispose().catch(() => undefined)
      }
    }

    // Subcase C (S1-#20): Advertised `request_peer_assistance` (ordinary chat without fixed target) uses
    // `"claude"|"codex"` union (NEVER `"claude|codex"`), and advertised `submit_input_result` (reply stage)
    // omits unsupported `plan_revision_required` and aligns 100% with runtime schemas!
    {
      const { cwd, appDataDir } = await createEnv()
      let peerInstructions = ''
      let peerSchemaTargets: unknown
      const hPeer = createAcpHarness()
      hPeer.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          hPeer.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string }> }).mcpServers
          const url = servers?.[0]?.url ?? ''
          const initRes = (await (
            await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
            })
          ).json()) as { result: { instructions: string } }
          peerInstructions = initRes.result.instructions
          const listRes = (await (
            await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
            })
          ).json()) as {
            result: {
              tools: Array<{
                name: string
                inputSchema: { properties?: { target?: { enum?: unknown } } }
              }>
            }
          }
          peerSchemaTargets = listRes.result.tools.find((t) => t.name === 'request_peer_assistance')
            ?.inputSchema.properties?.target?.enum
          hPeer.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(randomUUID()),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
          hPeer.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'gemini-4-carbon' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
        } else if (frame.method === 'session/prompt') {
          hPeer.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })

      const adapterPeer = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => hPeer.child,
        storageClient: { readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }) },
      })
      try {
        await collectEvents(adapterPeer.run(makeBaseRunInput(cwd), new AbortController().signal))
        expect(peerInstructions).toContain('target: "claude"|"codex"')
        expect(peerInstructions).not.toContain('target: "claude|codex"')
        expect(peerSchemaTargets).toEqual(['claude', 'codex'])
        expect(
          peerRequestToolInputSchema.safeParse({ target: 'claude|codex', kind: 'review' }).success,
        ).toBe(false)
        expect(
          peerRequestToolInputSchema.safeParse({ target: 'claude', kind: 'review' }).success,
        ).toBe(true)
        expect(
          peerRequestToolInputSchema.safeParse({ target: 'codex', kind: 'review' }).success,
        ).toBe(true)
      } finally {
        await adapterPeer.dispose()
      }

      // Now verify `submit_input_result` description in a `reply` stage where it IS advertised!
      let inputResultDescription = ''
      let inputResultSchemaObj: unknown
      const hReply = createAcpHarness()
      hReply.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          hReply.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          const servers = (frame.params as { mcpServers?: Array<{ url: string }> }).mcpServers
          const url = servers?.[0]?.url ?? ''
          const listRes = (await (
            await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
            })
          ).json()) as {
            result: {
              tools: Array<{ name: string; description: string; inputSchema: unknown }>
            }
          }
          const tool = listRes.result.tools.find((t) => t.name === 'submit_input_result')
          inputResultDescription = tool?.description ?? ''
          inputResultSchemaObj = tool?.inputSchema
          hReply.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(randomUUID()),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
          hReply.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              configOptions: [
                { id: 'model', currentValue: 'gemini-4-carbon' },
                { id: 'thought_level', currentValue: 'high' },
              ],
            },
          })
        } else if (frame.method === 'session/prompt') {
          hReply.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })

      const replySessionId = randomUUID()
      const replyRunId = randomUUID()
      const { task: replyTask, authorization: replyAuth } = makeCollaborationTask(
        replySessionId,
        replyRunId,
        'reply',
        'plan',
      )
      const pendingReplyTask: CollaborationTask = {
        ...replyTask,
        inputProcessing: { pending: { inputId: randomUUID(), inputSequence: 1 } },
      }
      const adapterReply = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => hReply.child,
        storageClient: { readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }) },
      })
      try {
        await collectEvents(
          adapterReply.run(
            makeBaseRunInput(cwd, {
              sessionId: replySessionId,
              runId: replyRunId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: replySessionId,
                message: { id: randomUUID(), content: 'Verify submit_input_result description.' },
                comments: [],
                collaboration: pendingReplyTask,
                collaborationAuthorization: replyAuth,
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(inputResultDescription.length).toBeGreaterThan(0)
        expect(inputResultDescription).not.toContain('plan_revision_required')
        expect(inputResultSchemaObj).toBeDefined()
        expect(
          collaborationInputResultSchema.safeParse({ outcome: 'plan_revision_required' }).success,
        ).toBe(false)
        expect(
          collaborationInputResultSchema.safeParse({ outcome: 'explanation_only' }).success,
        ).toBe(true)
        expect(collaborationInputResultSchema.safeParse({ outcome: 'processed' }).success).toBe(
          true,
        )
      } finally {
        await adapterReply.dispose()
      }
    }
  })
})

describe('AgyAgentAdapter Round-4 final review regressions', () => {
  it('High #1 & Med #18: rejects foreign trajectoryId / pre-boundary stepIdx on tokenless calls and leading-zero progressTokens on positive paths while preserving canonical negative ownership', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const pactSessionId = randomUUID()
    let mcpUrl = ''
    let mcpName = ''
    let foreignTitleRes: { result: Record<string, unknown> } | undefined
    let leadingZeroTitleRes: { result: Record<string, unknown> } | undefined
    let canonicalBlockedTitleRes: { result: Record<string, unknown> } | undefined
    let validTitleRes: { result: Record<string, unknown> } | undefined
    const harness = createAcpHarness()

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/load') {
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpUrl = servers?.[0]?.url ?? ''
        mcpName = servers?.[0]?.name ?? ''
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
        // 1) Tokenless ACP tool call with foreign trajectoryId MUST NOT admit
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-foreign-traj',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'in_progress',
              trajectoryId: 'traj-foreign',
              args: { title: 'Foreign Trajectory Title' },
            },
          },
        })
        // 2) Tokenless ACP tool call with pre-boundary stepIdx (< 5) MUST NOT admit
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-pre-step',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'in_progress',
              stepIdx: 2,
              args: { title: 'Foreign Trajectory Title' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        foreignTitleRes = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'publish_session_title',
              arguments: { title: 'Foreign Trajectory Title' },
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: 'traj-root:5',
              },
            },
          }),
        }).then((r) => r.json())) as { result: Record<string, unknown> }

        // 3) Leading-zero progressToken on Pact ACP call MUST be rejected on positive path
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-leading-zero-mcp',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'in_progress',
              progressToken: 'traj-root:06',
              args: { title: 'Leading Zero Title' },
            },
          },
        })
        // 4) Leading-zero progressToken on non-Pact ACP call MUST record canonical negative ownership for traj-root:7
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-leading-zero-nonmcp',
              name: 'view_file',
              status: 'in_progress',
              progressToken: 'traj-root:07',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))

        leadingZeroTitleRes = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'publish_session_title',
              arguments: { title: 'Leading Zero Title' },
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: 'traj-root:6',
              },
            },
          }),
        }).then((r) => r.json())) as { result: Record<string, unknown> }

        canonicalBlockedTitleRes = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'publish_session_title',
              arguments: { title: 'Canonical Blocked Title' },
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: 'traj-root:7',
              },
            },
          }),
        }).then((r) => r.json())) as { result: Record<string, unknown> }

        // 5) Legitimate tokenless call omitting trajectory/step fields still works and promotes!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-valid-tokenless',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'in_progress',
              args: { title: 'Legitimate Root Title' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        validTitleRes = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: {
              name: 'publish_session_title',
              arguments: { title: 'Legitimate Root Title' },
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: 'traj-root:8',
              },
            },
          }),
        }).then((r) => r.json())) as { result: Record<string, unknown> }
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-valid-tokenless',
              status: 'completed',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const storageClient: AgyNativeStorageClient = {
      readTrajectoryIdentity: async () => ({
        status: 'ok',
        trajectoryId: 'traj-root',
        stepCount: 5,
      }),
    }
    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient,
    })
    try {
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            nativeSessionId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              requestSessionTitle: true,
              message: { id: randomUUID(), content: 'Verify High #1 and Med #18.' },
              comments: [],
            },
          }),
          new AbortController().signal,
        ),
      )
      expect(foreignTitleRes?.result.isError).toBe(true)
      expect(leadingZeroTitleRes?.result.isError).toBe(true)
      expect(canonicalBlockedTitleRes?.result.isError).toBe(true)
      expect(validTitleRes?.result.isError).toBeUndefined()
      const titles = events.filter((e) => e.type === 'session.title.updated')
      expect(titles).toHaveLength(1)
      expect((titles[0] as { title: string }).title).toBe('Legitimate Root Title')
    } finally {
      await adapter.dispose()
    }
  })

  it('High #2: records negative non-Pact progressToken ownership before early-returning on oversized toolCallId', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const pactSessionId = randomUUID()
    const runId = randomUUID()
    const grantId = randomUUID()
    let mcpUrl = ''
    let sourceReadCalls = 0
    let httpRes: { result: Record<string, unknown> } | undefined
    const harness = createAcpHarness()

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpUrl = servers?.[0]?.url ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
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
        // Pin root trajectory via a normal non-MCP tool call
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-pin',
              name: 'view_file',
              status: 'completed',
              progressToken: 'traj-h2:0',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 10))
        // Start HTTP read_collaboration_source waiting on traj-h2:1
        const pendingRead = fetch(mcpUrl, {
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
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: 'traj-h2:1',
              },
            },
          }),
        }).then((r) => r.json() as Promise<{ result: Record<string, unknown> }>)

        await new Promise((r) => setTimeout(r, 15))
        // Non-Pact ACP frame with >1024-byte toolCallId carries progressToken traj-h2:1
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'x'.repeat(1_200),
              name: 'read_file',
              status: 'in_progress',
              progressToken: 'traj-h2:1',
            },
          },
        })
        httpRes = await pendingRead
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: randomUUID(), content: 'Verify High #2 oversized toolCallId.' },
              comments: [],
              sourceGrant: { runId, grant: grantId },
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                sourceReader: legacySourceReader(() => {
                  sourceReadCalls += 1
                  return { source: 'inputs', offset: 0, nextOffset: null, text: 'secret' }
                }),
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      expect(httpRes?.result.isError).toBe(true)
      expect(sourceReadCalls).toBe(0)
    } finally {
      await adapter.dispose()
    }
  })

  it('High #3: detects same-frame args vs rawInput conflict and terminal rawInput conflict and revokes without promotion', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const pactSessionId = randomUUID()
    let mcpUrl = ''
    let mcpName = ''
    let resBError: unknown
    const harness = createAcpHarness()

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
          result: defaultSessionNewResult(nativeSessionId),
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
        // Case A: pre-terminal args match HTTP, then terminal update supplies conflicting rawInput
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-conflict-terminal',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'in_progress',
              progressToken: 'traj-h3:1',
              args: { title: 'Original Title' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'publish_session_title',
              arguments: { title: 'Original Title' },
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: 'traj-h3:1',
              },
            },
          }),
        })
        // Terminal update omits args but supplies conflicting rawInput -> MUST revoke, NOT promote!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-conflict-terminal',
              status: 'completed',
              rawInput: { title: 'Tampered Terminal Title' },
            },
          },
        })

        // Case B: same-frame conflicting args vs rawInput MUST NOT admit
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-conflict-sameframe',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'in_progress',
              progressToken: 'traj-h3:2',
              args: { title: 'Title A' },
              rawInput: { title: 'Title B' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        const resB = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'publish_session_title',
              arguments: { title: 'Title A' },
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: 'traj-h3:2',
              },
            },
          }),
        }).then((r) => r.json())) as { result: Record<string, unknown> }
        resBError = resB.result.isError

        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              requestSessionTitle: true,
              message: { id: randomUUID(), content: 'Verify High #3 semantic args conflict.' },
              comments: [],
            },
          }),
          new AbortController().signal,
        ),
      )
      expect(resBError).toBe(true)
      expect(events.filter((e) => e.type === 'session.title.updated')).toHaveLength(0)
    } finally {
      await adapter.dispose()
    }
  })

  it('High #4: blocks provisional tokenless migration while an unresolved sibling call lacks args, then migrates once sibling resolves to mismatch', async () => {
    // Subcase A: sibling lacks args when matching call completes -> NO promotion
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const pactSessionId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      let stageErrH4a: unknown
      const harness = createAcpHarness()

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
            result: defaultSessionNewResult(nativeSessionId),
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
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-pin-h4a',
                name: 'view_file',
                status: 'completed',
                progressToken: 'traj-h4a:0',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          // Stage early provisional token:traj-h4a:1
          const res = (await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Ambiguous Provisional Title' },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: 'traj-h4a:1',
                },
              },
            }),
          }).then((r) => r.json())) as { result: Record<string, unknown> }
          stageErrH4a = res.result.isError

          // Sibling 1 arrives WITHOUT args
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-sib-noargs',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'in_progress',
              },
            },
          })
          // Sibling 2 arrives WITH matching args -> MUST NOT migrate while sibling 1 lacks args!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-sib-matching',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'in_progress',
                args: { title: 'Ambiguous Provisional Title' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          // Complete Sibling 2 while Sibling 1 is still unresolved -> zero promotion!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-sib-matching',
                status: 'completed',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const events = await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                requestSessionTitle: true,
                message: { id: randomUUID(), content: 'Verify High #4 subcase A.' },
                comments: [],
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(stageErrH4a).toBeUndefined()
        expect(events.filter((e) => e.type === 'session.title.updated')).toHaveLength(0)
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase B: once sibling 1 supplies mismatching args, sibling 2 becomes unique, migrates, and promotes!
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const pactSessionId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      const harness = createAcpHarness()

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
            result: defaultSessionNewResult(nativeSessionId),
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
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-pin-h4b',
                name: 'view_file',
                status: 'completed',
                progressToken: 'traj-h4b:0',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Disambiguated Title' },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: 'traj-h4b:1',
                },
              },
            }),
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-sib-other',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'in_progress',
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-sib-target',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'in_progress',
                args: { title: 'Disambiguated Title' },
              },
            },
          })
          // Sibling 1 updates with mismatching args -> sibling 2 is now uniquely compatible and migrates!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-sib-other',
                status: 'in_progress',
                args: { title: 'Completely Different Title' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-sib-target',
                status: 'completed',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const events = await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                requestSessionTitle: true,
                message: { id: randomUUID(), content: 'Verify High #4 subcase B.' },
                comments: [],
              },
            }),
            new AbortController().signal,
          ),
        )
        const titles = events.filter((e) => e.type === 'session.title.updated')
        expect(titles).toHaveLength(1)
        expect((titles[0] as { title: string }).title).toBe('Disambiguated Title')
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('High #5 & High #6: retires denied non-Pact IDs, preserves session/load refusals, rejects bidirectional tool-name conflicts, and rejects contradictory/malformed permission _meta before auto-approval', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const pactSessionId = randomUUID()
    let mcpUrl = ''
    let mcpName = ''
    const permissionDecisions: Array<{ id: unknown; outcome: unknown }> = []
    let reusedDeniedRes: { result: Record<string, unknown> } | undefined
    let loadRefusedRes: { result: Record<string, unknown> } | undefined
    const harness = createAcpHarness()

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/load') {
        const servers = (frame.params as { mcpServers?: Array<{ url: string; name: string }> })
          .mcpServers
        mcpUrl = servers?.[0]?.url ?? ''
        mcpName = servers?.[0]?.name ?? ''
        // High #5(b): Send a Pact permission request during session/load (before activeRun is set) with foreign/contradictory meta -> refused & tombstoned!
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-during-load',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            _meta: {
              'antigravity.google/root_conversation_id': nativeSessionId,
            },
            toolCall: {
              toolCallId: 'tc-refused-during-load',
              name: `mcp_${mcpName}_publish_session_title`,
              _meta: {
                root_conversation_id: 'foreign-root-conv',
              },
            },
            options: [
              { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
              { optionId: 'reject-1', kind: 'reject_once', name: 'Deny' },
            ],
          },
        })
        await new Promise((r) => setTimeout(r, 20))
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
        // High #6: contradictory non-string conversation_id in toolCall._meta MUST be rejected (NOT auto-approved)
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-bad-meta-type',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            _meta: {
              'antigravity.google/root_conversation_id': nativeSessionId,
              'antigravity.google/conversation_id': nativeSessionId,
            },
            toolCall: {
              toolCallId: 'tc-bad-meta-type',
              name: `mcp_${mcpName}_publish_session_title`,
              _meta: {
                conversation_id: 12345,
              },
            },
            options: [
              { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
              { optionId: 'reject-1', kind: 'reject_once', name: 'Deny' },
            ],
          },
        })
        // High #5(a): denied tokenless non-Pact permission request for read_file
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-deny-readfile',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: {
              toolCallId: 'tc-denied-readfile',
              name: 'read_file',
              title: 'Read secret file',
            },
            options: [
              { optionId: 'allow-rf', kind: 'allow_once', name: 'Allow' },
              { optionId: 'reject-rf', kind: 'reject_once', name: 'Deny' },
            ],
          },
        })
        await new Promise((r) => setTimeout(r, 30))

        // Attempt to reuse tc-denied-readfile as Pact tool in session/update -> MUST be tombstoned!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-denied-readfile',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'in_progress',
              progressToken: 'traj-h5:10',
              args: { title: 'Spoofed After Deny' },
            },
          },
        })
        // Attempt to reuse tc-refused-during-load in session/prompt -> MUST still be tombstoned!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-refused-during-load',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'in_progress',
              progressToken: 'traj-h5:11',
              args: { title: 'Spoofed After Load Refuse' },
            },
          },
        })
        // High #5(c): Bidirectional name conflict (Pact -> read_file) revokes call!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-bidir-flip',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'in_progress',
              progressToken: 'traj-h5:12',
              args: { title: 'Bidir Flip Title' },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'publish_session_title',
              arguments: { title: 'Bidir Flip Title' },
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: 'traj-h5:12',
              },
            },
          }),
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-bidir-flip',
              name: 'read_file',
              status: 'completed',
            },
          },
        })

        reusedDeniedRes = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'publish_session_title',
              arguments: { title: 'Spoofed After Deny' },
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: 'traj-h5:10',
              },
            },
          }),
        }).then((r) => r.json())) as { result: Record<string, unknown> }

        loadRefusedRes = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'publish_session_title',
              arguments: { title: 'Spoofed After Load Refuse' },
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: 'traj-h5:11',
              },
            },
          }),
        }).then((r) => r.json())) as { result: Record<string, unknown> }

        await new Promise((r) => setTimeout(r, 15))
        for (const resp of harness.responses) {
          permissionDecisions.push({
            id: resp.id,
            outcome: (resp.result as Record<string, unknown>)?.outcome,
          })
        }
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: {
        readTrajectoryIdentity: async () => ({
          status: 'ok',
          trajectoryId: 'traj-h5',
          stepCount: 5,
        }),
      },
    })
    try {
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            nativeSessionId,
            permissionMode: 'ask',
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              requestSessionTitle: true,
              message: { id: randomUUID(), content: 'Verify High #5 and High #6.' },
              comments: [],
            },
            host: {
              interactions: {
                requestPermission: async () => 'deny',
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      expect(reusedDeniedRes?.result.isError).toBe(true)
      expect(loadRefusedRes?.result.isError).toBe(true)
      expect(events.filter((e) => e.type === 'session.title.updated')).toHaveLength(0)
      const loadDecision = permissionDecisions.find((d) => d.id === 'perm-during-load')
      const badMetaDecision = permissionDecisions.find((d) => d.id === 'perm-bad-meta-type')
      expect(loadDecision?.outcome).not.toEqual({ outcome: 'selected', optionId: 'allow-1' })
      expect(badMetaDecision?.outcome).not.toEqual({ outcome: 'selected', optionId: 'allow-1' })
    } finally {
      await adapter.dispose()
    }
  })

  it('High #7: never promotes post-reply terminal updates from coalesced chunks or staged tokenless outcomes after saturation, while promoting pre-reply coalesced completions', async () => {
    // Subcase A: coalesced [promptReply, postReplyCompleted] while consumer is paused -> ZERO promotion
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const pactSessionId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      const harness = createAcpHarness()

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
            result: defaultSessionNewResult(nativeSessionId),
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
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-post-reply',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'in_progress',
                progressToken: 'traj-h7a:1',
                args: { title: 'Post Reply Spoof Title' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 15))
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Post Reply Spoof Title' },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: 'traj-h7a:1',
                },
              },
            }),
          })
          // Coalesce promptReply BEFORE post-reply terminal update in a single stdout chunk!
          const replyLine = JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
          const postReplyLine = JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-post-reply',
                status: 'completed',
              },
            },
          })
          harness.sendRawStdout(`${replyLine}\n${postReplyLine}\n`)
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const events = await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                requestSessionTitle: true,
                message: { id: randomUUID(), content: 'Verify High #7 post-reply coalesced.' },
                comments: [],
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(events.filter((e) => e.type === 'session.title.updated')).toHaveLength(0)
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase B: coalesced [preReplyCompleted, promptReply] DOES promote during trailing drain!
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const pactSessionId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      const harness = createAcpHarness()

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
            result: defaultSessionNewResult(nativeSessionId),
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
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-pre-reply',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'in_progress',
                progressToken: 'traj-h7b:1',
                args: { title: 'Pre Reply Valid Title' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 15))
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Pre Reply Valid Title' },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: 'traj-h7b:1',
                },
              },
            }),
          })
          const preReplyLine = JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-pre-reply',
                status: 'completed',
              },
            },
          })
          const replyLine = JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
          harness.sendRawStdout(`${preReplyLine}\n${replyLine}\n`)
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const events = await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                requestSessionTitle: true,
                message: { id: randomUUID(), content: 'Verify High #7 pre-reply coalesced.' },
                comments: [],
              },
            }),
            new AbortController().signal,
          ),
        )
        const titles = events.filter((e) => e.type === 'session.title.updated')
        expect(titles).toHaveLength(1)
        expect((titles[0] as { title: string }).title).toBe('Pre Reply Valid Title')
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase C: staged tokenless outcome does NOT promote after tokenless correlation saturation
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const pactSessionId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      const harness = createAcpHarness()

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
            result: defaultSessionNewResult(nativeSessionId),
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
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-pin-h7c',
                name: 'view_file',
                status: 'completed',
                progressToken: 'traj-h7c:0',
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-tokenless-staged',
                name: `mcp_${mcpName}_publish_session_title`,
                status: 'in_progress',
                args: { title: 'Saturated Tokenless Title' },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 15))
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'publish_session_title',
                arguments: { title: 'Saturated Tokenless Title' },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: 'traj-h7c:1',
                },
              },
            }),
          })
          // Saturate activeAcpToolCalls (>256 open Pact calls) via session/request_permission to latch tokenlessCorrelationCompromised without exceeding the 64-item UI tool-state budget
          for (let i = 0; i < 260; i += 1) {
            harness.sendToClient({
              jsonrpc: '2.0',
              id: `perm-sat-${i}`,
              method: 'session/request_permission',
              params: {
                sessionId: nativeSessionId,
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                },
                toolCall: {
                  toolCallId: `tc-sat-${i}`,
                  name: `mcp_${mcpName}_publish_session_title`,
                },
                options: [
                  { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
                  { optionId: 'reject-1', kind: 'reject_once', name: 'Deny' },
                ],
              },
            })
          }
          await new Promise((r) => setTimeout(r, 25))
          // Now complete the previously staged tokenless call -> MUST NOT promote after saturation!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-tokenless-staged',
                status: 'completed',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 15))
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const events = await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                requestSessionTitle: true,
                message: { id: randomUUID(), content: 'Verify High #7 saturation block.' },
                comments: [],
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(events.filter((e) => e.type === 'session.title.updated')).toHaveLength(0)
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('High #8: invokes recordWorkflowPlanUnavailable when acknowledged final open-mode publish_plan lacks terminal ACP confirmation, and publishes once on clean retry', async () => {
    // Subcase A: acknowledged final publish_plan without terminal ACP completed -> unavailable called, zero plan emitted
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const pactSessionId = randomUUID()
      const runId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      let unavailableCalls = 0
      let planStageErrH8a: unknown
      const harness = createAcpHarness()

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
            result: defaultSessionNewResult(nativeSessionId),
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
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-open-plan-unconfirmed',
                name: `mcp_${mcpName}_publish_plan`,
                status: 'in_progress',
                progressToken: 'traj-h8a:1',
                args: { offset: 0, text: '# Updated Open Plan\n', complete: true },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 15))
          const res = (await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'publish_plan',
                arguments: { offset: 0, text: '# Updated Open Plan\n', complete: true },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: 'traj-h8a:1',
                },
              },
            }),
          }).then((r) => r.json())) as { result: Record<string, unknown> }
          planStageErrH8a = res.result.isError
          // End turn WITHOUT sending ACP completed for tc-open-plan-unconfirmed!
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })

      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'collaborate')
      const openTask: CollaborationTask = { ...task, openMode: true }
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const events = await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Publish revised open plan.' },
                comments: [],
                collaboration: openTask,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  recordOpenPlanFinalIntent: () => true,
                  recordPlanUnavailable: () => {
                    unavailableCalls += 1
                  },
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(planStageErrH8a).toBeUndefined()
        expect(events.filter((e) => e.type === 'collaboration.plan')).toHaveLength(0)
        expect(unavailableCalls).toBe(1)
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase B: first final publish_plan fails via ACP failed, retry completes cleanly -> plan emitted once, unavailable NOT called
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      const pactSessionId = randomUUID()
      const runId = randomUUID()
      let mcpUrl = ''
      let mcpName = ''
      let unavailableCalls = 0
      const harness = createAcpHarness()

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
            result: defaultSessionNewResult(nativeSessionId),
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
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-open-plan-try1',
                name: `mcp_${mcpName}_publish_plan`,
                status: 'in_progress',
                progressToken: 'traj-h8b:1',
                args: { offset: 0, text: '# Draft 1\n', complete: true },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'publish_plan',
                arguments: { offset: 0, text: '# Draft 1\n', complete: true },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: 'traj-h8b:1',
                },
              },
            }),
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-open-plan-try1',
                status: 'failed',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-open-plan-try2',
                name: `mcp_${mcpName}_publish_plan`,
                status: 'in_progress',
                progressToken: 'traj-h8b:2',
                args: { offset: 0, text: '# Final Plan Retry\n', complete: true },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'publish_plan',
                arguments: { offset: 0, text: '# Final Plan Retry\n', complete: true },
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: 'traj-h8b:2',
                },
              },
            }),
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-open-plan-try2',
                status: 'completed',
              },
            },
          })
          await new Promise((r) => setTimeout(r, 10))
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })

      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'collaborate')
      const openTask: CollaborationTask = { ...task, openMode: true }
      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const events = await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Publish revised open plan on retry.' },
                comments: [],
                collaboration: openTask,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  recordOpenPlanFinalIntent: () => true,
                  recordPlanUnavailable: () => {
                    unavailableCalls += 1
                  },
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        const plans = events.filter((e) => e.type === 'collaboration.plan')
        expect(plans).toHaveLength(1)
        expect((plans[0] as { text: string }).text).toBe('# Final Plan Retry\n')
        expect(unavailableCalls).toBe(0)
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('High #10 & Med #13: distinguishes valid JSON-RPC rejection from malformed/mixed session/new replies and sends one bounded session/close independent of caller abort on fork/rebuild cancellation', async () => {
    const seedContent = 'Seed message for rebuild check'
    async function* makeRebuildChunks() {
      yield {
        kind: 'message' as const,
        messageId: randomUUID(),
        sequence: 1,
        speaker: 'user' as const,
        state: 'complete' as const,
        part: 0,
        final: true,
        content: seedContent,
      }
    }
    const stubRebuildStorage: AgyNativeStorageClient = {
      readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }),
      writeRebuildSeed: async () => ({
        status: 'ok',
        pbSha256: 'e'.repeat(64),
        pbBytes: 128,
        stepCount: 2,
        seedHash: 'f'.repeat(64),
        chunkCount: 1,
        verifiedPrefixBytes: 128,
        verifiedPrefixSha256: 'e'.repeat(64),
      }),
    }
    const runShellRejectionCheck = async (
      newReply: object,
      expectedState: 'settled' | 'unknown',
    ): Promise<void> => {
      const { cwd, appDataDir } = await createEnv()
      const reports: Array<{ state: string }> = []
      const harness = createAcpHarness()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, ...newReply })
        }
      })
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => harness.child,
        storageClient: stubRebuildStorage,
      })
      try {
        await expect(
          adapter.rebuildNativeContext(
            {
              rebuildId: randomUUID(),
              sessionId: randomUUID(),
              cwd,
              model: null,
              effort: null,
              permissionMode: 'ask',
              sourceHash: 'a'.repeat(64),
              reportNativeWork: (r) => reports.push({ state: r.state }),
            },
            makeRebuildChunks(),
            new AbortController().signal,
          ),
        ).rejects.toThrow(/zero-Turn session shell|protocol|rejected|JSON-RPC (?:error|response)/iu)
        expect(reports.at(-1)?.state).toBe(expectedState)
      } finally {
        await adapter.dispose()
      }
    }

    // Valid JSON-RPC error object -> settled
    await runShellRejectionCheck({ error: { code: -32000, message: 'rejected' } }, 'settled')
    // Malformed non-object error -> unknown
    await runShellRejectionCheck({ error: 'malformed-string-error' }, 'unknown')
    // Mixed result + error -> unknown
    await runShellRejectionCheck(
      {
        result: defaultSessionNewResult('sid-mixed'),
        error: { code: -32000, message: 'mixed' },
      },
      'unknown',
    )

    // Med #13: cancellation during onNativeSessionCreated in allocateZeroTurnSessionShell sends 1 bounded session/close independent of caller abort and preserves abort error
    {
      const { cwd, appDataDir } = await createEnv()
      const closeSessionIds: string[] = []
      const abortController = new AbortController()
      const harness = createAcpHarness()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult('sid-abort-cleanup'),
          })
        } else if (frame.method === 'session/close') {
          closeSessionIds.push(String((frame.params as { sessionId?: string })?.sessionId))
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        }
      })
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => harness.child,
        storageClient: stubRebuildStorage,
      })
      try {
        await expect(
          adapter.rebuildNativeContext(
            {
              rebuildId: randomUUID(),
              sessionId: randomUUID(),
              cwd,
              model: null,
              effort: null,
              permissionMode: 'ask',
              sourceHash: 'b'.repeat(64),
              onNativeSessionCreated: async () => {
                abortController.abort(new Error('caller cancelled during onNativeSessionCreated'))
              },
            },
            makeRebuildChunks(),
            abortController.signal,
          ),
        ).rejects.toThrow(/caller cancelled during onNativeSessionCreated/u)
        expect(closeSessionIds).toEqual(['sid-abort-cleanup'])
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('High #11 & Med #12: enforces wire order between set_config_option reply and coalesced config_option_update, and treats shared-family async model updates as unattributed', async () => {
    // High #11 Subcase A: coalesced [reply confirming 'high', post-reply update downgrading to 'low'] -> fails closed, no prompt dispatched
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      let promptDispatched = false
      let recordedSettings: unknown
      const harness = createAcpHarness()

      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (frame.method === 'session/set_mode') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_config_option') {
          const params = frame.params as { configId?: string }
          if (params.configId === 'thought_level') {
            const replyLine = JSON.stringify({
              jsonrpc: '2.0',
              id: frame.id,
              result: {
                configOptions: [
                  { id: 'model', currentValue: 'gemini-4-carbon' },
                  { id: 'thought_level', currentValue: 'high' },
                ],
              },
            })
            const downgradeUpdate = JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: nativeSessionId,
                update: {
                  sessionUpdate: 'config_option_update',
                  configOptions: [
                    { id: 'model', currentValue: 'gemini-4-carbon' },
                    { id: 'thought_level', currentValue: 'low' },
                  ],
                },
              },
            })
            harness.sendRawStdout(`${replyLine}\n${downgradeUpdate}\n`)
          } else {
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
          }
        } else if (frame.method === 'session/prompt') {
          promptDispatched = true
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        } else if (frame.method === 'session/close') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, {
                model: 'gemini-4-carbon',
                effort: 'high',
                host: {
                  recovery: {
                    inputSha256: 'c'.repeat(64),
                    canDispatch: () => true,
                    recordEffectiveSettings: (s) => {
                      recordedSettings = s
                    },
                    recordConfirmedUnsent: () => undefined,
                  },
                },
              }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(/substituted|incompatible|effort/iu)
        expect(promptDispatched).toBe(false)
        expect(recordedSettings).toBeUndefined()
      } finally {
        await adapter.dispose()
      }
    }

    // High #11 Subcase B: coalesced [pre-reply stale 'low' update, reply confirming 'high'] -> succeeds with effort 'high'
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      let recordedEffort: unknown
      const harness = createAcpHarness()

      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (frame.method === 'session/set_mode') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_config_option') {
          const params = frame.params as { configId?: string }
          if (params.configId === 'thought_level') {
            const staleUpdate = JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: nativeSessionId,
                update: {
                  sessionUpdate: 'config_option_update',
                  configOptions: [
                    { id: 'model', currentValue: 'gemini-4-carbon' },
                    { id: 'thought_level', currentValue: 'low' },
                  ],
                },
              },
            })
            const replyLine = JSON.stringify({
              jsonrpc: '2.0',
              id: frame.id,
              result: {
                configOptions: [
                  { id: 'model', currentValue: 'gemini-4-carbon' },
                  { id: 'thought_level', currentValue: 'high' },
                ],
              },
            })
            harness.sendRawStdout(`${staleUpdate}\n${replyLine}\n`)
          } else {
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
          }
        } else if (frame.method === 'session/prompt') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              model: 'gemini-4-carbon',
              effort: 'high',
              host: {
                recovery: {
                  inputSha256: 'd'.repeat(64),
                  canDispatch: () => true,
                  recordEffectiveSettings: (s) => {
                    recordedEffort = s.effort
                  },
                  recordConfirmedUnsent: () => undefined,
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(recordedEffort).toEqual({ known: true, value: 'high' })
      } finally {
        await adapter.dispose()
      }
    }

    // Med #12: switching between concrete variants in same family with empty set_model reply + family-only config_option_update MUST NOT record stale effort as effortKnown: true
    {
      const { cwd, appDataDir } = await createEnv()
      const nativeSessionId = randomUUID()
      let recordedSettings:
        | { model: string; effort: { known: true; value: string | null } | { known: false } }
        | undefined
      const harness = createAcpHarness()

      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              sessionId: nativeSessionId,
              models: {
                currentModelId: 'gemini-3.5-pro-low',
                availableModels: [
                  { modelId: 'gemini-3.5-pro-low', name: 'Gemini 3.5 Pro Low' },
                  { modelId: 'gemini-3.5-pro-high', name: 'Gemini 3.5 Pro High' },
                ],
              },
              configOptions: [
                {
                  id: 'model',
                  currentValue: 'gemini-3.5-pro',
                  options: [{ value: 'gemini-3.5-pro', name: 'Gemini 3.5 Pro' }],
                },
                {
                  id: 'thought_level',
                  currentValue: 'low',
                  options: [
                    { value: 'low', name: 'Low' },
                    { value: 'high', name: 'High' },
                  ],
                },
              ],
            },
          })
        } else if (frame.method === 'session/set_mode') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: {} })
        } else if (frame.method === 'session/set_model') {
          // Empty set_model reply + family-only async config_option_update sharing family 'gemini-3.5-pro' with prior 'gemini-3.5-pro-low'
          const familyOnlyUpdate = JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'config_option_update',
                configOptions: [
                  { id: 'model', currentValue: 'gemini-3.5-pro' },
                  { id: 'thought_level', currentValue: 'low' },
                ],
              },
            },
          })
          const replyLine = JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })
          harness.sendRawStdout(`${familyOnlyUpdate}\n${replyLine}\n`)
        } else if (frame.method === 'session/prompt') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      })

      const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
      try {
        const events = await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              model: 'gemini-3.5-pro-high',
              effort: null,
              host: {
                recovery: {
                  inputSha256: 'e'.repeat(64),
                  canDispatch: () => true,
                  recordEffectiveSettings: (s) => {
                    recordedSettings = s
                  },
                  recordConfirmedUnsent: () => undefined,
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        // Because family-only async update was treated as unattributed (effortKnown: false),
        // stale effort='low' MUST NOT be recorded as an effective recovery setting!
        expect(recordedSettings).toBeUndefined()
        expect(
          events.some(
            (e) =>
              e.type === 'run.model.resolved' &&
              (e as { model?: string }).model === 'gemini-3.5-pro-high',
          ),
        ).toBe(true)
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('Med #14: blocks duplicate background reports for >1024-byte CJK foreground IDs and after foreground dedup saturation while settling background tasks normally', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const cjkId = '中'.repeat(400) // 400 chars (<=512) but 1200 UTF-8 bytes (>1024)!
    const bgReports: NativeBackgroundReport[] = []
    let sendPostTurnNotifications: (() => void) | undefined
    const harness = createAcpHarness()

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/new') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
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
        // Start a tracked background daemon task so background listener stays attached after root turn
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'bg-task-1',
              name: 'run_command',
              args: { IsDaemon: true, CommandLine: 'echo bg' },
              status: 'in_progress',
              stepIdx: 1,
            },
          },
        })
        // Foreground message with 400-char CJK ID (1200 bytes > 1024)
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: cjkId,
              stepIdx: 2,
              content: { type: 'text', text: 'Foreground CJK reply.' },
            },
          },
        })
        // Saturate foreground dedup (>4096 distinct IDs) so foregroundDedupIncomplete latches
        for (let i = 0; i < 4_105; i += 1) {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: `fg-sat-${i}`,
                stepIdx: 3,
                content: { type: 'text', text: '' },
              },
            },
          })
        }
        await new Promise((r) => setTimeout(r, 40))
        sendPostTurnNotifications = () => {
          // 1) Replay the 400-char CJK ID after root turn -> MUST be ignored!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                outOfTurn: true,
                messageId: cjkId,
                stepIdx: 10,
                content: { type: 'text', text: 'Duplicate CJK replay.' },
              },
            },
          })
          // 2) Replay an evicted post-saturation foreground ID without independent step novelty -> MUST be ignored!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                outOfTurn: true,
                messageId: 'fg-sat-4104',
                content: { type: 'text', text: 'Duplicate saturated replay.' },
              },
            },
          })
          // 3) Genuine post-foreground background report with stepIdx > maxForegroundStepIdx (3) -> accepted!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                outOfTurn: true,
                messageId: 'genuine-bg-msg',
                stepIdx: 12,
                content: { type: 'text', text: 'Genuine background completion.' },
              },
            },
          })
          // 4) Settle tracked background task
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'bg-task-1',
                status: 'completed',
              },
            },
          })
        }
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            host: {
              effects: {
                recordBackgroundReport: async (report) => {
                  bgReports.push(report)
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      sendPostTurnNotifications?.()
      await vi.waitFor(() => {
        expect(bgReports.some((r) => r.text === 'Genuine background completion.')).toBe(true)
      })
      expect(bgReports.some((r) => r.text.includes('Duplicate'))).toBe(false)
      // Verify tracked background task settled cleanly so activeRuns cleared
      await vi.waitFor(() => {
        expect((Reflect.get(adapter, 'activeRuns') as Map<string, unknown>).size).toBe(0)
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('Med #15: adapter.dispose() on an external shared pool cancels its own silent accepted prompt and releases its lease without disrupting sibling adapters on the same pool', async () => {
    const { cwd, appDataDir } = await createEnv()
    const harness = createAcpHarness()
    let cancelReceivedForA = false
    let promptAStarted: (() => void) | undefined
    const promptAReady = new Promise<void>((markReady) => {
      promptAStarted = markReady
    })
    let sessionCounter = 0

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        sessionCounter += 1
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(`sid-shared-${sessionCounter}`),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        const sid = (frame.params as { sessionId?: string })?.sessionId
        if (sid === 'sid-shared-1') {
          // Silent accepted prompt: send an initial chunk so it's accepted, then hang until cancelled
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Working silently...' },
              },
            },
          })
          promptAStarted?.()
        } else {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Sibling B completed cleanly.' },
              },
            },
          })
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }
      } else if (frame.method === 'session/cancel') {
        if ((frame.params as { sessionId?: string })?.sessionId === 'sid-shared-1') {
          cancelReceivedForA = true
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
      // Start Adapter A's hanging silent accepted prompt
      const runAPromise = collectEvents(
        adapterA.run(makeBaseRunInput(cwd), new AbortController().signal),
      ).catch((err: unknown) => err)

      await promptAReady
      expect(sharedPool.activeLeaseCount).toBe(1)

      // Dispose Adapter A with a bounded deadline -> cancels Adapter A's run and releases its lease without closing sharedPool!
      await adapterA.dispose({ flushDeadlineAt: Date.now() + 2_000 })
      await runAPromise
      expect(cancelReceivedForA).toBe(true)
      expect(sharedPool.activeLeaseCount).toBe(0)

      // Sibling Adapter B on the same sharedPool MUST still run cleanly!
      const eventsB = await collectEvents(
        adapterB.run(makeBaseRunInput(cwd), new AbortController().signal),
      )
      expect(eventsB.some((e) => e.type === 'text.delta')).toBe(true)
    } finally {
      await adapterB.dispose()
      await sharedPool.dispose()
    }
  })

  it('Med #17, Med #19, Low #20: rejects invalid/oversized toolCall.status as live witness, restricts legacy permission optionId fallback to undefined kind, and derives source-read docs/schema from configured reader capability', async () => {
    const { cwd, appDataDir } = await createEnv()
    const nativeSessionId = randomUUID()
    const pactSessionId = randomUUID()
    const runId = randomUUID()
    const grantId = randomUUID()
    let mcpUrl = ''
    let mcpName = ''
    let initInstructions = ''
    let promptSystemAppend = ''
    let toolsListSourceSchema: Record<string, unknown> | undefined
    let sourceReadCalls = 0
    let invalidStatusReadRes: { result: Record<string, unknown> } | undefined
    let permDecisionNullKind: unknown
    let permDecisionUndefinedKind: unknown
    let permDecisionPactNullKind: unknown
    let permDecisionPactUndefKind: unknown
    const harness = createAcpHarness()

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
        const initRes = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        }).then((r) => r.json())) as { result?: { instructions?: string } }
        initInstructions = initRes.result?.instructions ?? ''

        const listRes = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        }).then((r) => r.json())) as {
          result?: { tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }> }
        }
        toolsListSourceSchema = listRes.result?.tools?.find(
          (t) => t.name === 'read_collaboration_source',
        )?.inputSchema

        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
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
        const meta = Reflect.get(frame.params as object, '_meta') as
          | { antigravity?: { systemPrompt?: { append?: string } } }
          | undefined
        promptSystemAppend = meta?.antigravity?.systemPrompt?.append ?? ''

        // Med #17: oversized unknown status MUST be rejected as positive live-call witness (0 source reads)
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-bad-status',
              name: `mcp_${mcpName}_read_collaboration_source`,
              status: 'weird_'.repeat(500),
              progressToken: 'traj-m17:1',
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        invalidStatusReadRes = (await fetch(mcpUrl, {
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
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: 'traj-m17:1',
              },
            },
          }),
        }).then((r) => r.json())) as { result: Record<string, unknown> }

        // Med #19(a): kind: null and kind: '' with optionId 'allow'/'deny' MUST NOT be selected -> falls back to cancelled
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-null-kind',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: { toolCallId: 'tc-perm-null', name: 'read_file' },
            options: [
              { optionId: 'allow', kind: null, name: 'Allow Null' },
              { optionId: 'deny', kind: '', name: 'Deny Empty' },
            ],
          },
        })
        // Med #19(b): absent kind (undefined) falls back to legacy alias 'deny' (reject_once in read-only plan_review)
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-undef-kind',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: { toolCallId: 'tc-perm-undef', name: 'read_file' },
            options: [
              { optionId: 'allow', name: 'Legacy Allow' },
              { optionId: 'deny', name: 'Legacy Deny' },
            ],
          },
        })
        // Med #19(c): Pact MCP auto-allow with kind: null on optionId 'allow' MUST NOT select it, whereas absent kind selects 'allow'
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-pact-null-kind',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            _meta: {
              'antigravity.google/root_conversation_id': nativeSessionId,
              'antigravity.google/conversation_id': nativeSessionId,
            },
            toolCall: {
              toolCallId: 'tc-perm-pact-null',
              name: `mcp_${mcpName}_read_collaboration_source`,
            },
            options: [
              { optionId: 'allow', kind: null, name: 'Allow Null' },
              { optionId: 'deny', kind: '', name: 'Deny Empty' },
            ],
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-pact-undef-kind',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            _meta: {
              'antigravity.google/root_conversation_id': nativeSessionId,
              'antigravity.google/conversation_id': nativeSessionId,
            },
            toolCall: {
              toolCallId: 'tc-perm-pact-undef',
              name: `mcp_${mcpName}_read_collaboration_source`,
            },
            options: [
              { optionId: 'allow', name: 'Legacy Allow' },
              { optionId: 'deny', name: 'Legacy Deny' },
            ],
          },
        })
        await new Promise((r) => setTimeout(r, 25))
        permDecisionNullKind = (
          harness.responses.find((r) => r.id === 'perm-null-kind')?.result as Record<
            string,
            unknown
          >
        )?.outcome
        permDecisionUndefinedKind = (
          harness.responses.find((r) => r.id === 'perm-undef-kind')?.result as Record<
            string,
            unknown
          >
        )?.outcome
        permDecisionPactNullKind = (
          harness.responses.find((r) => r.id === 'perm-pact-null-kind')?.result as Record<
            string,
            unknown
          >
        )?.outcome
        permDecisionPactUndefKind = (
          harness.responses.find((r) => r.id === 'perm-pact-undef-kind')?.result as Record<
            string,
            unknown
          >
        )?.outcome

        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan_review')
    const adapter = new AgyAgentAdapter({ appDataDir, processFactory: () => harness.child })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            permissionMode: 'ask',
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: randomUUID(), content: 'Verify Med #17, Med #19, Low #20.' },
              comments: [],
              sourceGrant: { runId, grant: grantId },
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                sourceReader: {
                  identity: { runId, grant: grantId },
                  navigation: () => ({ runId, grant: grantId, source: 'inputs', offset: 0 }),
                  read: () => {
                    sourceReadCalls += 1
                    return {
                      submitted: 'legacy',
                      request: { runId, grant: grantId, source: 'inputs', offset: 0 },
                      page: {
                        source: 'inputs',
                        offset: 0,
                        nextOffset: null,
                        text: 'native',
                        binding: {
                          submitted: 'legacy',
                          callerRunId: runId,
                          grantSha256: 'a'.repeat(64),
                          referenceSha256: null,
                        },
                      },
                    }
                  },
                  readNativeRoot: () => {
                    sourceReadCalls += 1
                    return {
                      submitted: 'nativeRoot',
                      request: { runId, grant: grantId, source: 'inputs', offset: 0 },
                      page: {
                        source: 'inputs',
                        offset: 0,
                        nextOffset: null,
                        text: 'native',
                        binding: {
                          submitted: 'legacy',
                          callerRunId: runId,
                          grantSha256: 'a'.repeat(64),
                          referenceSha256: null,
                        },
                      },
                    }
                  },
                  retire: () => undefined,
                },
              },
              interactions: {
                requestPermission: async () => 'allow',
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      // Med #17 assertions
      expect(invalidStatusReadRes?.result.isError).toBe(true)
      expect(sourceReadCalls).toBe(0)

      // Med #19 assertions (both reject_once and allow_once reject null/'' kind and only allow undefined kind fallback)
      expect(permDecisionNullKind).toEqual({ outcome: 'cancelled' })
      expect(permDecisionUndefinedKind).toEqual({ outcome: 'selected', optionId: 'deny' })
      expect(permDecisionPactNullKind).toEqual({ outcome: 'cancelled' })
      expect(permDecisionPactUndefKind).toEqual({ outcome: 'selected', optionId: 'allow' })

      // Low #20 native-capable assertions (both sourceReference and native-root-v1 advertised)
      expect(initInstructions).toContain('sourceReference: string, offset: integer')
      expect(initInstructions).toContain('context: "native-root-v1"')
      expect(promptSystemAppend).toContain(initInstructions)
      expect(JSON.stringify(toolsListSourceSchema)).toContain('sourceReference')
      expect(JSON.stringify(toolsListSourceSchema)).toContain('native-root-v1')
    } finally {
      await adapter.dispose()
    }
  })
})

describe('AgyAgentAdapter Wave-3 converged Run & Open-mode regressions', () => {
  const w3TempDirs: string[] = []
  afterEach(async () => {
    for (const dir of w3TempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  async function createWave3Env() {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-w3-'))
    w3TempDirs.push(root)
    const cwd = join(root, 'repo')
    const appDataDir = join(root, 'app-data')
    await mkdir(cwd, { recursive: true })
    await mkdir(appDataDir, { recursive: true })
    return { root, cwd, appDataDir }
  }

  it('routes post-cutoff background completion immediately while foreground awaits waitForRootOutput()', async () => {
    const { cwd, appDataDir } = await createWave3Env()
    const nativeSessionId = randomUUID()
    const runId = randomUUID()
    const harness = createAcpHarness()
    let releaseRootOutput!: () => void
    const rootOutputGate = new Promise<void>((r) => {
      releaseRootOutput = r
    })
    const backgroundReports: NativeBackgroundReport[] = []
    const effectStates: Array<{ state: string; reason?: string | undefined }> = []
    let promptFrameId: unknown

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        promptFrameId = frame.id
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'bg-w3-1',
              name: 'run_command',
              status: 'completed',
              args: { CommandLine: 'sleep 1', IsDaemon: true },
              rawOutput: { taskId: 'task-w3-1' },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Foreground answer.' },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: promptFrameId,
          result: { stopReason: 'end_turn' },
        })
      }
    })

    let enteredWaitForRootOutput = false
    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: { readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }) },
    })
    try {
      const runPromise = collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            runId,
            permissionMode: 'auto',
            host: {
              lifecycle: {
                waitForRootOutput: async () => {
                  enteredWaitForRootOutput = true
                  await rootOutputGate
                },
              },
              effects: {
                recordBackgroundReport: async (report) => {
                  backgroundReports.push(report)
                },
                reportNativeEffects: (report) => {
                  effectStates.push({ state: report.state, reason: report.reason })
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      await waitUntilCondition(() => enteredWaitForRootOutput)
      // Emit post-cutoff background completion WHILE foreground is paused inside `waitForRootOutput()`!
      harness.sendToClient({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: 'background_task_completed',
            taskId: 'task-w3-1',
            messageId: 'bg-msg-w3-1',
            text: 'Background daemon finished cleanly.',
          },
        },
      })

      // Frame pump MUST process post-cutoff update immediately without waiting for `waitForRootOutput()`!
      await waitUntilCondition(() => backgroundReports.length === 1)
      expect(backgroundReports[0]?.text).toBe('Background daemon finished cleanly.')
      // Root is NOT yet terminal while inside `waitForRootOutput()`, so native effects are still pending.
      expect(effectStates.some((e) => e.state === 'settled')).toBe(false)

      releaseRootOutput()
      const events = await runPromise
      expect(events.at(-1)).toMatchObject({ type: 'turn.completed', outcome: 'completed' })
      expect(effectStates.some((e) => e.state === 'settled')).toBe(true)
      expect(adapter.hasActiveBackgroundWork(runId)).toBe(false)
    } finally {
      releaseRootOutput()
      await adapter.dispose()
    }
  })

  it('persists Open-mode publish_plan final intent synchronously before HTTP 200 OK, rolls back on error, and records negative unavailability even with unknownEffectsReported', async () => {
    const { cwd, appDataDir } = await createWave3Env()
    const nativeSessionId = randomUUID()
    const trajId = randomUUID()
    const pactSessionId = randomUUID()
    const runId = randomUUID()
    const harness = createAcpHarness()
    let mcpUrl = ''
    let mcpServerName = ''
    const persistedIntents: Array<{
      executionId?: string | undefined
      callKey: string
      progressToken?: string | undefined
      candidateMarkdown: string
    }> = []
    let failFirstIntentPersist = true
    let firstPublishErr: boolean | undefined
    let retryPublishErr: boolean | undefined
    let unavailableCount = 0

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        const servers = (frame.params as { mcpServers?: Array<{ name: string; url: string }> })
          .mcpServers
        mcpUrl = servers?.[0]?.url ?? ''
        mcpServerName = servers?.[0]?.name ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        const callPublish = async (tcId: string, token: string, text: string) => {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: tcId,
                name: `mcp_${mcpServerName}_publish_plan`,
                status: 'in_progress',
                args: { text, offset: 0, complete: true },
                _meta: { progressToken: token },
              },
            },
          })
          const res = (await (
            await fetch(mcpUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: tcId,
                method: 'tools/call',
                params: {
                  name: 'publish_plan',
                  arguments: { text, offset: 0, complete: true },
                  _meta: {
                    progressToken: token,
                    'antigravity.google/root_conversation_id': nativeSessionId,
                    'antigravity.google/conversation_id': nativeSessionId,
                  },
                },
              }),
            })
          ).json()) as { result: { isError?: boolean } }
          return res.result.isError
        }

        // 1st attempt: synchronous intent persistence throws -> HTTP returns isError: true and rolls back pending final chunk!
        firstPublishErr = await callPublish('tc-pub-1', `${trajId}:1`, '# Plan v1')
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-pub-1',
              name: `mcp_${mcpServerName}_publish_plan`,
              status: 'failed',
            },
          },
        })

        // 2nd attempt: persistence succeeds BEFORE HTTP 200 OK; do NOT emit ACP `completed` for tc-pub-2 AND
        // trigger uncertain effects via 9 concurrent file-change observations so `unknownEffectsReported = true`!
        retryPublishErr = await callPublish('tc-pub-2', `${trajId}:2`, '# Plan v2')
        for (let i = 0; i < 9; i += 1) {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: `tc-file-${i}`,
                name: 'write_file',
                status: 'completed',
                args: { TargetFile: join(cwd, `f-${i}.ts`), CodeContent: 'export const x = 1\n' },
              },
            },
          })
        }
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const { task, authorization } = makeCollaborationTask(
      pactSessionId,
      runId,
      'collaborate',
      'build',
    )
    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: {
        readTrajectoryIdentity: async () => ({
          status: 'ok',
          trajectoryId: trajId,
          stepCount: 0,
        }),
      },
    })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            permissionMode: 'auto',
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: randomUUID(), content: 'Update the plan.' },
              comments: [],
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              effects: {
                recordFileChange: async () => {
                  await new Promise((r) => setTimeout(r, 25))
                },
              },
              workflow: {
                recordOpenPlanFinalIntent: (intent) => {
                  if (failFirstIntentPersist) {
                    failFirstIntentPersist = false
                    throw new Error('simulated sqlite write failure')
                  }
                  persistedIntents.push(intent)
                  return true
                },
                recordPlanUnavailable: () => {
                  unavailableCount += 1
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      expect(firstPublishErr).toBe(true)
      expect(retryPublishErr).toBeUndefined()
      expect(persistedIntents).toHaveLength(1)
      expect(persistedIntents[0]?.candidateMarkdown).toBe('# Plan v2')
      expect(persistedIntents[0]?.progressToken).toBe(`${trajId}:2`)
      // Negative plan unavailability MUST still be recorded even when `unknownEffectsReported` was triggered!
      expect(unavailableCount).toBeGreaterThanOrEqual(1)
    } finally {
      await adapter.dispose()
    }
  })

  it('delegates cold Brain Plan fallback strictly to storageClient.inspectRun and treats invalid_reply as unknown delivery', async () => {
    const { cwd, appDataDir } = await createWave3Env()

    // Subcase A: Cold Brain Plan fallback via storageClient.inspectRun (never direct fs.open!)
    {
      const nativeSessionId = randomUUID()
      const pactSessionId = randomUUID()
      const runId = randomUUID()
      const harness = createAcpHarness()
      let inspectCalls = 0
      const recordedPlans: Array<{ nativeId: string; text: string }> = []

      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-plan-edit',
                name: 'edit_file',
                status: 'completed',
                executionId: 'exec-brain-1',
                args: {
                  Path: join(appDataDir, 'brain', nativeSessionId, 'implementation_plan.md'),
                  ArtifactMetadata: {
                    Summary: 'Draft plan',
                    UserFacing: true,
                    RequestFeedback: true,
                  },
                },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', executionId: 'exec-brain-1' },
          })
        }
      })

      const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan')
      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => harness.child,
        storageClient: {
          readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }),
          inspectRun: async (req) => {
            inspectCalls += 1
            expect(req.includePlan).toBe(true)
            return {
              exists: true,
              terminalState: {
                executionId: 'exec-brain-1',
                status: 'completed',
                plan: {
                  nativeId: `${nativeSessionId}:implementation_plan`,
                  text: '# Isolated Brain Plan\nStep 1',
                },
              },
            }
          },
        },
      })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId: pactSessionId,
              runId,
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId: pactSessionId,
                message: { id: randomUUID(), content: 'Draft plan.' },
                comments: [],
                collaboration: task,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  recordPlan: (plan) => recordedPlans.push(plan),
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(inspectCalls).toBe(1)
        expect(recordedPlans).toEqual([
          {
            nativeId: `${nativeSessionId}:implementation_plan`,
            text: '# Isolated Brain Plan\nStep 1',
          },
        ])
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase B: Malformed session/prompt reply (`physicalOutcome === 'invalid_reply'`) reports unknown delivery, NEVER confirmed unsent!
    {
      const nativeSessionId = randomUUID()
      const harness = createAcpHarness()
      let unsentRecorded = false
      const effectStates: string[] = []

      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          // Malformed JSON-RPC response containing both result and error -> `physicalOutcome === 'invalid_reply'`.
          harness.sendRawStdout(
            `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' }, error: { code: -1, message: 'bad' } })}\n`,
          )
        }
      })

      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => harness.child,
        storageClient: { readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }) },
      })
      try {
        await expect(
          collectEvents(
            adapter.run(
              makeBaseRunInput(cwd, {
                host: {
                  effects: {
                    reportNativeEffects: (r) => effectStates.push(r.state),
                  },
                  recovery: {
                    inputSha256: 'd'.repeat(64),
                    recordEffectiveSettings: () => undefined,
                    recordConfirmedUnsent: () => {
                      unsentRecorded = true
                    },
                  },
                },
              }),
              new AbortController().signal,
            ),
          ),
        ).rejects.toThrow(/both result and error|protocol/iu)
        expect(unsentRecorded).toBe(false)
        expect(effectStates).toContain('unknown')
      } finally {
        await adapter.dispose()
      }
    }
  })
})

function makeDeepNestedArgs(leaf: string): Record<string, unknown> {
  let current: Record<string, unknown> = { leaf }
  for (let i = 0; i < 15; i += 1) {
    current = { nested: current }
  }
  return current
}

describe('AgyAgentAdapter Round-5 audit regressions', () => {
  const r5TempDirs: string[] = []
  afterEach(async () => {
    while (r5TempDirs.length > 0) {
      const dir = r5TempDirs.pop()!
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('intersects AgentCollaborationSourceReader supportedForms with implemented methods', () => {
    const readerBoth = {
      readSource: () => ({
        source: 'inputs',
        totalBytes: 0,
        totalLines: 0,
        offset: 0,
        text: '',
        hasMore: false,
      }),
      readNativeSource: () => ({
        source: 'inputs',
        totalBytes: 0,
        totalLines: 0,
        offset: 0,
        text: '',
        hasMore: false,
      }),
      supportedForms: ['sourceReference'] as const,
    }
    const capRestricted = resolveAgentCollaborationSourceCapability({
      sourceReader: readerBoth as unknown as NonNullable<
        NonNullable<NonNullable<AgentRunInput['host']>['workflow']>['sourceReader']
      >,
    })
    expect(capRestricted).toEqual({
      nativeRoot: false,
      sourceReference: true,
      legacy: false,
      forms: ['sourceReference'],
      tier: 'sourceReference',
    })

    const readerNativeOnly = {
      readSource: () => ({
        source: 'inputs',
        text: '',
        offset: 0,
        nextOffset: null,
      }),
      supportedForms: ['nativeRoot'] as const,
    }
    const capNoMethod = resolveAgentCollaborationSourceCapability({
      sourceReader: readerNativeOnly as unknown as NonNullable<
        NonNullable<NonNullable<AgentRunInput['host']>['workflow']>['sourceReader']
      >,
    })
    expect(capNoMethod).toEqual({
      nativeRoot: false,
      sourceReference: false,
      legacy: false,
      forms: [],
      tier: 'none',
    })
  })

  it('rejects foreign/contradictory permission and elicitation server requests before recordDispatch(accepted), auto-allow, or prompting user', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pact-agy-r5-server-req-'))
    const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-r5-server-req-data-'))
    r5TempDirs.push(cwd, appDataDir)

    const nativeSessionId = randomUUID()
    const foreignSessionId = randomUUID()
    const harness = createAcpHarness()
    let acceptedCount = 0
    let acceptedCountBeforeReply = -1
    let permissionPromptCalls = 0
    let userInputPromptCalls = 0
    const serverResponses: Array<Record<string, unknown>> = []

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        // 1. Contradictory permission request (foreign session alias inside _meta) BEFORE any accepted update:
        //    MUST be rejected BEFORE recordDispatch('accepted') and BEFORE requestPermission!
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'perm-foreign-meta',
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            _meta: { 'antigravity.google/conversation_id': foreignSessionId },
            toolCall: { toolCallId: 'tc-bad-1', title: 'Write file', kind: 'edit' },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          },
        })
        // 2. Contradictory elicitation/create (foreign session alias inside _meta):
        //    MUST be rejected BEFORE requestUserInput!
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 'elicit-foreign-meta',
          method: 'elicitation/create',
          params: {
            sessionId: nativeSessionId,
            _meta: { 'antigravity.google/conversation_id': foreignSessionId },
            message: 'Foreign question?',
            requestedSchema: {
              type: 'object',
              properties: { answer: { type: 'string', title: 'Answer' } },
              required: ['answer'],
            },
          },
        })
        // 3. Snapshot acceptedCount AFTER both foreign server requests are processed and BEFORE end_turn!
        setTimeout(() => {
          acceptedCountBeforeReply = acceptedCount
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
        }, 25)
      } else if (frame.id === 'perm-foreign-meta' || frame.id === 'elicit-foreign-meta') {
        serverResponses.push(frame)
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: { readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }) },
    })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            host: {
              lifecycle: {
                recordDispatch: (phase) => {
                  if (phase === 'accepted') acceptedCount += 1
                },
              },
              interactions: {
                requestPermission: async () => {
                  permissionPromptCalls += 1
                  return 'allow'
                },
                requestUserInput: async () => {
                  userInputPromptCalls += 1
                  return { action: 'accept', content: { answer: 'yes' } }
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      expect(acceptedCountBeforeReply).toBe(0)
      expect(permissionPromptCalls).toBe(0)
      expect(userInputPromptCalls).toBe(0)
      const permResp = serverResponses.find((r) => r.id === 'perm-foreign-meta')
      expect(permResp?.result).toEqual({ outcome: { outcome: 'cancelled' } })
      const elicitResp = serverResponses.find((r) => r.id === 'elicit-foreign-meta')
      expect(elicitResp?.result).toEqual({ action: 'cancel' })
    } finally {
      await adapter.dispose()
    }
  })

  it('blocks contradictory text/steer projection, prevents substring prompt binding, and fails closed on unresolved substantive pre-bind frames', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pact-agy-r5-attrib-'))
    const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-r5-attrib-data-'))
    r5TempDirs.push(cwd, appDataDir)

    const nativeSessionId = randomUUID()
    const foreignSessionId = randomUUID()
    const harness = createAcpHarness()
    const effectStates: string[] = []

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/load') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        // 0. Substantive frame with unverified executionId on a resumed session (staged pre-bind!)
        //    arriving BEFORE any foreign turn -> remains unresolved at terminal reply!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              executionId: 'exec-ambiguous-unverified',
              content: { type: 'text', text: 'UNRESOLVED_PREBIND_TEXT' },
            },
          },
        })
        // 1. Substring echo of our prompt ("hello") inside a different prompt MUST NOT bind exec-foreign!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              executionId: 'exec-foreign-1',
              content: { type: 'text', text: 'Earlier unrelated turn mentioning hello inside it' },
            },
          },
        })
        // 2. Execution-less substantive assistant text arriving while foreign turn is active -> never projected!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'FOREIGN_EXECUTIONLESS_TEXT' },
            },
          },
        })
        // 3. Contradictory session alias frame -> MUST NOT append text!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            _meta: { 'antigravity.google/conversation_id': foreignSessionId },
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'CONTRADICTORY_META_TEXT' },
            },
          },
        })
        // 4. Terminal reply arrives WITHOUT binding root execution while substantive pre-bind frame remains unresolved!
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
      storageClient: { readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }) },
    })
    try {
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            nativeSessionId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: randomUUID(),
              message: { id: randomUUID(), content: 'hello' },
              comments: [],
            },
            host: {
              effects: {
                reportNativeEffects: (r) => effectStates.push(r.state),
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      const deltas = events
        .filter(
          (e): e is Extract<NormalizedAgentEvent, { type: 'text.delta' }> =>
            e.type === 'text.delta',
        )
        .map((e) => e.text)
        .join('')
      expect(deltas).not.toContain('UNRESOLVED_PREBIND_TEXT')
      expect(deltas).not.toContain('FOREIGN_EXECUTIONLESS_TEXT')
      expect(deltas).not.toContain('CONTRADICTORY_META_TEXT')
      // Because substantive pre-bind frame stayed unresolved at terminal reply, adapter MUST report unknown!
      expect(effectStates).toContain('unknown')
    } finally {
      await adapter.dispose()
    }
  })

  it('invalidates earlier Phase-1 Brain Plan candidate when a later deferred edit_file starts and bypasses cachedEnded on inspectMissingPlan', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pact-agy-r5-brain-'))
    const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-r5-brain-data-'))
    r5TempDirs.push(cwd, appDataDir)

    const nativeSessionId = randomUUID()
    const runId = randomUUID()
    const pactSessionId = randomUUID()
    const brainPlanPath = join(appDataDir, 'brain', nativeSessionId, 'implementation_plan.md')
    await mkdir(join(appDataDir, 'brain', nativeSessionId), { recursive: true })
    await writeFile(brainPlanPath, '# Plan B From Storage Readback\nUpdated.', 'utf8')

    const harness = createAcpHarness()
    let inspectCalls = 0
    const recordedPlans: Array<{ nativeId: string; text: string }> = []
    let coldStorageHasPlan = false

    const { task, authorization } = makeCollaborationTask(pactSessionId, runId, 'plan')

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        // 1. Initial write_file captures Plan A inline.
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'brain-write-1',
              name: 'write_file',
              status: 'in_progress',
              executionId: 'exec-brain-r5',
              args: {
                Path: brainPlanPath,
                Content: '# Plan A (Stale)',
                ArtifactMetadata: {
                  Summary: 'Plan A',
                  UserFacing: true,
                  RequestFeedback: true,
                },
              },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'brain-write-1',
              name: 'write_file',
              status: 'completed',
              executionId: 'exec-brain-r5',
              content: [{ type: 'diff', path: brainPlanPath, newText: '# Plan A (Stale)' }],
            },
          },
        })
        // 2. Subsequent edit_file on the SAME Brain plan path completes WITHOUT inline diff ->
        //    MUST invalidate Plan A so readback is NOT skipped!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'brain-edit-2',
              name: 'edit_file',
              status: 'in_progress',
              executionId: 'exec-brain-r5',
              args: {
                Path: brainPlanPath,
                ArtifactMetadata: {
                  Summary: 'Plan B',
                  UserFacing: true,
                  RequestFeedback: true,
                },
              },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'brain-edit-2',
              name: 'edit_file',
              status: 'completed',
              executionId: 'exec-brain-r5',
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn', executionId: 'exec-brain-r5' },
        })
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: {
        readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }),
        inspectRun: async () => {
          inspectCalls += 1
          return {
            exists: true,
            terminalState: {
              executionId: 'exec-brain-r5',
              status: 'completed',
              plan: {
                nativeId: `${nativeSessionId}:implementation_plan`,
                text: '# Plan B From Storage Readback\nUpdated.',
              },
            },
          }
        },
        probeSessionStatus: async (probeInput) => ({
          kind: 'ended',
          source: 'stored_terminal',
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
          outcome: 'completed',
          output: {
            outputId: 'out-r5-1',
            text: 'Done.',
            completeness: 'complete',
            ...(coldStorageHasPlan
              ? {
                  plan: {
                    nativeId: `${nativeSessionId}:implementation_plan`,
                    text: '# Plan B Recovered After Cache Bypass',
                  },
                }
              : {}),
          },
        }),
      },
    })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: randomUUID(), content: 'Draft plan' },
              comments: [],
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                recordPlan: (plan) => recordedPlans.push(plan),
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      // Storage readback MUST have run (NOT skipped due to stale Plan A!) and recorded Plan B!
      expect(inspectCalls).toBe(1)
      expect(recordedPlans.at(-1)).toEqual({
        nativeId: `${nativeSessionId}:implementation_plan`,
        text: '# Plan B From Storage Readback\nUpdated.',
      })

      // Now verify `probeNativeStatus({ inspectMissingPlan: true })` bypasses `cachedEnded` lacking Plan!
      const missingPlanRunId = randomUUID()
      const cachedNoPlanCheck = await adapter.probeNativeStatus(
        {
          agentId: 'agy',
          sessionId: pactSessionId,
          requestId: randomUUID(),
          runId: missingPlanRunId,
          nativeSessionId,
          nativeTurnId: 'exec-cache-test',
          bindingGeneration: 1,
          executorId: adapter.executorId,
          cwd,
          model: null,
          effort: null,
        },
        new AbortController().signal,
      )
      expect(cachedNoPlanCheck.kind).toBe('ended')
      expect(
        cachedNoPlanCheck.kind === 'ended' ? cachedNoPlanCheck.output?.plan : 'bad',
      ).toBeUndefined()

      // Seed plan in storage and query again with `inspectMissingPlan: true` -> MUST bypass cache!
      coldStorageHasPlan = true
      const recoveredCheck = await adapter.probeNativeStatus(
        {
          agentId: 'agy',
          sessionId: pactSessionId,
          requestId: randomUUID(),
          runId: missingPlanRunId,
          nativeSessionId,
          nativeTurnId: 'exec-cache-test',
          bindingGeneration: 1,
          executorId: adapter.executorId,
          cwd,
          model: null,
          effort: null,
          inspectMissingPlan: true,
        },
        new AbortController().signal,
      )
      expect(recoveredCheck).toMatchObject({
        kind: 'ended',
        output: {
          plan: {
            nativeId: `${nativeSessionId}:implementation_plan`,
            text: '# Plan B Recovered After Cache Bypass',
          },
        },
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('requires confirmed preceding chunks before Open Mode final publish_plan, rolls back on false persistence, rejects invalid UTF-8 HTTP MCP bodies, and closes hung header sockets on run exit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pact-agy-r5-mcp-'))
    const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-r5-mcp-data-'))
    r5TempDirs.push(cwd, appDataDir)

    const nativeSessionId = randomUUID()
    const runId = randomUUID()
    const pactSessionId = randomUUID()
    const trajId = 'traj-r5-mcp'
    const harness = createAcpHarness()

    const baseOpen = makeCollaborationTask(pactSessionId, runId, 'collaborate')
    const task: CollaborationTask = {
      ...baseOpen.task,
      openMode: true,
      planVersion: 1,
    }
    const authorization: CollaborationTurnAuthorization = {
      ...baseOpen.authorization,
      stage: 'collaborate',
      actor: 'agy',
    }

    let mcpUrl = ''
    let mcpName = ''
    let badUtf8ErrorCode = 0
    let unconfirmedFinalErr = ''
    let rejectedPersistErr = ''
    let retryFinalOk = false
    let allowPersist = false
    let persistCalls = 0
    const publishedPlans: Array<{ nativeId: string; text: string }> = []
    let slowSocket: ReturnType<typeof netConnect> | undefined

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        const mcpServers = (frame.params as { mcpServers?: Array<{ name: string; url: string }> })
          .mcpServers
        mcpUrl = mcpServers?.[0]?.url ?? ''
        mcpName = mcpServers?.[0]?.name ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        // Open a slow-loris TCP socket sending an incomplete HTTP header to verify close() destroys it cleanly!
        const parsedUrl = new URL(mcpUrl)
        slowSocket = netConnect({ host: parsedUrl.hostname, port: Number(parsedUrl.port) })
        slowSocket.on('error', () => undefined)
        slowSocket.write('POST / HTTP/1.1\r\nHost: 127.0.0.1\r\n')

        // 1. Send valid JSON-RPC except for an invalid UTF-8 byte (0xff) inside a string ->
        //    fatal UTF-8 decoder MUST reject with JSON-RPC parse error -32700 (never decode as U+FFFD)!
        const badUtf8Body = Buffer.concat([
          Buffer.from('{"jsonrpc":"2.0","id":99,"method":"ping","params":{"s":"', 'utf8'),
          Buffer.from([0xff]),
          Buffer.from('"}}', 'utf8'),
        ])
        const invalidUtf8Resp = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: badUtf8Body,
        }).then((r) => r.json())) as { error?: { code?: number } }
        badUtf8ErrorCode = invalidUtf8Resp.error?.code ?? 0

        // Pin root trajectory via an initial ACP tool_call for chunk 0 (offset: 0, complete: false) WITHOUT completing it yet!
        const chunk0Args = { offset: 0, text: '# Part 1\n', complete: false }
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-plan-0',
              name: `mcp_${mcpName}_publish_plan`,
              status: 'in_progress',
              args: chunk0Args,
              _meta: { progressToken: `${trajId}:1` },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'publish_plan',
              arguments: chunk0Args,
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: `${trajId}:1`,
              },
            },
          }),
        })

        // 2. Send final chunk (complete: true) BEFORE chunk 0 has ACP completed -> MUST be rejected!
        const chunk1Args = {
          offset: Buffer.byteLength('# Part 1\n', 'utf8'),
          text: 'Part 2\n',
          complete: true,
        }
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-plan-1-unconfirmed',
              name: `mcp_${mcpName}_publish_plan`,
              status: 'in_progress',
              args: chunk1Args,
              _meta: { progressToken: `${trajId}:2` },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        const unconfirmedRes = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'publish_plan',
              arguments: chunk1Args,
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: `${trajId}:2`,
              },
            },
          }),
        }).then((r) => r.json())) as {
          result?: { isError?: boolean; content?: Array<{ text?: string }> }
        }
        unconfirmedFinalErr = unconfirmedRes.result?.isError
          ? (unconfirmedRes.result.content?.[0]?.text ?? 'err')
          : ''

        // Now complete chunk 0 in ACP!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-plan-0',
              name: `mcp_${mcpName}_publish_plan`,
              status: 'completed',
              _meta: { progressToken: `${trajId}:1` },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))

        // 3. Send final chunk when `recordOpenPlanFinalIntent` returns `false` -> MUST reject & roll back!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-plan-2-rejected',
              name: `mcp_${mcpName}_publish_plan`,
              status: 'in_progress',
              args: chunk1Args,
              _meta: { progressToken: `${trajId}:3` },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        const rejectedRes = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'publish_plan',
              arguments: chunk1Args,
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: `${trajId}:3`,
              },
            },
          }),
        }).then((r) => r.json())) as {
          result?: { isError?: boolean; content?: Array<{ text?: string }> }
        }
        rejectedPersistErr = rejectedRes.result?.isError
          ? (rejectedRes.result.content?.[0]?.text ?? 'err')
          : ''

        // 4. Now allow persistence (`return true`) and retry final chunk -> MUST succeed and promote!
        allowPersist = true
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-plan-3-ok',
              name: `mcp_${mcpName}_publish_plan`,
              status: 'in_progress',
              args: chunk1Args,
              _meta: { progressToken: `${trajId}:4` },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        const retryRes = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: {
              name: 'publish_plan',
              arguments: chunk1Args,
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
                progressToken: `${trajId}:4`,
              },
            },
          }),
        }).then((r) => r.json())) as { result?: { isError?: boolean } }
        retryFinalOk = !retryRes.result?.isError

        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-plan-3-ok',
              name: `mcp_${mcpName}_publish_plan`,
              status: 'completed',
              _meta: { progressToken: `${trajId}:4` },
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
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
      storageClient: { readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }) },
    })
    try {
      const startMs = Date.now()
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId: pactSessionId,
            runId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: pactSessionId,
              message: { id: randomUUID(), content: 'Publish plan' },
              comments: [],
              collaboration: task,
              collaborationAuthorization: authorization,
            },
            host: {
              workflow: {
                recordPlan: (plan) => publishedPlans.push(plan),
                recordOpenPlanFinalIntent: () => {
                  persistCalls += 1
                  return allowPersist
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      // Run finalized cleanly without hanging on the slow-loris socket!
      expect(Date.now() - startMs).toBeLessThan(3_000)
      expect(badUtf8ErrorCode).toBe(-32_700)
      expect(unconfirmedFinalErr).toMatch(/preceding Plan chunks must complete/iu)
      expect(rejectedPersistErr).toMatch(/rejected/iu)
      expect(persistCalls).toBe(2)
      expect(retryFinalOk).toBe(true)
      expect(publishedPlans).toEqual([
        {
          nativeId: `${nativeSessionId}:tc-plan-3-ok`,
          text: '# Part 1\nPart 2\n',
        },
      ])
    } finally {
      slowSocket?.destroy()
      await adapter.dispose()
    }
  })

  it('vetoes background alias matches on contradictory executionId and records explicit unavailability beyond 64 reports', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pact-agy-r5-bg-'))
    const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-r5-bg-data-'))
    r5TempDirs.push(cwd, appDataDir)

    const nativeSessionId = randomUUID()
    const harness = createAcpHarness()
    const recordedReports: NativeBackgroundReport[] = []
    let unavailableCount = 0
    const effectStates: string[] = []
    let sendPostTurnUpdates!: () => void

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        // Bind root executionId = 'exec-bg-owner' and start an active background daemon task 'bg-task-1'.
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'bg-tc-1',
              name: 'run_command',
              status: 'pending',
              executionId: 'exec-bg-owner',
              args: { CommandLine: 'pnpm watch', IsDaemon: true },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'bg-tc-1',
              name: 'run_command',
              status: 'completed',
              executionId: 'exec-bg-owner',
              args: { CommandLine: 'pnpm watch', IsDaemon: true },
              rawOutput: { taskId: 'bg-task-1' },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn', executionId: 'exec-bg-owner' },
        })
        sendPostTurnUpdates = () => {
          // 1. Conflicting executionId with SAME toolCallId/taskId alias -> MUST be vetoed!
          //    Neither persists report NOR settles bg-task-1!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'background_task_completed',
                toolCallId: 'bg-tc-1',
                taskId: 'bg-task-1',
                executionId: 'exec-DIFFERENT-NEW-TURN',
                messageId: 'bg-msg-foreign',
                content: { type: 'text', text: 'FOREIGN_BG_REPORT' },
              },
            },
          })
          // 2. Flood 65 distinct valid background reports for 'exec-bg-owner' ->
          //    First 64 persist; 65th MUST trigger recordBackgroundReportUnavailable + unknown effects!
          for (let i = 0; i < 65; i += 1) {
            harness.sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: nativeSessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  outOfTurn: true,
                  executionId: 'exec-bg-owner',
                  messageId: `bg-valid-msg-${i}`,
                  content: { type: 'text', text: `Report #${i}` },
                },
              },
            })
          }
        }
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: { readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }) },
    })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            host: {
              effects: {
                recordBackgroundReport: async (report) => {
                  recordedReports.push(report)
                },
                recordBackgroundReportUnavailable: () => {
                  unavailableCount += 1
                },
                reportNativeEffects: (r) => effectStates.push(r.state),
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      sendPostTurnUpdates()
      await vi.waitFor(() => {
        expect(recordedReports.length).toBe(64)
        expect(unavailableCount).toBeGreaterThanOrEqual(1)
      })
      expect(recordedReports.some((r) => r.text.includes('FOREIGN_BG_REPORT'))).toBe(false)
      expect(effectStates).toContain('unknown')
      expect(effectStates).not.toContain('settled')
    } finally {
      await adapter.dispose()
    }
  })

  it('rejects over-depth (>12) tool arguments instead of colliding on [max-depth] and charges null array slots', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pact-agy-r5-depth-'))
    const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-r5-depth-data-'))
    r5TempDirs.push(cwd, appDataDir)

    const nativeSessionId = randomUUID()
    const harness = createAcpHarness()
    let deepArgsTitleError = false

    let mcpUrl = ''
    let mcpName = ''
    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        const mcpServers = (frame.params as { mcpServers?: Array<{ name: string; url: string }> })
          .mcpServers
        mcpUrl = mcpServers?.[0]?.url ?? ''
        mcpName = mcpServers?.[0]?.name ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        // 1. Send an ACP tool_call with over-depth (>12) args AND an oversized null array in rawOutput:
        //    over-depth args MUST NOT match a normal MCP title call (no '[max-depth]' collision),
        //    and huge null-array rawOutput MUST be dropped/bounded by per-slot byte charging!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-deep-1',
              name: `mcp_${mcpName}_publish_session_title`,
              status: 'in_progress',
              args: { title: 'Title A', extra: makeDeepNestedArgs('A') },
              rawOutput: Array.from({ length: 40_000 }, () => null),
            },
          },
        })
        await new Promise((r) => setTimeout(r, 15))
        // Call MCP with different deep leaf 'B' -> MUST fail correlation (over-depth rejected, never collides)!
        const res = (await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'publish_session_title',
              arguments: { title: 'Title A', extra: makeDeepNestedArgs('B') },
              _meta: {
                'antigravity.google/root_conversation_id': nativeSessionId,
                'antigravity.google/conversation_id': nativeSessionId,
              },
            },
          }),
        }).then((r) => r.json())) as { result?: { isError?: boolean } }
        deepArgsTitleError = Boolean(res.result?.isError)

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
      storageClient: { readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }) },
    })
    try {
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: randomUUID(),
              message: { id: randomUUID(), content: 'Hello' },
              comments: [],
              requestSessionTitle: true,
            },
          }),
          new AbortController().signal,
        ),
      )
      expect(deepArgsTitleError).toBe(true)
      expect(events.some((e) => e.type === 'session.title.updated')).toBe(false)
    } finally {
      await adapter.dispose()
    }
  })
})

describe('AgyAgentAdapter Wave-6 audit regressions', () => {
  const w6TempDirs: string[] = []
  afterEach(async () => {
    await Promise.all(w6TempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('contradictory first frame does not bind or poison real executionId, and foreign-turn unscoped/malformed server requests reject before dispatch(accepted)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pact-agy-w6-bind-'))
    const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-w6-bind-data-'))
    w6TempDirs.push(cwd, appDataDir)

    const nativeSessionId = randomUUID()
    const harness = createAcpHarness()
    const dispatchPhases: string[] = []
    let permissionCalls = 0
    let elicitationCalls = 0
    const serverReplies: Array<{ id: unknown; result?: unknown; error?: unknown }> = []

    harness.onClientFrame((frame) => {
      if (frame.id !== undefined && frame.method === undefined) {
        serverReplies.push({ id: frame.id, result: frame.result, error: frame.error })
        return
      }
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/load' || frame.method === 'session/new') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        // 1. Contradictory first frame (matching top-level sessionId, conflicting _meta sessionId)
        //    carrying `exec-real` -> MUST NOT bind `exec-real` and MUST NOT add `exec-real` to knownForeignExecutionIds!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            _meta: { sessionId: 'foreign-session-conflict' },
            update: {
              sessionUpdate: 'agent_message_chunk',
              executionId: 'exec-real',
              content: { type: 'text', text: 'POISONED_CONTRADICTORY' },
            },
          },
        })
        // 2. Foreign turn starts before root binds (sets foreignTurnActiveUntilRootBound = true).
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              executionId: 'exec-foreign-1',
              content: { type: 'text', text: 'Different prompt from another client' },
            },
          },
        })
        // 3. Unscoped permission & elicitation during foreignTurnActiveUntilRootBound -> MUST reject before accepted!
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 901,
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: { toolCallId: 'tc-foreign-perm', title: 'Write file', kind: 'edit' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 902,
          method: 'elicitation/create',
          params: {
            sessionId: nativeSessionId,
            message: 'Foreign question',
            requestedSchema: {
              type: 'object',
              properties: { choice: { type: 'string' } },
            },
          },
        })
        // 4. Malformed elicitation payload (missing requestedSchema) -> MUST reject before accepted!
        harness.sendToClient({
          jsonrpc: '2.0',
          id: 903,
          method: 'elicitation/create',
          params: {
            sessionId: nativeSessionId,
            executionId: 'exec-real',
            message: 'Malformed elicitation',
          },
        })
        // 5. Real root prompt echo & text carrying `exec-real` -> MUST bind cleanly (was NOT poisoned)!
        const promptBlocks = (frame.params as { prompt?: Array<{ type?: string; text?: string }> })
          .prompt
        const sentPromptText = promptBlocks?.find((b) => b.type === 'text')?.text ?? ''
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              executionId: 'exec-real',
              content: { type: 'text', text: sentPromptText },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              executionId: 'exec-real',
              content: { type: 'text', text: 'REAL_ANSWER_OK' },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { stopReason: 'end_turn', executionId: 'exec-real' },
        })
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: { readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }) },
    })
    try {
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            nativeSessionId,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: randomUUID(),
              message: { id: randomUUID(), content: 'Real Wave 6 prompt' },
              comments: [],
            },
            host: {
              lifecycle: {
                recordDispatch: (phase) => dispatchPhases.push(phase),
              },
              interactions: {
                requestPermission: async () => {
                  permissionCalls += 1
                  return 'allow'
                },
                requestUserInput: async () => {
                  elicitationCalls += 1
                  return { action: 'accept', content: { choice: 'yes' } }
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      const textCompleted = events.find((e) => e.type === 'text.completed')
      expect(textCompleted).toMatchObject({ type: 'text.completed', text: 'REAL_ANSWER_OK' })
      expect(permissionCalls).toBe(0)
      expect(elicitationCalls).toBe(0)
      // All 3 rejected server requests (901, 902, 903) got negative terminal replies without prompting the user!
      expect(serverReplies.map((r) => r.id)).toEqual(expect.arrayContaining([901, 902, 903]))
      expect(dispatchPhases).toContain('accepted')
    } finally {
      await adapter.dispose()
    }
  })

  it('aborts in-flight permission & elicitation immediately when session/prompt replies and rejects conflicting executionId aliases in terminal reply', async () => {
    // Subcase A: In-flight permission & elicitation abort immediately on promptReplyReceived.
    {
      const cwd = await mkdtemp(join(tmpdir(), 'pact-agy-w6-postreply-'))
      const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-w6-postreply-data-'))
      w6TempDirs.push(cwd, appDataDir)

      const nativeSessionId = randomUUID()
      const harness = createAcpHarness()
      const serverReplies = new Map<unknown, { result?: unknown; error?: unknown }>()
      let permAborted = false
      let elicitAborted = false
      let resolvePerm!: (val: string) => void
      let resolveElicit!: (val: { action: 'accept'; content: Record<string, string> }) => void
      let permPrompted!: () => void
      let elicitPrompted!: () => void
      const bothPrompted = Promise.all([
        new Promise<void>((r) => {
          permPrompted = r
        }),
        new Promise<void>((r) => {
          elicitPrompted = r
        }),
      ])

      harness.onClientFrame(async (frame) => {
        if (frame.id !== undefined && frame.method === undefined) {
          serverReplies.set(frame.id, { result: frame.result, error: frame.error })
          return
        }
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 701,
            method: 'session/request_permission',
            params: {
              sessionId: nativeSessionId,
              toolCall: { toolCallId: 'tc-late-perm', title: 'Edit file', kind: 'edit' },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: 702,
            method: 'elicitation/create',
            params: {
              sessionId: nativeSessionId,
              message: 'Pick option',
              requestedSchema: {
                type: 'object',
                properties: { ans: { type: 'string' } },
              },
            },
          })
          await bothPrompted
          // Terminal prompt reply arrives while both interactive prompts are STILL in flight!
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn' },
          })
          await new Promise((r) => setTimeout(r, 15))
          // Late user approvals after prompt reply MUST NOT approve!
          resolvePerm('allow')
          resolveElicit({ action: 'accept', content: { ans: 'late-yes' } })
        }
      })

      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => harness.child,
        storageClient: { readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }) },
      })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              permissionMode: 'ask',
              host: {
                interactions: {
                  requestPermission: (_req, sig) =>
                    new Promise((done) => {
                      sig.addEventListener(
                        'abort',
                        () => {
                          permAborted = true
                        },
                        { once: true },
                      )
                      resolvePerm = done
                      permPrompted()
                    }),
                  requestUserInput: (_req, sig) =>
                    new Promise((done) => {
                      sig.addEventListener(
                        'abort',
                        () => {
                          elicitAborted = true
                        },
                        { once: true },
                      )
                      resolveElicit = done
                      elicitPrompted()
                    }),
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(permAborted).toBe(true)
        expect(elicitAborted).toBe(true)
        expect(serverReplies.get(701)?.result).toEqual({ outcome: { outcome: 'cancelled' } })
        expect(serverReplies.get(702)?.result).toEqual({ action: 'cancel' })
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase B: Terminal session/prompt reply with conflicting executionId vs execution_id fails with protocol_error.
    {
      const cwd = await mkdtemp(join(tmpdir(), 'pact-agy-w6-termalias-'))
      const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-w6-termalias-data-'))
      w6TempDirs.push(cwd, appDataDir)

      const nativeSessionId = randomUUID()
      const harness = createAcpHarness()
      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              stopReason: 'end_turn',
              executionId: 'exec-A',
              execution_id: 'exec-B',
            },
          })
        }
      })

      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => harness.child,
        storageClient: { readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }) },
      })
      try {
        await expect(
          collectEvents(adapter.run(makeBaseRunInput(cwd), new AbortController().signal)),
        ).rejects.toThrow(/conflicting execution/iu)
      } finally {
        await adapter.dispose()
      }
    }
  })

  it('rejects foreign/conflicting session metadata during control ops & replay, rejects incomplete visible prefix from turn.completed(completed), and enforces background _meta/progressToken/minStepIdx validation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pact-agy-w6-meta-bg-'))
    const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-w6-meta-bg-data-'))
    w6TempDirs.push(cwd, appDataDir)

    const nativeSessionId = randomUUID()
    const trajId = randomUUID()
    const harness = createAcpHarness()
    const observedTitles: string[] = []
    const recordedEvidence: Array<unknown> = []
    const recordedBgReports: NativeBackgroundReport[] = []
    let sendBgUpdates!: () => void

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/load') {
        // Send a spoofed session_info_update with conflicting _meta sessionId during session/load replay -> MUST be ignored!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            _meta: { sessionId: 'foreign-replay-session' },
            update: {
              sessionUpdate: 'session_info_update',
              title: 'SPOOFED_REPLAY_TITLE',
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        // 1. Send visible text prefix BEFORE any executionId binds, plus a substantive pre-bind frame that stays unresolved
        //    because foreign turn starts and terminal reply omits executionId!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Visible partial prefix' },
            },
          },
        })
        // Stage an execution-bearing substantive frame BEFORE root binds, and omit executionId from terminal reply
        // so `stagedPreBindNotifications` retains unresolved substantive work -> `unresolvedPreBindOutput = true`!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              executionId: 'exec-staged-unresolved',
              content: { type: 'text', text: 'UNRESOLVED_STAGED_CHUNK' },
            },
          },
        })
        // Also start a background task bound to stepIdx >= 10 (minStepIdx = 10 from storageClient below)
        // and send an oversized-key (>2048 keys) tool call to verify pre-sort key-cap rejection!
        const wideArgs: Record<string, number> = {}
        for (let i = 0; i < 2100; i += 1) {
          wideArgs[`k${i}`] = i
        }
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-wide-args',
              name: 'run_command',
              status: 'in_progress',
              args: wideArgs,
            },
          },
        })

        sendBgUpdates = () => {
          // Bad background update #1: non-object `_meta` -> MUST be rejected!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              _meta: 'invalid-meta-string',
              update: {
                sessionUpdate: 'background_task_completed',
                taskId: 'bg-1',
                summary: 'BAD_META_REPORT',
              },
            },
          })
          // Bad background update #2: pre-boundary stepIdx (< minStepIdx = 10) -> MUST be rejected!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              _meta: { progressToken: `${trajId}:5` },
              update: {
                sessionUpdate: 'background_task_completed',
                taskId: 'bg-2',
                summary: 'PRE_BOUNDARY_STEP_REPORT',
              },
            },
          })
          // Bad background update #3: malformed progressToken -> MUST be rejected!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              _meta: { progressToken: `${trajId}:007` },
              update: {
                sessionUpdate: 'background_task_completed',
                taskId: 'bg-3',
                summary: 'LEADING_ZERO_TOKEN_REPORT',
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
      storageClient: {
        readTrajectoryIdentity: async () => ({
          status: 'ok',
          trajectoryId: trajId,
          stepCount: 10,
        }),
      },
    })
    try {
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            nativeSessionId,
            host: {
              lifecycle: {
                observeNativeTitle: (title) => observedTitles.push(title),
                recordNativeEvidence: (ev) => recordedEvidence.push(ev),
              },
              effects: {
                recordBackgroundReport: async (report) => {
                  recordedBgReports.push(report)
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      // 1. Conflicting replay session_info_update was ignored.
      expect(observedTitles).not.toContain('SPOOFED_REPLAY_TITLE')

      // 2. Incomplete visible prefix: NO `text.completed`, `turn.completed` has `outcome: 'failed'`,
      //    while `recordNativeEvidence` preserved independently verified `outcome: 'completed'` + `completeness: 'partial'`!
      expect(events.some((e) => e.type === 'text.completed')).toBe(false)
      const turnCompleted = events.find((e) => e.type === 'turn.completed')
      expect(turnCompleted).toMatchObject({ type: 'turn.completed', outcome: 'failed' })
      expect(recordedEvidence).toContainEqual(
        expect.objectContaining({
          kind: 'ended',
          outcome: 'completed',
          output: expect.objectContaining({ completeness: 'partial' }),
        }),
      )

      // 3. Invalid background updates (_meta non-object, stepIdx < minStepIdx, malformed progressToken) all rejected!
      sendBgUpdates()
      await new Promise((r) => setTimeout(r, 30))
      expect(recordedBgReports).toHaveLength(0)
    } finally {
      await adapter.dispose()
    }
  })

  it('gates Open Mode publish_plan on strict boolean persistence, latches Phase-1 overlapping Brain Plan readback, and aligns source-read capability across legacy-only and nativeRoot-only readers', async () => {
    // Subcase A: Open Mode without `recordOpenPlanFinalIntent` omits `publish_plan`; `void`-returning callback fails closed.
    {
      const cwd = await mkdtemp(join(tmpdir(), 'pact-agy-w6-openplan-'))
      const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-w6-openplan-data-'))
      w6TempDirs.push(cwd, appDataDir)

      const nativeSessionId = randomUUID()
      const trajId = randomUUID()
      const runId = randomUUID()
      const sessionId = randomUUID()
      const { task, authorization } = makeCollaborationTask(sessionId, runId, 'collaborate')
      const openTask: CollaborationTask = { ...task, openMode: true }

      const harness = createAcpHarness()
      let mcpUrl = ''
      let mcpName = ''
      let voidPersistIsError: unknown = false

      harness.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          const servers = (frame.params as { mcpServers?: Array<{ name: string; url: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          const args = { offset: 0, text: '# Void Callback Plan\n', complete: true }
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-void-plan',
                name: `mcp_${mcpName}_publish_plan`,
                status: 'in_progress',
                args,
                _meta: { progressToken: `${trajId}:1` },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 15))
          const res = (await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'publish_plan',
                arguments: args,
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: `${trajId}:1`,
                },
              },
            }),
          }).then((r) => r.json())) as { result?: { isError?: boolean } }
          voidPersistIsError = res.result?.isError
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
        storageClient: {
          readTrajectoryIdentity: async () => ({
            status: 'ok',
            trajectoryId: trajId,
            stepCount: 0,
          }),
        },
      })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId,
              runId,
              permissionMode: 'auto',
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId,
                message: { id: randomUUID(), content: 'Publish plan with void callback' },
                comments: [],
                collaboration: openTask,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  recordOpenPlanFinalIntent: () => {
                    // Intentionally return void (undefined) instead of `true`!
                  },
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(mcpName).toBe(buildAgyPactMcpServerName(runId))
        expect(voidPersistIsError).toBe(true)
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase B: Phase-1 overlapping Brain Plan write_file + edit_file latches readback required
    // so earlier write_file completing inline CANNOT overwrite verified storage readback!
    {
      const cwd = await mkdtemp(join(tmpdir(), 'pact-agy-w6-brainlatch-'))
      const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-w6-brainlatch-data-'))
      w6TempDirs.push(cwd, appDataDir)

      const nativeSessionId = randomUUID()
      const runId = randomUUID()
      const sessionId = randomUUID()
      const brainPlanPath = join(appDataDir, 'brain', nativeSessionId, 'implementation_plan.md')
      await mkdir(join(appDataDir, 'brain', nativeSessionId), { recursive: true })
      await writeFile(brainPlanPath, '# Verified Readback Plan\nFrom storage.', 'utf8')
      const { task, authorization } = makeCollaborationTask(sessionId, runId, 'plan')
      const recordedPlans: Array<{ nativeId: string; text: string }> = []
      const harness = createAcpHarness()

      harness.onClientFrame((frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          // 1. write_file starts (in_progress) with inline Content '# Stale Inline Plan'
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'brain-op-1',
                name: 'write_file',
                status: 'in_progress',
                executionId: 'exec-brain-latch',
                args: {
                  Path: brainPlanPath,
                  Content: '# Stale Inline Plan',
                  ArtifactMetadata: {
                    Summary: 'Stale',
                    UserFacing: true,
                    RequestFeedback: true,
                  },
                },
              },
            },
          })
          // 2. Overlapping edit_file starts BEFORE write_file completes -> latches brainPlanReadbackRequired!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'brain-op-2',
                name: 'edit_file',
                status: 'in_progress',
                executionId: 'exec-brain-latch',
                args: {
                  Path: brainPlanPath,
                  Target: 'Stale',
                  Replacement: 'Edited',
                  ArtifactMetadata: {
                    Summary: 'Edited Plan',
                    UserFacing: true,
                    RequestFeedback: true,
                  },
                },
              },
            },
          })
          // 3. write_file completes inline AFTER edit_file started -> MUST NOT publish stale inline body!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'brain-op-1',
                name: 'write_file',
                status: 'completed',
                executionId: 'exec-brain-latch',
                content: [{ type: 'diff', path: brainPlanPath, newText: '# Stale Inline Plan' }],
              },
            },
          })
          // 4. edit_file completes -> storage readback resolves the authoritative plan!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'brain-op-2',
                name: 'edit_file',
                status: 'completed',
                executionId: 'exec-brain-latch',
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: { stopReason: 'end_turn', executionId: 'exec-brain-latch' },
          })
        }
      })

      const adapter = new AgyAgentAdapter({
        appDataDir,
        processFactory: () => harness.child,
        storageClient: {
          readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }),
          inspectRun: async () => ({
            exists: true,
            stepCount: 4,
            terminalState: {
              executionId: 'exec-brain-latch',
              status: 'completed',
              plan: {
                nativeId: `${nativeSessionId}:brain-op-2`,
                text: '# Verified Readback Plan\nFrom storage.',
              },
            },
          }),
        },
      })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId,
              runId,
              permissionMode: 'auto',
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId,
                message: { id: randomUUID(), content: 'Draft Phase 1 Plan' },
                comments: [],
                collaboration: task,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  recordPlan: (plan) => recordedPlans.push(plan),
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(recordedPlans).toEqual([
          {
            nativeId: `${nativeSessionId}:brain-op-2`,
            text: '# Verified Readback Plan\nFrom storage.',
          },
        ])
      } finally {
        await adapter.dispose()
      }
    }

    // Subcase C: Legacy-only AgentCollaborationSourceReader advertises ONLY legacy schema & succeeds on legacy read!
    {
      const cwd = await mkdtemp(join(tmpdir(), 'pact-agy-w6-src-'))
      const appDataDir = await mkdtemp(join(tmpdir(), 'pact-agy-w6-src-data-'))
      w6TempDirs.push(cwd, appDataDir)

      const nativeSessionId = randomUUID()
      const trajId = randomUUID()
      const runId = randomUUID()
      const sessionId = randomUUID()
      const grantId = randomUUID()
      const { task, authorization } = makeCollaborationTask(sessionId, runId, 'plan_review')
      const harness = createAcpHarness()
      let mcpUrl = ''
      let mcpName = ''
      let sourceToolProps: string[] = []
      let sourceReadResp: { isError?: boolean; content?: Array<{ text?: string }> } | undefined

      harness.onClientFrame(async (frame) => {
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new') {
          const servers = (frame.params as { mcpServers?: Array<{ name: string; url: string }> })
            .mcpServers
          mcpUrl = servers?.[0]?.url ?? ''
          mcpName = servers?.[0]?.name ?? ''
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_config_option'
        ) {
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
        } else if (frame.method === 'session/prompt') {
          const listRes = (await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }),
          }).then((r) => r.json())) as {
            result?: {
              tools?: Array<{
                name: string
                inputSchema?: { properties?: Record<string, unknown> }
              }>
            }
          }
          const srcTool = listRes.result?.tools?.find((t) => t.name === 'read_collaboration_source')
          sourceToolProps = Object.keys(srcTool?.inputSchema?.properties ?? {})

          const readArgs = { runId, grant: grantId, source: 'inputs', offset: 0 }
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-legacy-src',
                name: `mcp_${mcpName}_read_collaboration_source`,
                status: 'in_progress',
                args: readArgs,
                _meta: { progressToken: `${trajId}:1` },
              },
            },
          })
          await new Promise((r) => setTimeout(r, 15))
          const callRes = (await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 11,
              method: 'tools/call',
              params: {
                name: 'read_collaboration_source',
                arguments: readArgs,
                _meta: {
                  'antigravity.google/root_conversation_id': nativeSessionId,
                  'antigravity.google/conversation_id': nativeSessionId,
                  progressToken: `${trajId}:1`,
                },
              },
            }),
          }).then((r) => r.json())) as {
            result?: { isError?: boolean; content?: Array<{ text?: string }> }
          }
          sourceReadResp = callRes.result
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
        storageClient: {
          readTrajectoryIdentity: async () => ({
            status: 'ok',
            trajectoryId: trajId,
            stepCount: 0,
          }),
        },
      })
      try {
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId,
              runId,
              permissionMode: 'auto',
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId,
                message: { id: randomUUID(), content: 'Review using legacy-only reader' },
                comments: [],
                sourceGrant: { runId, grant: grantId },
                collaboration: task,
                collaborationAuthorization: authorization,
              },
              host: {
                workflow: {
                  // Legacy-only AgentCollaborationSourceReader (`supportedForms: ['legacy']`, no `readCollaborationSourcePart`)!
                  sourceReader: {
                    identity: { runId, grant: grantId },
                    supportedForms: ['legacy'],
                    navigation: () => ({
                      runId,
                      grant: grantId,
                      source: 'inputs',
                      offset: 0,
                    }),
                    read: () => ({
                      submitted: 'legacy',
                      request: { runId, grant: grantId, source: 'inputs', offset: 0 },
                      page: {
                        source: 'inputs',
                        offset: 0,
                        nextOffset: null,
                        text: 'LEGACY_ONLY_PLAN_BODY',
                        binding: {
                          submitted: 'legacy',
                          callerRunId: runId,
                          grantSha256: createHash('sha256').update(grantId).digest('hex'),
                          referenceSha256: 'a'.repeat(64),
                        },
                      },
                    }),
                    retire: () => {},
                  },
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(sourceToolProps).toContain('source')
        expect(sourceToolProps).not.toContain('handle')
        expect(sourceToolProps).not.toContain('path')
        expect(sourceReadResp?.content?.[0]?.text).toContain('LEGACY_ONLY_PLAN_BODY')
        expect(sourceReadResp?.isError).toBeUndefined()
      } finally {
        await adapter.dispose()
      }
    }
  })
  it('auto-allows Phase-1 Brain Plan write_file/edit_file permission requests only when ArtifactMetadata and every target stays inside this run brain directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-brain-plan-perm-'))
    const cwd = join(root, 'workspace')
    const appDataDir = join(root, 'gemini', 'antigravity-cli')
    const nativeSessionId = randomUUID()
    const otherSessionId = randomUUID()
    const brainPlanPath = join(appDataDir, 'brain', nativeSessionId, 'implementation_plan.md')
    const brainMetaPath = join(
      appDataDir,
      'brain',
      nativeSessionId,
      'implementation_plan.md.metadata.json',
    )
    const otherBrainPlanPath = join(appDataDir, 'brain', otherSessionId, 'implementation_plan.md')
    const workspaceFile = join(cwd, 'parse-port.mjs')
    await mkdir(cwd, { recursive: true })
    await mkdir(join(appDataDir, 'brain', nativeSessionId), { recursive: true })

    const harness = createAcpHarness()
    let permSeq = 0
    const permOutcomes = new Map<string, unknown>()
    const sendPermission = (id: string, toolCall: Record<string, unknown>) => {
      const rpcId = `perm-${++permSeq}-${id}`
      harness.sendToClient({
        jsonrpc: '2.0',
        id: rpcId,
        method: 'session/request_permission',
        params: {
          sessionId: nativeSessionId,
          toolCall,
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
      })
      return rpcId
    }

    let phase: 'plan' | 'plan_review' = 'plan'
    harness.onClientFrame((frame) => {
      if (typeof frame.method !== 'string' && 'id' in frame && typeof frame.id === 'string') {
        permOutcomes.set(frame.id, Reflect.get(frame, 'result'))
        return
      }
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new' || frame.method === 'session/load') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        if (phase === 'plan') {
          // 1. Valid Brain Plan write_file with ArtifactMetadata -> MUST auto-allow without UI card.
          const allowId = sendPermission('valid-brain', {
            toolCallId: 'tc-valid-brain',
            name: 'write_file',
            status: 'pending',
            args: {
              Path: brainPlanPath,
              Content: '# Official Plan v1\nSafe',
              ArtifactMetadata: { Summary: 'Plan v1', UserFacing: true, RequestFeedback: true },
            },
            locations: [{ path: brainPlanPath }],
            content: [{ type: 'diff', path: brainPlanPath, newText: '# Official Plan v1\nSafe' }],
          })
          // 2. Denied cases in Phase-1 plan mode: workspace path, missing ArtifactMetadata,
          //    foreign session brain path, non-md metadata file, read_file, move target outside brain.
          sendPermission('workspace-even-meta', {
            toolCallId: 'tc-ws',
            name: 'write_file',
            status: 'pending',
            args: {
              Path: workspaceFile,
              Content: 'evil',
              ArtifactMetadata: { Summary: 'Fake', UserFacing: true },
            },
          })
          sendPermission('missing-meta', {
            toolCallId: 'tc-nometa',
            name: 'write_file',
            status: 'pending',
            args: { Path: brainPlanPath, Content: '# Missing Meta' },
          })
          sendPermission('other-session', {
            toolCallId: 'tc-other-sid',
            name: 'write_file',
            status: 'pending',
            args: {
              Path: otherBrainPlanPath,
              Content: '# Other SID',
              ArtifactMetadata: { Summary: 'Other', UserFacing: true },
            },
          })
          sendPermission('non-md-meta', {
            toolCallId: 'tc-non-md',
            name: 'write_file',
            status: 'pending',
            args: {
              Path: brainMetaPath,
              Content: '{}',
              ArtifactMetadata: { Summary: 'Meta', UserFacing: false },
            },
          })
          sendPermission('read-file', {
            toolCallId: 'tc-read',
            name: 'read_file',
            status: 'pending',
            args: { Path: workspaceFile },
          })
          sendPermission('diff-move-outside', {
            toolCallId: 'tc-move',
            name: 'edit_file',
            status: 'pending',
            args: {
              Path: brainPlanPath,
              ArtifactMetadata: { Summary: 'Move', UserFacing: true },
            },
            content: [
              {
                type: 'diff',
                path: brainPlanPath,
                previousPath: workspaceFile,
                newText: '# Plan',
              },
            ],
          })

          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-valid-brain',
                name: 'write_file',
                status: 'completed',
                args: {
                  Path: brainPlanPath,
                  Content: '# Official Plan v1\nSafe',
                  ArtifactMetadata: { Summary: 'Plan v1', UserFacing: true, RequestFeedback: true },
                },
                content: [
                  { type: 'diff', path: brainPlanPath, newText: '# Official Plan v1\nSafe' },
                ],
              },
            },
          })

          void allowId
          setTimeout(() => {
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn' },
            })
          }, 50)
        } else {
          // plan_review stage has planModeStage === false -> even valid Brain Plan write MUST be denied!
          sendPermission('review-stage-brain', {
            toolCallId: 'tc-review-brain',
            name: 'edit_file',
            status: 'pending',
            args: {
              Path: brainPlanPath,
              ArtifactMetadata: { Summary: 'Should Deny', UserFacing: true },
            },
          })
          setTimeout(() => {
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn' },
            })
          }, 50)
        }
      }
    })

    const requestPermissionSpy =
      vi.fn<
        NonNullable<
          NonNullable<NonNullable<AgentRunInput['host']>['interactions']>['requestPermission']
        >
      >()
    const capturedPlans: Array<{ nativeId: string; text: string }> = []
    const sessionId = randomUUID()
    const run1Id = randomUUID()
    const { task: planTask, authorization: planAuth } = makeCollaborationTask(
      sessionId,
      run1Id,
      'plan',
    )

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: {
        readTrajectoryIdentity: async () => ({ status: 'no_storage_root' }),
      },
    })

    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId,
            runId: run1Id,
            permissionMode: 'ask',
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId,
              message: { id: randomUUID(), content: '/plan Create parsePort plan' },
              comments: [],
              sourceGrant: { runId: run1Id, grant: 'g-plan' },
              collaboration: planTask,
              collaborationAuthorization: planAuth,
            },
            host: {
              workflow: {
                recordPlan: (plan) => capturedPlans.push(plan),
              },
              interactions: {
                requestPermission: requestPermissionSpy,
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      expect(requestPermissionSpy).not.toHaveBeenCalled()
      expect(capturedPlans).toEqual([
        {
          nativeId: `${nativeSessionId}:tc-valid-brain`,
          text: '# Official Plan v1\nSafe',
        },
      ])
      expect(permOutcomes.get('perm-1-valid-brain')).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow' },
      })
      for (const deniedKey of [
        'perm-2-workspace-even-meta',
        'perm-3-missing-meta',
        'perm-4-other-session',
        'perm-5-non-md-meta',
        'perm-6-read-file',
        'perm-7-diff-move-outside',
      ]) {
        expect(permOutcomes.get(deniedKey)).toEqual({
          outcome: { outcome: 'selected', optionId: 'deny' },
        })
      }

      // Now verify plan_review (planModeStage === false) denies Brain Plan write permission!
      phase = 'plan_review'
      const run2Id = randomUUID()
      const { task: reviewTask, authorization: reviewAuth } = makeCollaborationTask(
        sessionId,
        run2Id,
        'plan_review',
      )
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId,
            runId: run2Id,
            nativeSessionId,
            bindingGeneration: 1,
            permissionMode: 'ask',
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId,
              message: { id: randomUUID(), content: 'Review plan' },
              comments: [],
              sourceGrant: { runId: run2Id, grant: 'g-review' },
              collaboration: reviewTask,
              collaborationAuthorization: reviewAuth,
            },
            host: {
              interactions: {
                requestPermission: requestPermissionSpy,
              },
            },
          }),
          new AbortController().signal,
        ),
      )

      expect(requestPermissionSpy).not.toHaveBeenCalled()
      expect(permOutcomes.get('perm-8-review-stage-brain')).toEqual({
        outcome: { outcome: 'selected', optionId: 'deny' },
      })
    } finally {
      await adapter.dispose()
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('denies pre-dispatch, missing-id, incomplete-location, symlinked/nested Brain, duplicate-call, and code_review plan permissions, allowing a single direct plan write only once', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-agy-plan-hardening-')))
    const cwd = join(root, 'workspace')
    const appDataDir = join(root, 'gemini', 'antigravity-cli')
    const symlinkBrainAppDataDir = join(root, 'gemini-sym-brain', 'antigravity-cli')
    const symlinkSessionAppDataDir = join(root, 'gemini-sym-session', 'antigravity-cli')
    const nativeSessionId = randomUUID()
    const brainSessionDir = join(appDataDir, 'brain', nativeSessionId)
    const nestedPlanDir = join(brainSessionDir, 'sub')
    const validPlanPath = join(brainSessionDir, 'implementation_plan.md')
    const nestedPlanPath = join(nestedPlanDir, 'implementation_plan.md')
    const danglingLinkPath = join(brainSessionDir, 'dangling.md')
    const outsideEscapeDir = join(root, 'outside-brain')
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(nestedPlanDir, { recursive: true }),
      mkdir(outsideEscapeDir, { recursive: true }),
      mkdir(symlinkBrainAppDataDir, { recursive: true }),
      mkdir(join(symlinkSessionAppDataDir, 'brain'), { recursive: true }),
    ])
    await symlink(join(outsideEscapeDir, 'nonexistent.md'), danglingLinkPath)
    await symlink(outsideEscapeDir, join(symlinkBrainAppDataDir, 'brain'))
    await symlink(outsideEscapeDir, join(symlinkSessionAppDataDir, 'brain', nativeSessionId))

    const runPermScenario = async (targetAppDataDir: string, stage: 'plan' | 'code_review') => {
      const harness = createAcpHarness()
      let seq = 0
      const outcomes = new Map<string, unknown>()
      const sendPerm = (label: string, toolCall: Record<string, unknown>) => {
        const rpcId = `perm-${++seq}-${label}`
        harness.sendToClient({
          jsonrpc: '2.0',
          id: rpcId,
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall,
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        })
        return rpcId
      }

      harness.onClientFrame((frame) => {
        if (typeof frame.method !== 'string' && 'id' in frame && typeof frame.id === 'string') {
          outcomes.set(frame.id, Reflect.get(frame, 'result'))
          return
        }
        if (frame.method === 'initialize') {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        } else if (frame.method === 'session/new' || frame.method === 'session/load') {
          harness.sendToClient({
            jsonrpc: '2.0',
            id: frame.id,
            result: defaultSessionNewResult(nativeSessionId),
          })
        } else if (
          frame.method === 'session/set_mode' ||
          frame.method === 'session/set_model' ||
          frame.method === 'session/set_config_option'
        ) {
          if (
            frame.method === 'session/set_mode' &&
            targetAppDataDir === appDataDir &&
            stage === 'plan'
          ) {
            // Send pre-dispatch permission request after session registration, BEFORE session/prompt dispatches!
            sendPerm('pre-dispatch', {
              toolCallId: 'tc-pre-dispatch',
              name: 'write_file',
              status: 'pending',
              args: {
                Path: validPlanPath,
                Content: '# Pre-dispatch',
                ArtifactMetadata: { Summary: 'Pre', UserFacing: true },
              },
            })
          }
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
        } else if (frame.method === 'session/prompt') {
          if (targetAppDataDir === appDataDir && stage === 'plan') {
            sendPerm('missing-tc-id', {
              name: 'write_file',
              status: 'pending',
              args: {
                Path: validPlanPath,
                Content: '# Missing ID',
                ArtifactMetadata: { Summary: 'No ID', UserFacing: true },
              },
            })
            sendPerm('incomplete-locations', {
              toolCallId: 'tc-bad-locs',
              name: 'write_file',
              status: 'pending',
              args: {
                Path: validPlanPath,
                Content: '# Bad Locs',
                ArtifactMetadata: { Summary: 'Bad Locs', UserFacing: true },
              },
              locations: [{ missingPathKey: true }],
            })
            sendPerm('dangling-symlink', {
              toolCallId: 'tc-dangling',
              name: 'write_file',
              status: 'pending',
              args: {
                Path: danglingLinkPath,
                Content: '# Dangling',
                ArtifactMetadata: { Summary: 'Dangling', UserFacing: true },
              },
            })
            sendPerm('nested-subdir', {
              toolCallId: 'tc-nested',
              name: 'write_file',
              status: 'pending',
              args: {
                Path: nestedPlanPath,
                Content: '# Nested',
                ArtifactMetadata: { Summary: 'Nested', UserFacing: true },
              },
            })
            sendPerm('valid-first', {
              toolCallId: 'tc-valid-once',
              name: 'write_file',
              status: 'pending',
              args: {
                Path: validPlanPath,
                Content: '# Valid Plan',
                ArtifactMetadata: { Summary: 'Plan', UserFacing: true },
              },
              locations: [{ path: validPlanPath }],
            })
            sendPerm('duplicate-same-tc', {
              toolCallId: 'tc-valid-once',
              name: 'write_file',
              status: 'pending',
              args: {
                Path: validPlanPath,
                Content: '# Duplicate',
                ArtifactMetadata: { Summary: 'Dup', UserFacing: true },
              },
            })
          } else {
            const targetPath = join(
              targetAppDataDir,
              'brain',
              nativeSessionId,
              'implementation_plan.md',
            )
            sendPerm('target', {
              toolCallId: `tc-${stage}`,
              name: 'write_file',
              status: 'pending',
              args: {
                Path: targetPath,
                Content: '# Target',
                ArtifactMetadata: { Summary: 'Target', UserFacing: true },
              },
            })
          }
          setTimeout(() => {
            harness.sendToClient({
              jsonrpc: '2.0',
              id: frame.id,
              result: { stopReason: 'end_turn' },
            })
          }, 40)
        }
      })

      const adapter = new AgyAgentAdapter({
        appDataDir: targetAppDataDir,
        processFactory: () => harness.child,
      })
      const spyPerm = vi.fn<
        NonNullable<
          NonNullable<NonNullable<AgentRunInput['host']>['interactions']>['requestPermission']
        >
      >(() => Promise.resolve('agy-reject-once'))
      try {
        const sessionId = randomUUID()
        const runId = randomUUID()
        const { task, authorization } = makeCollaborationTask(sessionId, runId, stage)
        await collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              sessionId,
              runId,
              permissionMode: 'ask',
              promptEnvelope: {
                version: 'pact-agent-prompt-v1',
                sessionId,
                message: { id: randomUUID(), content: 'Run planning/review stage' },
                comments: [],
                sourceGrant: { runId, grant: 'g-hardening' },
                collaboration: task,
                collaborationAuthorization: authorization,
              },
              host: {
                interactions: {
                  requestPermission: spyPerm,
                },
              },
            }),
            new AbortController().signal,
          ),
        )
        expect(spyPerm).not.toHaveBeenCalled()
        return outcomes
      } finally {
        await adapter.dispose()
      }
    }

    try {
      const planOutcomes = await runPermScenario(appDataDir, 'plan')
      expect(planOutcomes.get('perm-1-pre-dispatch')).toEqual({
        outcome: { outcome: 'selected', optionId: 'deny' },
      })
      for (const denied of [
        'perm-2-missing-tc-id',
        'perm-3-incomplete-locations',
        'perm-4-dangling-symlink',
        'perm-5-nested-subdir',
        'perm-7-duplicate-same-tc',
      ]) {
        expect(planOutcomes.get(denied)).toEqual({
          outcome: { outcome: 'selected', optionId: 'deny' },
        })
      }
      expect(planOutcomes.get('perm-6-valid-first')).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow' },
      })

      const symBrainOutcomes = await runPermScenario(symlinkBrainAppDataDir, 'plan')
      expect(symBrainOutcomes.get('perm-1-target')).toEqual({
        outcome: { outcome: 'selected', optionId: 'deny' },
      })

      const symSessionOutcomes = await runPermScenario(symlinkSessionAppDataDir, 'plan')
      expect(symSessionOutcomes.get('perm-1-target')).toEqual({
        outcome: { outcome: 'selected', optionId: 'deny' },
      })

      const codeReviewOutcomes = await runPermScenario(appDataDir, 'code_review')
      expect(codeReviewOutcomes.get('perm-1-target')).toEqual({
        outcome: { outcome: 'selected', optionId: 'deny' },
      })
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('prevents conflicted write_file Overwrite updates or cross-Brain moves from creating undoable WorkspaceChanges entries', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pact-agy-ws-conflict-')))
    const cwd = join(root, 'workspace')
    const storageRoot = join(root, 'storage')
    const appDataDir = join(root, 'gemini', 'antigravity-cli')
    const filePath = join(root, 'pact.sqlite')
    const migrationsFolder = resolve(
      import.meta.dirname,
      '../../../../../packages/persistence/drizzle',
    )
    const nativeSessionId = randomUUID()
    const existingFile = join(cwd, 'existing.mjs')
    const movedFile = join(cwd, 'cross-moved.mjs')
    const brainPlan = join(appDataDir, 'brain', nativeSessionId, 'implementation_plan.md')
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(storageRoot, { recursive: true }),
      mkdir(join(appDataDir, 'brain', nativeSessionId), { recursive: true }),
    ])
    await promisify(execFile)('git', ['init', '--quiet', cwd])
    await writeFile(existingFile, 'export const v = 1\n', 'utf8')
    await writeFile(movedFile, 'export const moved = 1\n', 'utf8')

    const db = await PactDatabase.open({ filePath, migrationsFolder })
    const projectId = randomUUID()
    const sessionId = randomUUID()
    const createdAt = new Date().toISOString()
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Workspace',
      kind: 'git',
      directoryPath: cwd,
      createdAt,
    })
    db.sessionRepository.create(
      { id: sessionId, projectId, title: 'Conflict test', createdAt },
      {
        primaryAgentId: 'agy',
        secondaryAgentId: 'codex',
        agents: {
          claude: { model: null, effort: null },
          codex: { model: null, effort: null },
          agy: { model: null, effort: null },
        },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    )
    const run = db.conversationRepository.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Edit workspace files',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'agy',
      settingsRevision: 1,
      model: null,
      effort: null,
    }).run

    const wsChanges = new WorkspaceChanges(
      db.workspaceChangesRepository,
      db.sessionRepository,
      db.projectCatalogRepository,
      storageRoot,
      runDirectoryWorker,
      filePath,
    )
    await wsChanges.initialize()
    const runAbort = new AbortController()
    await wsChanges.start(run, runAbort.signal)

    const harness = createAcpHarness()
    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
      } else if (frame.method === 'session/new') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
      } else if (
        frame.method === 'session/set_mode' ||
        frame.method === 'session/set_model' ||
        frame.method === 'session/set_config_option'
      ) {
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
      } else if (frame.method === 'session/prompt') {
        // Conflicted write_file: Overwrite flips false -> true across updates without oldText!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-conflict-write',
              name: 'write_file',
              status: 'pending',
              args: { Path: existingFile, Overwrite: false },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-conflict-write',
              name: 'write_file',
              status: 'completed',
              args: { Path: existingFile, Overwrite: true },
              content: [{ type: 'diff', path: existingFile, newText: 'export const v = 2\n' }],
            },
          },
        })
        // Cross-Brain/workspace move diff.
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-cross-move',
              name: 'edit_file',
              status: 'completed',
              args: { Path: brainPlan },
              content: [
                {
                  type: 'diff',
                  path: brainPlan,
                  movePath: movedFile,
                  oldText: '# p',
                  newText: 'export const moved = 1\n',
                },
              ],
            },
          },
        })
        setTimeout(() => {
          harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
        }, 25)
      }
    })

    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
    })
    try {
      await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            sessionId,
            runId: run.id,
            host: {
              effects: {
                recordFileChange: async (change, sig) => {
                  await wsChanges.record(run.id, change, sig)
                },
                recordUncertainEffects: (reason) => {
                  wsChanges.uncertain(run.id, reason)
                },
                reportNativeEffects: (effect) => {
                  if (effect.state === 'unknown') {
                    wsChanges.observeUncertainEffects(run.id)
                  }
                },
              },
            },
          }),
          runAbort.signal,
        ),
      )
      const summary = await wsChanges.finish(run.id)
      expect(summary?.state).toBe('mixed')
      const page = wsChanges.readPage({ changeSetId: run.id })
      const existingEntry = page.files.find((f) => f.path === 'existing.mjs')
      expect(existingEntry).toBeDefined()
      expect(existingEntry?.kind).not.toBe('added')
      const movedEntry = page.files.find((f) => f.path === 'cross-moved.mjs')
      expect(movedEntry?.kind).toBe('renamed')
      await expect(wsChanges.undo(run.id)).rejects.toMatchObject({
        code: 'WORKSPACE_UNDO_UNAVAILABLE',
      })
    } finally {
      await adapter.dispose()
      await wsChanges.dispose()
      db.close()
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('drains trailing session/load replay continuously across set_mode, set_config_option, and trajectory identity read without queue overflow or phantom file edits', async () => {
    const { cwd, appDataDir } = await createEnv()
    const targetPath = join(cwd, 'historical.ts')
    await writeFile(targetPath, 'export const live = true\n', 'utf8')
    const harness = createAcpHarness()
    const nativeSessionId = 'sid-preprompt-drain'

    const emitEditReplayBatch = (prefix: string, count: number): void => {
      const lines: string[] = []
      for (let i = 0; i < count; i += 1) {
        lines.push(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: i % 2 === 0 ? 'tool_call' : 'tool_call_update',
                toolCallId: `tc-hist-${prefix}-${Math.floor(i / 2)}`,
                name: 'edit_file',
                status: i % 2 === 0 ? 'in_progress' : 'completed',
                args: { Path: targetPath, Target: 'a', Replacement: 'b' },
                content: [
                  {
                    type: 'diff',
                    path: targetPath,
                    oldText: 'export const live = false\n',
                    newText: 'export const live = true\n',
                  },
                ],
              },
            },
          }),
        )
      }
      harness.sendRawStdout(`${lines.join('\n')}\n`)
    }

    let readTrajectoryStarted = Promise.withResolvers<void>()
    let releaseReadTrajectory = Promise.withResolvers<void>()

    harness.onClientFrame(async (frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/load') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
        })
        return
      }
      if (frame.method === 'session/set_mode') {
        // Stream 1,800 replay frames during session/set_mode before returning the RPC reply!
        for (let b = 0; b < 6; b += 1) {
          emitEditReplayBatch(`mode-${b}`, 300)
          await new Promise<void>((r) => setImmediate(r))
        }
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: { currentModeId: (frame.params as Record<string, unknown>)?.modeId ?? 'default' },
        })
        return
      }
      if (frame.method === 'session/set_config_option') {
        // Stream 1,800 replay frames during session/set_config_option before returning!
        for (let b = 0; b < 6; b += 1) {
          emitEditReplayBatch(`cfg-${b}`, 300)
          await new Promise<void>((r) => setImmediate(r))
        }
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
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Live turn reply.' },
            },
          },
        })
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const recordedChanges: unknown[] = []
    const effectStates: string[] = []
    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: {
        readTrajectoryIdentity: async () => {
          readTrajectoryStarted.resolve()
          // While readTrajectoryIdentity awaits, emit another 1,800 replay frames (total 5,400 > 4,096!)
          for (let b = 0; b < 6; b += 1) {
            emitEditReplayBatch(`traj-${b}`, 300)
            await new Promise<void>((r) => setImmediate(r))
          }
          await releaseReadTrajectory.promise
          return {
            status: 'ok',
            trajectoryId: randomUUID(),
            stepCount: 700,
          }
        },
      },
    })

    try {
      const runPromise = collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            nativeSessionId,
            host: {
              effects: {
                recordFileChange: async (change) => {
                  recordedChanges.push(change)
                },
                reportNativeEffects: (report) => {
                  effectStates.push(report.state)
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      await readTrajectoryStarted.promise
      releaseReadTrajectory.resolve()
      const events = await runPromise
      const answerText = events
        .filter(
          (ev): ev is Extract<NormalizedAgentEvent, { type: 'text.completed' }> =>
            ev.type === 'text.completed',
        )
        .map((ev) => ev.text)
        .join('')
      expect(answerText).toBe('Live turn reply.')
      expect(recordedChanges).toEqual([])
      expect(effectStates).not.toContain('unknown')
      expect(effectStates).toContain('settled')
    } finally {
      await adapter.dispose()
    }
  })

  it('rejects before session/prompt with zero phantom file edits and settled native effects if pre-prompt stream closes while historical edit_file replay is buffered', async () => {
    const { cwd, appDataDir } = await createEnv()
    const targetPath = join(cwd, 'phantom.ts')
    await writeFile(targetPath, 'export const phantom = 1\n', 'utf8')
    const harness = createAcpHarness()
    const nativeSessionId = 'sid-preprompt-close'

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/load') {
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
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
      }
    })

    const recordedChanges: unknown[] = []
    const effectStates: string[] = []
    const dispatchPhases: string[] = []
    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: {
        readTrajectoryIdentity: async () => {
          // Emit historical edit_file updates immediately followed by child termination during pre-prompt gap!
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-hist-close-1',
                name: 'edit_file',
                status: 'in_progress',
                args: { Path: targetPath, Target: '1', Replacement: '2' },
              },
            },
          })
          harness.sendToClient({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: nativeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-hist-close-1',
                name: 'edit_file',
                status: 'completed',
                content: [
                  {
                    type: 'diff',
                    path: targetPath,
                    oldText: 'export const phantom = 0\n',
                    newText: 'export const phantom = 1\n',
                  },
                ],
              },
            },
          })
          harness.child.kill('SIGTERM')
          return {
            status: 'ok',
            trajectoryId: randomUUID(),
            stepCount: 42,
          }
        },
      },
    })

    try {
      await expect(
        collectEvents(
          adapter.run(
            makeBaseRunInput(cwd, {
              nativeSessionId,
              host: {
                lifecycle: {
                  recordDispatch: (phase) => {
                    dispatchPhases.push(phase)
                  },
                },
                effects: {
                  recordFileChange: async (change) => {
                    recordedChanges.push(change)
                  },
                  reportNativeEffects: (report) => {
                    effectStates.push(report.state)
                  },
                },
              },
            }),
            new AbortController().signal,
          ),
        ),
      ).rejects.toThrow(/Antigravity/u)

      expect(harness.requests.some((r) => r.method === 'session/prompt')).toBe(false)
      expect(dispatchPhases).toContain('rejected')
      expect(dispatchPhases).not.toContain('possibly_sent')
      expect(recordedChanges).toEqual([])
      expect(effectStates).not.toContain('unknown')
      expect(effectStates).toContain('settled')
    } finally {
      await adapter.dispose()
    }
  })

  it('drops post-prompt tool_call_update carrying a pre-prompt replayed toolCallId while still recording fresh live file edits', async () => {
    const { cwd, appDataDir } = await createEnv()
    const replayedFile = join(cwd, 'replayed.ts')
    const liveFile = join(cwd, 'live.ts')
    await writeFile(replayedFile, 'export const replayed = 1\n', 'utf8')
    await writeFile(liveFile, 'export const live = 2\n', 'utf8')
    const harness = createAcpHarness()
    const nativeSessionId = 'sid-split-replay'

    harness.onClientFrame((frame) => {
      if (frame.method === 'initialize') {
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
        return
      }
      if (frame.method === 'session/load') {
        // Emit only the opening `tool_call` during historical session/load replay.
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-replayed-split-1',
              name: 'edit_file',
              status: 'in_progress',
              args: { Path: replayedFile },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          id: frame.id,
          result: defaultSessionNewResult(nativeSessionId),
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
        // First emit the split completion of the historical pre-prompt toolCallId -> MUST be dropped!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-replayed-split-1',
              name: 'edit_file',
              status: 'completed',
              content: [
                {
                  type: 'diff',
                  path: replayedFile,
                  oldText: 'export const replayed = 0\n',
                  newText: 'export const replayed = 1\n',
                },
              ],
            },
          },
        })
        // Then emit a genuine live edit_file with a fresh toolCallId -> MUST be recorded!
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-live-fresh-2',
              name: 'edit_file',
              status: 'in_progress',
              args: { Path: liveFile },
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-live-fresh-2',
              name: 'edit_file',
              status: 'completed',
              content: [
                {
                  type: 'diff',
                  path: liveFile,
                  oldText: 'export const live = 1\n',
                  newText: 'export const live = 2\n',
                },
              ],
            },
          },
        })
        harness.sendToClient({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Done.' },
            },
          },
        })
        harness.sendToClient({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })

    const recordedChanges: Array<{ path: string; kind: string }> = []
    const adapter = new AgyAgentAdapter({
      appDataDir,
      processFactory: () => harness.child,
      storageClient: {
        readTrajectoryIdentity: async () => ({
          status: 'ok',
          trajectoryId: randomUUID(),
          stepCount: 10,
        }),
      },
    })

    try {
      const events = await collectEvents(
        adapter.run(
          makeBaseRunInput(cwd, {
            nativeSessionId,
            host: {
              effects: {
                recordFileChange: async (change) => {
                  recordedChanges.push({ path: change.path, kind: change.kind })
                },
              },
            },
          }),
          new AbortController().signal,
        ),
      )
      expect(events.some((ev) => ev.type === 'text.completed' && ev.text === 'Done.')).toBe(true)
      expect(recordedChanges).toEqual([{ path: 'live.ts', kind: 'modified' }])
    } finally {
      await adapter.dispose()
    }
  })
})
