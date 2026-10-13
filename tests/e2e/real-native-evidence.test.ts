import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { serializeAgentPromptEnvelope } from '../../packages/agent-runtime/src/index.js'
import { readNativeEvidence } from './real-native-evidence.js'

test('Native exec evidence reads literal templates without evaluating dynamic or tagged scripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-template-evidence-'))
  try {
    const path = join(root, 'native.jsonl')
    const command = 'node -e "console.log(\'marker\\n\')"'
    const scripts = [
      'await tools.exec_command({cmd: `' + command.replaceAll('\\', '\\\\') + '`});',
      'await tools.exec_command({cmd: `unproven ${globalThis.mustNotExecute()}`});',
      'await tools.exec_command({cmd: String.raw`unproven`});',
      'text("tools.exec_command({cmd: \'quoted prompt\'})");',
    ]
    await writeFile(
      path,
      scripts
        .map((input, index) =>
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'custom_tool_call', name: 'exec', call_id: `call-${index}`, input },
          }),
        )
        .join('\n') + '\n',
    )
    const evidence = await readNativeEvidence(path)
    expect(evidence.shellCommands).toEqual([command])
    expect(evidence.commandCalls).toEqual([{ command, callId: 'call-0' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// Counter mechanics only; these synthetic records never count as business evidence.
test('Native user-input counts exclude tool results, side chains and zero-query seeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-evidence-mechanics-'))
  try {
    const path = join(root, 'native.jsonl')
    const user = {
      type: 'user',
      sessionId: 'owned',
      uuid: 'accepted-request',
      message: {
        content: [
          {
            type: 'text',
            text: serializeAgentPromptEnvelope({
              version: 'pact-agent-prompt-v1',
              sessionId: 'owned',
              message: { id: 'accepted-message', content: 'accepted task shape' },
              comments: [],
            }),
          },
        ],
      },
    }
    await writeFile(
      path,
      [
        user,
        user,
        { ...user, message: { content: [{ type: 'tool_result', content: 'command result' }] } },
        {
          ...user,
          uuid: 'seed-request',
          message: { content: 'Frozen source: ' + JSON.stringify(user.message.content) },
        },
        { ...user, isSidechain: true },
        { ...user, shouldQuery: false },
        { type: 'event_msg', payload: { type: 'task_started' } },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n',
    )
    const facts = await readNativeEvidence(path)
    expect(facts.claudeUserInputs).toBe(1)
    expect(facts.codexModelStarts).toBe(1)
    expect(facts.nativeIds).toEqual(new Set(['owned']))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Native configuration and Bash evidence comes from execution records, not user text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-evidence-mechanics-'))
  try {
    const path = join(root, 'native.jsonl')
    await writeFile(
      path,
      [
        {
          type: 'user',
          message: { content: JSON.stringify({ quotedAnswer: 'Generated answer\nwith "quotes"' }) },
        },
        { type: 'user', message: { content: 'Bash: print an effort, model=pretend' } },
        {
          type: 'assistant',
          message: {
            model: 'actual-assistant',
            content: [{ type: 'tool_use', name: 'Bash', input: { command: 'printf actual' } }],
          },
        },
        {
          type: 'turn_context',
          payload: { turn_id: 'native-turn', model: 'actual-codex', effort: 'high' },
        },
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'printf second' }),
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            input:
              'const r = await tools.exec_command({cmd: "printf third", yield_time_ms: 30000}); text(r.output)',
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    )
    const facts = await readNativeEvidence(path)
    expect(facts.containsText('Generated answer\nwith "quotes"')).toBe(true)
    expect(facts.assistantModels).toEqual(['actual-assistant'])
    expect(facts.shellCommands).toEqual(['printf actual', 'printf second', 'printf third'])
    expect(facts.toolNames).toEqual(['Bash', 'function_call:exec_command', 'custom_tool_call:exec'])
    expect(facts.commandCalls).toContainEqual({ command: 'printf third', yieldTimeMs: 30000 })
    expect(facts.codexTurnSettings).toEqual([
      { turnId: 'native-turn', model: 'actual-codex', effort: 'high' },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
