/* oxlint-disable vitest/no-conditional-expect -- Each native scenario asserts its offered actions and exact raw response. */
import { query, getSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import type { AgentRunInput } from '@pact/agent-runtime'

import { ClaudeAgentAdapter } from './claude-agent-adapter'

it('drains one MiB of synthetic stderr before a real SDK interrupt and exact actor close without model traffic', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-claude-stderr-'))
  const executable = join(directory, 'fixture.mjs')
  const factsPath = join(directory, 'facts.json')
  // This stream-json program only echoes initialization and User/interrupt receipts.
  // It cannot authenticate, load native settings, run tools or contact any model.
  await writeFile(
    executable,
    `
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
const factsPath = ${JSON.stringify(factsPath)}
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const facts = { pid: process.pid, userInputs: 0, interrupts: 0, stderrBytes: 0, modelCalls: 0, toolCalls: 0, stage: 'starting' }
const save = () => writeFileSync(factsPath, JSON.stringify(facts))
let user
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const message = JSON.parse(line)
  if (message.type === 'control_request' && message.request.subtype === 'interrupt') {
    facts.interrupts += 1
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } })
    send({ type: 'result', subtype: 'error_during_execution', session_id: user.session_id, uuid: 'interrupt-result', user_message_uuid: user.uuid, user_message_uuids: [user.uuid], is_error: true, terminal_reason: 'aborted_tools', errors: ['Interrupted'], duration_ms: 1, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [] })
    facts.stage = 'interrupted'
    save()
    lines.close()
    process.stdin.destroy()
    break
  } else if (message.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {}, hooks_applied: true }, pending_permission_requests: [], pending_user_dialog_requests: [] } })
  } else if (message.type === 'user') {
    user = message
    facts.userInputs += 1
    facts.stage = 'writing-stderr'
    save()
    send({ type: 'user', uuid: user.uuid, user_message_uuid: user.uuid, session_id: user.session_id, parent_tool_use_id: null, message: user.message })
    const chunk = Buffer.alloc(16 * 1024, 's')
    for (let index = 0; index < 64; index += 1) {
      const accepted = process.stderr.write(chunk)
      facts.stderrBytes += chunk.length
      if (!accepted) await once(process.stderr, 'drain')
    }
    facts.stage = 'stderr-drained'
    save()
  }
}
`,
    { mode: 0o700 },
  )
  let actor: ChildProcess | undefined
  const close = Promise.withResolvers<{ pid: number | undefined; code: number | null }>()
  const ownedSpawn = vi.fn<
    (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  >((command, args, options) => {
    if (!args.includes(executable)) throw new Error('Only the owned synthetic program may run.')
    const child = spawn(command, args, options)
    actor = child
    child.once('close', (code) => close.resolve({ pid: child.pid, code }))
    return child
  })
  const metadata = vi.fn<typeof getSessionInfo>(async () => undefined)
  const adapter = new ClaudeAgentAdapter(executable, {
    query,
    getSessionInfo: metadata,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This observer forwards the Adapter's exact three-argument spawn call and returns its real child.
    spawn: ownedSpawn as unknown as typeof spawn,
  })
  const controller = new AbortController()
  const evidence = vi.fn<NonNullable<AgentRunInput['recordNativeEvidence']>>()
  const archived = vi.fn<NonNullable<AgentRunInput['recordArchivedEvent']>>()
  const runId = crypto.randomUUID(),
    sessionId = crypto.randomUUID()
  const outcome = (async () => {
    for await (const event of adapter.run(
      {
        runId,
        sessionId,
        cwd: directory,
        model: null,
        effort: null,
        permissionMode: 'ask',
        peerAssistanceAllowed: false,
        promptEnvelope: {
          version: 'pact-agent-prompt-v1',
          sessionId,
          message: { id: crypto.randomUUID(), content: 'Synthetic zero-model stderr transport' },
          comments: [],
        },
        recordNativeEvidence: evidence,
        recordArchivedEvent: archived,
      },
      controller.signal,
    ))
      void event
  })().catch((error: unknown) => error)
  try {
    await vi.waitFor(
      async () => {
        const facts: unknown = JSON.parse(await readFile(factsPath, 'utf8'))
        expect(facts).toMatchObject({
          stage: 'stderr-drained',
          stderrBytes: 1024 * 1024,
          userInputs: 1,
        })
      },
      { timeout: 3_000 },
    )
    controller.abort()
    await expect(outcome).resolves.toMatchObject({ kind: 'unknown_delivery' })
    await vi.waitFor(() =>
      expect(evidence).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'ended',
          outcome: 'interrupted',
          identity: expect.objectContaining({ runId, requestId: runId }),
        }),
      ),
    )
    await vi.waitFor(() =>
      expect(adapter.diagnostics()).toEqual({ activeQueries: 0, activeSessions: 0 }),
    )
    expect(await close.promise).toMatchObject({ pid: actor!.pid, code: 0 })
    expect(adapter.hasActiveBackgroundWork(runId)).toBe(false)
    expect(JSON.parse(await readFile(factsPath, 'utf8'))).toMatchObject({
      stage: 'interrupted',
      userInputs: 1,
      interrupts: 1,
      stderrBytes: 1024 * 1024,
      modelCalls: 0,
      toolCalls: 0,
    })
    expect(ownedSpawn).toHaveBeenCalledOnce()
    expect(metadata).not.toHaveBeenCalled()
    expect(JSON.stringify([evidence.mock.calls, archived.mock.calls])).not.toContain('s'.repeat(32))
  } finally {
    // On a failed pre-fix reproducer, stop only this test's synthetic actor.
    if (actor && actor.exitCode === null) actor.kill('SIGTERM')
    await adapter.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

it.each([
  'approval',
  'question',
  'form',
  'url',
  'abort',
  'decline',
  'session-rule',
  'user-rule',
  'project-rule',
  'local-rule',
  'cli-rule',
  'mixed-rules',
  'forged-rule',
] as const)(
  'encodes %s through the real SDK control-response protocol without running a native tool',
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-claude-control-'))
    const executable = join(directory, 'fixture.mjs')
    const factsPath = join(directory, 'response.json')
    // This executable implements only synthetic stream-json. It cannot load
    // native settings, authenticate, execute a Tool or contact a model.
    await writeFile(
      executable,
      `
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
const kind = ${JSON.stringify(kind)}
const factsPath = ${JSON.stringify(factsPath)}
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const lines = createInterface({ input: process.stdin })
let user
for await (const line of lines) {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {}, hooks_applied: true }, pending_permission_requests: [], pending_user_dialog_requests: [] } })
  } else if (message.type === 'user') {
    user = message
    send({ type: 'system', subtype: 'init', session_id: user.session_id, uuid: 'init', cwd: process.cwd(), tools: [], mcp_servers: [], model: 'fixture', permissionMode: 'default', slash_commands: [], output_style: 'default', apiKeySource: 'none', claude_code_version: 'fixture', skills: [], plugins: [] })
    const rule = destination => ({ type: 'addRules', destination, behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'fixture-only' }] })
    const destinations = { 'session-rule': 'session', 'user-rule': 'userSettings', 'project-rule': 'projectSettings', 'local-rule': 'localSettings', 'cli-rule': 'cliArg', 'forged-rule': 'userSettings' }
    const suggestions = kind === 'mixed-rules' ? [rule('session'), rule('userSettings')] : destinations[kind] ? [rule(destinations[kind])] : []
    const request = kind === 'form' || kind === 'url'
      ? { subtype: 'elicitation', mcp_server_name: 'fixture', message: 'Fixture input', mode: kind === 'url' ? 'url' : 'form', ...(kind === 'url' ? { url: 'https://example.test/authorize', elicitation_id: 'fixture-auth' } : { requested_schema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'] } }) }
      : { subtype: 'can_use_tool', tool_name: kind === 'question' ? 'AskUserQuestion' : 'Bash', tool_use_id: 'fixture-tool', permission_suggestions: suggestions, input: kind === 'question' ? { questions: [{ question: 'Fixture question?', header: 'Fixture', options: [{ label: 'One', description: 'One option' }, { label: 'Two', description: 'Two option' }], multiSelect: false }] } : { command: 'fixture-only' } }
    send({ type: 'control_request', request_id: 'fixture-control', request })
    if (kind === 'abort') send({ type: 'control_cancel_request', request_id: 'fixture-control' })
  } else if (message.type === 'control_response' && message.response.request_id === 'fixture-control') {
    writeFileSync(factsPath, JSON.stringify(message.response))
    send({ type: 'result', subtype: 'success', session_id: user.session_id, uuid: 'result', user_message_uuid: user.uuid, user_message_uuids: [user.uuid], result: 'Fixture finished', is_error: false, duration_ms: 1, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [], stop_reason: 'end_turn' })
    break
  }
}
`,
      { mode: 0o700 },
    )
    const adapter = new ClaudeAgentAdapter(executable)
    const requestPermission = vi.fn<NonNullable<AgentRunInput['requestPermission']>>(
      async (_request, signal) => {
        if (kind === 'abort')
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) reject(new Error('Interrupted'))
            else
              signal.addEventListener('abort', () => reject(new Error('Interrupted')), {
                once: true,
              })
          })
        if (kind === 'decline') return 'decline' as const
        if (kind === 'session-rule') {
          expect(_request.actions?.map((action) => action.id)).toContain('native-updates')
          return 'native-updates'
        }
        if (kind.endsWith('-rule') || kind === 'mixed-rules') {
          expect(_request.actions?.map((action) => action.id)).not.toContain('native-updates')
          return kind === 'forged-rule' ? 'native-updates' : 'allow'
        }
        throw new Error('Expired fixture callback; token=never-export-this')
      },
    )
    const requestUserInput = vi.fn<NonNullable<AgentRunInput['requestUserInput']>>(async () => {
      throw new Error('Expired fixture input')
    })
    try {
      const sessionId = crypto.randomUUID()
      for await (const event of adapter.run(
        {
          runId: crypto.randomUUID(),
          sessionId,
          cwd: directory,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId,
            message: { id: crypto.randomUUID(), content: 'Synthetic control request' },
            comments: [],
          },
          model: null,
          effort: null,
          permissionMode: 'ask',
          peerAssistanceAllowed: false,
          requestPermission,
          requestUserInput,
        },
        new AbortController().signal,
      ))
        void event
      const response: unknown = JSON.parse(await readFile(factsPath, 'utf8'))
      const ruleAllowed =
        (kind.endsWith('-rule') && kind !== 'forged-rule') || kind === 'mixed-rules'
      const expected =
        kind === 'decline'
          ? { subtype: 'success', response: { behavior: 'deny' } }
          : ruleAllowed
            ? { subtype: 'success', response: { behavior: 'allow' } }
            : { subtype: 'error' }
      expect(response).toMatchObject(expected)
      expect(JSON.stringify(response)).not.toContain('never-export-this')
      if (!ruleAllowed) expect(JSON.stringify(response)).not.toContain('"behavior":"allow"')
      if (kind === 'session-rule')
        expect(response).toMatchObject({
          response: { updatedPermissions: [{ destination: 'session' }] },
        })
      else expect(JSON.stringify(response)).not.toContain('updatedPermissions')
      await vi.waitFor(() => expect(adapter.diagnostics().activeQueries).toBe(0))
    } finally {
      await adapter.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
