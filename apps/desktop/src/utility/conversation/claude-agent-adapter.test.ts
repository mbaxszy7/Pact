/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion, vitest/require-mock-type-parameters -- The SDK protocol stubs intentionally provide only fields consumed by the Adapter. */
import type { SDKMessage, SDKUserMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const forkWorker = vi.hoisted(() => ({ path: '' }))
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
          String(filename).endsWith('native-fork-worker.js') ? forkWorker.path : filename,
          options,
        )
      }
    },
  }
})

import type {
  AgentNativeProbeInput,
  AgentNativeContextRebuildInput,
  AgentRunInput,
} from '@pact/agent-runtime'

import { NativeCapacityError } from './agent-execution-error'
import { CLAUDE_TITLE_TIMEOUT_MS, ClaudeAgentAdapter } from './claude-agent-adapter.js'
import { planEnvelope, planRunInput } from './collaboration-fixture.test-support.js'
import { nativeWorkerFixture } from './native-workers-fixture.test-support.js'

let workerFixture: Awaited<ReturnType<typeof nativeWorkerFixture>>
beforeAll(async () => {
  workerFixture = await nativeWorkerFixture(['native-fork-worker'])
  forkWorker.path = workerFixture.paths['native-fork-worker']!
}, 20_000)
afterAll(async () => {
  await workerFixture?.dispose()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('Claude Agent lifecycle', () => {
  it.each([false, true])(
    'keeps reading Steer consumption and final control receipts with background carrier failure=%s',
    async (carrierFails) => {
      const input = {
        ...planRunInput('claude'),
        nativeSessionId: 'claude-carrier-failure',
        nativeGeneration: 'carrier-failure-fixture',
        bindingGeneration: 1,
      }
      const steerId = randomUUID(),
        carrier = planEnvelope('Exact plan carrier')
      const overflow = Promise.withResolvers<void>(),
        deliverCarrier = Promise.withResolvers<void>()
      const rootPrompt = Promise.withResolvers<void>()
      const evidence = vi.fn<NonNullable<AgentRunInput['recordNativeEvidence']>>()
      const failure = vi.fn<NonNullable<AgentRunInput['recordOutputFailure']>>()
      const consumption = vi.fn<(inputId: string) => void>()
      const persistCarrier = vi.fn<NonNullable<AgentRunInput['recordCollaborationCarrier']>>(() => {
        if (carrierFails) throw new Error('The final-proof working reservation is unavailable.')
      })
      const prompts: SDKUserMessage[] = []
      let reachedEof = false,
        inputDrain: Promise<void> | undefined
      const query = ((request: { prompt: AsyncIterable<SDKUserMessage> }) => {
        inputDrain = (async () => {
          for await (const message of request.prompt) {
            prompts.push(message)
            if (prompts.length === 1) rootPrompt.resolve()
          }
        })()
        void inputDrain.catch(() => undefined)
        const output = (async function* () {
          await rootPrompt.promise
          yield {
            type: 'system',
            subtype: 'init',
            session_id: input.nativeSessionId,
            capabilities: ['interrupt_cancel_queued_v1'],
          } as SDKMessage
          yield {
            type: 'assistant',
            session_id: input.nativeSessionId,
            parent_tool_use_id: null,
            user_message_uuid: input.runId,
            uuid: 'initial-empty',
            message: { id: 'initial-empty', model: 'fixture', content: [] },
          } as unknown as SDKMessage
          await overflow.promise
          for (let index = 0; index < 129; index += 1)
            yield {
              type: 'assistant',
              session_id: input.nativeSessionId,
              parent_tool_use_id: null,
              user_message_uuid: input.runId,
              uuid: `overflow-${index}`,
              message: {
                id: `overflow-${index}`,
                model: 'fixture',
                content: [{ type: 'text', text: 'Nonempty' }],
              },
            } as SDKMessage
          await deliverCarrier.promise
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: input.nativeSessionId,
            user_message_uuid: input.runId,
            structured_output: carrier,
            result: JSON.stringify(carrier),
          } as SDKMessage
          yield {
            type: 'user',
            session_id: input.nativeSessionId,
            uuid: steerId,
            user_message_uuid: steerId,
            parent_tool_use_id: null,
            message: { role: 'user', content: 'Supplement incorporated' },
          } as SDKMessage
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: input.nativeSessionId,
            user_message_uuid: steerId,
            structured_output: carrier,
            result: JSON.stringify(carrier),
          } as SDKMessage
          reachedEof = true
        })()
        return {
          [Symbol.asyncIterator]: () => output,
          cancelAsyncMessage: vi.fn(async () => false),
          interrupt: vi.fn(async () => ({ cancelled: [], still_queued: [] })),
          close: vi.fn(),
          return: () => output.return(undefined),
        }
      }) as never
      const adapter = new ClaudeAgentAdapter('/fake/claude', {
        query,
        getSessionInfo: vi.fn() as never,
      })
      const started = Promise.withResolvers<void>()
      const outcome = (async () => {
        for await (const event of adapter.run(
          {
            ...input,
            recordNativeEvidence: evidence,
            recordOutputFailure: failure,
            recordCollaborationCarrier: persistCarrier,
          },
          new AbortController().signal,
        ))
          if (event.type === 'turn.started') started.resolve()
      })().catch((error: unknown) => error)
      try {
        await started.promise
        await expect(
          adapter.steer(
            {
              runId: input.runId,
              inputId: steerId,
              nativeSessionId: input.nativeSessionId,
              nativeTurnId: input.runId,
              nativeGeneration: input.nativeGeneration,
              bindingGeneration: 1,
              promptEnvelope: {
                ...input.promptEnvelope,
                message: { id: steerId, content: 'Supplement' },
              },
              recordDispatch: () => undefined,
              recordConsumption: consumption,
            },
            new AbortController().signal,
          ),
        ).resolves.toEqual({ status: 'submitted' })
        expect(prompts.map((message) => message.uuid)).toEqual([input.runId, steerId])
        overflow.resolve()
        expect(await outcome).toMatchObject({ kind: 'response_too_large' })
        expect(failure).toHaveBeenCalledTimes(1)
        deliverCarrier.resolve()
        await vi.waitFor(() => expect(persistCarrier).toHaveBeenCalled())
        await vi.waitFor(() =>
          expect({
            consumedIds: consumption.mock.calls.map(([id]) => id),
            nativeEnded: evidence.mock.calls.some(
              ([fact]) => fact.kind === 'ended' && fact.outcome === 'completed',
            ),
            reachedEof,
          }).toEqual({ consumedIds: [steerId], nativeEnded: true, reachedEof: true }),
        )
      } finally {
        overflow.resolve()
        deliverCarrier.resolve()
        await adapter.dispose()
        await inputDrain
        await outcome
      }
    },
  )

  it.each([false, true])(
    'keeps the exact native ending independent of empty items or projection overflow=%s',
    async (overflow) => {
      const input = runInput(),
        evidence = vi.fn<NonNullable<AgentRunInput['recordNativeEvidence']>>()
      const failure = vi.fn<NonNullable<AgentRunInput['recordOutputFailure']>>()
      const query = ((request: { prompt: AsyncIterable<SDKUserMessage> }) => ({
        async *[Symbol.asyncIterator]() {
          const prompt = await request.prompt[Symbol.asyncIterator]().next()
          expect(prompt.value?.uuid).toBe(input.runId)
          for (let index = 0; index < (overflow ? 129 : 256); index += 1)
            yield {
              type: 'assistant',
              uuid: `assistant-${index}`,
              session_id: input.nativeSessionId,
              user_message_uuid: input.runId,
              parent_tool_use_id: null,
              message: {
                id: `answer-${index}`,
                model: 'fixture',
                content: [{ type: 'text', text: overflow ? 'Nonempty' : '' }],
              },
            } as SDKMessage
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: input.nativeSessionId,
            user_message_uuid: input.runId,
            result: 'Final answer',
          } as SDKMessage
        },
        close: vi.fn(),
        return: vi.fn(async () => ({ done: true, value: undefined })),
      })) as never
      const adapter = new ClaudeAgentAdapter('/fake/claude', {
        query,
        getSessionInfo: vi.fn() as never,
      })
      const events: string[] = []
      try {
        const outcome = (async () => {
          for await (const event of adapter.run(
            { ...input, recordNativeEvidence: evidence, recordOutputFailure: failure },
            new AbortController().signal,
          ))
            events.push(event.type)
        })().catch((error: unknown) => error)
        const result: unknown = await outcome
        expect(result === undefined).toBe(!overflow)
        expect(result && typeof result === 'object' ? Reflect.get(result, 'kind') : undefined).toBe(
          overflow ? 'response_too_large' : undefined,
        )
        expect(failure).toHaveBeenCalledTimes(Number(overflow))
        expect(events.includes('turn.completed')).toBe(!overflow)
        await vi.waitFor(() =>
          expect(evidence).toHaveBeenCalledWith(
            expect.objectContaining({
              kind: 'ended',
              source: 'live_terminal',
              outcome: 'completed',
              identity: expect.objectContaining({
                requestId: input.runId,
                nativeSessionId: input.nativeSessionId,
              }),
            }),
          ),
        )
      } finally {
        await adapter.dispose()
      }
    },
  )

  it.each([true, false])(
    'keeps the complete native carrier private with valid submission=%s and enforces the readonly source-reader route',
    async (valid) => {
      const input = planRunInput('claude'),
        source = planEnvelope('Detailed plan\n'.repeat(5000)),
        carrier = valid ? source : { ...source, result: { ...source.result, submission: 'wrong' } },
        record = vi.fn<NonNullable<AgentRunInput['recordCollaborationCarrier']>>(),
        query = vi.fn(
          fakeQuery([
            {
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: 'claude-envelope',
              user_message_uuid: input.runId,
              result: JSON.stringify(carrier),
              structured_output: carrier,
            } as SDKMessage,
          ]),
        ),
        adapter = new ClaudeAgentAdapter('/fake/claude', {
          query: query as never,
          getSessionInfo: vi.fn() as never,
        }),
        events: import('@pact/contracts').NormalizedAgentEvent[] = []
      try {
        for await (const event of adapter.run(
          {
            ...input,
            nativeSessionId: 'claude-envelope',
            recordCollaborationCarrier: record,
            readCollaborationSourcePart: () => ({
              source: 'document',
              offset: 0,
              text: 'Complete source',
              nextOffset: null,
            }),
          },
          new AbortController().signal,
        ))
          events.push(event)
        expect(record).toHaveBeenCalledOnce()
        expect(record).toHaveBeenCalledWith(carrier)
        expect(
          events.filter((event) => event.type === 'text.completed').map((event) => event.text),
        ).toEqual([source.answer])
        expect(
          events.filter(
            (event) =>
              event.type === (valid ? 'collaboration.result' : 'collaboration.result_incomplete'),
          ),
        ).toHaveLength(1)
        const submitted = events.find((event) => event.type === 'collaboration.result')
        expect(submitted?.result.plan).toBe(valid ? source.result.plan : undefined)
        const options = query.mock.calls[0]![0].options!,
          server = Object.keys(options.mcpServers!)[0]!
        expect(options.allowedTools).toContain(`mcp__${server}__read_collaboration_source`)
        expect(options.allowedTools).not.toContain(`mcp__${server}__publish_collaboration_result`)
        expect(options.allowedTools).not.toContain(`mcp__${server}__request_peer_assistance`)
        expect(options.canUseTool).toBeTypeOf('function')
        const instructions = JSON.stringify(options.systemPrompt)
        expect(instructions).toContain('source=required_inputs')
        expect(instructions).toContain('$body')
        expect(instructions).not.toContain('If the user body is directly present')
        expect(query).toHaveBeenCalledOnce()
      } finally {
        await adapter.dispose()
      }
    },
  )
  it('allows only the registered internal title publisher without broadening native tool permissions', async () => {
    const query = vi.fn(
      fakeQuery([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'claude-session-1',
          user_message_uuid: runInput().runId,
          result: 'Done',
        } as SDKMessage,
      ]),
    )
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query: query as never,
      getSessionInfo: vi.fn() as never,
    })
    try {
      for await (const event of adapter.run(
        {
          ...runInput(),
          permissionMode: 'native',
          promptEnvelope: { ...runInput().promptEnvelope, requestSessionTitle: true },
        },
        new AbortController().signal,
      ))
        void event
      const options = query.mock.calls[0]![0].options!,
        server = Object.keys(options.mcpServers!)[0]!
      expect(options.allowedTools).toEqual([`mcp__${server}__publish_session_title`])
      expect(options.permissionMode).toBeUndefined()
      expect(options.allowDangerouslySkipPermissions).toBeUndefined()
      expect(options.settingSources).toEqual(['user', 'project', 'local'])
    } finally {
      await adapter.dispose()
    }
  })

  it('discovers only authoritative user-callable Skills at zero turns and drains discovery stderr', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
    })
    const disposeQuery = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const metadataInputs: SDKUserMessage[] = []
    const queryFactory = vi.fn((request: Parameters<typeof sdkQuery>[0]) => {
      request.options!.spawnClaudeCodeProcess!({
        command: process.execPath,
        args: [],
        env: {},
        signal: request.options!.abortController!.signal,
      })
      return {
        supportedCommands: async () => [
          { name: 'check', description: 'Allowed Skill', argumentHint: '' },
          { name: 'hidden', description: 'Not user-callable', argumentHint: '' },
        ],
        async *[Symbol.asyncIterator]() {
          try {
            for await (const message of request.prompt as AsyncIterable<SDKUserMessage>)
              metadataInputs.push(message)
            const signal = request.options!.abortController!.signal
            await new Promise<void>((resolve, reject) => {
              const finish = (error?: Error) => {
                child.stderr.removeListener('drain', drained)
                signal.removeEventListener('abort', aborted)
                if (error) reject(error)
                else resolve()
              }
              const drained = () => finish(),
                aborted = () => finish(new Error('Owned metadata cancelled'))
              child.stderr.once('drain', drained)
              signal.addEventListener('abort', aborted, { once: true })
              if (child.stderr.write(Buffer.alloc(512 * 1024, 120))) finish()
            })
            yield { type: 'system', subtype: 'init', skills: ['check'] } as SDKMessage
            yield { type: 'result', num_turns: 0, is_error: false } as SDKMessage
          } finally {
            child.exitCode = 0
            child.stdout.end()
            child.stderr.end()
            child.emit('close', 0, null)
          }
        },
        [Symbol.asyncDispose]: disposeQuery,
      }
    })
    const adapter = new ClaudeAgentAdapter(process.execPath, {
      query: queryFactory as unknown as typeof sdkQuery,
      getSessionInfo: vi.fn() as never,
      spawn: vi.fn(() => child) as never,
    })
    const controller = new AbortController(),
      deadline = setTimeout(() => controller.abort(), 1_000)
    try {
      const skills = await adapter.discoverSkills('/owned/metadata', controller.signal)
      expect(skills.map((entry) => entry.name)).toEqual(['check'])
      expect(metadataInputs).toHaveLength(1)
      expect(metadataInputs[0]?.shouldQuery).toBe(false)
      expect(queryFactory.mock.calls[0]![0].options?.persistSession).toBe(false)
      expect(child.stderr.readableLength).toBe(0)
      expect(child.stderr.listenerCount('error')).toBe(0)
      expect(disposeQuery).toHaveBeenCalledTimes(1)
    } finally {
      clearTimeout(deadline)
      controller.abort()
      await adapter.dispose()
    }
  })

  it('refuses a ninth unresolved native context after eight actor exits without terminal receipts', async () => {
    const controllers: AbortController[] = []
    const states: Array<{
      child: ReturnType<
        typeof Object.assign<
          EventEmitter,
          { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; exitCode: number | null }
        >
      >
      read: ReturnType<typeof Promise.withResolvers<IteratorResult<SDKMessage>>>
      readStarted: ReturnType<typeof Promise.withResolvers<void>>
      prompt: SDKUserMessage | undefined
    }> = []
    const nativeInputs: SDKUserMessage[] = []
    const ninthAccepted = Promise.withResolvers<void>()
    const evidence = vi.fn<NonNullable<AgentRunInput['recordNativeEvidence']>>()
    const queryFactory = vi.fn((request: Parameters<typeof sdkQuery>[0]) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
      })
      const state = {
        child,
        read: Promise.withResolvers<IteratorResult<SDKMessage>>(),
        readStarted: Promise.withResolvers<void>(),
        prompt: undefined as SDKUserMessage | undefined,
      }
      void state.read.promise.catch(() => undefined)
      states.push(state)
      request.options!.spawnClaudeCodeProcess!({
        command: '/fake/claude',
        args: [],
        env: {},
        signal: request.options!.abortController!.signal,
      })
      let firstRead = true
      return {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<SDKMessage>> => {
            if (firstRead) {
              firstRead = false
              const promptStream = request.prompt as AsyncIterable<SDKUserMessage>
              const first = await promptStream[Symbol.asyncIterator]().next()
              if (!first.done) {
                state.prompt = first.value
                nativeInputs.push(first.value)
              }
              if (!state.prompt) throw new Error('Input was cancelled before consumption.')
              return {
                done: false,
                value: {
                  type: 'user',
                  uuid: state.prompt.uuid,
                  user_message_uuid: state.prompt.uuid,
                  session_id: state.prompt.session_id,
                  parent_tool_use_id: null,
                  message: state.prompt.message,
                } as SDKMessage,
              }
            }
            state.readStarted.resolve()
            if (states.length === 9) ninthAccepted.resolve()
            return state.read.promise
          },
        }),
        interrupt: vi.fn(async () => undefined),
        close: vi.fn(),
        return: vi.fn(async () => ({ done: true, value: undefined })),
      }
    })
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query: queryFactory as unknown as typeof sdkQuery,
      getSessionInfo: vi.fn() as never,
      spawn: vi.fn(() => states.at(-1)!.child) as never,
    })
    const outcomes: Promise<unknown>[] = []
    const unresolvedRuns: string[] = []
    const start = (): { runId: string; nativeSessionId: string; outcome: Promise<unknown> } => {
      const runId = crypto.randomUUID(),
        sessionId = crypto.randomUUID(),
        nativeSessionId = crypto.randomUUID()
      const controller = new AbortController()
      controllers.push(controller)
      const outcome = (async () => {
        for await (const event of adapter.run(
          {
            ...runInput(),
            runId,
            sessionId,
            nativeSessionId,
            recordNativeEvidence: evidence,
            promptEnvelope: { ...runInput().promptEnvelope, sessionId },
          },
          controller.signal,
        ))
          void event
      })().catch((error: unknown) => error)
      outcomes.push(outcome)
      return { runId, nativeSessionId, outcome }
    }
    try {
      for (let index = 0; index < 8; index += 1) {
        const current = start()
        // oxlint-disable-next-line no-await-in-loop -- These eight admissions deliberately retire transport sequentially while retaining each Native recovery owner.
        await vi.waitFor(() => expect(states[index]).toBeDefined())
        const state = states[index]!
        // oxlint-disable-next-line no-await-in-loop -- Wait for the actual User receipt and sole pending SDK read before Stop.
        await state.readStarted.promise
        expect(state.prompt?.uuid).toBe(current.runId)
        expect(state.prompt?.session_id).toBe(current.nativeSessionId)
        controllers[index]!.abort()
        // oxlint-disable-next-line no-await-in-loop -- One foreground observation must settle before the next controlled admission.
        await expect(current.outcome).resolves.toMatchObject({ kind: 'unknown_delivery' })
        state.read.reject(new Error('Owned SDK read failed without EOF or terminal receipt.'))
        state.child.exitCode = 1
        state.child.emit('close', 1, null)
        // oxlint-disable-next-line no-await-in-loop -- Actual actor close plus rejected read releases transport, not the Native work fence.
        await vi.waitFor(() =>
          expect(adapter.diagnostics()).toEqual({ activeQueries: 0, activeSessions: 0 }),
        )
        unresolvedRuns.push(current.runId)
        expect(adapter.hasActiveBackgroundWork(current.runId)).toBe(true)
        expect(evidence.mock.calls.some(([fact]) => fact.kind === 'ended')).toBe(false)
      }
      expect(nativeInputs).toHaveLength(8)
      expect(new Set(nativeInputs.map((prompt) => prompt.session_id)).size).toBe(8)
      expect(unresolvedRuns.every((runId) => adapter.hasActiveBackgroundWork(runId))).toBe(true)
      const ninth = start()
      const admission = await Promise.race([
        ninth.outcome.then((error) => ({ status: 'rejected', error }) as const),
        ninthAccepted.promise.then(() => ({ status: 'accepted' }) as const),
      ])
      expect(queryFactory).toHaveBeenCalledTimes(8)
      expect(admission).toMatchObject({
        status: 'rejected',
        error: expect.any(NativeCapacityError),
      })
      expect(nativeInputs).toHaveLength(8)
    } finally {
      for (const controller of controllers) controller.abort()
      for (const state of states) {
        state.read.reject(new Error('Owned test read cleanup; no terminal receipt.'))
        state.child.exitCode = 1
        state.child.emit('close', 1, null)
        state.child.stdin.destroy()
        state.child.stdout.destroy()
        state.child.stderr.destroy()
      }
      await Promise.all(outcomes)
      await adapter.dispose()
    }
  })
  it('drains custom-spawn stderr, absorbs stream errors and retires the listener only at actor close', async () => {
    const f = cancellationFixture()
    try {
      await f.ready()
      expect(f.child.stderr.readableFlowing).toBe(true)
      expect(f.child.stderr.listenerCount('error')).toBe(1)
      const chunk = Buffer.alloc(16 * 1024, 's')
      for (let index = 0; index < 64; index += 1) f.child.stderr.write(chunk)
      await vi.waitFor(() => expect(f.child.stderr.readableLength).toBe(0))
      expect(f.child.stderr.writableLength).toBe(0)
      f.child.stderr.emit('error', new Error('Synthetic stderr error: never-publish-stderr'))
      expect(f.adapter.diagnostics()).toEqual({ activeQueries: 1, activeSessions: 1 })
      expect(f.evidence.mock.calls.some(([fact]) => fact.kind === 'ended')).toBe(false)
      f.controller.abort()
      await f.outcome
      f.finishResult({
        done: false,
        value: {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          terminal_reason: 'aborted_tools',
          errors: ['Interrupted'],
          session_id: runInput().nativeSessionId,
          user_message_uuid: runInput().runId,
        } as SDKMessage,
      })
      await vi.waitFor(() => expect(f.readCount()).toBe(3))
      expect(f.child.stderr.listenerCount('error')).toBe(1)
      f.child.emit('close', 1, null)
      await vi.waitFor(() =>
        expect(f.adapter.diagnostics()).toEqual({ activeQueries: 0, activeSessions: 0 }),
      )
      expect(f.child.stderr.listenerCount('error')).toBe(0)
      expect(f.child.stderr.readableFlowing).toBe(false)
      expect(JSON.stringify([f.evidence.mock.calls, f.report.mock.calls])).not.toContain(
        'never-publish-stderr',
      )
    } finally {
      await f.dispose()
    }
  })
  it.each(['exit-first', 'drain-first'] as const)(
    'releases a matched interrupted query after nonzero actor exit and drain: %s',
    async (order) => {
      const f = cancellationFixture()
      try {
        await f.ready()
        f.controller.abort()
        await expect(f.outcome).resolves.toMatchObject({ kind: 'unknown_delivery' })
        expect(f.interrupt).toHaveBeenCalledOnce()
        expect(f.options().abortController?.signal.aborted).toBe(false)
        if (order === 'exit-first') f.child.emit('close', 1, null)
        f.finishResult({
          done: false,
          value: {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            terminal_reason: 'aborted_tools',
            errors: ['Interrupted'],
            session_id: 'claude-session-1',
            user_message_uuid: runInput().runId,
          } as SDKMessage,
        })
        await vi.waitFor(() =>
          expect(f.evidence).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'ended', outcome: 'interrupted' }),
          ),
        )
        expect(f.adapter.diagnostics()).toEqual(
          order === 'drain-first'
            ? { activeQueries: 1, activeSessions: 1 }
            : { activeQueries: 0, activeSessions: 0 },
        )
        if (order === 'drain-first') f.child.emit('close', 1, null)
        await vi.waitFor(() =>
          expect(f.adapter.diagnostics()).toEqual({ activeQueries: 0, activeSessions: 0 }),
        )
        expect(f.adapter.hasActiveBackgroundWork()).toBe(false)
      } finally {
        await f.dispose()
      }
    },
  )
  it('releases an exited transport while retaining missing-terminal recovery and work fences', async () => {
    const f = cancellationFixture()
    try {
      await f.ready()
      f.controller.abort()
      await f.outcome
      f.failRead(new Error('CLI iterator failed'))
      await vi.waitFor(() =>
        expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ state: 'unknown' })),
      )
      expect(f.adapter.diagnostics()).toEqual({ activeQueries: 1, activeSessions: 1 })
      f.child.emit('error', new Error('Not exit evidence'))
      expect(f.adapter.diagnostics()).toEqual({ activeQueries: 1, activeSessions: 1 })
      f.child.emit('close', 143, null)
      await vi.waitFor(() =>
        expect(f.adapter.diagnostics()).toEqual({ activeQueries: 0, activeSessions: 0 }),
      )
      expect(f.evidence.mock.calls.some(([fact]) => fact.kind === 'ended')).toBe(false)
      expect(f.adapter.hasActiveBackgroundWork()).toBe(true)
      expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unknown' }))
    } finally {
      await f.dispose()
    }
  })
  it.each(['reject', 'deadline'] as const)(
    'does not retry or fabricate an ending after interruption %s',
    async (fault) => {
      vi.useFakeTimers()
      const f = cancellationFixture(fault)
      try {
        await f.ready()
        f.controller.abort()
        await f.outcome
        await vi.advanceTimersByTimeAsync(2001)
        expect(f.interrupt).toHaveBeenCalledOnce()
        expect(f.evidence.mock.calls.some(([fact]) => fact.kind === 'ended')).toBe(false)
        expect(f.adapter.diagnostics()).toEqual({ activeQueries: 1, activeSessions: 1 })
        expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ state: 'unknown' }))
      } finally {
        await f.dispose()
      }
    },
  )
  it('retains an exited and drained query until its accepted file evidence is durable, then reports its generation once', async () => {
    const recorded = Promise.withResolvers<void>()
    let observationSignal: AbortSignal | undefined
    const recordFileChange = vi.fn<NonNullable<AgentRunInput['recordFileChange']>>(
      (_change, signal) => {
        observationSignal = signal
        return recorded.promise
      },
    )
    const generation = 'native-generation-7'
    const f = cancellationFixture(undefined, { nativeGeneration: generation, recordFileChange })
    let hookWork: Promise<unknown> | undefined
    try {
      await f.ready()
      const hook = f.options().hooks!.PostToolUse![0]!.hooks[0]!
      hookWork = hook(
        {
          hook_event_name: 'PostToolUse',
          session_id: runInput().nativeSessionId,
          transcript_path: '/project/native-transcript.jsonl',
          cwd: runInput().cwd,
          tool_name: 'Write',
          tool_use_id: 'write-7',
          tool_input: { file_path: '/project/a.txt', content: 'after\n' },
          tool_response: {
            filePath: '/project/a.txt',
            type: 'update',
            originalFile: 'before\n',
            content: 'after\n',
          },
        },
        'write-7',
        { signal: f.options().abortController!.signal },
      )
      await vi.waitFor(() => expect(recordFileChange).toHaveBeenCalledOnce())
      expect(recordFileChange).toHaveBeenCalledWith(
        {
          path: '/project/a.txt',
          kind: 'modified',
          before: 'before\n',
          after: 'after\n',
          operationId: 'write-7:0',
        },
        observationSignal,
      )
      f.controller.abort()
      await f.outcome
      f.child.emit('close', 1, null)
      f.finishResult({
        done: false,
        value: {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          terminal_reason: 'aborted_tools',
          errors: ['Interrupted'],
          session_id: runInput().nativeSessionId,
          user_message_uuid: runInput().runId,
        } as SDKMessage,
      })
      await vi.waitFor(() => expect(f.readCount()).toBe(3))
      expect(f.evidence).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'ended', outcome: 'interrupted' }),
      )
      expect(f.adapter.diagnostics()).toEqual({ activeQueries: 1, activeSessions: 1 })
      expect(f.adapter.hasActiveBackgroundWork(runInput().runId)).toBe(true)
      expect(observationSignal?.aborted).toBe(false)
      expect(
        f.report.mock.calls.filter(([report]) => report.reason === 'native_observation_released'),
      ).toHaveLength(0)
      recorded.resolve()
      await hookWork
      await vi.waitFor(() =>
        expect(f.adapter.diagnostics()).toEqual({ activeQueries: 0, activeSessions: 0 }),
      )
      expect(f.adapter.hasActiveBackgroundWork(runInput().runId)).toBe(false)
      expect(observationSignal?.aborted).toBe(true)
      expect(f.report).toHaveBeenLastCalledWith({
        runId: runInput().runId,
        generation,
        state: 'settled',
        reason: 'native_observation_released',
      })
      f.child.emit('close', 1, null)
      await Promise.resolve()
      expect(
        f.report.mock.calls.filter(([report]) => report.reason === 'native_observation_released'),
      ).toHaveLength(1)
    } finally {
      recorded.resolve()
      await hookWork
      await f.dispose()
    }
  })
  it('closes unconsumed input on cancellation without submitting a User message, dispatching or interrupting', async () => {
    const inputGate = Promise.withResolvers<void>()
    const dispatch = vi.fn<NonNullable<AgentRunInput['recordDispatch']>>()
    const f = cancellationFixture(undefined, { recordDispatch: dispatch }, inputGate.promise)
    try {
      await vi.waitFor(() => expect(f.readCount()).toBe(1))
      expect(f.prompts).toEqual([])
      f.controller.abort()
      await expect(f.outcome).resolves.toMatchObject({ kind: 'agent_process_crash' })
      expect(f.interrupt).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
      expect(f.options().abortController!.signal.aborted).toBe(false)
      inputGate.resolve()
      await vi.waitFor(() => expect(f.inputClosed()).toBe(true))
      expect(f.prompts).toEqual([])
      expect(dispatch).not.toHaveBeenCalled()
      expect(f.interrupt).not.toHaveBeenCalled()
      expect(f.evidence.mock.calls.some(([fact]) => fact.kind === 'ended')).toBe(false)
      expect(f.adapter.diagnostics()).toEqual({ activeQueries: 1, activeSessions: 1 })
      f.child.emit('close', 0, null)
      await vi.waitFor(() =>
        expect(f.adapter.diagnostics()).toEqual({ activeQueries: 0, activeSessions: 0 }),
      )
      expect(f.adapter.hasActiveBackgroundWork(runInput().runId)).toBe(false)
      expect(f.evidence.mock.calls.some(([fact]) => fact.kind === 'ended')).toBe(false)
      expect(f.report).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'unknown', reason: 'native_observation_released' }),
      )
    } finally {
      inputGate.resolve()
      await f.dispose()
    }
  })
  it.each(['user', 'tool', 'changed-hash'] as const)(
    'does not unlock a cold binding after additional native work: %s',
    async (fault) => {
      const f = bootstrapFixture()
      try {
        await f.adapter.rebuildNativeContext(
          rebuildInput(),
          rebuildSource(),
          new AbortController().signal,
        )
        const original = f.getSessionMessages.getMockImplementation()!
        if (fault !== 'changed-hash')
          f.getSessionMessages.mockImplementation(
            async () =>
              [
                ...(await original()),
                {
                  type: fault === 'user' ? 'user' : 'assistant',
                  uuid: 'later-work',
                  session_id: rebuildInput().nativeSessionId,
                  parent_tool_use_id: null,
                  message: {
                    role: fault === 'user' ? 'user' : 'assistant',
                    content:
                      fault === 'user'
                        ? 'Later request'
                        : [{ type: 'tool_use', name: 'Bash', input: { command: 'echo changed' } }],
                  },
                },
              ] as never,
          )
        const cold = f.cold()
        try {
          const input = initializedInput()
          if (fault === 'changed-hash') input.confirmedInitialization.sourceHash = 'b'.repeat(64)
          await expect(
            cold.probeNativeStatus(input, new AbortController().signal),
          ).resolves.toMatchObject({ kind: 'no_evidence' })
          expect(f.query).toHaveBeenCalledOnce()
        } finally {
          await cold.dispose()
        }
      } finally {
        await f.adapter.dispose()
      }
    },
  )
  it('requires exact persisted terminal identity and native existence, without resuming', async () => {
    const source = await savedClaudeAnswerFixture()
    const query = vi.fn(),
      info = vi.fn(async () => ({ sessionId: source.nativeSessionId })),
      read = vi.fn(async () => [])
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query: query as never,
      getSessionInfo: info as never,
      getSessionMessages: read as never,
    })
    const identity = {
      sessionId: 'session-1',
      agentId: 'claude' as const,
      runId: runInput().runId,
      requestId: runInput().runId,
      nativeSessionId: source.nativeSessionId,
      nativeTurnId: runInput().runId,
      bindingGeneration: 1,
      executorId: 'executor-1',
    }
    const input: AgentNativeProbeInput = {
      ...identity,
      cwd: source.cwd,
      model: null,
      effort: null,
      confirmedTerminal: {
        kind: 'ended',
        source: 'stored_terminal',
        identity,
        outcome: 'completed',
      },
    }
    try {
      await expect(
        adapter.probeNativeStatus(input, new AbortController().signal),
      ).resolves.toMatchObject({ kind: 'ended', outcome: 'completed' })
      expect(info).toHaveBeenCalledOnce()
      expect(read).not.toHaveBeenCalled()
      await expect(
        adapter.probeNativeStatus({ ...input, executorId: 'other' }, new AbortController().signal),
      ).resolves.toMatchObject({ kind: 'no_evidence' })
      info.mockResolvedValue(undefined as never)
      await expect(
        adapter.probeNativeStatus(input, new AbortController().signal),
      ).resolves.toMatchObject({ kind: 'no_evidence' })
      expect(query).not.toHaveBeenCalled()
      expect(await readFile(source.path, 'utf8')).toBe(source.original)
    } finally {
      await adapter.dispose()
      await source.dispose()
    }
  })
  it('recovers the exact saved response after a persisted native terminal receipt', async () => {
    const requestId = runInput().runId
    const source = await savedClaudeAnswerFixture()
    const query = vi.fn()
    const read = vi.fn(async () => {
      throw new Error('Exact native Turn read must use its bounded Worker')
    })
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query: query as never,
      getSessionInfo: vi.fn(async () => ({ sessionId: source.nativeSessionId })) as never,
      getSessionMessages: read as never,
    })
    const identity = {
      sessionId: 'session-1',
      agentId: 'claude' as const,
      runId: requestId,
      requestId,
      nativeSessionId: source.nativeSessionId,
      nativeTurnId: requestId,
      bindingGeneration: 1,
      executorId: 'executor-1',
    }
    try {
      const result = await adapter.probeNativeStatus(
        {
          ...identity,
          cwd: source.cwd,
          model: null,
          effort: null,
          confirmedTerminal: {
            kind: 'ended',
            source: 'stored_terminal',
            identity,
            outcome: 'completed',
          },
        },
        new AbortController().signal,
      )
      expect(result).toMatchObject({
        kind: 'ended',
        output: { text: 'Exact saved answer', completeness: 'complete' },
      })
      expect(query).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      expect(await readFile(source.path, 'utf8')).toBe(source.original)
    } finally {
      await adapter.dispose()
      await source.dispose()
    }
  })

  it('holds Auto input until this Query returns both initialization and the native mode acknowledgement', async () => {
    const initialized = Promise.withResolvers<unknown>(),
      acknowledged = Promise.withResolvers<void>()
    const initializationResult = vi.fn<() => Promise<unknown>>(() => initialized.promise)
    const setPermissionMode = vi.fn<(mode: string) => Promise<void>>(() => acknowledged.promise)
    const inputs: SDKUserMessage[] = []
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query: fakeQuery(
        [
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: 'claude-session-1',
            user_message_uuid: runInput().runId,
            result: 'Done',
          } as SDKMessage,
        ],
        { initializationResult, setPermissionMode, onInput: (message) => inputs.push(message) },
      ),
      getSessionInfo: vi.fn() as never,
    })
    try {
      const completed = (async () => {
        for await (const event of adapter.run(
          { ...runInput(), permissionMode: 'auto' },
          new AbortController().signal,
        ))
          void event
      })()
      await vi.waitFor(() => expect(initializationResult).toHaveBeenCalledOnce())
      expect(setPermissionMode).not.toHaveBeenCalled()
      expect(inputs).toEqual([])
      initialized.resolve({})
      await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledWith('auto'))
      expect(inputs).toEqual([])
      acknowledged.resolve()
      await completed
      expect(inputs).toHaveLength(1)
    } finally {
      initialized.resolve({})
      acknowledged.resolve()
      await adapter.dispose()
    }
  })

  it.each(['unreadable', 'duplicate', 'oversized'] as const)(
    'retains known Claude termination when response readback is %s',
    async (fault) => {
      const identity = {
        sessionId: 'session-1',
        agentId: 'claude' as const,
        runId: runInput().runId,
        requestId: runInput().runId,
        nativeSessionId: 'claude-session-1',
        nativeTurnId: runInput().runId,
        bindingGeneration: 1,
        executorId: 'executor-1',
      }
      const query = vi.fn(),
        read = vi.fn(async () => {
          if (fault === 'unreadable') throw new Error('Read unavailable')
          const user = {
            type: 'user',
            uuid: runInput().runId,
            session_id: 'claude-session-1',
            message: { role: 'user', content: 'Original' },
            parent_tool_use_id: null,
          }
          return fault === 'duplicate'
            ? [user, user]
            : [
                user,
                {
                  type: 'assistant',
                  uuid: 'answer',
                  session_id: 'claude-session-1',
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024 + 1) }],
                  },
                  parent_tool_use_id: null,
                },
              ]
        })
      const adapter = new ClaudeAgentAdapter('/fake/claude', {
        query: query as never,
        getSessionInfo: vi.fn(async () => ({ sessionId: 'claude-session-1' })) as never,
        getSessionMessages: read as never,
      })
      try {
        const result = await adapter.probeNativeStatus(
          {
            ...identity,
            cwd: '/project',
            model: null,
            effort: null,
            confirmedTerminal: {
              kind: 'ended',
              source: 'stored_terminal',
              identity,
              outcome: 'completed',
            },
          },
          new AbortController().signal,
        )
        expect(result).toMatchObject({ kind: 'ended', outcome: 'completed' })
        expect('output' in result).toBe(false)
        expect(query).not.toHaveBeenCalled()
      } finally {
        await adapter.dispose()
      }
    },
  )

  it('settles naturally ended startup work after Auto refusal without declaring initialized history', async () => {
    const f = bootstrapFixture('permission-refused')
    const report = vi.fn<NonNullable<AgentNativeContextRebuildInput['reportNativeWork']>>()
    try {
      await expect(
        f.adapter.rebuildNativeContext(
          { ...rebuildInput(), permissionMode: 'auto', reportNativeWork: report },
          rebuildSource(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ kind: 'runtime_incompatible' })
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(expect.objectContaining({ state: 'settled' })),
      )
      expect(f.prompts).toEqual([])
      expect(f.getSessionMessages).not.toHaveBeenCalled()
      await expect(
        f.adapter.inspectNativeRebuild(
          rebuildInput(),
          rebuildSource(),
          new AbortController().signal,
        ),
      ).resolves.toBeUndefined()
    } finally {
      await f.adapter.dispose()
    }
  })

  it('does not declare known unfinished startup Hooks settled from CLI exit alone', async () => {
    const f = bootstrapFixture('open-hook')
    const report = vi.fn<NonNullable<AgentNativeContextRebuildInput['reportNativeWork']>>()
    try {
      await expect(
        f.adapter.rebuildNativeContext(
          { ...rebuildInput(), reportNativeWork: report },
          rebuildSource(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ kind: 'runtime_incompatible' })
      expect(report).not.toHaveBeenCalled()
    } finally {
      await f.adapter.dispose()
    }
  })

  it('records natural initialization settlement independently of later history readback failure', async () => {
    const f = bootstrapFixture('changed')
    const report = vi.fn<NonNullable<AgentNativeContextRebuildInput['reportNativeWork']>>()
    const dispatched = vi.fn<
      NonNullable<AgentNativeContextRebuildInput['onNativeCreationDispatched']>
    >(async () => undefined)
    try {
      await expect(
        f.adapter.rebuildNativeContext(
          { ...rebuildInput(), onNativeCreationDispatched: dispatched, reportNativeWork: report },
          rebuildSource(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ kind: 'protocol_error' })
      expect(report).toHaveBeenCalledOnce()
      expect(report.mock.calls[0]![0]).toMatchObject({
        executorId: dispatched.mock.calls[0]![0],
        nativeSessionId: rebuildInput().nativeSessionId,
        state: 'settled',
      })
    } finally {
      await f.adapter.dispose()
    }
  })

  it.each(['native', 'ask', 'full', 'auto'] as const)(
    'preserves native abilities in selected permission mode: %s',
    async (permissionMode) => {
      const initializationResult = vi.fn(async () => ({}))
      const setPermissionMode = vi.fn(async (_mode: string) => undefined)
      const query = vi.fn(
        fakeQuery(
          [
            {
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: 'claude-session-1',
              user_message_uuid: runInput().runId,
              result: 'Done',
            } as SDKMessage,
          ],
          { initializationResult, setPermissionMode },
        ),
      )
      const adapter = new ClaudeAgentAdapter('/fake/claude', {
        query: query as never,
        getSessionInfo: vi.fn() as never,
      })
      try {
        for await (const event of adapter.run(
          { ...runInput(), permissionMode },
          new AbortController().signal,
        ))
          void event
        const options = query.mock.calls[0]![0].options!
        const nativeModes = {
          native: undefined,
          ask: 'default',
          full: 'bypassPermissions',
          auto: 'auto',
        }
        expect(options.permissionMode).toBe(nativeModes[permissionMode])
        expect(options.allowDangerouslySkipPermissions).toBe(
          permissionMode === 'full' ? true : undefined,
        )
        expect(options.settingSources).toEqual(['user', 'project', 'local'])
        expect(options.allowedTools).toBeUndefined()
        expect(options.disallowedTools).toBeUndefined()
        expect(initializationResult).toHaveBeenCalledTimes(permissionMode === 'auto' ? 1 : 0)
        expect(setPermissionMode.mock.calls).toEqual(permissionMode === 'auto' ? [['auto']] : [])
      } finally {
        await adapter.dispose()
      }
    },
  )

  it('does not resume a Query or infer missing from an unreadable transcript', async () => {
    const close = vi.fn()
    const dispose = vi.fn(async () => undefined)
    const startup = vi.fn(async () => {
      throw new Error('No conversation found with session ID: missing-session')
    })
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query: fakeQuery([]),
      getSessionInfo: vi.fn() as never,
      getSessionMessages: vi.fn(async () => []) as never,
      startup: startup as never,
    })

    await expect(
      adapter.probeNativeStatus(
        {
          agentId: 'claude',
          requestId: runInput().runId,
          bindingGeneration: 1,
          sessionId: 'session-1',
          nativeSessionId: 'missing-session',
          cwd: '/project',
          model: null,
          effort: null,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: 'no_evidence' })
    expect(startup).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
    expect(adapter.diagnostics()).toEqual({ activeQueries: 0, activeSessions: 0 })
    await adapter.dispose()
  })

  it('rebuilds using false-only input, complete readback and actual natural child exit', async () => {
    const f = bootstrapFixture()
    try {
      await expect(
        f.adapter.rebuildNativeContext(
          rebuildInput(),
          rebuildSource(),
          new AbortController().signal,
        ),
      ).resolves.toEqual({ nativeSessionId: rebuildInput().nativeSessionId })
      expect(f.prompts).toHaveLength(1)
      expect(f.prompts.every((message) => message.shouldQuery === false)).toBe(true)
      const content = JSON.parse(f.prompts[0]!.message.content as string)
      expect(content.chunks.map((chunk: { kind: string }) => chunk.kind)).toEqual([
        'message',
        'comment',
      ])
      expect(f.query).toHaveBeenCalledOnce()
      expect(f.adapter.diagnostics()).toEqual({ activeQueries: 0, activeSessions: 0 })
      const cold = f.cold()
      try {
        await expect(
          cold.probeNativeStatus(initializedInput(), new AbortController().signal),
        ).resolves.toMatchObject({ kind: 'binding_ready' })
        await expect(
          cold.inspectNativeRebuild(rebuildInput(), rebuildSource(), new AbortController().signal),
        ).resolves.toBeUndefined()
        expect(f.query).toHaveBeenCalledOnce()
      } finally {
        await cold.dispose()
      }
    } finally {
      await f.adapter.dispose()
    }
  })

  it.each(['missing', 'changed', 'duplicate'] as const)(
    'rejects %s historical seed readback without creating another Session',
    async (fault) => {
      const f = bootstrapFixture(fault)
      try {
        await expect(
          f.adapter.rebuildNativeContext(
            rebuildInput(),
            rebuildSource(),
            new AbortController().signal,
          ),
        ).rejects.toBeDefined()
        expect(f.query).toHaveBeenCalledOnce()
        await expect(
          f.adapter.inspectNativeRebuild(
            rebuildInput(),
            rebuildSource(),
            new AbortController().signal,
          ),
        ).resolves.toBeUndefined()
      } finally {
        await f.adapter.dispose()
      }
    },
  )

  it('does not treat a synthetic assistant error as accepted context', async () => {
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query: fakeQuery([
        {
          type: 'assistant',
          uuid: 'synthetic-error',
          error: 'unknown',
          session_id: 'claude-session-1',
          parent_tool_use_id: null,
          message: { id: 'rejected', model: 'fixture', content: [] },
        } as unknown as SDKMessage,
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          user_message_uuid: runInput().runId,
          session_id: 'claude-session-1',
          errors: ['prompt is too long'],
        } as SDKMessage,
      ]),
      getSessionInfo: vi.fn() as never,
    })
    const events: string[] = []
    const consume = (async () => {
      for await (const event of adapter.run(runInput(), new AbortController().signal))
        events.push(event.type)
    })()
    await expect(consume).rejects.toMatchObject({ kind: 'context_limit' })
    expect(events).toContain('turn.started')
    expect(events).not.toContain('text.completed')
    await adapter.dispose()
  })

  it('publishes terminal completion without starting title enrichment', async () => {
    const getSessionInfo = vi.fn(() => new Promise<never>(() => undefined))
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query: fakeQuery([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          user_message_uuid: runInput().runId,
          session_id: 'claude-session-1',
          result: 'Done',
        } as SDKMessage,
      ]),
      getSessionInfo: getSessionInfo as never,
    })
    const eventTypes: string[] = []

    for await (const event of adapter.run(runInput(), new AbortController().signal)) {
      eventTypes.push(event.type)
    }

    expect(eventTypes).toContain('turn.completed')
    expect(getSessionInfo).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(adapter.diagnostics()).toEqual({ activeQueries: 0, activeSessions: 0 }),
    )
    await adapter.dispose()
  })

  it.each(['hook', 'task', 'background'] as const)(
    'keeps observed unfinished %s work unknown after the root result and EOF',
    async (kind) => {
      const report = vi.fn()
      const start =
        kind === 'hook'
          ? { subtype: 'hook_started', hook_id: 'work-1' }
          : kind === 'task'
            ? { subtype: 'task_started', task_id: 'work-1' }
            : { subtype: 'background_tasks_changed', tasks: [{ task_id: 'work-1' }] }
      const adapter = new ClaudeAgentAdapter('/fake/claude', {
        getSessionInfo: vi.fn() as never,
        query: fakeQuery([
          { type: 'system', session_id: 'claude-session-1', ...start } as SDKMessage,
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: 'claude-session-1',
            user_message_uuid: runInput().runId,
            result: 'Done',
          } as SDKMessage,
        ]),
      })
      try {
        for await (const event of adapter.run(
          { ...runInput(), reportNativeEffects: report },
          new AbortController().signal,
        ))
          void event
        await vi.waitFor(() => expect(report).toHaveBeenCalled())
        expect(report.mock.calls.map(([value]) => value.state)).not.toContain('settled')
        expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unknown' }))
      } finally {
        await adapter.dispose()
      }
    },
  )

  it.each(['hook', 'task', 'level-before-edge'] as const)(
    'settles completed %s work after the root result and natural EOF',
    async (kind) => {
      const report = vi.fn()
      const work =
        kind === 'hook'
          ? [
              { subtype: 'hook_started', hook_id: 'work-1' },
              { subtype: 'hook_response', hook_id: 'work-1' },
            ]
          : kind === 'task'
            ? [
                { subtype: 'task_started', task_id: 'work-1' },
                { subtype: 'task_notification', task_id: 'work-1' },
              ]
            : [
                { subtype: 'background_tasks_changed', tasks: [{ task_id: 'work-1' }] },
                { subtype: 'background_tasks_changed', tasks: [] },
                { subtype: 'task_started', task_id: 'work-1' },
              ]
      const adapter = new ClaudeAgentAdapter('/fake/claude', {
        getSessionInfo: vi.fn() as never,
        query: fakeQuery([
          ...work.map(
            (event) =>
              Object.assign(
                { type: 'system', session_id: 'claude-session-1' },
                event,
              ) as SDKMessage,
          ),
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: 'claude-session-1',
            user_message_uuid: runInput().runId,
            result: 'Done',
          } as SDKMessage,
        ]),
      })
      try {
        for await (const event of adapter.run(
          { ...runInput(), reportNativeEffects: report },
          new AbortController().signal,
        ))
          void event
        await vi.waitFor(() =>
          expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'settled' })),
        )
        expect(adapter.hasActiveBackgroundWork()).toBe(false)
      } finally {
        await adapter.dispose()
      }
    },
  )

  it.each(['items', 'bytes'] as const)(
    'keeps overflowed Hook observation unknown even when recorded identities complete: %s',
    async (budget) => {
      const report = vi.fn()
      const ids = Array.from(
        { length: budget === 'items' ? 65 : 24 },
        (_, i) => `${i}-${budget === 'bytes' ? '界'.repeat(1000) : 'hook'}`,
      )
      const messages = ids.flatMap((hook_id) => [
        {
          type: 'system',
          subtype: 'hook_started',
          session_id: 'claude-session-1',
          hook_id,
        } as SDKMessage,
      ])
      messages.push(
        ...ids.map(
          (hook_id) =>
            ({
              type: 'system',
              subtype: 'hook_response',
              session_id: 'claude-session-1',
              hook_id,
            }) as SDKMessage,
        ),
      )
      messages.push({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-session-1',
        user_message_uuid: runInput().runId,
        result: 'Done',
      } as SDKMessage)
      const adapter = new ClaudeAgentAdapter('/fake/claude', {
        getSessionInfo: vi.fn() as never,
        query: fakeQuery(messages),
      })
      try {
        for await (const event of adapter.run(
          { ...runInput(), reportNativeEffects: report },
          new AbortController().signal,
        ))
          void event
        await vi.waitFor(() =>
          expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unknown' })),
        )
        expect(report.mock.calls.map(([value]) => value.state)).not.toContain('settled')
      } finally {
        await adapter.dispose()
      }
    },
  )

  it('bounds optional title enrichment', async () => {
    vi.useFakeTimers()
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query: fakeQuery([]),
      getSessionInfo: (() => new Promise<never>(() => undefined)) as never,
    })
    const title = adapter.enrichTitle(
      {
        runId: 'run-1',
        sessionId: 'session-1',
        nativeSessionId: 'claude-session-1',
        cwd: '/project',
      },
      new AbortController().signal,
    )

    await vi.advanceTimersByTimeAsync(CLAUDE_TITLE_TIMEOUT_MS)
    await expect(title).resolves.toBeUndefined()
    await adapter.dispose()
  })

  it('does not infer a native ending from silence and retains observation after cancellation', async () => {
    vi.useFakeTimers()
    let finishRead: ((value: IteratorResult<SDKMessage>) => void) | undefined
    const pending = new Promise<IteratorResult<SDKMessage>>((resolve) => {
      finishRead = resolve
    })
    let reads = 0
    const signal = new AbortController()
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query: ((request: { prompt: AsyncIterable<SDKUserMessage> }) =>
        ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (reads++ === 0) {
                await request.prompt[Symbol.asyncIterator]().next()
                return pending
              }
              return { done: true, value: undefined }
            },
          }),
          close: vi.fn(),
          return: vi.fn(async () => ({ done: true, value: undefined })),
        }) as never) as never,
      getSessionInfo: vi.fn() as never,
    })
    const consume = (async () => {
      for await (const event of adapter.run(runInput(), signal.signal)) {
        void event
      }
    })()
    const outcome = consume.catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(adapter.hasActiveBackgroundWork(runInput().runId)).toBe(true)
    signal.abort()
    expect(await outcome).toMatchObject({ kind: 'unknown_delivery' })
    expect(adapter.hasActiveBackgroundWork(runInput().runId)).toBe(true)
    finishRead?.({
      done: false,
      value: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-session-1',
        user_message_uuid: runInput().runId,
        result: 'Done',
      } as SDKMessage,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.diagnostics()).toEqual({ activeQueries: 0, activeSessions: 0 })
    await adapter.dispose()
  })

  it('does not infer Agent completion from a model response or resume-worded error', async () => {
    const query = ((request: { prompt: AsyncIterable<SDKUserMessage> }) => ({
      async *[Symbol.asyncIterator]() {
        await request.prompt[Symbol.asyncIterator]().next()
        yield {
          type: 'assistant',
          session_id: 'claude-session-1',
          parent_tool_use_id: null,
          message: {
            id: 'answer',
            model: 'fixture',
            content: [{ type: 'text', text: 'A public response' }],
          },
        } as SDKMessage
        throw new Error('resume transport failed')
      },
      close: vi.fn(),
      return: vi.fn(async () => ({ done: true, value: undefined })),
    })) as never
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query,
      getSessionInfo: vi.fn() as never,
    })
    const events: string[] = []
    const consume = (async () => {
      for await (const event of adapter.run(runInput(), new AbortController().signal))
        events.push(event.type)
    })()
    await expect(consume).rejects.toMatchObject({ kind: 'unknown_delivery' })
    expect(events).not.toContain('turn.completed')
    expect(adapter.diagnostics()).toEqual({ activeQueries: 1, activeSessions: 1 })
    await adapter.dispose()
  })
})

async function savedClaudeAnswerFixture() {
  const created = await mkdtemp(join(tmpdir(), 'pact-claude-answer-test-'))
  try {
    const cwd = await realpath(created),
      profile = join(cwd, 'profile'),
      nativeSessionId = randomUUID()
    const project = join(profile, 'projects', cwd.replace(/[^a-z0-9]/giu, '-'))
    await mkdir(project, { recursive: true })
    const original =
      [
        {
          type: 'user',
          uuid: runInput().runId,
          parentUuid: null,
          message: { role: 'user', content: 'Original task' },
        },
        {
          type: 'assistant',
          uuid: randomUUID(),
          parentUuid: runInput().runId,
          message: {
            id: 'saved-answer',
            role: 'assistant',
            content: [{ type: 'text', text: 'Exact saved answer' }],
          },
        },
      ]
        .map((record) =>
          JSON.stringify({
            ...record,
            sessionId: nativeSessionId,
            cwd,
            timestamp: new Date().toISOString(),
          }),
        )
        .join('\n') + '\n'
    const path = join(project, nativeSessionId + '.jsonl')
    await writeFile(path, original)
    vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
    return {
      cwd,
      nativeSessionId,
      path,
      original,
      dispose: () => rm(created, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(created, { recursive: true, force: true })
    throw error
  }
}

function runInput() {
  return {
    runId: 'e847391a-8b6a-4f0c-91c9-fd72b9c3a70d',
    sessionId: 'session-1',
    nativeSessionId: 'claude-session-1',
    cwd: '/project',
    promptEnvelope: {
      version: 'pact-agent-prompt-v1' as const,
      sessionId: 'session-1',
      message: { id: 'message-1', content: 'Hello' },
      comments: [],
    },
    model: null,
    effort: null,
  }
}

function cancellationFixture(
  interruptFailure?: 'reject' | 'deadline',
  input: Partial<AgentRunInput> = {},
  beforePrompt?: Promise<void>,
) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
    killed: false,
    exitCode: null,
    kill: vi.fn(),
  })
  child.on('error', () => undefined)
  const controller = new AbortController(),
    evidence = vi.fn(),
    report = vi.fn()
  let reads = 0,
    captured: Parameters<typeof sdkQuery>[0] | undefined
  let inputClosed = false
  const prompts: SDKUserMessage[] = []
  let finishResult!: (value: IteratorResult<SDKMessage>) => void, failRead!: (error: Error) => void
  const read = new Promise<IteratorResult<SDKMessage>>((resolve, reject) => {
    finishResult = resolve
    failRead = reject
  })
  const interrupt = vi.fn(() =>
    interruptFailure === 'reject'
      ? Promise.reject(new Error('Interrupt refused'))
      : interruptFailure === 'deadline'
        ? new Promise<void>(() => undefined)
        : Promise.resolve(),
  )
  const query = ((request: Parameters<typeof sdkQuery>[0]) => {
    captured = request
    request.options?.spawnClaudeCodeProcess?.({
      command: '/fake/claude',
      args: [],
      env: {},
      signal: request.options.abortController!.signal,
    })
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (reads++ === 0) {
            if (beforePrompt) await beforePrompt
            const promptStream = request.prompt as AsyncIterable<SDKUserMessage>
            const first = await promptStream[Symbol.asyncIterator]().next()
            if (!first.done) prompts.push(first.value)
            inputClosed = true
            if (!prompts.length) return { done: true, value: undefined }
            return {
              done: false,
              value: {
                type: 'user',
                uuid: runInput().runId,
                session_id: 'claude-session-1',
                parent_tool_use_id: null,
                message: { role: 'user', content: 'accepted' },
              } as SDKMessage,
            }
          }
          if (reads === 2) return read
          throw new Error('Actor exited with code 1')
        },
      }),
      interrupt,
      close: vi.fn(),
      return: vi.fn(async () => ({ done: true, value: undefined })),
    }
  }) as unknown as typeof sdkQuery
  const adapter = new ClaudeAgentAdapter('/fake/claude', {
    query,
    getSessionInfo: vi.fn() as never,
    spawn: vi.fn(() => child) as never,
  })
  const consume = (async () => {
    for await (const event of adapter.run(
      { ...runInput(), recordNativeEvidence: evidence, reportNativeEffects: report, ...input },
      controller.signal,
    ))
      void event
  })()
  const outcome = consume.catch((error: unknown) => error)
  return {
    adapter,
    child,
    controller,
    evidence,
    report,
    interrupt,
    outcome,
    finishResult,
    failRead,
    prompts,
    readCount: () => reads,
    inputClosed: () => inputClosed,
    options: () => captured!.options!,
    ready: async () => {
      await vi.waitFor(() => expect(reads).toBeGreaterThan(1))
    },
    dispose: async () => {
      controller.abort()
      finishResult({ done: true, value: undefined })
      child.emit('close', 0, null)
      await outcome
      await adapter.dispose()
    },
  }
}

function fakeQuery(
  messages: SDKMessage[],
  controls: {
    initializationResult?: () => Promise<unknown>
    setPermissionMode?: (mode: string) => Promise<void>
    onInput?: (message: SDKUserMessage) => void
  } = {},
) {
  return ((request: Parameters<typeof sdkQuery>[0]) => ({
    async *[Symbol.asyncIterator]() {
      if (typeof request.prompt === 'string') throw new Error('Fixture requires streaming input.')
      // A one-input native actor responds while the streaming producer remains
      // open for Steer; EOF can only follow the actor's terminal receipt.
      const first = await request.prompt[Symbol.asyncIterator]().next()
      if (!first.done) controls.onInput?.(first.value)
      yield* messages
    },
    initializationResult: controls.initializationResult ?? vi.fn(async () => ({})),
    setPermissionMode: controls.setPermissionMode ?? vi.fn(async () => undefined),
    close: vi.fn(),
    return: vi.fn(async () => ({ done: true, value: undefined })),
  })) as unknown as typeof sdkQuery
}

function rebuildInput() {
  return {
    rebuildId: 'debc7f83-13b6-4d17-88fa-cd2a3a8a9199',
    sessionId: 'session-1',
    nativeSessionId: '3b222d47-fd99-48b9-9b6e-c23428710e41',
    sourceHash: 'a'.repeat(64),
    cwd: '/project',
    model: null,
    effort: null,
  }
}
function initializedInput() {
  return {
    target: 'initialized_binding' as const,
    agentId: 'claude' as const,
    requestId: rebuildInput().rebuildId,
    sessionId: 'session-1',
    bindingGeneration: 2,
    nativeSessionId: rebuildInput().nativeSessionId,
    cwd: '/project',
    model: null,
    effort: null,
    confirmedInitialization: {
      rebuildId: rebuildInput().rebuildId,
      sourceHash: rebuildInput().sourceHash,
    },
    source: rebuildSource(),
  }
}
function bootstrapFixture(
  fault?: 'missing' | 'changed' | 'duplicate' | 'permission-refused' | 'open-hook',
) {
  const prompts: SDKUserMessage[] = []
  const child = new EventEmitter()
  const query = vi.fn(
    (request: {
      prompt: AsyncIterable<SDKUserMessage>
      options: { spawnClaudeCodeProcess: (spec: object) => unknown }
    }) => {
      request.options.spawnClaudeCodeProcess({
        command: '/fake/claude',
        args: [],
        cwd: '/project',
        env: {},
      })
      return {
        async *[Symbol.asyncIterator]() {
          for await (const message of request.prompt) prompts.push(message)
          yield {
            type: 'system',
            subtype: 'init',
            session_id: rebuildInput().nativeSessionId,
          } as SDKMessage
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: rebuildInput().nativeSessionId,
            user_message_uuids: prompts.map((message) => message.uuid),
            result: 'No response requested.',
          } as SDKMessage
          if (fault === 'open-hook')
            yield {
              type: 'system',
              subtype: 'hook_started',
              session_id: rebuildInput().nativeSessionId,
              hook_id: 'unfinished-hook',
            } as SDKMessage
          child.emit('exit', 0, null)
        },
        initializationResult: vi.fn(async () => ({})),
        setPermissionMode: vi.fn(async () => {
          if (fault === 'permission-refused')
            throw Object.assign(new Error('Cannot set permission mode to auto: fixture refusal'), {
              errorClass: 'control_request_failed',
              telemetryMessage: 'Claude Code control request failed (set_permission_mode)',
            })
        }),
        close: vi.fn(),
        return: vi.fn(async () => ({ done: true, value: undefined })),
      }
    },
  )
  const getSessionInfo = vi.fn(async () => ({
    sessionId: rebuildInput().nativeSessionId,
    fileSize: 1024,
  }))
  const getSessionMessages = vi.fn(async () => {
    if (fault === 'missing') return []
    const rows = prompts.map((message) => ({
      ...message,
      message: {
        ...message.message,
        content: fault === 'changed' ? 'Changed' : message.message.content,
      },
    }))
    return fault === 'duplicate' ? [...rows, ...rows] : rows
  })
  const dependencies = {
    query: query as never,
    getSessionInfo: getSessionInfo as never,
    getSessionMessages: getSessionMessages as never,
    spawn: (() => child) as never,
  }
  return {
    prompts,
    query,
    getSessionMessages,
    adapter: new ClaudeAgentAdapter('/fake/claude', dependencies),
    cold: () => new ClaudeAgentAdapter('/fake/claude', dependencies),
  }
}

async function* rebuildSource() {
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
    kind: 'comment' as const,
    messageId: 'message-1',
    sequence: 0,
    comment: {
      id: 'comment-1',
      sessionId: 'session-1',
      body: 'A sent Comment',
      state: 'sent' as const,
      anchor: {
        type: 'message' as const,
        messageId: 'message-1',
        contentHash: 'hash',
        textBasis: 'markdown-visible-v2' as const,
        startOffset: 0,
        endOffset: 8,
        quote: 'Original',
      },
      createdAt: '2026-09-29T00:00:00.000Z',
      updatedAt: '2026-09-29T00:00:00.000Z',
    },
  }
}
