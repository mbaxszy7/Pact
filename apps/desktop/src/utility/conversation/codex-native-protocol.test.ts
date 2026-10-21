/* oxlint-disable typescript/no-unsafe-type-assertion -- Minimal fake native process exercises the production protocol seam. */
/* oxlint-disable vitest/no-conditional-expect -- Protocol responders assert each method's exact native request shape. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentNativeContextRebuildInput, AgentRunInput } from '@pact/agent-runtime'
import type { NativeContextRebuildChunk, NormalizedAgentEvent } from '@pact/contracts'
import type { NativeInitializationWitness } from '@pact/contracts'

import { CodexAgentAdapter } from './codex-agent-adapter'

const nativeHomes: string[] = []
afterEach(async () => {
  await Promise.all(
    nativeHomes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
async function nativeHome() {
  const storageRoot = await mkdtemp(join(tmpdir(), 'pact-codex-home-test-'))
  nativeHomes.push(storageRoot)
  return { storageRoot, path: join(storageRoot, 'native.jsonl') }
}
function saveRollout(
  path: string,
  nativeSessionId: string,
  items: any[],
): NativeInitializationWitness {
  const records = [
    { type: 'session_meta', payload: { id: nativeSessionId } },
    ...items.map((item) => ({
      type: 'response_item',
      payload: {
        ...item,
        type: item.type === 'userMessage' ? 'message' : item.type,
        ...(item.type === 'userMessage' ? { role: 'user' } : {}),
      },
    })),
  ]
  const text = records.map((record) => JSON.stringify(record) + '\n').join('')
  writeFileSync(path, text)
  return {
    kind: 'codex_rollout_v1',
    nativeSessionId,
    verifiedPrefixBytes: Buffer.byteLength(text),
    verifiedPrefixSha256: createHash('sha256').update(text).digest('hex'),
    recordCount: records.length,
  }
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

type Send = (message: object) => void
function nativeProcess(
  handler: (request: Record<string, any>, send: Send) => void,
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough()
  Object.assign(child, {
    spawnReader: () => nativeProcess(handler),
    stdin,
    stdout,
    stderr,
    exitCode: null,
    kill: () => {
      queueMicrotask(() => {
        Object.assign(child, { exitCode: 0 })
        child.emit('exit', 0, null)
      })
      return true
    },
  })
  let input = ''
  stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8')
    while (input.includes('\n')) {
      const end = input.indexOf('\n'),
        line = input.slice(0, end)
      input = input.slice(end + 1)
      handler(JSON.parse(line), (message) =>
        queueMicrotask(() => stdout.write(`${JSON.stringify(message)}\n`)),
      )
    }
  })
  return child
}

const rebuild: AgentNativeContextRebuildInput = {
  rebuildId: 'rebuild-1',
  sessionId: 'session-1',
  cwd: '/project',
  sourceHash: 'a'.repeat(64),
  model: null,
  effort: null,
}
async function* seed(): AsyncGenerator<NativeContextRebuildChunk> {
  for (let index = 0; index < 30; index += 1)
    yield {
      kind: 'message',
      messageId: `message-${index}`,
      sequence: index,
      speaker: 'user',
      state: 'complete',
      part: 0,
      final: true,
      content: `question-${index}`,
    }
}

describe('Codex bounded native protocol', () => {
  it.each([
    'command',
    'network',
    'command-default',
    'network-default',
    'session',
    'legacy',
    'forged',
    'persistent-only',
  ] as const)(
    'offers only one-call/current-Session responses when native proposes persistent rules: %s',
    async (kind) => {
      let response: Record<string, any> | undefined
      const amendments = [
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['pnpm', 'test'] } },
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: 'example.test', action: 'allow' },
          },
        },
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: 'example.test', action: 'deny' },
          },
        },
      ]
      const requestPermission = vi.fn<NonNullable<AgentRunInput['requestPermission']>>(
        async (request) => {
          expect(request.actions?.map((action) => action.label)).not.toContain(
            'Review and allow command rule…',
          )
          expect(request.actions?.map((action) => action.label)).not.toContain(
            'Review and allow host rule…',
          )
          expect(request.actions?.map((action) => action.label)).not.toContain(
            'Review and block host rule…',
          )
          expect(request.actions?.map((action) => action.scope).join(' ')).not.toContain(
            'Persistence:',
          )
          if (kind === 'forged') return 'native-7'
          const selectedAction = request.actions?.find((action) =>
            kind === 'session' ? action.kind === 'rule' : action.kind === 'allow',
          )
          if (!selectedAction) throw new Error('Required scoped action missing')
          return selectedAction.id
        },
      )
      const child = nativeProcess((request, send) => {
        const { id, method } = request
        if (method === 'initialize') send({ id, result: {} })
        else if (method === 'config/read')
          send({
            id,
            result: {
              config: { approval_policy: 'on-request', sandbox_mode: 'danger-full-access' },
            },
          })
        else if (method === 'thread/start')
          send({
            id,
            result: {
              thread: { id: 'thread-1' },
              model: 'gpt-test',
              approvalPolicy: 'on-request',
              approvalsReviewer: 'user',
              sandbox: { type: 'dangerFullAccess' },
            },
          })
        else if (method === 'turn/start') {
          send({ id, result: { turn: { id: 'turn-1' } } })
          send({
            id: 'scope-approval',
            method:
              kind === 'legacy' ? 'execCommandApproval' : 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'command-1',
              command: ['pnpm', 'test'],
              cwd: '/project',
              proposedExecpolicyAmendment: ['pnpm', 'test'],
              proposedNetworkPolicyAmendments: [{ host: 'example.test', action: 'allow' }],
              ...(kind.startsWith('network')
                ? { networkApprovalContext: { host: 'example.test', protocol: 'https' } }
                : {}),
              ...(!kind.endsWith('-default')
                ? {
                    availableDecisions:
                      kind === 'persistent-only'
                        ? amendments
                        : ['accept', ...amendments, 'acceptForSession', 'cancel'],
                  }
                : {}),
            },
          })
        } else if (id === 'scope-approval') {
          response = request
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
            runId: 'scope-run',
            sessionId: 'session-1',
            cwd: '/project',
            model: null,
            effort: null,
            permissionMode: 'native',
            peerAssistanceAllowed: false,
            requestPermission,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: 'session-1',
              message: { id: 'message-1', content: 'Synthetic scoped approval' },
              comments: [],
            },
          },
          new AbortController().signal,
        ))
          void event
        expect(requestPermission).toHaveBeenCalledTimes(kind === 'persistent-only' ? 0 : 1)
        expect(response).toMatchObject(
          kind === 'forged' || kind === 'persistent-only'
            ? { error: expect.any(Object) }
            : {
                result: {
                  decision:
                    kind === 'session'
                      ? 'acceptForSession'
                      : kind === 'legacy'
                        ? 'approved'
                        : 'accept',
                },
              },
        )
        expect(JSON.stringify(response)).not.toContain('Amendment')
        expect(JSON.stringify(response)).not.toContain('amendment')
        await vi.waitFor(() => expect(adapter.hasActiveBackgroundWork()).toBe(false))
      } finally {
        await adapter.dispose()
      }
    },
  )

  it.each([
    'idle',
    'notLoaded',
    'missing',
    'active',
    'late-active',
    'changed-seed',
    'extra-user',
    'extra-tool',
    'missing-witness',
  ])(
    'checks a committed initialized binding cold without inventing a Model Turn: %s',
    async (scenario) => {
      const home = await nativeHome()
      const items: object[] = []
      let index = 0
      for await (const chunk of seed()) {
        items.push({
          type: 'userMessage',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                pactContext: true,
                pactRebuildId: rebuild.rebuildId,
                pactSourceHash: rebuild.sourceHash,
                chunkIndex: index++,
                ...chunk,
              }),
            },
          ],
        })
      }
      const witness = saveRollout(home.path, 'new-thread', items)
      if (scenario === 'changed-seed') items.pop()
      if (scenario === 'extra-user')
        items.push({ type: 'userMessage', content: [{ type: 'text', text: 'A new native task' }] })
      if (scenario === 'extra-tool')
        items.push({ type: 'commandExecution', id: 'native-task', status: 'inProgress' })
      saveRollout(home.path, 'new-thread', items)
      const methods: string[] = []
      let metadataReads = 0
      const child = nativeProcess((request, send) => {
        const { id, method, params } = request
        methods.push(method)
        if (method === 'initialize') send({ id, result: {} })
        else if (method === 'thread/read') {
          metadataReads += 1
          expect(params.includeTurns).toBe(false)
          if (scenario === 'missing')
            send({
              id,
              error: { code: -32600, message: 'no rollout found for thread id new-thread' },
            })
          else
            send({
              id,
              result: {
                thread: {
                  id: 'new-thread',
                  path: home.path,
                  status: {
                    type:
                      scenario === 'active' || (scenario === 'late-active' && metadataReads > 1)
                        ? 'active'
                        : scenario === 'idle'
                          ? 'idle'
                          : 'notLoaded',
                  },
                },
              },
            })
        } else if (method === 'thread/items/list') {
          const offset = Number(params.cursor ?? 0),
            page = items.slice(offset, offset + 25)
          send({
            id,
            result: {
              data: page.map((item) => ({ item, turnId: null })),
              nextCursor: offset + page.length < items.length ? String(offset + page.length) : null,
            },
          })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child), home)
      try {
        const result = await adapter.probeNativeStatus(
          {
            target: 'initialized_binding',
            sessionId: 'session-1',
            agentId: 'codex',
            requestId: 'check-1',
            nativeSessionId: 'new-thread',
            bindingGeneration: 2,
            cwd: '/project',
            model: null,
            effort: null,
            confirmedInitialization: {
              rebuildId: rebuild.rebuildId,
              sourceHash: rebuild.sourceHash!,
              ...(scenario === 'missing-witness' ? {} : { witness }),
            },
            source: seed(),
          },
          new AbortController().signal,
        )
        expect(result.kind).toBe(
          ['idle', 'notLoaded'].includes(scenario)
            ? 'binding_ready'
            : scenario === 'missing'
              ? 'missing'
              : 'no_evidence',
        )
        expect(result.identity).toEqual({
          sessionId: 'session-1',
          agentId: 'codex',
          requestId: 'check-1',
          nativeSessionId: 'new-thread',
          bindingGeneration: 2,
        })
        // A completed durable receipt is distinct from an unconfirmed creation.
        await expect(
          adapter.inspectNativeRebuild(
            { ...rebuild, nativeSessionId: 'new-thread' },
            seed(),
            new AbortController().signal,
          ),
        ).resolves.toBeUndefined()
        expect(
          methods.filter((method) =>
            ['thread/start', 'thread/resume', 'thread/inject_items', 'turn/start'].includes(method),
          ),
        ).toEqual([])
      } finally {
        await adapter.dispose()
      }
    },
  )

  it('binds the real executor before startup callbacks and rejects zero-start failure without a phantom unknown owner', async () => {
    const order: string[] = [],
      phases: string[] = [],
      evidence: string[] = []
    const child = nativeProcess((request, send) => {
      order.push(request.method)
      if (request.method === 'initialize') send({ id: request.id, result: {} })
      else if (request.method === 'config/read')
        send({ id: request.id, error: { code: -32603, message: 'Configuration unavailable' } })
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    try {
      const task = async () => {
        for await (const event of adapter.run(
          {
            runId: 'run-1',
            sessionId: 'session-1',
            cwd: '/project',
            nativeSessionId: 'old-thread',
            model: null,
            effort: null,
            promptEnvelope: {
              version: 'pact-agent-prompt-v1',
              sessionId: 'session-1',
              message: { id: 'message-1', content: 'Hello' },
              comments: [],
            },
            recordExecutor: () => order.push('executor'),
            recordDispatch: (phase) => phases.push(phase),
            recordNativeEvidence: (fact) => evidence.push(fact.kind),
          },
          new AbortController().signal,
        ))
          void event
      }
      await expect(task()).rejects.toThrow('effective native configuration')
      expect(order[0]).toBe('executor')
      expect(phases).toEqual(['rejected'])
      expect(evidence).not.toContain('no_evidence')
      expect(order).not.toContain('thread/resume')
      expect(adapter.hasActiveBackgroundWork()).toBe(false)
    } finally {
      await adapter.dispose()
    }
  })

  it.each(['valid', 'missing', 'duplicate', 'reordered', 'changed', 'source-hash', 'open-hook'])(
    'requires complete persisted seed readback despite every append ACK: %s',
    async (fault) => {
      const home = await nativeHome()
      const methods: string[] = []
      const stored: any[] = []
      let notify: Send | undefined
      const child = nativeProcess((request, send) => {
        const { id, method, params } = request
        methods.push(method)
        if (method === 'initialize') send({ id, result: {} })
        else if (method === 'config/read') send({ id, result: { config: {} } })
        else if (method === 'thread/start') {
          notify = send
          if (fault === 'open-hook')
            send({
              method: 'hook/started',
              params: {
                threadId: 'new-thread',
                turnId: null,
                run: { id: 'hook-1', status: 'running' },
              },
            })
          send({
            id,
            result: {
              thread: { id: 'new-thread' },
              approvalPolicy: 'on-request',
              approvalsReviewer: 'user',
              sandbox: { type: 'readOnly' },
            },
          })
        } else if (method === 'thread/inject_items') {
          stored.push(...params.items)
          let items = [...stored]
          if (fault === 'missing') items.pop()
          if (fault === 'duplicate') items.push(items[0])
          if (fault === 'reordered') [items[0], items[1]] = [items[1], items[0]]
          if (fault === 'changed' || fault === 'source-hash') {
            items = structuredClone(items)
            const marker = JSON.parse(items[0].content[0].text)
            if (fault === 'changed') marker.content = 'different body'
            else marker.pactSourceHash = 'b'.repeat(64)
            items[0].content[0].text = JSON.stringify(marker)
          }
          saveRollout(home.path, 'new-thread', items)
          send({ id, result: {} })
        } else if (method === 'thread/read') {
          expect(params.includeTurns).toBe(false)
          send({
            id,
            result: { thread: { id: 'new-thread', path: home.path, status: { type: 'idle' } } },
          })
        } else if (method === 'thread/items/list') {
          send({ id, result: { data: [], nextCursor: null } })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child), home)
      try {
        const created = adapter.rebuildNativeContext(rebuild, seed(), new AbortController().signal)
        if (fault === 'valid')
          await expect(created).resolves.toMatchObject({
            nativeSessionId: 'new-thread',
            initializationWitness: { kind: 'codex_rollout_v1' },
          })
        else await expect(created).rejects.toThrow(/native|frozen|initialization/iu)
        const checked = await adapter.inspectNativeRebuild(
          { ...rebuild, nativeSessionId: 'new-thread' },
          seed(),
          new AbortController().signal,
        )
        expect(Boolean(checked?.initializationWitness)).toBe(fault === 'valid')
        if (fault === 'open-hook') {
          expect(adapter.hasActiveBackgroundWork(rebuild.rebuildId)).toBe(true)
          notify!({
            method: 'hook/completed',
            params: {
              threadId: 'new-thread',
              turnId: 'other-turn',
              run: { id: 'hook-1', status: 'completed' },
            },
          })
          await expect(
            adapter.inspectNativeRebuild(
              { ...rebuild, nativeSessionId: 'new-thread' },
              seed(),
              new AbortController().signal,
            ),
          ).resolves.toBeUndefined()
          notify!({
            method: 'hook/completed',
            params: {
              threadId: 'new-thread',
              turnId: null,
              run: { id: 'hook-1', status: 'completed' },
            },
          })
          await expect(
            adapter.inspectNativeRebuild(
              { ...rebuild, nativeSessionId: 'new-thread' },
              seed(),
              new AbortController().signal,
            ),
          ).resolves.toMatchObject({ initializationWitness: { kind: 'codex_rollout_v1' } })
          expect(adapter.hasActiveBackgroundWork(rebuild.rebuildId)).toBe(false)
        }
        expect(methods.filter((method) => method === 'thread/start')).toHaveLength(1)
        expect(methods).not.toContain('turn/start')
        expect(methods.filter((method) => method === 'thread/items/list').length).toBe(0)
      } finally {
        await adapter.dispose()
      }
    },
  )

  it('checks recent terminal metadata and recovers only its bounded body, without hydrating a long Thread', async () => {
    const methods: string[] = []
    const turns = Array.from({ length: 2000 }, (_, index) => ({
      id: `turn-${index}`,
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      error: null,
    }))
    const child = nativeProcess((request, send) => {
      const { id, method, params } = request
      methods.push(method)
      if (method === 'initialize') send({ id, result: {} })
      else if (method === 'thread/read') {
        expect(params.includeTurns).toBe(false)
        send({ id, result: { thread: { id: 'thread-1', status: { type: 'notLoaded' } } } })
      } else if (method === 'thread/turns/list') {
        expect(params.itemsView).toBe('notLoaded')
        expect(params.sortDirection).toBe('desc')
        const offset = Number(params.cursor ?? 0),
          descending = turns.toReversed()
        send({
          id,
          result: { data: descending.slice(offset, offset + 25), nextCursor: String(offset + 25) },
        })
      } else if (method === 'thread/items/list') {
        expect(params.turnId).toBe('turn-1970')
        send({
          id,
          result: {
            data: [
              {
                turnId: params.turnId,
                item: { id: 'answer-1', type: 'agentMessage', text: 'Original body' },
              },
            ],
            nextCursor: null,
          },
        })
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    try {
      await expect(
        adapter.probeNativeStatus(
          {
            sessionId: 'session-1',
            agentId: 'codex',
            requestId: 'run-1',
            runId: 'run-1',
            nativeSessionId: 'thread-1',
            nativeTurnId: 'turn-1970',
            bindingGeneration: 1,
            cwd: '/project',
            model: null,
            effort: null,
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        kind: 'ended',
        outcome: 'completed',
        source: 'stored_terminal',
        output: { text: 'Original body', completeness: 'complete' },
      })
      expect(methods.filter((method) => method === 'thread/turns/list')).toHaveLength(2)
      expect(methods).not.toContain('thread/resume')
      expect(methods).not.toContain('turn/start')
    } finally {
      await adapter.dispose()
    }
  })

  it.each([
    'no-terminal',
    'later-unfinished',
    'body-overflow',
    'item-frame-overflow',
    'items-unavailable',
  ])('keeps terminal truth separate from body availability: %s', async (scenario) => {
    const child = nativeProcess((request, send) => {
      const { id, method, params } = request
      if (method === 'initialize') send({ id, result: {} })
      else if (method === 'thread/read')
        send({ id, result: { thread: { id: 'thread-1', status: { type: 'notLoaded' } } } })
      else if (method === 'thread/turns/list') {
        const terminal = {
          id: 'turn-1',
          status: 'completed',
          error: null,
          ...(scenario === 'no-terminal' ? {} : { completedAt: 2 }),
        }
        send({
          id,
          result: {
            data:
              scenario === 'later-unfinished'
                ? [{ id: 'turn-2', status: 'inProgress' }, terminal]
                : [terminal],
            nextCursor: null,
          },
        })
      } else if (method === 'thread/items/list') {
        if (scenario === 'items-unavailable')
          send({ id, error: { code: -32601, message: 'Unsupported item read' } })
        else {
          const count = scenario === 'body-overflow' ? 129 : 1,
            offset = Number(params.cursor ?? 0)
          send({
            id,
            result: {
              data: Array.from({ length: Math.min(params.limit, count - offset) }, (_, index) => ({
                turnId: 'turn-1',
                item: {
                  id: `item-${offset + index}`,
                  type: 'agentMessage',
                  text: scenario === 'item-frame-overflow' ? 'x'.repeat(1024 * 1024 + 1) : 'body',
                },
              })),
              nextCursor: offset + params.limit < count ? String(offset + params.limit) : null,
            },
          })
        }
      }
    })
    const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
    try {
      const result = await adapter.probeNativeStatus(
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
      expect(result.kind).toBe(
        ['no-terminal', 'later-unfinished'].includes(scenario) ? 'no_evidence' : 'ended',
      )
      expect('output' in result && result.output?.completeness === 'complete').toBe(false)
      expect(adapter.diagnostics().open).toBe(true)
    } finally {
      await adapter.dispose()
    }
  })

  it('an oversized historical item retires only its reader while the live model continues to a real terminal', async () => {
    let notifyLive: Send | undefined
    let liveKilled = false
    const handler = (request: Record<string, any>, send: Send) => {
      const { id, method, params } = request
      if (method === 'initialize') send({ id, result: {} })
      else if (method === 'config/read')
        send({
          id,
          result: { config: { approval_policy: 'on-request', sandbox_mode: 'danger-full-access' } },
        })
      else if (method === 'thread/start')
        send({
          id,
          result: {
            thread: { id: 'live-thread' },
            model: 'gpt-test',
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            sandbox: { type: 'dangerFullAccess' },
          },
        })
      else if (method === 'turn/start') {
        notifyLive = send
        send({ id, result: { turn: { id: 'live-turn' } } })
      } else if (method === 'thread/read')
        send({ id, result: { thread: { id: params.threadId, status: { type: 'notLoaded' } } } })
      else if (method === 'thread/turns/list')
        send({
          id,
          result: {
            data: [{ id: 'old-turn', status: 'completed', completedAt: 2, error: null }],
            nextCursor: null,
          },
        })
      else if (method === 'thread/items/list') {
        expect(params.limit).toBe(1)
        send({
          id,
          result: {
            data: [
              {
                turnId: 'old-turn',
                item: { id: 'huge-body', type: 'agentMessage', text: 'x'.repeat(1024 * 1024 + 1) },
              },
            ],
            nextCursor: null,
          },
        })
      }
    }
    let first = true
    const adapter = new CodexAgentAdapter('/fake/codex', () => {
      const child = nativeProcess(handler)
      if (first) {
        first = false
        const kill = child.kill.bind(child)
        child.kill = (...args) => {
          liveKilled = true
          return kill(...args)
        }
      }
      return child
    })
    const events: NormalizedAgentEvent[] = []
    const task = (async () => {
      for await (const event of adapter.run(
        {
          runId: 'live-run',
          sessionId: 'session-1',
          cwd: '/project',
          model: null,
          effort: null,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId: 'session-1',
            message: { id: 'message-1', content: 'Keep running' },
            comments: [],
          },
        },
        new AbortController().signal,
      ))
        events.push(event)
    })()
    try {
      await new Promise<void>((resolve, reject) => {
        let checks = 0
        const wait = (): void => {
          if (notifyLive) resolve()
          else if (++checks > 1000) reject(new Error('The fake native task was not dispatched.'))
          else setImmediate(wait)
        }
        wait()
      })
      const result = await adapter.probeNativeStatus(
        {
          sessionId: 'session-1',
          agentId: 'codex',
          requestId: 'old-run',
          runId: 'old-run',
          nativeSessionId: 'old-thread',
          nativeTurnId: 'old-turn',
          bindingGeneration: 1,
          cwd: '/project',
          model: null,
          effort: null,
        },
        new AbortController().signal,
      )
      expect(result.kind).toBe('ended')
      expect(liveKilled).toBe(false)
      expect(adapter.diagnostics().open).toBe(true)
      expect(adapter.hasActiveBackgroundWork()).toBe(true)
      notifyLive!({
        method: 'turn/completed',
        params: {
          threadId: 'live-thread',
          turn: { id: 'live-turn', status: 'completed', error: null },
        },
      })
      await task
      expect(events.at(-1)).toMatchObject({ type: 'turn.completed', outcome: 'completed' })
      expect(adapter.hasActiveBackgroundWork()).toBe(false)
    } finally {
      await adapter.dispose()
    }
  })

  it.each(['peer', 'title'] as const)(
    'uses one installed %s capability across resumed Turns; foreign and old completions do not consume root admission',
    async (kind) => {
      let installed: { url: string; name: string } | undefined
      let turnCount = 0
      const executorIds: string[] = []
      const requests: Record<string, any>[] = []
      const errors: unknown[] = []
      const child = nativeProcess((request, send) => {
        const { id, method, params } = request
        requests.push(request)
        if (method === 'initialize') send({ id, result: {} })
        else if (method === 'config/read')
          send({
            id,
            result: {
              config: { approval_policy: 'on-request', sandbox_mode: 'danger-full-access' },
            },
          })
        else if (method === 'thread/start' || method === 'thread/resume') {
          if (!installed) {
            const [key, value] = Object.entries(params.config).find(([entryKey]) =>
              entryKey.startsWith('mcp_servers.'),
            )!
            installed = {
              name: key.slice('mcp_servers.'.length),
              url: (value as { url: string }).url,
            }
          } else expect(params.excludeTurns).toBe(true)
          send({
            id,
            result: {
              thread: { id: 'root-thread' },
              model: 'test',
              approvalPolicy: 'on-request',
              approvalsReviewer: 'user',
              sandbox: { type: 'dangerFullAccess' },
            },
          })
        } else if (method === 'thread/settings/update') {
          send({ id, result: {} })
          send({
            method: 'thread/settings/updated',
            params: {
              threadId: 'root-thread',
              threadSettings: {
                approvalPolicy: params.approvalPolicy,
                approvalsReviewer: params.approvalsReviewer,
                sandboxPolicy: params.sandboxPolicy,
              },
            },
          })
        } else if (method === 'turn/start') {
          turnCount += 1
          const turnId = `turn-${turnCount}`
          send({ id, result: { turn: { id: turnId } } })
          void (async () => {
            const proposal =
              kind === 'title'
                ? { title: 'Metadata from the owning Turn' }
                : { target: 'claude', kind: 'review', reason: 'Review the conclusion.' }
            const toolName = kind === 'title' ? 'publish_session_title' : 'request_peer_assistance'
            const result: any = await fetch(installed!.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: toolName, arguments: proposal },
              }),
            }).then((response) => response.json())
            const item = {
              id: 'peer-1',
              type: 'mcpToolCall',
              server: installed!.name,
              tool: toolName,
              status: 'completed',
              error: null,
              arguments: proposal,
              result: result.result,
            }
            send({ method: 'item/completed', params: { threadId: 'foreign-thread', turnId, item } })
            send({
              method: 'item/completed',
              params: { threadId: 'root-thread', turnId: 'old-turn', item },
            })
            send({ method: 'item/completed', params: { threadId: 'root-thread', turnId, item } })
            send({
              method: 'item/completed',
              params: { threadId: 'root-thread', turnId, item: { ...item, id: 'duplicate' } },
            })
            send({
              method: 'turn/completed',
              params: {
                threadId: 'root-thread',
                turn: { id: turnId, status: 'completed', error: null },
              },
            })
          })().catch((error) => {
            errors.push(error)
            child.emit('exit', 1, null)
          })
        }
      })
      const adapter = new CodexAgentAdapter('/fake/codex', forkingFactory(child))
      try {
        for (let index = 0; index < 3; index += 1) {
          const input: AgentRunInput = {
            runId: `run-${index}`,
            sessionId: 'session-1',
            cwd: '/project',
            ...(index ? { nativeSessionId: 'root-thread' } : {}),
            model: null,
            effort: null,
            peerAssistanceAllowed: index !== 2,
            promptEnvelope: {
              ...(kind === 'title' && index !== 2 ? { requestSessionTitle: true as const } : {}),
              version: 'pact-agent-prompt-v1',
              sessionId: 'session-1',
              message: { id: `message-${index}`, content: 'Review code' },
              comments: [],
            },
            recordExecutor: (executor) => executorIds.push(executor),
          }
          const events: NormalizedAgentEvent[] = []
          // oxlint-disable-next-line no-await-in-loop -- Later Turns deliberately reuse the same native Thread/capability.
          for await (const event of adapter.run(input, new AbortController().signal))
            events.push(event)
          expect(
            events.filter(
              (event) =>
                event.type ===
                (kind === 'title' ? 'session.title.updated' : 'peer.assistance.requested'),
            ),
          ).toHaveLength(index === 2 ? 0 : 1)
        }
        expect(errors).toEqual([])
        expect(executorIds).toHaveLength(3)
        expect(new Set(executorIds).size).toBe(1)
        expect(
          requests
            .filter((request) => request.method === 'thread/resume')
            .map((request) =>
              Object.values(request.params.config)
                .map((value) =>
                  value && typeof value === 'object' ? Reflect.get(value, 'url') : undefined,
                )
                .find((url) => typeof url === 'string'),
            ),
        ).toEqual([installed!.url, installed!.url])
      } finally {
        await adapter.dispose()
      }
    },
  )
})
