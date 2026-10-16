import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { serializeAgentPromptEnvelope } from '../../packages/agent-runtime/src/index.js'
import { readCodexNativeDefaults, readNativeEvidence } from './real-native-evidence.js'

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
      {
        turnId: 'native-turn',
        model: 'actual-codex',
        effort: 'high',
        effortSource: 'effort',
        effortFields: {
          effort: { present: true, value: 'high' },
          reasoning_effort: { present: false },
        },
      },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Native turn-context evidence preserves omitted, explicit None and named effort fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-native-settings-evidence-'))
  try {
    const path = join(root, 'native.jsonl')
    const records = [
      {},
      { effort: null },
      { reasoning_effort: null },
      { effort: null, reasoning_effort: null },
      { effort: 'none' },
      { reasoning_effort: 'high' },
      { effort: 'model-defined-custom', reasoning_effort: 'model-defined-custom' },
    ]
    await writeFile(
      path,
      records
        .map((fields, index) =>
          JSON.stringify({
            type: 'turn_context',
            payload: { turn_id: `native-turn-${index}`, model: 'actual-codex', ...fields },
          }),
        )
        .join('\n') + '\n',
    )
    const facts = await readNativeEvidence(path)
    expect(facts.codexTurnSettings).toEqual([
      {
        turnId: 'native-turn-0',
        model: 'actual-codex',
        effort: null,
        effortSource: 'omitted',
        effortFields: { effort: { present: false }, reasoning_effort: { present: false } },
      },
      {
        turnId: 'native-turn-1',
        model: 'actual-codex',
        effort: null,
        effortSource: 'effort',
        effortFields: {
          effort: { present: true, value: null },
          reasoning_effort: { present: false },
        },
      },
      {
        turnId: 'native-turn-2',
        model: 'actual-codex',
        effort: null,
        effortSource: 'reasoning_effort',
        effortFields: {
          effort: { present: false },
          reasoning_effort: { present: true, value: null },
        },
      },
      {
        turnId: 'native-turn-3',
        model: 'actual-codex',
        effort: null,
        effortSource: 'both',
        effortFields: {
          effort: { present: true, value: null },
          reasoning_effort: { present: true, value: null },
        },
      },
      {
        turnId: 'native-turn-4',
        model: 'actual-codex',
        effort: 'none',
        effortSource: 'effort',
        effortFields: {
          effort: { present: true, value: 'none' },
          reasoning_effort: { present: false },
        },
      },
      {
        turnId: 'native-turn-5',
        model: 'actual-codex',
        effort: 'high',
        effortSource: 'reasoning_effort',
        effortFields: {
          effort: { present: false },
          reasoning_effort: { present: true, value: 'high' },
        },
      },
      {
        turnId: 'native-turn-6',
        model: 'actual-codex',
        effort: 'model-defined-custom',
        effortSource: 'both',
        effortFields: {
          effort: { present: true, value: 'model-defined-custom' },
          reasoning_effort: { present: true, value: 'model-defined-custom' },
        },
      },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Native evidence rejects malformed or conflicting effort fields instead of treating them as None', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-native-invalid-settings-'))
  try {
    const fields = [
      { effort: false },
      { effort: 0 },
      { effort: [] },
      { effort: {} },
      { effort: '' },
      { effort: '\n' },
      { effort: 'x'.repeat(241) },
      { reasoning_effort: 0 },
      { effort: false, reasoning_effort: 'high' },
      { effort: 'high', reasoning_effort: false },
      { effort: 'high', reasoning_effort: 'low' },
      { effort: null, reasoning_effort: 'high' },
      { effort: 'high', reasoning_effort: null },
    ]
    for (const [index, invalid] of fields.entries()) {
      const path = join(root, `invalid-${index}.jsonl`)
      // oxlint-disable-next-line no-await-in-loop -- Keep one bounded Native evidence read active and settled before cleanup.
      await writeFile(
        path,
        JSON.stringify({
          type: 'turn_context',
          payload: { turn_id: 'native-turn', model: 'actual-codex', ...invalid },
        }) + '\n',
      )
      // oxlint-disable-next-line no-await-in-loop -- A failed assertion must not leave sibling reads racing cleanup.
      await expect(readNativeEvidence(path)).rejects.toThrow(/Invalid Native|Conflicting Native/u)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Native settings observation rejects an invalid context structure or model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-native-invalid-context-'))
  try {
    const payloads = [null, [], {}, { model: null }, { model: '' }, { model: false }]
    for (const [index, payload] of payloads.entries()) {
      const path = join(root, `invalid-${index}.jsonl`)
      // oxlint-disable-next-line no-await-in-loop -- Keep this synthetic file and read under one settled owner.
      await writeFile(path, JSON.stringify({ type: 'turn_context', payload }) + '\n')
      // oxlint-disable-next-line no-await-in-loop -- A failed assertion must not leave sibling reads racing cleanup.
      await expect(readNativeEvidence(path)).rejects.toThrow(/Malformed Native|Invalid Native/u)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Native config/read ACK reports actual nullable or named defaults without retaining private fields', () => {
  expect(
    readCodexNativeDefaults({
      result: {
        config: { model: 'actual-codex', model_reasoning_effort: null, unrelated: 'do-not-retain' },
      },
    }),
  ).toEqual({
    model: 'actual-codex',
    effort: { source: 'model_reasoning_effort', present: true, value: null },
  })
  expect(
    readCodexNativeDefaults({
      result: { config: { model: null, model_reasoning_effort: 'model-defined-custom' } },
    }),
  ).toEqual({
    model: null,
    effort: { source: 'model_reasoning_effort', present: true, value: 'model-defined-custom' },
  })
  expect(
    readCodexNativeDefaults({
      result: { config: { model: 'actual-codex', model_reasoning_effort: 'none' } },
    }).effort.value,
  ).toBe('none')
})

test('Native default evidence requires a successful ACK with present, valid settings fields', () => {
  const valid = { model: 'actual-codex', model_reasoning_effort: null }
  const invalidReplies = [
    null,
    {},
    { config: valid },
    { result: null },
    { result: { config: [] } },
    { error: { code: -1, message: 'synthetic rejection' }, result: { config: valid } },
    { result: { config: { model: 'actual-codex' } } },
    { result: { config: { model_reasoning_effort: null } } },
    { result: { config: { ...valid, model: undefined } } },
    { result: { config: { ...valid, model: '' } } },
    ...[undefined, false, 0, [], {}, '', '\n', 'x'.repeat(241)].map((value) => ({
      result: { config: { ...valid, model_reasoning_effort: value } },
    })),
  ]
  for (const reply of invalidReplies)
    expect(() => readCodexNativeDefaults(reply)).toThrow(/Native config\/read|Invalid Native/u)
})
