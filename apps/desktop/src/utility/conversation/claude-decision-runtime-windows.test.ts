import { createHash, randomUUID as contextId } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { decisionInputSchema } from '@pact/contracts'

import { ClaudeDecisionRuntime } from './claude-decision-runtime'

const protocol = vi.hoisted(() => {
  const state: {
    tail: string
    helper: boolean
    probeTail: boolean
    holdClose: { entered: () => void; release: Promise<void> } | undefined
  } = { tail: 'none', helper: false, probeTail: false, holdClose: undefined }
  return state
})

// Protocol-lifecycle unit seam only. The native Windows lane independently
// exercises actual CLI processes, Jobs, SQLite witnesses and receipt retirement.
vi.mock('../owned-process-group', async () => {
  const { ChildProcess } = await import('node:child_process')
  const { PassThrough } = await import('node:stream')
  const { randomUUID } = await import('node:crypto')
  const credentialSource = 'ANTHROPIC_API_KEY'
  return {
    OwnedProcessGroup: class {
      released = false
      readonly stdin = new PassThrough()
      readonly stdout = new PassThrough()
      readonly stderr = new PassThrough()
      readonly child = Object.assign(new ChildProcess(), {
        stdin: this.stdin,
        stdout: this.stdout,
        stderr: this.stderr,
      })
      constructor(private readonly options: { onCloseInput?: () => void }) {}
      spawn(_command: string, args: string[]) {
        const argument = (name: string) => args[args.indexOf(name) + 1]!
        const session = argument('--session-id'),
          model = argument('--model')
        const settings: unknown = JSON.parse(argument('--settings'))
        const send = (value: object) => this.stdout.write(JSON.stringify(value) + '\n')
        this.stdin.on('data', (chunk: Buffer) => {
          const value: unknown = JSON.parse(chunk.toString())
          if (!value || typeof value !== 'object') throw new Error('Owned input invalid')
          const request = Reflect.get(value, 'request')
          if (Reflect.get(value, 'type') === 'control_request') {
            const subtype: unknown =
              request && typeof request === 'object' ? Reflect.get(request, 'subtype') : undefined
            const response =
              subtype === 'initialize'
                ? {
                    models: [{ value: 'haiku', resolvedModel: model }],
                    account: {
                      apiProvider: 'firstParty',
                      email: 'owned@example.invalid',
                      organization: 'owned',
                      apiKeySource: credentialSource,
                    },
                  }
                : subtype === 'get_settings'
                  ? {
                      effective: {
                        ...(settings && typeof settings === 'object' ? settings : {}),
                        ...(protocol.helper ? { apiKeyHelper: 'owned-helper' } : {}),
                      },
                      applied: { model },
                    }
                  : { policy: { allDisabled: true, policyHookCount: 0 }, hooks: [] }
            send({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: Reflect.get(value, 'request_id'),
                response,
              },
            })
            if (protocol.probeTail && subtype === 'get_hooks_listing')
              this.stdout.write('{"incomplete":')
            return
          }
          const command = Reflect.get(value, 'uuid'),
            answer = '{"candidateId":"wait","highlights":[]}'
          const lifecycle = (state: string) => ({
            type: 'command_lifecycle',
            session_id: session,
            command_uuid: command,
            uuid: randomUUID(),
            state,
          })
          const messages: object[] = [
            lifecycle('queued'),
            lifecycle('started'),
            {
              type: 'system',
              subtype: 'init',
              session_id: session,
              model,
              tools: [],
              mcp_servers: [],
            },
            {
              type: 'assistant',
              session_id: session,
              parent_tool_use_id: null,
              user_message_uuid: command,
              user_message_uuids: [command],
              message: { id: 'owned', model, content: [{ type: 'text', text: answer }] },
            },
            {
              type: 'result',
              session_id: session,
              subtype: 'success',
              is_error: false,
              num_turns: 1,
              queued_turn_count: 0,
              result_index: 0,
              user_message_uuid: command,
              user_message_uuids: [command],
              result: answer,
              usage: { input_tokens: 2, output_tokens: 3 },
            },
            lifecycle('completed'),
          ]
          if (protocol.tail === 'tool')
            messages.push({
              type: 'assistant',
              session_id: session,
              parent_tool_use_id: null,
              user_message_uuid: command,
              user_message_uuids: [command],
              message: {
                id: 'owned',
                model,
                content: [{ type: 'tool_use', id: 'late-tool', name: 'Bash', input: {} }],
              },
            })
          if (protocol.tail === 'session')
            messages.push({ type: 'system', subtype: 'status', session_id: randomUUID() })
          if (protocol.tail === 'none')
            messages.push({
              type: 'rate_limit_event',
              session_id: session,
              uuid: randomUUID(),
              rate_limit_info: { status: 'allowed', unifiedWindows: {} },
            })
          this.stdout.write(
            messages.map((message) => JSON.stringify(message)).join('\n') +
              '\n' +
              (protocol.tail === 'partial' ? '{"incomplete":' : ''),
          )
        })
        return this.child
      }
      physicalWitness(ownerId: string) {
        return Promise.resolve({
          version: 2,
          platform: 'win32',
          ownerId,
          generation: randomUUID(),
          protocolVersion: 1,
          phase: 'contained',
          owner: { pid: 5101, creationFileTime: '10' },
          bridge: { pid: 5102, creationFileTime: '20' },
          root: { pid: 5103, creationFileTime: '30' },
          receipt: { id: randomUUID(), volumeSerial: 'b'.repeat(16), fileId: 'c'.repeat(32) },
          atomicJob: true,
          noBreakaway: true,
        })
      }
      async close() {
        if (this.released) return
        if (protocol.holdClose) {
          protocol.holdClose.entered()
          await protocol.holdClose.release
        }
        this.options.onCloseInput?.()
        this.stdout.end()
        this.stderr.end()
        this.child.emit('close', 0, null)
        this.released = true
      }
    },
  }
})

function fixture(tail: string, helper = false, probeTail = false) {
  protocol.tail = tail
  protocol.helper = helper
  protocol.probeTail = probeTail
  protocol.holdClose = undefined
  const text = 'Complete owned source.'
  const input = decisionInputSchema.parse({
    version: 1,
    objective: 'Keep waiting.',
    handoff: {
      id: 'a'.repeat(64),
      sessionId: contextId(),
      budgetRoot: { kind: 'task', id: contextId() },
      budgetSubjectId: 'task:owned',
      eventId: 'event:owned',
      slot: 'workflow_next',
      factFingerprint: 'b'.repeat(64),
      freshnessGuard: {
        taskRevision: 1,
        settingsRevision: 1,
        inputSequence: 1,
        runId: contextId(),
        bindingGeneration: 1,
        agentId: 'claude',
        stateFingerprint: 'c'.repeat(64),
      },
    },
    candidates: [{ id: 'wait', description: 'Keep waiting.' }],
    sources: [{ id: 'source:1', text, digest: createHash('sha256').update(text).digest('hex') }],
  })
  const physicalCompletion =
    vi.fn<
      NonNullable<ConstructorParameters<typeof ClaudeDecisionRuntime>[0]['physicalCompletion']>
    >()
  const dispatch = vi.fn<() => void>()
  const runtime = new ClaudeDecisionRuntime({
    executable: process.execPath,
    modelId: 'claude-haiku-5-5',
    ownerId: contextId(),
    cwd: process.cwd(),
    current: () => true,
    reserve: () => 'reserved',
    dispatch,
    environment: { ANTHROPIC_API_KEY: 'OWNED_ONLY' },
    beginNativeStage: () => 1,
    physicalPrepared: () => {},
    prepared: () => {},
    physicalCompletion,
  })
  return { input, runtime, physicalCompletion, dispatch }
}

describe.runIf(process.platform === 'win32')('Windows runtime final protocol settlement', () => {
  it('preserves cancellation and its lease when cancellation wins during final stream closure', async () => {
    const f = fixture('none'),
      entered = Promise.withResolvers<void>(),
      released = Promise.withResolvers<void>()
    const controller = new AbortController()
    protocol.holdClose = { entered: () => entered.resolve(), release: released.promise }
    try {
      const pending = f.runtime.evaluateDecision(f.input, controller.signal)
      await entered.promise
      controller.abort()
      expect(await pending).toEqual({ kind: 'unavailable', reason: 'cancelled' })
      expect(f.runtime.diagnostics().working.released).toBe(false)
      expect(f.physicalCompletion).not.toHaveBeenCalled()
      released.resolve()
      expect(await f.runtime.settlement()).toBe(true)
      expect(f.physicalCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: { kind: 'unavailable', reason: 'cancelled' } }),
      )
    } finally {
      released.resolve()
      await f.runtime.dispose()
      protocol.holdClose = undefined
    }
  })

  it('does not confirm a probe with an invalid tail after its last metadata response', async () => {
    const f = fixture('none', false, true)
    try {
      expect(await f.runtime.probeAdmission()).toMatchObject({
        supported: false,
        physicalReleased: true,
      })
      expect(await f.runtime.settlement()).toBe(true)
      expect(f.dispatch).not.toHaveBeenCalled()
    } finally {
      await f.runtime.dispose()
    }
  })

  it.each(['tool', 'session', 'partial'] as const)(
    'rejects a %s tail after a completed result while physically releasing the owner',
    async (tail) => {
      const f = fixture(tail)
      try {
        expect((await f.runtime.evaluateDecision(f.input, new AbortController().signal)).kind).toBe(
          'unavailable',
        )
        expect(await f.runtime.settlement()).toBe(true)
        expect(f.runtime.usage).toEqual({ inputTokens: 2, outputTokens: 3 })
        expect(f.physicalCompletion).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: expect.objectContaining({ kind: 'unavailable' }) }),
        )
      } finally {
        await f.runtime.dispose()
      }
    },
  )

  it('keeps a valid result with bounded late native metadata', async () => {
    const f = fixture('none')
    try {
      expect(await f.runtime.evaluateDecision(f.input, new AbortController().signal)).toEqual({
        kind: 'recommendation',
        recommendation: { candidateId: 'wait', highlights: [] },
      })
      expect(await f.runtime.settlement()).toBe(true)
    } finally {
      await f.runtime.dispose()
    }
  })

  it('refuses an effective credential helper despite existing native account identity', async () => {
    const f = fixture('none', true)
    try {
      expect((await f.runtime.evaluateDecision(f.input, new AbortController().signal)).kind).toBe(
        'unavailable',
      )
      expect(await f.runtime.settlement()).toBe(true)
      expect(f.dispatch).not.toHaveBeenCalled()
    } finally {
      await f.runtime.dispose()
    }
  })
})
