/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion, vitest/require-mock-type-parameters -- The SDK protocol stubs intentionally provide only fields consumed by the Adapter. */
import type { SDKMessage, SDKUserMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'

import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolveSourceFixturePath } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { diagnosticEventSchema, type DiagnosticEvent } from '@pact/contracts/diagnostics'

const planDiagnostics = vi.hoisted(() => ({ events: [] as DiagnosticEvent[] }))
vi.mock('../../diagnostics/utility-log', () => ({
  recordDiagnostic: (event: DiagnosticEvent) => planDiagnostics.events.push(event),
}))

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

import { collaborationSourceWireResultSchema } from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import { NativeCapacityError } from './agent-execution-error'
import { CLAUDE_TITLE_TIMEOUT_MS, ClaudeAgentAdapter } from './claude-agent-adapter.js'
import { planRunInput } from './collaboration-fixture.test-support.js'
import { FrozenSourceReader } from './frozen-source-reader'
import { NativeForkFiles } from './native-fork-files'
import { nativeWorkerFixture } from './native-workers-fixture.test-support.js'
import { PactPeerToolServer } from './pact-peer-tool-server'

let workerFixture: Awaited<ReturnType<typeof nativeWorkerFixture>>
beforeAll(async () => {
  workerFixture = await nativeWorkerFixture(['native-fork-worker'])
  forkWorker.path = workerFixture.paths['native-fork-worker']!
}, 20_000)
afterAll(async () => {
  await workerFixture?.dispose()
})

const bootstrapDirectories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await Promise.all(
    bootstrapDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('Claude plan submission diagnostics', () => {
  it.each([
    'valid',
    'missing_prompt',
    'wrong_prompt',
    'missing_history',
    'pending',
    'binding_missing',
    'receipt_unavailable',
    'old_failure',
    'recovered_prompt',
  ] as const)('preserves plan authorization and identifies %s', async (mode) => {
    planDiagnostics.events.length = 0
    const directory = await mkdtemp(join(tmpdir(), 'pact-plan-diagnostic-'))
    const cwd = await realpath(directory)
    const profile = join(cwd, 'profile')
    const project = join(profile, 'projects', cwd.replace(/[^a-z0-9]/giu, '-'))
    await mkdir(project, { recursive: true })
    vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
    const input = { ...planRunInput('claude'), cwd, nativeSessionId: randomUUID() }
    const promptId = randomUUID(),
      attachmentId = randomUUID(),
      callId = randomUUID(),
      receiptId = randomUUID()
    const path = join(profile, 'private-path-not-for-diagnostics.md')
    const operation = { file_path: path, content: 'private-plan-body-not-for-diagnostics' }
    const recordPlan = vi.fn<NonNullable<AgentRunInput['recordWorkflowPlan']>>()
    const transcript = join(project, `${input.nativeSessionId}.jsonl`)
    const append = async (record: Record<string, unknown>) =>
      appendFile(
        transcript,
        JSON.stringify({
          ...record,
          cwd,
          sessionId: input.nativeSessionId,
          timestamp: new Date().toISOString(),
        }) + '\n',
      )
    await append({
      type: 'user',
      uuid: input.runId,
      parentUuid: null,
      promptId,
      message: { role: 'user', content: 'Plan' },
    })
    await append({
      type: 'attachment',
      uuid: attachmentId,
      parentUuid: input.runId,
      attachment: {
        type: mode === 'binding_missing' ? 'unknown' : 'plan_mode',
        isSubAgent: false,
        planFilePath: path,
      },
    })
    const writeRecord = {
      type: 'assistant',
      uuid: callId,
      parentUuid: attachmentId,
      message: {
        id: 'write-message',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'write-plan', name: 'Write', input: operation }],
      },
    }
    if (mode !== 'missing_history') await append(writeRecord)
    const f = cancellationFixture(undefined, { ...input, recordWorkflowPlan: recordPlan })
    try {
      await f.ready()
      const hook = {
        session_id: input.nativeSessionId,
        transcript_path: transcript,
        cwd,
        ...(['missing_prompt', 'old_failure', 'recovered_prompt'].includes(mode)
          ? {}
          : { prompt_id: mode === 'wrong_prompt' ? randomUUID() : promptId }),
        tool_use_id: 'write-plan',
        tool_name: 'Write',
        tool_input: operation,
      }
      const options = { signal: f.options().abortController!.signal }
      const pre = f.options().hooks!.PreToolUse![0]!.hooks[0]!
      const post = f.options().hooks!.PostToolUse![0]!.hooks[0]!
      await pre({ ...hook, hook_event_name: 'PreToolUse' }, 'write-plan', options)
      if (mode !== 'pending' && mode !== 'missing_history') {
        const response = {
          filePath: path,
          content: operation.content,
          userModified: mode === 'receipt_unavailable',
        }
        await append({
          type: 'user',
          uuid: receiptId,
          parentUuid: callId,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'write-plan', content: 'Written' }],
          },
          toolUseResult: response,
        })
        await post(
          { ...hook, hook_event_name: 'PostToolUse', tool_response: response },
          'write-plan',
          options,
        )
      }
      if (mode !== 'missing_history')
        await append({
          type: 'assistant',
          uuid: randomUUID(),
          parentUuid: mode === 'pending' ? callId : receiptId,
          message: {
            id: 'exit-message',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'exit-plan', name: 'ExitPlanMode', input: {} }],
          },
        })
      if (mode !== 'old_failure')
        await pre(
          {
            ...hook,
            ...(mode === 'recovered_prompt' ? { prompt_id: promptId } : {}),
            hook_event_name: 'PreToolUse',
            tool_use_id: 'exit-plan',
            tool_name: 'ExitPlanMode',
            tool_input: {},
          },
          'exit-plan',
          options,
        )
      const result = await f.options().canUseTool!(
        'ExitPlanMode',
        {},
        { ...options, toolUseID: 'exit-plan', requestId: 'exit-request' },
      )
      expect(result?.behavior).toBe('deny')
      const message = result?.behavior === 'deny' ? result.message : ''
      const expected = {
        valid: 'submitted to Pact',
        missing_prompt: 'hook_prompt_missing',
        wrong_prompt: 'hook_prompt_mismatch',
        missing_history: 'history_lookup_failed',
        pending: 'plan_pending',
        binding_missing: 'history_binding_missing',
        receipt_unavailable: 'plan_unavailable',
        old_failure: 'Pact diagnostic: submission_hook_unverified.',
        recovered_prompt: 'submitted to Pact',
      }[mode]
      expect(message).toContain(expected)
      expect(message).not.toContain('private-path')
      expect(message).not.toContain(operation.content)
      expect(message).not.toContain(input.runId)
      expect(message).not.toContain(promptId)
      expect(message.includes('Latest capture: hook_prompt_missing/Write/success.')).toBe(
        mode === 'old_failure',
      )
      expect(message.includes('Latest capture')).toBe(
        [
          'missing_prompt',
          'wrong_prompt',
          'missing_history',
          'binding_missing',
          'old_failure',
        ].includes(mode),
      )
      const successful = mode === 'valid' || mode === 'recovered_prompt'
      const events = planDiagnostics.events.filter((event) => event.operation === 'claude_plan')
      expect(events.length).toBeGreaterThan(0)
      for (const event of events) {
        expect(diagnosticEventSchema.safeParse(event).success).toBe(true)
        expect(event).toMatchObject({
          sessionId: input.sessionId,
          runId: input.runId,
          agentId: 'claude',
        })
        expect(['info', 'warn']).toContain(event.level)
      }
      expect(events.at(-1)).toMatchObject({
        planStage: 'submission',
        planReason: successful
          ? 'submitted'
          : mode === 'old_failure'
            ? 'submission_hook_unverified'
            : expected,
        level: successful ? 'info' : 'warn',
      })
      expect(events.at(-1)?.planCapture).toEqual(
        mode === 'old_failure'
          ? { code: 'hook_prompt_missing', tool: 'Write', phase: 'success' }
          : ['missing_prompt', 'wrong_prompt', 'missing_history', 'binding_missing'].includes(mode)
            ? { code: expected, tool: 'ExitPlanMode', phase: 'begin' }
            : undefined,
      )
      const serialized = JSON.stringify(events)
      for (const sensitive of [path, operation.content, promptId, 'write-plan', 'exit-plan', cwd])
        expect(serialized).not.toContain(sensitive)
      // Repeated permission callbacks must not flood the default log or change authorization.
      for (let attempt = 0; attempt < 70; attempt++) {
        // oxlint-disable-next-line no-await-in-loop -- Exercise sequential SDK callback retries.
        await f.options().canUseTool!(
          'ExitPlanMode',
          {},
          {
            ...options,
            toolUseID: 'exit-plan',
            requestId: 'exit-request',
          },
        )
      }
      expect(planDiagnostics.events).toHaveLength(events.length)
      expect(recordPlan.mock.calls.length > 0).toBe(mode === 'valid' || mode === 'recovered_prompt')
      expect(
        recordPlan.mock.calls.every(
          ([plan]) => plan.nativeId === 'write-plan' && plan.text === operation.content,
        ),
      ).toBe(true)
    } finally {
      await f.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('Claude terminated plan authentication', () => {
  it.each([
    'valid',
    'no_permission',
    'changed_permission',
    'changed_hook',
    'wrong_prompt',
    'cancel',
    'failed',
    'question',
    'missing_terminal',
    'live_changed_permission',
    'retained_recording_failure',
  ] as const)(
    'joins one terminal read only for the exact missing-operation permission intent: %s',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'pact-terminal-plan-')),
        cwd = await realpath(directory)
      const profile = join(cwd, 'profile'),
        project = join(profile, 'projects', cwd.replace(/[^a-z0-9]/giu, '-'))
      await mkdir(project, { recursive: true })
      vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
      const input = { ...planRunInput('claude'), cwd, nativeSessionId: randomUUID() },
        promptId = randomUUID()
      const path = join(profile, 'private-plan.md'),
        text = 'Authenticated original native plan.'
      const transcript = join(project, `${input.nativeSessionId}.jsonl`)
      let parent: string | null = null
      const append = async (
        type: string,
        fields: Record<string, unknown>,
        id: string = randomUUID(),
      ): Promise<void> => {
        await appendFile(
          transcript,
          JSON.stringify({
            type,
            uuid: id,
            parentUuid: parent,
            sessionId: input.nativeSessionId,
            cwd,
            timestamp: new Date().toISOString(),
            ...fields,
          }) + '\n',
        )
        parent = id
      }
      await append(
        'user',
        { promptId, message: { role: 'user', content: 'Plan' } },
        mode === 'retained_recording_failure' ? randomUUID() : input.runId,
      )
      await append('attachment', {
        attachment: { type: 'plan_mode', isSubAgent: false, planFilePath: path },
      })
      await append('assistant', {
        message: {
          id: 'write',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'write-plan',
              name: 'Write',
              input: { file_path: path, content: text },
            },
          ],
        },
      })
      await append('user', {
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'write-plan', content: 'Written' }],
        },
        toolUseResult: { filePath: path, content: text, userModified: false },
      })
      if (mode === 'retained_recording_failure') {
        const basis = {
          version: 1,
          sourceRunId: randomUUID(),
          sourceMessageId: randomUUID(),
          document: {
            id: randomUUID(),
            sha256: createHash('sha256').update(text).digest('hex'),
            bytes: Buffer.byteLength(text),
            chars: text.length,
          },
        }
        input.promptEnvelope.collaborationAuthorization!.planReference = basis
        input.promptEnvelope.collaboration!.planReference = basis
        input.promptEnvelope.collaboration!.planVersion = 1
        await append(
          'user',
          { promptId, message: { role: 'user', content: 'Retain this plan.' } },
          input.runId,
        )
        await append('attachment', {
          attachment: { type: 'plan_mode', isSubAgent: false, planFilePath: path },
        })
      }
      let availablePlan: { nativeId: string; text: string } | undefined,
        failStore = false
      const plan = vi.fn<NonNullable<AgentRunInput['recordWorkflowPlan']>>((value) => {
        availablePlan = value
      })
      const unavailable = vi.fn<NonNullable<AgentRunInput['recordWorkflowPlanUnavailable']>>(() => {
        if (failStore) throw new Error('Controlled unavailable source storage failure')
        availablePlan = undefined
      })
      const retain = vi.fn<NonNullable<AgentRunInput['recordWorkflowPlanRetained']>>(() => {
        throw new Error('Controlled retained source storage failure')
      })
      const sourceFailure = vi.fn<NonNullable<AgentRunInput['recordOutputFailure']>>()
      const settled = Promise.withResolvers<void>()
      const reports = vi.fn<NonNullable<AgentRunInput['reportNativeEffects']>>((report) => {
        if (report.state !== 'pending') settled.resolve()
      })
      const reads = vi.spyOn(NativeForkFiles.prototype, 'readAnswer')
      const f = cancellationFixture(
        undefined,
        {
          ...input,
          recordWorkflowPlan: plan,
          recordWorkflowPlanUnavailable: unavailable,
          recordWorkflowPlanRetained: retain,
          recordOutputFailure: sourceFailure,
          reportNativeEffects: reports,
        },
        undefined,
        true,
      )
      try {
        await f.ready()
        const intent = { plan: text, planFilePath: path }
        const hook = {
          hook_event_name: 'PreToolUse' as const,
          session_id: input.nativeSessionId,
          transcript_path: transcript,
          cwd,
          prompt_id: mode === 'wrong_prompt' ? randomUUID() : promptId,
          tool_name: 'ExitPlanMode',
          tool_use_id: 'exit-plan',
          tool_input: intent,
        }
        const options = { signal: f.options().abortController!.signal }
        const pre = f.options().hooks!.PreToolUse![0]!.hooks[0]!
        if (mode === 'live_changed_permission') {
          const writeHook = {
            ...hook,
            tool_name: 'Write',
            tool_use_id: 'write-plan',
            tool_input: { file_path: path, content: text },
          }
          await pre(writeHook, 'write-plan', options)
          await f.options().hooks!.PostToolUse![0]!.hooks[0]!(
            {
              ...writeHook,
              hook_event_name: 'PostToolUse',
              tool_response: { filePath: path, content: text, userModified: false },
            },
            'write-plan',
            options,
          )
        }
        // The live Hook arrives before this exact Exit is persisted. Write+ack already exist.
        await pre(hook, 'exit-plan', options)
        expect(plan).toHaveBeenCalledTimes(mode === 'live_changed_permission' ? 1 : 0)
        if (mode === 'changed_hook')
          await pre({ ...hook, tool_input: { ...intent, plan: 'Changed' } }, 'exit-plan', options)
        const decisions: Array<string | undefined> = []
        if (mode !== 'no_permission') {
          for (let index = 0; index < 3; index++) {
            // oxlint-disable-next-line no-await-in-loop -- Repeated actual SDK callback identities must not authorize a second proof.
            const decision = await f.options().canUseTool!(
              'ExitPlanMode',
              ['changed_permission', 'live_changed_permission'].includes(mode)
                ? { ...intent, plan: 'Changed' }
                : intent,
              { ...options, toolUseID: 'exit-plan', requestId: 'same-permission' },
            )
            decisions.push(decision?.behavior)
          }
        }
        expect(decisions).toEqual(mode === 'no_permission' ? [] : ['deny', 'deny', 'deny'])
        if (mode !== 'missing_terminal')
          await append('assistant', {
            message: {
              id: 'exit',
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'exit-plan', name: 'ExitPlanMode', input: intent }],
            },
          })
        if (mode === 'question')
          await pre(
            {
              ...hook,
              tool_name: 'AskUserQuestion',
              tool_use_id: 'question',
              tool_input: { questions: [] },
            },
            'question',
            options,
          )
        if (mode === 'cancel') f.controller.abort()
        if (mode === 'retained_recording_failure') failStore = true
        f.finishResult({
          done: false,
          value: {
            type: 'result',
            subtype: mode === 'failed' ? 'error_during_execution' : 'success',
            is_error: mode === 'failed',
            session_id: input.nativeSessionId,
            user_message_uuids: [input.runId],
            result: 'Plan ready.',
          } as SDKMessage,
        })
        // EOF without actor close is insufficient; actor close and drain race into one owner.
        await f.outcome
        expect(plan).toHaveBeenCalledTimes(mode === 'live_changed_permission' ? 1 : 0)
        expect(availablePlan).toBeUndefined()
        f.child.emit('close', 0, null)
        f.child.emit('close', 0, null)
        await settled.promise
        expect(reports).toHaveBeenLastCalledWith(
          expect.objectContaining({
            state: mode === 'retained_recording_failure' ? 'unknown' : 'settled',
          }),
        )
        const terminalReads = reads.mock.calls.filter(([request]) => request.terminalPlanSubmission)
        expect(terminalReads).toHaveLength(
          ['valid', 'wrong_prompt', 'missing_terminal', 'retained_recording_failure'].includes(mode)
            ? 1
            : 0,
        )
        expect(plan.mock.calls).toEqual(
          ['valid', 'live_changed_permission'].includes(mode)
            ? [[{ nativeId: 'write-plan', text }]]
            : [],
        )
        expect(
          mode !== 'valid' ||
            reports.mock.invocationCallOrder.at(-1)! > plan.mock.invocationCallOrder[0]!,
        ).toBe(true)
        expect(availablePlan).toEqual(
          mode === 'valid' ? { nativeId: 'write-plan', text } : undefined,
        )
        expect(retain).toHaveBeenCalledTimes(mode === 'retained_recording_failure' ? 1 : 0)
        expect(sourceFailure).toHaveBeenCalledTimes(mode === 'retained_recording_failure' ? 1 : 0)
        const status =
          mode === 'valid'
            ? await f.adapter.probeNativeStatus(
                {
                  sessionId: input.sessionId,
                  agentId: 'claude',
                  runId: input.runId,
                  requestId: input.runId,
                  nativeSessionId: input.nativeSessionId,
                  nativeTurnId: input.runId,
                  bindingGeneration: input.bindingGeneration ?? 1,
                  executorId: f.adapter.executorId,
                  cwd,
                  model: null,
                  effort: null,
                  planSource: true,
                },
                new AbortController().signal,
              )
            : undefined
        expect(status?.kind).toBe(mode === 'valid' ? 'ended' : undefined)
        expect(status && status.kind === 'ended' ? status.outcome : undefined).toBe(
          mode === 'valid' ? 'completed' : undefined,
        )
        expect(
          status && status.kind === 'ended' ? status.planUnavailable : undefined,
        ).toBeUndefined()
      } finally {
        await f.dispose()
        reads.mockRestore()
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})

describe('Claude Agent lifecycle', () => {
  it.each([
    { pendingSteer: false, publicationFails: false, background: false },
    { pendingSteer: true, publicationFails: false, background: false },
    { pendingSteer: false, publicationFails: true, background: false },
    { pendingSteer: true, publicationFails: true, background: false },
    { pendingSteer: true, publicationFails: false, background: true },
    { pendingSteer: true, publicationFails: true, background: true },
  ])(
    'preserves exact terminal control when body sealing fails with pending Steer=$pendingSteer and publication failure=$publicationFails in background=$background',
    async ({ pendingSteer, publicationFails, background }) => {
      planDiagnostics.events.length = 0
      const base = runInput(),
        sessionId = randomUUID()
      const input = {
        ...base,
        sessionId,
        promptEnvelope: { ...base.promptEnvelope, sessionId },
        nativeGeneration: 'finish-failure',
        bindingGeneration: 1,
      }
      const steerId = randomUUID()
      const started = Promise.withResolvers<void>()
      const bodyDelivered = Promise.withResolvers<void>()
      const controller = new AbortController()
      const deliverResult = Promise.withResolvers<void>()
      const consumeSteer = Promise.withResolvers<void>()
      const evidence = vi.fn<NonNullable<AgentRunInput['recordNativeEvidence']>>()
      const failure = vi.fn<NonNullable<AgentRunInput['recordOutputFailure']>>()
      failure.mockImplementation(() => {
        if (publicationFails) throw new NativeCapacityError('Fixture output publication failed.')
      })
      const workflowPlan = vi.fn<NonNullable<AgentRunInput['recordWorkflowPlan']>>()
      const consumption = vi.fn<(inputId: string) => void>()
      let reachedEof = false
      let inputDrain: Promise<void> | undefined
      const query = ((request: { prompt: AsyncIterable<SDKUserMessage> }) => {
        const root = Promise.withResolvers<void>()
        inputDrain = (async () => {
          for await (const message of request.prompt)
            if (message.uuid === input.runId) root.resolve()
        })()
        const output = (async function* () {
          await root.promise
          yield {
            type: 'system',
            subtype: 'init',
            session_id: input.nativeSessionId,
            capabilities: ['interrupt_cancel_queued_v1'],
          } as SDKMessage
          yield {
            type: 'user',
            uuid: input.runId,
            user_message_uuid: input.runId,
            session_id: input.nativeSessionId,
            parent_tool_use_id: null,
            message: { role: 'user', content: 'Request' },
          } as SDKMessage
          for (const event of [
            { type: 'message_start', message: { id: 'unfinished-api', model: 'fixture' } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Partial body' },
            },
          ])
            yield {
              type: 'stream_event',
              uuid: randomUUID(),
              session_id: input.nativeSessionId,
              parent_tool_use_id: null,
              event,
            } as SDKMessage
          await deliverResult.promise
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: input.nativeSessionId,
            user_message_uuid: input.runId,
            result: 'Unsealed body',
          } as SDKMessage
          if (pendingSteer) {
            await consumeSteer.promise
            yield {
              type: 'user',
              uuid: steerId,
              user_message_uuid: steerId,
              session_id: input.nativeSessionId,
              parent_tool_use_id: null,
              message: { role: 'user', content: 'Supplement consumed' },
            } as SDKMessage
            yield {
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: input.nativeSessionId,
              user_message_uuid: steerId,
              result: 'Complete',
            } as SDKMessage
          }
          reachedEof = true
        })()
        return {
          [Symbol.asyncIterator]: () => output,
          initializationResult: vi.fn(async () => ({ current_permission_mode: 'default' })),
          setPermissionMode: vi.fn(async () => undefined),
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
      const events: import('@pact/contracts').NormalizedAgentEvent[] = []
      const outcome = (async () => {
        for await (const event of adapter.run(
          {
            ...input,
            recordNativeEvidence: evidence,
            recordOutputFailure: failure,
            recordWorkflowPlan: workflowPlan,
          },
          controller.signal,
        )) {
          events.push(event)
          if (event.type === 'turn.started') started.resolve()
          if (event.type === 'text.delta') bodyDelivered.resolve()
        }
      })().catch((error: unknown) => error)
      try {
        await started.promise
        const steering = pendingSteer
          ? await adapter.steer(
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
            )
          : undefined
        expect(steering?.status).toBe(pendingSteer ? 'submitted' : undefined)
        if (background) {
          await bodyDelivered.promise
          controller.abort()
          await outcome
        }
        deliverResult.resolve()
        await expect(outcome).resolves.toMatchObject({
          kind: background
            ? 'unknown_delivery'
            : publicationFails
              ? 'runtime_incompatible'
              : pendingSteer
                ? 'unknown_delivery'
                : 'protocol_error',
        })
        await vi.waitFor(() => expect(failure).toHaveBeenCalledTimes(1))
        expect(failure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'protocol_error' }))
        const diagnostics = planDiagnostics.events.filter((event) => event.operation === 'send')
        expect(diagnostics).toHaveLength(Number(publicationFails))
        for (const event of diagnostics) {
          expect(diagnosticEventSchema.parse(event)).toMatchObject({
            scope: 'run',
            phase: 'failed',
            level: 'error',
            runtimeBoundary: 'projection',
            failureSource: 'classified_error',
            code: 'runtime_incompatible',
            runId: input.runId,
          })
          expect(JSON.stringify(event)).not.toContain('Fixture output publication failed')
        }
        expect(
          events.some((event) => event.type === 'text.delta' && event.text === 'Partial body'),
        ).toBe(true)
        expect(
          events.some(
            (event) => event.type === 'text.completed' || event.type === 'turn.completed',
          ),
        ).toBe(false)
        expect(workflowPlan).not.toHaveBeenCalled()
        expect(evidence.mock.calls.some(([fact]) => fact.kind === 'ended')).toBe(!pendingSteer)
        consumeSteer.resolve()
        await vi.waitFor(() =>
          expect(evidence).toHaveBeenCalledWith(
            expect.objectContaining({
              kind: 'ended',
              source: 'live_terminal',
              outcome: 'completed',
            }),
          ),
        )
        expect(consumption.mock.calls.map(([id]) => id)).toEqual(pendingSteer ? [steerId] : [])
        await vi.waitFor(() => expect(reachedEof).toBe(true))
        await vi.waitFor(() => expect(adapter.hasActiveBackgroundWork()).toBe(false))
        expect(
          evidence.mock.calls.some(
            ([fact]) => fact.kind === 'ended' && fact.output?.completeness === 'complete',
          ),
        ).toBe(false)
      } finally {
        deliverResult.resolve()
        consumeSteer.resolve()
        await adapter.dispose()
        await outcome
        await inputDrain
      }
    },
  )

  it.each([false, true])(
    'keeps Steer consumption and terminal receipts after projection overflow with legacy structured output=%s',
    async (legacyStructured) => {
      const input = {
        ...planRunInput('claude'),
        nativeSessionId: 'claude-carrier-failure',
        nativeGeneration: 'carrier-failure-fixture',
        bindingGeneration: 1,
      }
      const steerId = randomUUID(),
        carrier = {
          version: 'pact-collaboration-envelope-v5',
          answer: 'Old carrier',
          result: { plan: 'Untrusted old plan' },
        }
      const overflow = Promise.withResolvers<void>(),
        deliverCarrier = Promise.withResolvers<void>()
      const rootPrompt = Promise.withResolvers<void>()
      const evidence = vi.fn<NonNullable<AgentRunInput['recordNativeEvidence']>>()
      const failure = vi.fn<NonNullable<AgentRunInput['recordOutputFailure']>>()
      const consumption = vi.fn<(inputId: string) => void>()
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
            ...(legacyStructured ? { structured_output: carrier } : {}),
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
            ...(legacyStructured ? { structured_output: carrier } : {}),
            result: JSON.stringify(carrier),
          } as SDKMessage
          reachedEof = true
        })()
        return {
          [Symbol.asyncIterator]: () => output,
          initializationResult: vi.fn(async () => ({ current_permission_mode: 'plan' })),
          setPermissionMode: vi.fn(async () => undefined),
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

  it('keeps native prose literal and refuses legacy structured output as workflow authority', async () => {
    const input = planRunInput('claude')
    const text = JSON.stringify({
      version: 'pact-collaboration-envelope-v5',
      answer: 'Literal prose',
      result: { plan: 'Not a native plan' },
    })
    const record = vi.fn<NonNullable<AgentRunInput['recordWorkflowPlan']>>()
    const query = vi.fn(
      fakeQuery([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'claude-native-plan',
          user_message_uuid: input.runId,
          result: text,
          structured_output: { plan: 'Untrusted plan' },
        } as SDKMessage,
      ]),
    )
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query: query as never,
      getSessionInfo: vi.fn() as never,
    })
    const events: import('@pact/contracts').NormalizedAgentEvent[] = []
    try {
      for await (const event of adapter.run(
        {
          ...input,
          nativeSessionId: 'claude-native-plan',
          recordWorkflowPlan: record,
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
      expect(record).not.toHaveBeenCalled()
      expect(
        events.filter((event) => event.type === 'text.completed').map((event) => event.text),
      ).toEqual([text])
      expect(events.filter((event) => event.type === 'collaboration.plan')).toEqual([])
      const options = query.mock.calls[0]![0].options!
      const server = Object.keys(options.mcpServers!)[0]!
      expect(options.allowedTools).toContain(`mcp__${server}__read_collaboration_source`)
      expect(options.allowedTools).not.toContain(`mcp__${server}__publish_collaboration_result`)
      expect(options.allowedTools).not.toContain(`mcp__${server}__request_peer_assistance`)
      expect(options.permissionMode).toBe('plan')
      expect(options.canUseTool).toBeTypeOf('function')
      expect(options.outputFormat).toBeUndefined()
      expect(query).toHaveBeenCalledOnce()
    } finally {
      await adapter.dispose()
    }
  })
  it.each(['default', 'plan'] as const)(
    'confirms native planning before dispatch when initialized in %s',
    async (mode) => {
      const input = planRunInput('claude')
      const received: SDKUserMessage[] = []
      const acknowledge = Promise.withResolvers<void>()
      const setPermissionMode = vi.fn<(mode: string) => Promise<void>>(() => acknowledge.promise)
      const query = fakeQuery(
        [
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: 'plan-mode',
            user_message_uuid: input.runId,
            result: 'Planning complete.',
          } as SDKMessage,
        ],
        {
          initializationResult: async () => ({ current_permission_mode: mode }),
          setPermissionMode,
          onInput: (message) => received.push(message),
        },
      )
      const adapter = new ClaudeAgentAdapter('/fake/claude', {
        query,
        getSessionInfo: vi.fn() as never,
      })
      const running = (async () => {
        for await (const event of adapter.run(
          { ...input, nativeSessionId: 'plan-mode', permissionMode: 'full' },
          new AbortController().signal,
        )) {
          void event
        }
      })()
      try {
        await vi.waitFor(() =>
          expect(mode === 'default' ? setPermissionMode.mock.calls.length : received.length).toBe(
            1,
          ),
        )
        expect(received).toHaveLength(mode === 'default' ? 0 : 1)
        expect(setPermissionMode.mock.calls).toEqual(mode === 'default' ? [['plan']] : [])
        acknowledge.resolve()
        await running
        expect(received.map((message) => message.uuid)).toEqual([input.runId])
      } finally {
        acknowledge.resolve()
        await adapter.dispose()
        await running
      }
    },
  )
  it('refuses an unknown native planning mode before exposing the user input', async () => {
    const input = planRunInput('claude'),
      received = vi.fn<(message: SDKUserMessage) => void>()
    const query = fakeQuery([], {
      initializationResult: async () => ({ current_permission_mode: 'unrecognized' }),
      onInput: received,
    })
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query,
      getSessionInfo: vi.fn() as never,
    })
    try {
      const run = (async () => {
        for await (const event of adapter.run(input, new AbortController().signal)) {
          void event
        }
      })()
      await expect(run).rejects.toMatchObject({ kind: 'runtime_incompatible' })
      expect(received).not.toHaveBeenCalled()
    } finally {
      await adapter.dispose()
    }
  })
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
      const f = await bootstrapFixture()
      try {
        await f.adapter.rebuildNativeContext(
          rebuildInput(),
          rebuildSource(),
          new AbortController().signal,
        )
        if (fault !== 'changed-hash') await f.appendNativeWork(fault)
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
      expect(info).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      await expect(
        adapter.probeNativeStatus({ ...input, executorId: 'other' }, new AbortController().signal),
      ).resolves.toMatchObject({ kind: 'no_evidence' })
      expect(await readFile(source.path, 'utf8')).toBe(source.original)
      await rm(source.path)
      await expect(
        adapter.probeNativeStatus(input, new AbortController().signal),
      ).resolves.toMatchObject({ kind: 'no_evidence' })
      expect(query).not.toHaveBeenCalled()
      await expect(readFile(source.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
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
      const source = await savedClaudeAnswerFixture()
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
      const query = vi.fn(),
        read = vi.fn(async () => {
          throw new Error('No unbounded SDK transcript fallback is allowed.')
        })
      const original =
        fault === 'unreadable'
          ? 'Invalid JSON\n'
          : fault === 'duplicate'
            ? source.original + source.original
            : source.original +
              JSON.stringify({
                type: 'assistant',
                uuid: randomUUID(),
                parentUuid: runInput().runId,
                sessionId: source.nativeSessionId,
                cwd: source.cwd,
                timestamp: new Date().toISOString(),
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024 + 1) }],
                },
              }) +
              '\n'
      await writeFile(source.path, original)
      const adapter = new ClaudeAgentAdapter('/fake/claude', {
        query: query as never,
        getSessionInfo: vi.fn(async () => ({ sessionId: 'claude-session-1' })) as never,
        getSessionMessages: read as never,
      })
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
        expect(result).toMatchObject({ kind: 'ended', outcome: 'completed' })
        expect('output' in result).toBe(false)
        expect(query).not.toHaveBeenCalled()
        expect(read).not.toHaveBeenCalled()
        expect(await readFile(source.path, 'utf8')).toBe(original)
      } finally {
        await adapter.dispose()
        await source.dispose()
      }
    },
  )

  it('settles naturally ended startup work after Auto refusal without declaring initialized history', async () => {
    const f = await bootstrapFixture('permission-refused')
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
    const f = await bootstrapFixture('open-hook')
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
    const f = await bootstrapFixture('changed')
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
    const f = await bootstrapFixture()
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
      const f = await bootstrapFixture(fault)
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
  naturalEof = false,
) {
  const effectiveInput = { ...runInput(), ...input }
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
                uuid: effectiveInput.runId,
                session_id: effectiveInput.nativeSessionId,
                parent_tool_use_id: null,
                message: { role: 'user', content: 'accepted' },
              } as SDKMessage,
            }
          }
          if (reads === 2) return read
          if (naturalEof) return { done: true, value: undefined }
          throw new Error('Actor exited with code 1')
        },
      }),
      interrupt,
      initializationResult: vi.fn(async () => ({
        current_permission_mode: request.options?.permissionMode ?? 'default',
      })),
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
    initializationResult:
      controls.initializationResult ??
      vi.fn(async () => ({
        current_permission_mode: request.options?.permissionMode ?? 'default',
      })),
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
async function bootstrapFixture(
  fault?: 'missing' | 'changed' | 'duplicate' | 'permission-refused' | 'open-hook',
) {
  const profile = await mkdtemp(join(tmpdir(), 'pact-claude-seed-test-'))
  bootstrapDirectories.push(profile)
  const project = join(profile, 'projects', '-project'),
    path = join(project, rebuildInput().nativeSessionId + '.jsonl')
  await mkdir(project, { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
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
          const rows =
            fault === 'missing'
              ? []
              : prompts.map((message, index) => ({
                  ...message,
                  sessionId: rebuildInput().nativeSessionId,
                  cwd: '/project',
                  parentUuid: index ? prompts[index - 1]!.uuid : null,
                  timestamp: new Date().toISOString(),
                  message: {
                    ...message.message,
                    content: fault === 'changed' ? 'Changed' : message.message.content,
                  },
                }))
          await writeFile(
            path,
            (fault === 'duplicate' ? [...rows, ...rows] : rows)
              .map((row) => JSON.stringify(row) + '\n')
              .join(''),
          )
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
    appendNativeWork: async (kind: 'user' | 'tool') =>
      appendFile(
        path,
        JSON.stringify({
          type: kind === 'user' ? 'user' : 'assistant',
          uuid: randomUUID(),
          parentUuid: prompts.at(-1)!.uuid,
          sessionId: rebuildInput().nativeSessionId,
          cwd: '/project',
          timestamp: new Date().toISOString(),
          message: {
            role: kind === 'user' ? 'user' : 'assistant',
            content:
              kind === 'user'
                ? 'Later request'
                : [
                    {
                      type: 'tool_use',
                      id: randomUUID(),
                      name: 'Bash',
                      input: { command: 'echo changed' },
                    },
                  ],
          },
        }) + '\n',
      ),
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

it('registers the complete strict source schema on the actual SDK before native dispatch', async () => {
  const input = runInput(),
    identity = { runId: input.runId, grant: randomUUID() }
  const text = 'Controlled SDK source.',
    document = {
      id: randomUUID(),
      sha256: createHash('sha256').update(text).digest('hex'),
      bytes: Buffer.byteLength(text),
      chars: text.length,
    }
  const reference = { ...identity, source: 'document' as const, document, offset: 0 }
  const read = vi.fn<NonNullable<AgentRunInput['collaborationSourceReader']>['read']>((raw) => {
    expect(raw).toEqual(reference)
    return {
      submitted: 'legacy',
      request: { ...identity, source: 'document', document, offset: 0 },
      page: {
        source: 'document',
        document,
        text,
        offset: 0,
        nextOffset: null,
        binding: {
          submitted: 'legacy',
          callerRunId: identity.runId,
          grantSha256: createHash('sha256').update(identity.grant).digest('hex'),
          referenceSha256: null,
        },
      },
    }
  })
  const f = cancellationFixture(undefined, {
    ...input,
    promptEnvelope: { ...input.promptEnvelope, sourceGrant: identity },
    readCollaborationSourcePart: () => {
      throw Error('The borrowed owner handles source requests')
    },
    collaborationSourceReader: {
      identity,
      read,
      navigation: () => reference,
      retire: () => undefined,
    },
  })
  try {
    await f.ready()
    const server = Object.values(f.options().mcpServers!)[0]!
    if (server.type !== 'sdk') throw Error('Expected the owned SDK MCP server')
    const replies: object[] = []
    const transport: Parameters<typeof server.instance.connect>[0] = {
      start: async () => undefined,
      close: async () => undefined,
      send: async (message) => {
        replies.push(message)
      },
    }
    await server.instance.connect(transport)
    let nextId = 0
    const exchange = async (method: string, params: Record<string, unknown>) => {
      const id = ++nextId
      transport.onmessage?.({ jsonrpc: '2.0', id, method, params })
      await vi.waitFor(() =>
        expect(replies.some((reply) => Reflect.get(reply, 'id') === id)).toBe(true),
      )
      return replies.find((reply) => Reflect.get(reply, 'id') === id)!
    }
    await exchange('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'source-schema-test', version: '1' },
    })
    transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const listed = await exchange('tools/list', {})
    const source = Reflect.get(listed, 'result') as {
      tools: Array<{ name: string; inputSchema: { required: string[]; properties: object } }>
    }
    const schema = source.tools.find(
      (tool) => tool.name === 'read_collaboration_source',
    )!.inputSchema
    expect(schema.required).toEqual(expect.arrayContaining(['runId', 'grant', 'offset']))
    expect(schema.properties).not.toHaveProperty('sourceReference')
    expect(JSON.stringify(listed)).toContain('anthropic/alwaysLoad')
    const valid = await exchange('tools/call', {
      name: 'read_collaboration_source',
      arguments: reference,
    })
    expect(valid).toMatchObject({ result: { content: [{ type: 'text' }] } })
    const extra = await exchange('tools/call', {
      name: 'read_collaboration_source',
      arguments: { ...reference, unexpected: true },
    })
    expect(extra).toMatchObject({ result: { isError: true } })
    const nested = await exchange('tools/call', {
      name: 'read_collaboration_source',
      arguments: { ...identity, offset: 0, document: { ...document, unexpected: true } },
    })
    expect(nested).toMatchObject({ result: { isError: true } })
    const missing = await exchange('tools/call', {
      name: 'read_collaboration_source',
      arguments: { ...identity, source: 'document', document },
    })
    expect(missing).toMatchObject({ result: { isError: true } })
    expect(read).toHaveBeenCalledTimes(1)
    await server.instance.close()
  } finally {
    await f.dispose()
  }
})

it('encodes Claude Steer with exact legacy arguments and keeps ordinary root references', async () => {
  const input = runInput(),
    grant = randomUUID(),
    rootBatch = randomUUID(),
    nextBatch = randomUUID(),
    steerId = randomUUID()
  const prompts: SDKUserMessage[] = [],
    rootPrompt = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>()
  const navigation = vi.fn<NonNullable<AgentRunInput['collaborationSourceReader']>['navigation']>(
    (target, form) => {
      if (target.batchId === nextBatch && form !== 'legacy')
        throw Error('Prepared Batch is not reference-authorized')
      return form === 'sourceReference'
        ? { sourceReference: 'controlled-root-reference', offset: 0 }
        : { ...target, runId: input.runId, grant, offset: 0 }
    },
  )
  let drain: Promise<void> | undefined
  const query = ((request: Parameters<typeof sdkQuery>[0]) => {
    if (typeof request.prompt === 'string') throw Error('Expected native streaming input')
    const stream = request.prompt
    drain = (async () => {
      for await (const message of stream) {
        prompts.push(message)
        if (prompts.length === 1) rootPrompt.resolve()
      }
    })()
    void drain.catch(() => undefined)
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
        uuid: randomUUID(),
        message: { id: 'initial', model: 'fixture', content: [] },
      } as unknown as SDKMessage
      await finish.promise
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: input.nativeSessionId,
        user_message_uuid: input.runId,
        result: 'Original native round complete.',
      } as SDKMessage
      yield {
        type: 'user',
        session_id: input.nativeSessionId,
        uuid: steerId,
        user_message_uuid: steerId,
        parent_tool_use_id: null,
        message: { role: 'user', content: 'Supplement incorporated.' },
      } as SDKMessage
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: input.nativeSessionId,
        user_message_uuid: steerId,
        result: 'Supplement complete.',
      } as SDKMessage
    })()
    return {
      [Symbol.asyncIterator]: () => output,
      initializationResult: vi.fn(async () => ({ current_permission_mode: 'default' })),
      setPermissionMode: vi.fn(async () => undefined),
      cancelAsyncMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => ({ cancelled: [], still_queued: [] })),
      close: vi.fn(),
      return: () => output.return(undefined),
    }
  }) as never
  const adapter = new ClaudeAgentAdapter('/fake/claude', {
      query,
      getSessionInfo: vi.fn() as never,
    }),
    controller = new AbortController()
  const envelope = {
    ...input.promptEnvelope,
    sourceGrant: { runId: input.runId, grant },
    inputBatchRef: { id: rootBatch, revision: 0, memberCount: 0 },
  }
  const outcome = (async () => {
    for await (const event of adapter.run(
      {
        ...input,
        nativeGeneration: grant,
        bindingGeneration: 1,
        peerAssistanceAllowed: false,
        promptEnvelope: envelope,
        collaborationSourceReader: {
          identity: { runId: input.runId, grant },
          navigation,
          read: () => {
            throw Error('Encoding fixture does not read sources')
          },
          retire: () => undefined,
        },
      },
      controller.signal,
    ))
      if (event.type === 'turn.started') started.resolve()
  })().catch((error: unknown) => error)
  try {
    await started.promise
    const result = await adapter.steer(
      {
        runId: input.runId,
        inputId: steerId,
        nativeSessionId: input.nativeSessionId!,
        nativeTurnId: input.runId,
        nativeGeneration: grant,
        bindingGeneration: 1,
        promptEnvelope: {
          ...envelope,
          message: { id: steerId, content: 'Supplement.' },
          inputBatchRef: { id: nextBatch, revision: 0, memberCount: 0 },
        },
        recordDispatch: () => undefined,
        recordConsumption: () => undefined,
      },
      new AbortController().signal,
    )
    expect(result).toEqual({ status: 'submitted' })
    expect(prompts).toHaveLength(2)
    const rootText = prompts[0]!.message.content,
      steerText = prompts[1]!.message.content
    if (typeof rootText !== 'string' || typeof steerText !== 'string')
      throw Error('Expected text-only native input')
    const rootStart =
      rootText.indexOf('\n', rootText.indexOf('Pact context (JSON reference data;')) + 1
    const rootContext: { sourceReadArguments: unknown } = JSON.parse(rootText.slice(rootStart))
    expect(rootContext.sourceReadArguments).toEqual({
      source: 'batch',
      runId: input.runId,
      grant,
      batchId: rootBatch,
      offset: 0,
    })
    const start =
      steerText.indexOf('\n', steerText.indexOf('Pact context (JSON reference data;')) + 1
    const context: { sourceReadArguments: unknown } = JSON.parse(steerText.slice(start))
    expect(context.sourceReadArguments).toEqual({
      source: 'batch',
      runId: input.runId,
      grant,
      batchId: nextBatch,
      offset: 0,
    })
    expect(
      navigation.mock.calls
        .filter(([target]) => target.batchId === nextBatch)
        .map(([, form]) => form),
    ).toEqual(['legacy'])
    finish.resolve()
    expect(await outcome).toBeUndefined()
  } finally {
    finish.resolve()
    controller.abort()
    await adapter.dispose()
    await outcome
    await drain?.catch(() => undefined)
  }
})

it.each([true, false])(
  'retains both Claude SDK text-frame UUIDs in one API item with partial=%s',
  async (partial) => {
    const input = runInput(),
      sid = input.nativeSessionId,
      messages: SDKMessage[] = []
    const stream = (event: unknown, parent_tool_use_id: string | null = null) =>
      ({
        type: 'stream_event',
        uuid: randomUUID(),
        session_id: sid,
        parent_tool_use_id,
        event,
      }) as SDKMessage
    const assistant = (
      id: string,
      uuid: string,
      text: string,
      parent_tool_use_id: string | null = null,
    ) =>
      ({
        type: 'assistant',
        uuid,
        session_id: sid,
        parent_tool_use_id,
        message: { id, role: 'assistant', model: 'fixture', content: [{ type: 'text', text }] },
      }) as SDKMessage
    messages.push({
      type: 'user',
      uuid: input.runId,
      user_message_uuid: input.runId,
      session_id: sid,
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Request' },
    } as SDKMessage)
    if (partial)
      messages.push(stream({ type: 'message_start', message: { id: 'api-1', model: 'fixture' } }))
    for (const [index, text] of ['First.', ' Second.'].entries()) {
      if (partial)
        messages.push(
          stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
          stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }),
        )
      messages.push(assistant('api-1', randomUUID(), text))
      if (partial) messages.push(stream({ type: 'content_block_stop', index }))
    }
    messages.push(
      stream({ type: 'message_start', message: { id: 'child-api', model: 'child' } }, 'child-tool'),
      stream(
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Child text must stay outside the root.' },
        },
        'child-tool',
      ),
      assistant('child-api', randomUUID(), 'Child text must stay outside the root.', 'child-tool'),
    )
    if (partial) messages.push(stream({ type: 'message_stop' }))
    messages.push(assistant('api-2', randomUUID(), 'Final.'), {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sid,
      user_message_uuid: input.runId,
      result: 'Final.',
    } as SDKMessage)
    const adapter = new ClaudeAgentAdapter('/fake/claude', {
        query: fakeQuery(messages),
        getSessionInfo: vi.fn() as never,
      }),
      events: import('@pact/contracts').NormalizedAgentEvent[] = []
    try {
      for await (const event of adapter.run(input, new AbortController().signal)) events.push(event)
      expect(events.findLast((event) => event.type === 'text.completed')).toMatchObject({
        text: 'First. Second.\n\nFinal.',
      })
      expect(
        events
          .filter((event) => event.type === 'text.delta')
          .map((event) => event.text)
          .join(''),
      ).toBe('First. Second.\n\nFinal.')
      expect(events.findLast((event) => event.type === 'turn.completed')).toMatchObject({
        outcome: 'completed',
      })
    } finally {
      await adapter.dispose()
    }
  },
)

it('roundtrips actual immutable current and historical Sources through SDK and native HTTP', async () => {
  const db = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolveSourceFixturePath(
      import.meta.dirname,
      '../../../../../packages/persistence/drizzle',
    ),
  })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  let fixture: ReturnType<typeof cancellationFixture> | undefined
  let reader: FrozenSourceReader | undefined
  let peer: PactPeerToolServer | undefined
  let sdkServer: { close: () => Promise<void> } | undefined
  try {
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'SDK source seam',
      directoryPath: '/project',
      kind: 'directory',
      createdAt,
    })
    db.sessionRepository.create(
      { id: sessionId, projectId, title: 'SDK source seam', createdAt },
      {
        primaryAgentId: 'claude',
        agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    )
    const repo = db.conversationRepository
    const old = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Historical question without optional declaration.',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    }).run
    repo.applyEvent(sessionId, old.id, {
      type: 'turn.started',
      agentId: 'codex',
      turnId: 'history-turn',
    })
    repo.applyEvent(sessionId, old.id, {
      type: 'text.completed',
      agentId: 'codex',
      turnId: 'history-turn',
      outputId: randomUUID(),
      text: 'Historical agreed scope.',
    })
    repo.applyEvent(sessionId, old.id, {
      type: 'turn.completed',
      agentId: 'codex',
      turnId: 'history-turn',
      outcome: 'completed',
    })
    const history = repo.internalMessage(old.userMessageId, sessionId)!
    const commentId = randomUUID(),
      comment = 'Preserve the agreed cancellation boundary.'
    const beforeComment = repo.readPage({ scope: 'drafts', sessionId })
    if (beforeComment.scope !== 'drafts') throw Error('Missing source draft headers')
    repo.saveCommentDraft({
      mode: 'create',
      sessionId,
      commentId,
      expectedCommentsRevision: beforeComment.commentsRevision,
      body: comment,
      anchor: {
        type: 'message',
        messageId: history.id,
        contentHash: createHash('sha256').update(history.content).digest('hex'),
        textBasis: 'markdown-visible-v2',
        startOffset: 0,
        endOffset: 10,
        quote: history.content.slice(0, 10),
      },
    })
    const drafts = repo.readPage({ scope: 'drafts', sessionId })
    if (drafts.scope !== 'drafts') throw Error('Missing actual draft revision')
    const content = 'Current release note: 2027-04-12. Unicode source αβ🐈.\n'.repeat(200)
    const started = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content,
      expectedCommentsRevision: drafts.commentsRevision,
      commentIds: [commentId],
      agentId: 'claude',
      settingsRevision: db.sessionRepository.find(sessionId)!.settingsRevision,
      model: null,
      effort: null,
      handoffSourceRefs: [
        {
          id: history.id,
          revision: history.contentRevision,
          digest: createHash('sha256').update(history.content).digest('hex'),
        },
      ],
      userInformation: {
        version: 'user-information-v1',
        id: randomUUID(),
        kind: 'user_supplied_value',
        question: 'What launch date should be used?',
        input: 'text',
        options: [],
        state: { status: 'answered', value: '2027-04-12' },
      },
    }).run
    const batch = repo.inputBatchForRun(started.id)!,
      identity = { runId: started.id, grant: randomUUID() }
    reader = new FrozenSourceReader(
      identity,
      sessionId,
      repo,
      () => true,
      () => batch.id,
      undefined,
      undefined,
      batch.id,
    )
    const input: AgentRunInput = {
      ...runInput(),
      runId: started.id,
      sessionId,
      promptEnvelope: {
        version: 'pact-agent-prompt-v1',
        targetAgentId: 'claude',
        sessionId,
        sourceGrant: identity,
        inputBatchRef: batch,
        message: { id: started.userMessageId, content },
        comments: [],
      },
      collaborationSourceReader: reader,
    }
    fixture = cancellationFixture(undefined, input)
    await fixture.ready()
    const server = Object.values(fixture.options().mcpServers!)[0]!
    if (server.type !== 'sdk') throw Error('Expected actual owned SDK MCP server')
    sdkServer = server.instance
    const replies: object[] = []
    const transport: Parameters<typeof server.instance.connect>[0] = {
      start: async () => undefined,
      close: async () => undefined,
      send: async (message) => {
        replies.push(message)
        expect(replies.length).toBeLessThanOrEqual(128)
      },
    }
    await server.instance.connect(transport)
    let nextId = 0
    const sdk = async (method: string, params: Record<string, unknown>) => {
      const id = ++nextId
      transport.onmessage?.({ jsonrpc: '2.0', id, method, params })
      await vi.waitFor(() =>
        expect(replies.some((reply) => Reflect.get(reply, 'id') === id)).toBe(true),
      )
      return Reflect.get(
        replies.find((reply) => Reflect.get(reply, 'id') === id)!,
        'result',
      ) as Record<string, unknown>
    }
    await sdk('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'actual-source-seam', version: '1' },
    })
    transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const prompt = fixture.prompts[0]!.message.content
    const text =
      typeof prompt === 'string'
        ? prompt
        : prompt
            .filter((part) => part.type === 'text')
            .map((part) => ('text' in part ? part.text : ''))
            .join('\n')
    const marker = text.indexOf('Pact context (JSON reference data;')
    const context = JSON.parse(text.slice(text.indexOf('\n', marker) + 1)) as Record<
      string,
      unknown
    >
    const call = async (args: unknown) =>
      sdk('tools/call', { name: 'read_collaboration_source', arguments: args })
    const root = { threadId: randomUUID(), turnId: randomUUID() }
    peer = new PactPeerToolServer()
    peer.beginTurn('claude', false, undefined, false, undefined, identity, reader)
    peer.bindNativeSourceRoot(identity, { ...root, executorId: randomUUID() }, () => true)
    const url = await peer.start()
    const httpReply = async (args: unknown, turnId = root.turnId) => {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'read_collaboration_source',
            arguments: args,
            _meta: {
              threadId: root.threadId,
              'x-codex-turn-metadata': { thread_id: root.threadId, turn_id: turnId },
            },
          },
        }),
      })
      const responseBody: unknown = await response.json()
      if (responseBody === null || typeof responseBody !== 'object')
        throw Error('Missing actual Source HTTP result')
      return responseBody
    }
    const http = async (args: unknown, turnId = root.turnId) =>
      Reflect.get(await httpReply(args, turnId), 'result') as Record<string, unknown>
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- This decoder belongs to the single Source transport seam fixture.
    const decode = (reply: Record<string, unknown>) => {
      expect(reply['isError']).not.toBe(true)
      const parts = reply['content'] as Array<{ text: string }>
      return collaborationSourceWireResultSchema.parse(JSON.parse(parts[0]!.text))
    }
    const traverse = async (
      read: (args: unknown) => Promise<Record<string, unknown>>,
      initial: unknown,
      form: 'legacy' | 'sourceReference' | 'nativeRoot',
    ) => {
      const pending: unknown[] = [initial, reader!.navigation({ source: 'handoff_sources' }, form)]
      const seen = new Set<string>(),
        documents = new Map<string, { text: string; sha256: string; chars: number }>()
      const batches: Array<Record<string, unknown>> = []
      let calls = 0
      for (let i = 0; i < pending.length; i++) {
        expect(i).toBeLessThan(64)
        const args = pending[i],
          key = JSON.stringify(args)
        if (seen.has(key)) continue
        seen.add(key)
        // oxlint-disable-next-line no-await-in-loop -- Each immutable page supplies the next authorized navigation.
        const value = decode(await read(args))
        calls++
        expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(48 * 1024)
        if (value.nextOffset !== null) {
          if (value.nextRead === undefined) throw Error('Missing Source continuation navigation')
          pending.push(value.nextRead)
        }
        if (value.source === 'document') {
          const document = value.document!,
            assembled = documents.get(document.id) ?? {
              text: '',
              sha256: document.sha256,
              chars: document.chars,
            }
          if (value.offset !== assembled.text.length)
            throw Error('Source document cursor is not contiguous')
          assembled.text += value.text
          documents.set(document.id, assembled)
        } else {
          const index = JSON.parse(value.text) as Record<string, unknown>
          if (value.source === 'batch') {
            batches.push(index)
            for (const field of ['bodyRead', 'userInformationRead', 'clarificationAnswerRead'])
              if (index[field] !== undefined) pending.push(index[field])
            for (const member of (index['members'] ?? []) as Array<Record<string, unknown>>)
              pending.push(member['bodyRead'])
          } else
            for (const item of (index['items'] ?? []) as Array<Record<string, unknown>>) {
              if (item['batchRead'] !== undefined) pending.push(item['batchRead'])
              for (const entry of (item['documents'] ?? []) as Array<Record<string, unknown>>)
                pending.push(entry['read'])
            }
        }
      }
      for (const item of documents.values()) {
        expect(item.text.length).toBe(item.chars)
        expect(createHash('sha256').update(item.text).digest('hex')).toBe(item.sha256)
      }
      expect([...documents.values()].some((value) => value.text === content)).toBe(true)
      expect([...documents.values()].some((value) => value.text === comment)).toBe(true)
      expect([...documents.values()].some((value) => value.text === history.content)).toBe(true)
      expect(batches.some((value) => value['userInformationRead'] !== undefined)).toBe(true)
      const historical = batches.find((value) => value['userInformationRead'] === undefined)!
      expect(historical).toBeDefined()
      expect(historical['clarificationAnswerRead']).toBeUndefined()
      return { calls, documents: documents.size, historical }
    }
    const batchPage = decode(await call(context['sourceReadArguments']))
    expect(batchPage.source).toBe('batch')
    const directMembers = Reflect.get(batchPage, 'members') as
      | Array<{ bodyRead: unknown }>
      | undefined
    expect(directMembers?.[0]?.bodyRead).toBeDefined()
    expect(Reflect.get(batchPage, 'bodyRead')).toBeDefined()
    expect(decode(await call(directMembers![0]!.bodyRead)).text).toBe(comment)
    const batchIndex = JSON.parse(batchPage.text) as Record<string, unknown>
    const actualBodyPage = decode(await call(batchIndex['bodyRead']))
    expect(actualBodyPage.source).toBe('document')
    expect(() => JSON.parse(actualBodyPage.text)).toThrow(SyntaxError)
    const handoffPage = decode(
      await call(reader.navigation({ source: 'handoff_sources' }, 'legacy')),
    )
    expect(handoffPage.source).toBe('handoff_sources')
    const handoffIndex = JSON.parse(handoffPage.text) as Record<string, unknown>
    expect(handoffIndex['bodyRead']).toBeUndefined()
    const missingHandoffBody = await http(handoffIndex['bodyRead'])
    expect(missingHandoffBody['isError']).toBe(true)
    expect(() =>
      JSON.parse((missingHandoffBody['content'] as Array<{ text: string }>)[0]!.text),
    ).toThrow(SyntaxError)
    const sdkResult = await traverse(call, context['sourceReadArguments'], 'legacy')
    const referenceResult = await traverse(
      http,
      reader.navigation({ source: 'batch', batchId: batch.id }, 'sourceReference'),
      'sourceReference',
    )
    const nativeResult = await traverse(
      http,
      reader.navigation({ source: 'batch', batchId: batch.id }, 'nativeRoot'),
      'nativeRoot',
    )
    expect(nativeResult.documents).toBe(sdkResult.documents)
    expect(referenceResult.documents).toBe(sdkResult.documents)
    const literal = reader.navigation({ source: 'batch', batchId: batch.id }, 'sourceReference')
    if (!('sourceReference' in literal) || typeof literal.sourceReference !== 'string')
      throw Error('Expected actual host-signed reference')
    const token = literal.sourceReference
    const tampered = {
      ...literal,
      sourceReference: token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),
    }
    expect(await httpReply(tampered)).toMatchObject({ error: { code: -32603 } })
    expect(decode(await http(literal)).source).toBe('batch')
    expect((await call(literal))['isError']).toBe(true)
    expect((await call({ ...literal, runId: identity.runId }))['isError']).toBe(true)
    expect(await httpReply({ ...literal, runId: identity.runId })).toMatchObject({
      error: { code: -32603 },
    })
    const missing = await http(sdkResult.historical['clarificationAnswerRead'])
    expect(missing['isError']).toBe(true)
    expect(() => JSON.parse((missing['content'] as Array<{ text: string }>)[0]!.text)).toThrow(
      SyntaxError,
    )
    expect(
      (
        await http(
          reader.navigation({ source: 'batch', batchId: batch.id }, 'nativeRoot'),
          randomUUID(),
        )
      )['isError'],
    ).toBe(true)
    reader.retire()
    expect(await httpReply(literal)).toMatchObject({ error: { code: -32603 } })
  } finally {
    await sdkServer?.close()
    await peer?.dispose()
    reader?.retire()
    await fixture?.dispose()
    db.close()
  }
})
