/* oxlint-disable typescript/no-unsafe-type-assertion -- These deliberately small actors exercise the production transport and SDK input seams. */
import type { query as sdkQuery, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, open, realpath, rm, symlink, link, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AgentRunInput } from '@pact/agent-runtime'
import type { RunEffectiveExecutionSettings } from '@pact/contracts'

const worker = vi.hoisted(() => ({ path: '', forkPath: '' }))
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
          String(filename).endsWith('native-json-parser-worker.js')
            ? worker.path
            : String(filename).endsWith('native-fork-worker.js')
              ? worker.forkPath
              : filename,
          options,
        )
      }
    },
  }
})

import { NativeInputWithheldError } from './agent-execution-error'
import { ClaudeAgentAdapter } from './claude-agent-adapter'
import { CodexAgentAdapter } from './codex-agent-adapter'
import { NativeForkFiles } from './native-fork-files'
import { nativeWorkerFixture } from './native-workers-fixture.test-support'

let fixture: Awaited<ReturnType<typeof nativeWorkerFixture>>
beforeAll(async () => {
  fixture = await nativeWorkerFixture(['native-json-parser-worker', 'native-fork-worker'])
  worker.path = fixture.paths['native-json-parser-worker']!
  worker.forkPath = fixture.paths['native-fork-worker']!
}, 20_000)
afterAll(async () => {
  await fixture?.dispose()
})

/* oxlint-disable vitest/no-conditional-expect -- Each filesystem variant has a distinct safety obligation. */
describe('bounded exact native existence verification', () => {
  it.each(['missing', 'oversized', 'symlink', 'hardlink'] as const)(
    'checks %s through the real Worker without loading transcript bodies',
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), 'pact-native-exists-test-')),
        cwd = await realpath(directory),
        profile = join(cwd, 'profile'),
        nativeSessionId = randomUUID(),
        project = join(profile, 'projects', cwd.replace(/[^a-z0-9]/giu, '-')),
        path = join(project, nativeSessionId + '.jsonl'),
        files = new NativeForkFiles()
      await mkdir(project, { recursive: true })
      vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
      try {
        if (kind === 'oversized') {
          const handle = await open(path, 'w')
          try {
            await handle.truncate(33 * 1024 * 1024)
          } finally {
            await handle.close()
          }
          await expect(
            files.readAnswer(
              { cwd, nativeSessionId, nativeTurnId: randomUUID() },
              new AbortController().signal,
            ),
          ).rejects.toBeInstanceOf(Error)
        } else if (kind !== 'missing') {
          const target = join(project, 'target.jsonl')
          await writeFile(target, 'Invalid JSON\n')
          if (kind === 'symlink') await symlink(target, path)
          else await link(target, path)
        }
        const reading = files.exists({ cwd, nativeSessionId }, new AbortController().signal)
        if (kind === 'symlink' || kind === 'hardlink')
          await expect(reading).rejects.toBeInstanceOf(Error)
        else await expect(reading).resolves.toBe(kind === 'oversized')
        expect(files.active).toBe(false)
      } finally {
        await files.dispose()
        vi.unstubAllEnvs()
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
/* oxlint-enable vitest/no-conditional-expect */

function input(): AgentRunInput {
  return {
    runId: randomUUID(),
    sessionId: randomUUID(),
    nativeSessionId: 'original-session',
    cwd: '/project',
    model: null,
    effort: null,
    speed: 'standard',
    permissionMode: 'native',
    promptEnvelope: {
      version: 'pact-agent-prompt-v1',
      sessionId: 'session',
      message: { id: randomUUID(), content: 'Exact original input' },
      comments: [],
    },
  }
}
function capture(): NonNullable<AgentRunInput['recovery']> {
  return {
    inputSha256: 'a'.repeat(64),
    recordEffectiveSettings:
      vi.fn<NonNullable<AgentRunInput['recovery']>['recordEffectiveSettings']>(),
    recordConfirmedUnsent: vi.fn<NonNullable<AgentRunInput['recovery']>['recordConfirmedUnsent']>(),
  }
}
async function consume(adapter: CodexAgentAdapter | ClaudeAgentAdapter, value: AgentRunInput) {
  for await (const event of adapter.run(value, new AbortController().signal)) void event
}

function codexFixture(options: { effort?: null | string; nativeError?: boolean } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: () => {
      queueMicrotask(() => {
        child.exitCode = 0
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      })
      return true
    },
  })
  const methods: string[] = [],
    starts: object[] = []
  let model = 'gpt-fixture',
    text = ''
  const send = (value: object) =>
    queueMicrotask(() => child.stdout.write(JSON.stringify(value) + '\n'))
  child.stdin.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8')
    while (text.includes('\n')) {
      const end = text.indexOf('\n'),
        frame = JSON.parse(text.slice(0, end)) as {
          id?: number
          method: string
          params: Record<string, unknown>
        }
      text = text.slice(end + 1)
      methods.push(frame.method)
      if (frame.method === 'initialize')
        send({ id: frame.id, result: { userAgent: 'codex_cli_rs/0.159.2' } })
      else if (frame.method === 'config/read')
        send({
          id: frame.id,
          result: {
            config: {
              approval_policy: 'on-request',
              approvals_reviewer: 'user',
              sandbox_mode: 'danger-full-access',
            },
          },
        })
      else if (frame.method === 'thread/resume')
        send({
          id: frame.id,
          result: {
            thread: { id: frame.params.threadId },
            model,
            ...(options.effort === 'missing' ? {} : { reasoningEffort: options.effort ?? null }),
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            sandbox: { type: 'dangerFullAccess' },
          },
        })
      else if (frame.method === 'turn/start') {
        starts.push(frame)
        if (options.nativeError)
          send({
            id: frame.id,
            error: { code: -32600, message: 'Rejected after receiving the root frame' },
          })
        else {
          send({ id: frame.id, result: { turn: { id: 'root-turn' } } })
          send({
            method: 'turn/completed',
            params: {
              threadId: 'original-session',
              turn: { id: 'root-turn', status: 'completed' },
            },
          })
        }
      }
    }
  })
  const adapter = new CodexAgentAdapter(
    '/owned/protocol-fixture',
    () => child as unknown as ChildProcessWithoutNullStreams,
  )
  return {
    adapter,
    methods,
    starts,
    model: (value: string) => {
      model = value
    },
  }
}

describe('Codex reexecution evidence at the real root writer', () => {
  it('records known-null effort and exact physical not-sent identity before the first byte', async () => {
    const f = codexFixture(),
      recovery = capture(),
      value = input()
    try {
      await expect(
        consume(f.adapter, {
          ...value,
          recovery,
          recordDispatch: (phase) => {
            if (phase === 'possibly_sent') throw new NativeInputWithheldError()
          },
        }),
      ).rejects.toBeInstanceOf(NativeInputWithheldError)
      await vi.waitFor(() =>
        expect(recovery.recordConfirmedUnsent).toHaveBeenCalledExactlyOnceWith(
          { kind: 'codex_root_frame_not_written', requestId: expect.any(Number) },
          { executorId: f.adapter.executorId, nativeSessionId: value.nativeSessionId },
        ),
      )
      expect(recovery.recordEffectiveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'codex',
          model: 'gpt-fixture',
          effort: { known: true, value: null },
          speed: 'standard',
        }),
        expect.objectContaining({ executorId: f.adapter.executorId }),
      )
      expect(f.starts).toHaveLength(0)
    } finally {
      await f.adapter.dispose()
    }
  })
  it('does not convert a post-write native rejection into confirmed-unsent proof', async () => {
    const f = codexFixture({ nativeError: true }),
      recovery = capture()
    try {
      await expect(consume(f.adapter, { ...input(), recovery })).rejects.toBeInstanceOf(Error)
      expect(f.starts).toHaveLength(1)
      expect(recovery.recordConfirmedUnsent).not.toHaveBeenCalled()
    } finally {
      await f.adapter.dispose()
    }
  })
  it.each(['effort', 'speed'] as const)(
    'keeps unknown native %s out of complete effective settings',
    async (unknown) => {
      const f = codexFixture({ effort: unknown === 'effort' ? 'missing' : null }),
        recovery = capture()
      try {
        await consume(f.adapter, {
          ...input(),
          speed: unknown === 'speed' ? 'native' : 'standard',
          recovery,
        })
        expect(f.starts).toHaveLength(1)
        expect(recovery.recordEffectiveSettings).not.toHaveBeenCalled()
      } finally {
        await f.adapter.dispose()
      }
    },
  )
  it.each(['settings', 'executor', 'authority'] as const)(
    'withholds a replacement when its %s changes',
    async (changed) => {
      const f = codexFixture(),
        recovery = capture(),
        value = input()
      try {
        await consume(f.adapter, { ...value, recovery })
        const settings = vi.mocked(recovery.recordEffectiveSettings).mock.calls[0]![0]
        if (changed === 'settings') f.model('another-native-model')
        await expect(
          consume(f.adapter, {
            ...value,
            runId: randomUUID(),
            recovery: {
              ...capture(),
              expected: {
                settings,
                executorId: changed === 'executor' ? 'other-executor' : f.adapter.executorId,
                nativeSessionId: value.nativeSessionId!,
              },
              canDispatch: () => changed !== 'authority',
            },
          }),
        ).rejects.toBeInstanceOf(NativeInputWithheldError)
        expect(f.starts).toHaveLength(1)
        expect(f.methods.filter((method) => method === 'thread/start')).toHaveLength(0)
      } finally {
        await f.adapter.dispose()
      }
    },
  )
})

function claudeFixture(
  options: {
    missingEffort?: boolean
    unknownSpeed?: boolean
    holdProducer?: boolean
    lateFailure?: boolean
  } = {},
) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: () => true,
  })
  const prompts: SDKUserMessage[] = []
  const closed = Promise.withResolvers<void>(),
    producer = Promise.withResolvers<void>()
  let settingsReads = 0,
    text = ''
  child.stdin.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8')
    while (text.includes('\n')) {
      const end = text.indexOf('\n'),
        frame = JSON.parse(text.slice(0, end)) as {
          request_id: string
          request: { subtype: string }
        }
      text = text.slice(end + 1)
      if (frame.request.subtype === 'get_settings') {
        settingsReads++
        queueMicrotask(() =>
          child.stdout.write(
            JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: frame.request_id,
                response: {
                  applied: {
                    model: 'claude-fixture',
                    ...(options.missingEffort ? {} : { effort: null }),
                    ...(options.unknownSpeed ? {} : { fastMode: false }),
                  },
                  effective: {
                    ...(options.unknownSpeed ? {} : { fastMode: false }),
                    permissions: { defaultMode: 'default' },
                    env: { PRIVATE_VALUE: 'do-not-retain' },
                  },
                },
              },
            }) + '\n',
          ),
        )
      }
    }
  })
  const query = ((request: Parameters<typeof sdkQuery>[0]) => {
    request.options!.spawnClaudeCodeProcess!({
      command: '/owned/claude',
      args: [],
      env: {},
      signal: request.options!.abortController!.signal,
    })
    const iterator = (request.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]()
    let step = 0
    return {
      initializationResult: async () => ({ current_permission_mode: 'default' }),
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (step++ === 0) {
            if (options.holdProducer) await producer.promise
            const first = await iterator.next()
            if (first.done) return { done: true, value: undefined }
            prompts.push(first.value)
            return {
              done: false,
              value: {
                type: 'user',
                session_id: first.value.session_id,
                uuid: first.value.uuid,
                parent_tool_use_id: null,
                message: first.value.message,
              } as SDKMessage,
            }
          }
          if (options.lateFailure) throw new Error('Native transport failed after yielding')
          if (step === 2)
            return {
              done: false,
              value: {
                type: 'result',
                subtype: 'success',
                session_id: prompts[0]!.session_id,
                user_message_uuid: prompts[0]!.uuid,
                is_error: false,
                result: 'Complete',
              } as SDKMessage,
            }
          await iterator.return?.()
          return { done: true, value: undefined }
        },
      }),
      interrupt: async () => undefined,
      return: async () => {
        await iterator.return?.()
        return { done: true, value: undefined }
      },
      close: () => {
        void iterator.return?.()
        child.exitCode = 0
        child.emit('close', 0, null)
        closed.resolve()
      },
    }
  }) as unknown as typeof sdkQuery
  const adapter = new ClaudeAgentAdapter('/owned/claude', {
    query,
    getSessionInfo: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').getSessionInfo>(),
    spawn: vi.fn<() => ReturnType<typeof import('node:child_process').spawn>>(
      () => child as never,
    ) as never,
  })
  return {
    adapter,
    prompts,
    settingsReads: () => settingsReads,
    releaseProducer: () => producer.resolve(),
    close: () => {
      child.exitCode = 0
      child.emit('close', 0, null)
      closed.resolve()
    },
  }
}

describe('Claude reexecution evidence at the actual SDK producer', () => {
  it('does no evidence-settings RPC without optional recovery capture', async () => {
    const f = claudeFixture()
    try {
      await consume(f.adapter, input())
      expect(f.settingsReads()).toBe(0)
      expect(f.prompts).toHaveLength(1)
    } finally {
      f.close()
      await f.adapter.dispose()
    }
  })
  it('records actual complete settings without retaining effective environment values', async () => {
    const f = claudeFixture(),
      recovery = capture()
    try {
      await consume(f.adapter, { ...input(), recovery })
      expect(f.settingsReads()).toBe(1)
      expect(recovery.recordEffectiveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'claude',
          model: 'claude-fixture',
          effort: { known: true, value: null },
          speed: 'standard',
        }),
        expect.objectContaining({ executorId: f.adapter.executorId }),
      )
      expect(JSON.stringify(vi.mocked(recovery.recordEffectiveSettings).mock.calls)).not.toContain(
        'do-not-retain',
      )
      expect(recovery.recordConfirmedUnsent).not.toHaveBeenCalled()
    } finally {
      f.close()
      await f.adapter.dispose()
    }
  })
  it.each(['effort', 'speed'] as const)(
    'does not invent known native %s from an incomplete readback',
    async (unknown) => {
      const f = claudeFixture({
          missingEffort: unknown === 'effort',
          unknownSpeed: unknown === 'speed',
        }),
        recovery = capture()
      try {
        await consume(f.adapter, { ...input(), recovery })
        expect(f.prompts).toHaveLength(1)
        expect(recovery.recordEffectiveSettings).not.toHaveBeenCalled()
      } finally {
        f.close()
        await f.adapter.dispose()
      }
    },
  )
  it('does not publish unsent while an unconsumed producer can still yield, then records its natural no-yield close', async () => {
    const f = claudeFixture({ holdProducer: true }),
      recovery = capture(),
      report = vi.fn<NonNullable<AgentRunInput['reportNativeEffects']>>(),
      value = input()
    try {
      const result = consume(f.adapter, {
        ...value,
        recovery,
        reportNativeEffects: report,
        recordDispatch: (phase) => {
          if (phase === 'possibly_sent') throw new NativeInputWithheldError()
        },
      })
      await vi.waitFor(() => expect(f.settingsReads()).toBe(1))
      expect(recovery.recordConfirmedUnsent).not.toHaveBeenCalled()
      f.releaseProducer()
      await expect(result).rejects.toBeInstanceOf(NativeInputWithheldError)
      expect(f.prompts).toHaveLength(0)
      expect(recovery.recordConfirmedUnsent).toHaveBeenCalledExactlyOnceWith(
        { kind: 'claude_root_not_yielded' },
        { executorId: f.adapter.executorId, nativeSessionId: value.nativeSessionId },
      )
      expect(report.mock.calls.map(([fact]) => fact.state)).not.toContain('settled')
    } finally {
      f.close()
      await f.adapter.dispose()
    }
  })
  it('never converts a post-yield transport failure into unsent', async () => {
    const f = claudeFixture({ lateFailure: true }),
      recovery = capture()
    try {
      await expect(consume(f.adapter, { ...input(), recovery })).rejects.toBeInstanceOf(Error)
      expect(f.prompts).toHaveLength(1)
      expect(recovery.recordConfirmedUnsent).not.toHaveBeenCalled()
    } finally {
      f.close()
      await f.adapter.dispose()
    }
  })
  it('refuses to label a new Query with the original executor', async () => {
    const f = claudeFixture(),
      value = input(),
      settings: RunEffectiveExecutionSettings = {
        version: 1,
        provider: 'claude',
        model: 'claude-fixture',
        effort: { known: true, value: null },
        speed: 'standard',
        permissionMode: 'native',
        configurationSha256: 'b'.repeat(64),
        provenance: 'claude_applied_settings',
      }
    try {
      await expect(
        consume(f.adapter, {
          ...value,
          recovery: {
            ...capture(),
            expected: {
              settings,
              executorId: 'original-executor',
              nativeSessionId: value.nativeSessionId!,
            },
            canDispatch: () => true,
          },
        }),
      ).rejects.toBeInstanceOf(NativeInputWithheldError)
      expect(f.settingsReads()).toBe(0)
      expect(f.prompts).toHaveLength(0)
    } finally {
      f.close()
      await f.adapter.dispose()
    }
  })
})
