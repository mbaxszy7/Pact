import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

import { serializeAgentPromptEnvelope } from '../../packages/agent-runtime/src/index.js'
import {
  sourceReadDiagnosticSchema,
  sourceReadCallIdentity,
} from '../../packages/contracts/src/diagnostics.js'
import {
  collaborationSourceReadSchema,
  collaborationSourceNativeReadSchema,
  collaborationSourceWireResultSchema,
} from '../../packages/contracts/src/index.js'
import { assembleFrozenBatch } from './frozen-batch-evidence.js'
import {
  nativeByteLimit,
  readCodexNativeDefaults,
  readNativeEvidence,
  readNativeSourceEvidence,
} from './real-native-evidence.js'
import {
  inspectRoutingSourceRecords,
  routingNativeSourceEvidence,
  retainRoutingNativeSourceEvidence,
} from './relay-routing-native-source-evidence.js'
import {
  routingBenefitSummary,
  emitRoutingEvidence,
  correlateSourceReadFailures,
  routingSafeLogPhases,
} from './relay-routing-real-observation.js'
import { sourceReadFailureScript } from './source-read-failure-diagnostics.js'

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

test.each(['single-line', 'multiline-unicode'])(
  'Native syntax failure keeps safe location facts and still rejects before cleanup: %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-native-syntax-facts-')),
      secret = 'controlled-private-source-grant-never-export',
      input =
        mode === 'single-line'
          ? `const value = {sourceReference:${JSON.stringify(secret)} offset:0}`
          : `const value = {\nsourceReference:${JSON.stringify(secret + ' 🐈 中文')}\noffset:0}`
    try {
      const path = join(root, 'native.jsonl')
      await writeFile(
        path,
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            namespace: 'functions',
            name: 'exec',
            call_id: 'syntax-call',
            input,
          },
        }) + '\n',
      )
      const failure: unknown = await readNativeEvidence(path).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(SyntaxError)
      if (!(failure instanceof SyntaxError)) throw Error('Expected strict native syntax rejection')
      const message = failure.message
      expect(Buffer.byteLength(message)).toBeLessThanOrEqual(2048)
      expect(message).not.toContain(input)
      expect(message).not.toContain(secret)
      expect(message).not.toContain('🐈')
      const facts = JSON.parse(message.slice(message.indexOf('{')))
      expect(facts).toMatchObject({
        version: 'pact-native-script-syntax-v1',
        inputSha256: createHash('sha256').update(input).digest('hex'),
        inputUtf8Bytes: Buffer.byteLength(input),
        reasonCode: 'UnexpectedToken',
        rawScriptOrParserMessageRetained: false,
      })
      expect(facts.offset).toBeGreaterThan(0)
      expect(facts.line).toBeGreaterThanOrEqual(1)
      expect(facts.characters.length).toBeGreaterThan(0)
      expect(facts.characters.length).toBeLessThanOrEqual(17)
      expect(Reflect.get(failure, 'cause')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

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

// Synthetic regression for the observed Codex 0.163 CodeMode record shape, never model evidence.
const evidenceSha = (value: string) => createHash('sha256').update(value).digest('hex')
const evidenceResponse = (payload: Record<string, unknown>) => ({ type: 'response_item', payload })
const isEvidenceRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
function requiredEvidenceRecord(value: unknown) {
  if (!isEvidenceRecord(value)) throw Error('Expected a synthetic Native record object')
  return value
}

function routingCodeModeFixture() {
  const comment = 'A complete frozen Comment 原文.',
    sessionId = randomUUID(),
    expected = {
      runId: randomUUID(),
      batchId: randomUUID(),
      commentId: randomUUID(),
      commentSha256: evidenceSha(comment),
      nativeSessionId: randomUUID(),
      nativeTurnId: randomUUID(),
    },
    grant = randomUUID(),
    document = {
      id: randomUUID(),
      sha256: expected.commentSha256,
      bytes: Buffer.byteLength(comment),
      chars: comment.length,
    },
    batch = { id: expected.batchId, revision: 0, memberCount: 1 },
    prompt = serializeAgentPromptEnvelope({
      version: 'pact-agent-prompt-v1',
      targetAgentId: 'codex',
      sessionId,
      sourceGrant: { runId: expected.runId, grant },
      inputBatchRef: batch,
      message: { id: randomUUID(), content: 'Read the frozen source.' },
      comments: [],
    }),
    metadata = { turn_id: expected.nativeTurnId },
    input = `const value = await tools.reader({ grant: ${JSON.stringify(grant)} }); text(value);`,
    completed = (item: Record<string, unknown>) => ({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: expected.nativeSessionId,
        turn_id: expected.nativeTurnId,
        item,
      },
    }),
    sourcePage = (source: 'batch' | 'document', text: string) =>
      completed({
        type: 'McpToolCall',
        id: `exec-${source}`,
        server: `pact_peer_${'a'.repeat(32)}`,
        tool: 'read_collaboration_source',
        status: 'completed',
        readOnlyHint: true,
        arguments: {
          runId: expected.runId,
          grant,
          source,
          offset: 0,
          ...(source === 'batch' ? { batchId: expected.batchId } : { document }),
        },
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                source,
                text,
                offset: 0,
                nextOffset: null,
                ...(source === 'document' ? { document } : {}),
              }),
            },
          ],
        },
      }),
    records = [
      evidenceResponse({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      }),
      completed({ type: 'UserMessage', content: [{ type: 'text', text: prompt }] }),
      evidenceResponse({
        type: 'custom_tool_call',
        name: 'exec',
        namespace: 'functions',
        call_id: 'code-wrapper',
        input,
        internal_chat_message_metadata_passthrough: metadata,
      }),
      sourcePage(
        'batch',
        JSON.stringify({
          batch: { ...batch, sessionId, sequence: 1, commentsRevision: 0 },
          members: [
            {
              memberId: expected.commentId,
              ordinal: 0,
              commentId: expected.commentId,
              revision: 0,
              anchorDocument: document,
              body: document,
              state: 'pending_response',
            },
          ],
          hasMore: false,
          nextOrdinal: 0,
        }),
      ),
      sourcePage('document', comment),
      evidenceResponse({
        type: 'custom_tool_call_output',
        call_id: 'code-wrapper',
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
        ],
        internal_chat_message_metadata_passthrough: metadata,
      }),
      completed({ type: 'AgentMessage', phase: 'final_answer' }),
    ]
  return { records, expected, grant, input, sha: evidenceSha, completed }
}

function routingBatchBodyFixture() {
  const f = routingCodeModeFixture(),
    body = 'The complete current input 正文🙂.',
    document = {
      id: randomUUID(),
      sha256: evidenceSha(body),
      bytes: Buffer.byteLength(body),
      chars: body.length,
    },
    indexItem = requiredEvidenceRecord(f.records[3]!.payload['item']),
    indexResult = requiredEvidenceRecord(indexItem['result']),
    indexContent = indexResult['content']
  if (!Array.isArray(indexContent)) throw Error('Synthetic index content unavailable')
  const block = requiredEvidenceRecord(indexContent[0]),
    indexPage = requiredEvidenceRecord(JSON.parse(String(block['text']))),
    index = requiredEvidenceRecord(JSON.parse(String(indexPage['text'])))
  index['body'] = document
  indexPage['text'] = JSON.stringify(index)
  block['text'] = JSON.stringify(indexPage)
  const bodyReceipt = (
    text: string,
    offset: number,
    nextOffset: number | null,
    reference = document,
  ) => {
    const leaf = structuredClone(f.records[4]!),
      item = requiredEvidenceRecord(leaf.payload['item']),
      args = requiredEvidenceRecord(item['arguments'])
    item['id'] = `current-input-body-${randomUUID()}`
    args['document'] = reference
    args['offset'] = offset
    item['result'] = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            source: 'document',
            document: reference,
            offset,
            nextOffset,
            text,
          }),
        },
      ],
    }
    return leaf
  }
  return { ...f, body, document, bodyReceipt, index, indexPage, block }
}

test.each([
  'complete',
  'missing',
  'corrupt',
  'incomplete',
  'wrong-input-hash',
  'other-document',
  'wrong-reference-metadata',
] as const)(
  'Batch body proof requires its own exact authenticated document receipts: %s',
  (mode) => {
    const f = routingBatchBodyFixture(),
      reference =
        mode === 'other-document'
          ? { ...f.document, id: randomUUID() }
          : mode === 'wrong-reference-metadata'
            ? { ...f.document, bytes: f.document.bytes + 1 }
            : f.document
    if (mode !== 'missing')
      f.records.splice(
        5,
        0,
        f.bodyReceipt(
          mode === 'corrupt' ? `${f.body}x` : f.body,
          0,
          mode === 'incomplete' ? f.body.length : null,
          reference,
        ),
      )
    const result = inspectRoutingSourceRecords(f.records, {
      ...f.expected,
      batchBodySha256: mode === 'wrong-input-hash' ? 'f'.repeat(64) : f.document.sha256,
    })
    expect(result.allToolsAllowed && result.completeBatch && result.completeComment).toBe(true)
    expect(result.completeBatchBody).toBe(mode === 'complete')
    expect(result.boundaryDiagnostics).toMatchObject({
      bodyReferencePresent: true,
      bodyReferenceExpectedShaMatched: mode !== 'wrong-input-hash',
      exactBodyDocumentCallCount: [
        'missing',
        'other-document',
        'wrong-reference-metadata',
      ].includes(mode)
        ? 0
        : 1,
      authenticatedBodyPageCount: [
        'missing',
        'other-document',
        'wrong-reference-metadata',
      ].includes(mode)
        ? 0
        : 1,
      bodyReadOutcome:
        mode === 'complete'
          ? 'complete'
          : ['missing', 'other-document', 'wrong-reference-metadata'].includes(mode)
            ? 'document_not_called'
            : mode === 'incomplete'
              ? 'incomplete_page_chain'
              : mode === 'wrong-input-hash'
                ? 'reference_hash_mismatch'
                : 'content_mismatch',
    })
  },
)

test.each(['complete', 'gap', 'overlap'] as const)(
  'Batch body proves continuous Unicode pages: %s',
  (mode) => {
    const f = routingBatchBodyFixture(),
      split = f.body.length - 3
    f.records.splice(
      5,
      0,
      f.bodyReceipt(f.body.slice(0, split), 0, split),
      f.bodyReceipt(
        f.body.slice(split),
        mode === 'gap' ? split + 1 : mode === 'overlap' ? split - 1 : split,
        null,
      ),
    )
    const result = inspectRoutingSourceRecords(f.records, {
      ...f.expected,
      batchBodySha256: f.document.sha256,
    })
    expect(result.completeBatchBody).toBe(mode === 'complete')
  },
)

test('Batch body reference cannot change between authenticated index pages', () => {
  const f = routingBatchBodyFixture(),
    second = structuredClone(f.records[3]!),
    item = requiredEvidenceRecord(second.payload['item']),
    args = requiredEvidenceRecord(item['arguments'])
  requiredEvidenceRecord(f.index['batch'])['memberCount'] = 2
  f.index['hasMore'] = true
  const members = f.index['members']
  if (!Array.isArray(members)) throw Error('Missing complete source members')
  const otherId = randomUUID()
  const secondIndex = {
    ...f.index,
    hasMore: false,
    nextOrdinal: 1,
    members: [
      { ...requiredEvidenceRecord(members[0]), memberId: otherId, commentId: otherId, ordinal: 1 },
    ],
    body: { ...f.document, id: randomUUID() },
  }
  for (const ordinal of [0, 1]) {
    const owner =
      ordinal === 0
        ? requiredEvidenceRecord(f.records[ordinal]!.payload)
        : requiredEvidenceRecord(f.records[ordinal]!.payload['item'])
    const content = owner['content']
    if (!Array.isArray(content)) throw Error('Missing source root')
    const block = requiredEvidenceRecord(content[0]),
      text = String(block['text'])
    const split = text.indexOf('\n', text.indexOf('Pact context (JSON reference data;')) + 1
    const context = requiredEvidenceRecord(JSON.parse(text.slice(split)))
    requiredEvidenceRecord(context['inputBatchRef'])['memberCount'] = 2
    block['text'] = text.slice(0, split) + JSON.stringify(context)
  }
  item['id'] = 'second-batch-index'
  args['offset'] = 1
  item['result'] = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          source: 'batch',
          offset: 1,
          nextOffset: null,
          text: JSON.stringify(secondIndex),
        }),
      },
    ],
  }
  f.indexPage['nextOffset'] = 1
  f.indexPage['text'] = JSON.stringify(f.index)
  f.block['text'] = JSON.stringify(f.indexPage)
  f.records.splice(4, 0, second)
  expect(() => inspectRoutingSourceRecords(f.records, f.expected)).toThrow(
    'Batch body reference changed',
  )
})

test('routing source evidence binds CodeMode leaf receipts to the current native root and ordered wrapper', () => {
  const f = routingCodeModeFixture(),
    facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts).toMatchObject({
    sourceToolCalls: 2,
    genericToolCallCount: 1,
    allToolsAllowed: true,
    sourceGrantMatched: true,
    completeBatch: true,
    completeComment: true,
    commentSha256: f.expected.commentSha256,
  })
  expect(facts.codeModeScripts).toEqual([
    {
      sha256: f.sha(f.input),
      bytes: Buffer.byteLength(f.input),
      syntaxAudited: true,
      nativeCompleted: true,
      classification: 'source_operations',
      admissible: true,
      sourceToolDiscovery: false,
      sanitizedInput: null,
    },
  ])
  expect(JSON.stringify(facts)).not.toContain(f.grant)
})

test.each(['other-tool', 'missing-native-input', 'second-reader'] as const)(
  'Source-only diagnostics explain the rejected %s predicate without accepting it',
  (kind) => {
    const f = routingCodeModeFixture()
    if (kind === 'other-tool') {
      const extra = structuredClone(f.records[4]!),
        item = requiredEvidenceRecord(extra.payload['item'])
      item['id'] = 'controlled-metadata-call'
      item['tool'] = 'publish_session_title'
      item['arguments'] = { title: 'CONTROLLED_METADATA' }
      item['result'] = { content: [{ type: 'text', text: 'CONTROLLED_RESULT' }] }
      f.records.splice(5, 0, extra)
    } else if (kind === 'missing-native-input') f.records.splice(1, 1)
    else
      requiredEvidenceRecord(f.records[4]!.payload['item'])['server'] =
        `pact_peer_${'b'.repeat(32)}`
    const facts = inspectRoutingSourceRecords(f.records, f.expected)
    expect(facts.allToolsAllowed).toBe(false)
    expect(facts.sourceGrantMatched && facts.completeBatch && facts.completeComment).toBe(true)
    expect(facts.boundaryDiagnostics).toMatchObject({
      ledgerValid: true,
      reasons: [],
      toolScope: {
        totalCalls: kind === 'other-tool' ? 3 : 2,
        sourceCalls: 2,
        sourceReaders: kind === 'second-reader' ? 2 : 1,
        nativeInputObserved: kind !== 'missing-native-input',
        openWrapper: false,
        nonSourceCalls:
          kind === 'other-tool'
            ? [
                {
                  kind: 'publish_session_title',
                  nameSha256: evidenceSha(
                    `mcp__pact_peer_${'a'.repeat(32)}__publish_session_title`,
                  ),
                },
              ]
            : [],
        omittedNonSourceCalls: 0,
      },
    })
    expect(JSON.stringify(facts)).not.toContain('CONTROLLED_METADATA')
    expect(JSON.stringify(facts)).not.toContain('CONTROLLED_RESULT')
  },
)

/** Every record is synthetic counter evidence; none is real-model business evidence. */
function multiCommandSourceFixture() {
  const f = routingBatchBodyFixture(),
    records = structuredClone(f.records.slice(0, 2)),
    starts: number[] = [],
    outputs: number[] = [],
    scripts: string[] = []
  let lateBody = -1
  for (let index = 0; index < 4; index++) {
    const start = structuredClone(f.records[2]!),
      input = `${f.input}\n/* ${'bounded source audit '.repeat(150)} */`,
      id = `multi-source-${index}`
    requiredEvidenceRecord(start.payload)['call_id'] = id
    requiredEvidenceRecord(start.payload)['input'] = input
    starts.push(records.length)
    scripts.push(input)
    records.push(start)
    for (const ordinal of [3, 4]) {
      const receipt = structuredClone(f.records[ordinal]!)
      requiredEvidenceRecord(receipt.payload['item'])['id'] = `multi-leaf-${index}-${ordinal}`
      records.push(receipt)
    }
    if (index === 3) {
      lateBody = records.length
      records.push(f.bodyReceipt(f.body, 0, null))
    }
    const output = structuredClone(f.records[5]!)
    requiredEvidenceRecord(output.payload)['call_id'] = id
    outputs.push(records.length)
    records.push(output)
  }
  records.push(structuredClone(f.records.at(-1)!))
  return {
    ...f,
    records,
    starts,
    outputs,
    scripts,
    lateBody,
    expected: { ...f.expected, batchBodySha256: f.document.sha256 },
  }
}

test('multi-command source audit covers the whole Root beyond eight KiB without retaining script text', () => {
  const f = multiCommandSourceFixture(),
    facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(f.scripts.every((script) => Buffer.byteLength(script) <= 8192)).toBe(true)
  expect(f.scripts.reduce((bytes, script) => bytes + Buffer.byteLength(script), 0)).toBeGreaterThan(
    8192,
  )
  expect(facts).toMatchObject({
    allToolsAllowed: true,
    sourceGrantMatched: true,
    completeBatch: true,
    completeBatchBody: true,
    completeComment: true,
    codeModeScriptAudit: {
      scripts: 4,
      retainedRawScriptBytes: 0,
      diagnosticScriptTextBytes: 0,
      totalUtf8Bytes: f.scripts.reduce((bytes, script) => bytes + Buffer.byteLength(script), 0),
    },
  })
  expect(facts.codeModeScripts.map((script) => script.sha256)).toEqual(f.scripts.map(evidenceSha))
  expect(
    facts.codeModeScripts.every((script) => script.syntaxAudited && script.sanitizedInput === null),
  ).toBe(true)
  expect(facts.codeModeScriptAudit.inputUtf8HighWaterBytes).toBeLessThanOrEqual(8192)
  expect(facts.codeModeScriptAudit.proofMetadataHighWaterBytes).toBeLessThanOrEqual(64 * 1024)
  expect(facts.codeModeScriptAudit.parsedAstObjectHighWater).toBeLessThanOrEqual(10_000)
  expect(facts.codeModeScriptAudit.parsedAstStringUtf16PayloadHighWaterBytes).toBeLessThanOrEqual(
    512 * 1024,
  )
})

test.each([
  'failed-leaf',
  'foreign-root',
  'wrong-grant',
  'unknown-operation',
  'missing-completion',
  'missing-page',
  'invalid-script',
] as const)(
  'multi-command source audit still rejects %s after the former cumulative boundary',
  (fault) => {
    const f = multiCommandSourceFixture(),
      leaf = requiredEvidenceRecord(f.records[f.lateBody]!.payload['item'])
    if (fault === 'failed-leaf') {
      leaf['status'] = 'failed'
      leaf['result'] = { isError: true, content: [{ type: 'text', text: 'Validation rejected.' }] }
    }
    if (fault === 'foreign-root') f.records[f.lateBody]!.payload['thread_id'] = randomUUID()
    if (fault === 'wrong-grant') requiredEvidenceRecord(leaf['arguments'])['grant'] = randomUUID()
    if (fault === 'unknown-operation') leaf['tool'] = 'publish_session_title'
    if (fault === 'missing-completion') f.records.splice(f.outputs.at(-1)!, 1)
    if (fault === 'missing-page') {
      const result = requiredEvidenceRecord(leaf['result']),
        content = result['content']
      if (!Array.isArray(content)) throw Error('Missing controlled source page')
      requiredEvidenceRecord(content[0])['text'] = JSON.stringify({
        source: 'document',
        document: f.document,
        offset: 0,
        nextOffset: 4,
        text: f.body.slice(0, 4),
      })
    }
    if (fault === 'invalid-script')
      requiredEvidenceRecord(f.records[f.starts.at(-1)!]!.payload)['input'] = 'await ('
    const facts = inspectRoutingSourceRecords(f.records, f.expected)
    expect(facts.codeModeScripts).toHaveLength(4)
    expect(
      facts.allToolsAllowed &&
        facts.sourceGrantMatched &&
        facts.completeBatch &&
        facts.completeBatchBody &&
        facts.completeComment,
    ).toBe(false)
  },
)

test('multi-command source audit keeps the original per-command, record and command-count limits', () => {
  const oversized = multiCommandSourceFixture()
  requiredEvidenceRecord(oversized.records[oversized.starts[0]!]!.payload)['input'] = 'x'.repeat(
    8193,
  )
  expect(() => inspectRoutingSourceRecords(oversized.records, oversized.expected)).toThrow(
    'Native command arguments exceed 8 KiB',
  )
  expect(() =>
    inspectRoutingSourceRecords(
      Array.from({ length: 10_001 }, () => ({})),
      oversized.expected,
    ),
  ).toThrow('Native records exceed 10000')
  const f = multiCommandSourceFixture(),
    metadata = { turn_id: f.expected.nativeTurnId }
  for (let index = 0; index < 253; index++)
    f.records.splice(
      f.records.length - 1,
      0,
      evidenceResponse({
        type: 'custom_tool_call',
        name: 'exec',
        namespace: 'functions',
        call_id: `discovery-${index}`,
        input:
          'const xs=ALL_TOOLS.filter(x=>x.name.includes("read_collaboration_source"));text(xs);',
        internal_chat_message_metadata_passthrough: metadata,
      }),
      evidenceResponse({
        type: 'custom_tool_call_output',
        call_id: `discovery-${index}`,
        output: [{ type: 'input_text', text: 'Script completed\n' }],
        internal_chat_message_metadata_passthrough: metadata,
      }),
    )
  const finalOutput = f.records.splice(f.records.length - 2, 1)[0]!,
    finalStart = f.records.splice(f.records.length - 2, 1)[0]!
  const within = inspectRoutingSourceRecords(f.records, f.expected)
  expect(within).toMatchObject({
    allToolsAllowed: true,
    completeBatchBody: true,
    codeModeScriptAudit: { scripts: 256 },
  })
  expect(within.codeModeScriptAudit.proofMetadataHighWaterBytes).toBeLessThanOrEqual(64 * 1024)
  f.records.splice(f.records.length - 1, 0, finalStart, finalOutput)
  expect(() => inspectRoutingSourceRecords(f.records, f.expected)).toThrow(
    'command observation exceeded its bound',
  )
})

test('source audit refuses oversized identity metadata before encoding an unchecked copy', () => {
  const f = routingCodeModeFixture(),
    original = JSON.stringify.bind(JSON),
    stringify = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((value: unknown, ...rest: unknown[]) => {
        if (
          value &&
          typeof value === 'object' &&
          Object.hasOwn(value, 'wrappers') &&
          Object.hasOwn(value, 'wrapperDiagnostics')
        )
          throw Error('Unchecked metadata serialization')
        return Reflect.apply(original, JSON, [value, ...rest])
      })
  try {
    requiredEvidenceRecord(f.records[2]!.payload)['call_id'] = 'x'.repeat(96 * 1024)
    expect(() => inspectRoutingSourceRecords(f.records, f.expected)).toThrow(
      'Source script proof metadata exceeds 64 KiB',
    )
  } finally {
    stringify.mockRestore()
  }
})

test('multi-command source audit keeps the original owned Native file byte limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-source-audit-byte-limit-'))
  try {
    const f = multiCommandSourceFixture(),
      path = join(root, 'native.jsonl')
    await writeFile(path, f.records.map((record) => JSON.stringify(record)).join('\n'))
    const native = await readNativeEvidence(path)
    await writeFile(path, 'x'.repeat(nativeByteLimit + 1))
    const receipts: unknown[] = []
    await expect(
      retainRoutingNativeSourceEvidence(native, f.expected, async (receipt) => {
        receipts.push(receipt)
      }),
    ).rejects.toThrow('Native source inspection failed')
    expect(receipts).toMatchObject([{ status: 'unavailable' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each(['correct', 'wrong-run', 'missing'] as const)(
  'source seed %s is observed independently without changing the source acceptance gate',
  (mode) => {
    const f = routingCodeModeFixture()
    const roots = [
      requiredEvidenceRecord(f.records[0]!.payload)['content'],
      requiredEvidenceRecord(requiredEvidenceRecord(f.records[1]!.payload)['item'])['content'],
    ]
    for (const content of roots) {
      if (!Array.isArray(content)) throw Error('Expected controlled root content')
      for (const part of content) {
        const item = requiredEvidenceRecord(part),
          text = item['text']
        if (typeof text !== 'string') throw Error('Expected controlled prompt text')
        const start = text.indexOf('\n', text.indexOf('Pact context (JSON reference data;')) + 1
        const context = requiredEvidenceRecord(JSON.parse(text.slice(start)))
        if (mode === 'wrong-run')
          requiredEvidenceRecord(context['sourceReadArguments'])['runId'] = randomUUID()
        if (mode === 'missing') delete context['sourceReadArguments']
        item['text'] = text.slice(0, start) + JSON.stringify(context)
      }
    }
    const facts = inspectRoutingSourceRecords(f.records, f.expected)
    expect(facts.boundaryDiagnostics.rootSourceReadArgumentsMatched).toBe(
      mode === 'correct' ? true : mode === 'wrong-run' ? false : null,
    )
    expect(facts).toMatchObject({
      allToolsAllowed: true,
      sourceGrantMatched: true,
      completeBatch: true,
      completeComment: true,
    })
  },
)

test.each([
  'caught_command',
  'unknown_operation',
  'wrong_root',
  'wrong_turn',
  'failed_leaf',
  'foreign_server',
  'wrong_grant',
  'missing_leaf',
  'missing_output',
  'empty_wrapper',
  'foreign_wrapper',
  'wrong_output_id',
  'leaf_outside_wrapper',
  'is_error',
  'quoted_only',
  'unknown_response',
  'malformed_completed',
  'unmatched_output',
] as const)(
  'routing source evidence rejects CodeMode %s without evaluating wrapper code',
  (fault) => {
    const f = routingCodeModeFixture(),
      records: Array<{ type: string; payload: Record<string, unknown> }> = structuredClone(
        f.records,
      )
    const leaf = requiredEvidenceRecord(records[3]!.payload['item'])
    if (fault === 'caught_command' || fault === 'unknown_operation')
      records.splice(
        4,
        0,
        f.completed({
          type: fault === 'caught_command' ? 'CommandExecution' : 'UnknownToolOperation',
          id: 'caught-foreign',
          status: 'failed',
        }),
      )
    if (fault === 'wrong_root') records[3]!.payload['thread_id'] = randomUUID()
    if (fault === 'wrong_turn') records[3]!.payload['turn_id'] = randomUUID()
    if (fault === 'failed_leaf') leaf['status'] = 'failed'
    if (fault === 'foreign_server') leaf['server'] = 'unrelated_server'
    if (fault === 'wrong_grant') requiredEvidenceRecord(leaf['arguments'])['grant'] = randomUUID()
    if (fault === 'missing_leaf') records.splice(4, 1)
    if (fault === 'missing_output') records.splice(5, 1)
    if (fault === 'empty_wrapper') records.splice(3, 2)
    if (fault === 'foreign_wrapper') records[2]!.payload['namespace'] = 'foreign'
    if (fault === 'wrong_output_id') records[5]!.payload['call_id'] = 'unmatched-wrapper'
    if (fault === 'leaf_outside_wrapper') records.splice(2, 0, records.splice(3, 1)[0]!)
    if (fault === 'is_error') requiredEvidenceRecord(leaf['result'])['isError'] = true
    if (fault === 'unknown_response')
      records.splice(
        4,
        0,
        evidenceResponse({ type: 'web_search_call', id: 'foreign', status: 'completed' }),
      )
    if (fault === 'malformed_completed')
      records.splice(4, 0, { type: 'event_msg', payload: { type: 'item_completed' } })
    if (fault === 'unmatched_output')
      records.splice(
        4,
        0,
        evidenceResponse({
          type: 'function_call_output',
          call_id: 'unmatched',
          output: 'untrusted',
        }),
      )
    const facts = inspectRoutingSourceRecords(
      fault === 'quoted_only'
        ? [{ type: 'user', message: { content: JSON.stringify(records) } }]
        : records,
      f.expected,
    )
    expect(
      facts.allToolsAllowed &&
        facts.sourceGrantMatched &&
        facts.completeBatch &&
        facts.completeComment,
    ).toBe(false)
  },
)

test('routing source evidence rejects duplicate CodeMode leaf identities', () => {
  const f = routingCodeModeFixture()
  f.records.splice(4, 0, f.records[3]!)
  expect(() => inspectRoutingSourceRecords(f.records, f.expected)).toThrow(/identity was repeated/u)
})

test('routing source evidence rejects duplicate Native tool output identities', () => {
  const f = routingCodeModeFixture()
  f.records.splice(
    4,
    0,
    evidenceResponse({ type: 'function_call_output', call_id: 'unmatched', output: 'first' }),
    evidenceResponse({ type: 'function_call_output', call_id: 'unmatched', output: 'second' }),
  )
  expect(() => inspectRoutingSourceRecords(f.records, f.expected)).toThrow(
    /output identity was repeated/u,
  )
})

test('routing source evidence accepts the observed namespace-absent native exec frame', () => {
  const f = routingCodeModeFixture()
  delete requiredEvidenceRecord(f.records[2]!.payload)['namespace']
  expect(inspectRoutingSourceRecords(f.records, f.expected).allToolsAllowed).toBe(true)
})

function withSourceDiscovery(script: string) {
  const f = routingCodeModeFixture(),
    metadata = { turn_id: f.expected.nativeTurnId }
  f.records.splice(
    2,
    0,
    evidenceResponse({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'discovery',
      input: script,
      internal_chat_message_metadata_passthrough: metadata,
    }),
    evidenceResponse({
      type: 'custom_tool_call_output',
      call_id: 'discovery',
      output: [{ type: 'input_text', text: 'Script completed\n' }],
      internal_chat_message_metadata_passthrough: metadata,
    }),
  )
  return f
}

test('routing source evidence statically admits only reader metadata discovery before real source leaves', () => {
  const f = withSourceDiscovery(
      'const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(t);',
    ),
    result = inspectRoutingSourceRecords(f.records, f.expected)
  expect(result).toMatchObject({
    allToolsAllowed: true,
    sourceToolCalls: 2,
    genericToolCallCount: 2,
    completeBatch: true,
    completeComment: true,
    sourceGrantMatched: true,
  })
  expect(result.codeModeScripts[0]?.sourceToolDiscovery).toBe(true)
})

test('routing source evidence admits the observed literal metadata regex without invoking its listed tools', () => {
  const f = withSourceDiscovery(
      'const xs = ALL_TOOLS.filter(x => /read_collaboration_source|publish_session_title/i.test(x.name+" "+x.description)); text(xs);',
    ),
    result = inspectRoutingSourceRecords(f.records, f.expected)
  expect(result).toMatchObject({
    allToolsAllowed: true,
    sourceGrantMatched: true,
    completeBatch: true,
    completeComment: true,
  })
  expect(result.codeModeScripts[0]?.sourceToolDiscovery).toBe(true)
})

test.each([
  'const t = ALL_TOOLS.find(x => x.name.includes("read_collaboration_source")); text(t.description);',
  'const t = ALL_TOOLS.find(x => x.name.includes("read_collaboration_source")); if (!t) { text("read_collaboration_source unavailable"); exit(); } text(t.name);',
  'text(ALL_TOOLS.find(x => x.name.includes("read_collaboration_source")));',
])('routing source evidence statically validates reader find metadata %s', (script) => {
  const f = withSourceDiscovery(script)
  const facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.allToolsAllowed && facts.completeBatch && facts.completeComment).toBe(true)
  expect(facts.codeModeScripts[0]?.sourceToolDiscovery).toBe(true)
})

const nativeSourceRefusal =
  'Use the exact sourceGrant from the current root input. This request has no active matching source capability.'

function sourceRefusalFixture() {
  const f = routingCodeModeFixture(),
    rejected = structuredClone(f.records[3]!),
    item = requiredEvidenceRecord(rejected.payload['item']),
    args = requiredEvidenceRecord(item['arguments'])
  item['id'] = 'explicit-current-source-refusal'
  item['result'] = { isError: true, content: [{ type: 'text', text: nativeSourceRefusal }] }
  args['runId'] = f.expected.runId.slice(1)
  f.records.splice(4, 0, rejected)
  return { ...f, rejected, item, args }
}

test('an exact owned pre-read refusal remains visible without becoming a source receipt', () => {
  const f = sourceRefusalFixture(),
    facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts).toMatchObject({
    sourceToolCalls: 3,
    allToolsAllowed: false,
    sourceGrantMatched: true,
    completeBatch: true,
    completeComment: true,
    rejectedSourceReads: { other: 1 },
    sourceRejections: [
      {
        readerBoundToSuccessfulSource: true,
        nativeStatus: 'completed',
        outcome: 'capability_refused_before_source_read',
        requestedRunMatched: false,
        requestedGrantMatched: true,
      },
    ],
  })
})

test('source failure diagnostics retain the rejected wrapper boundary and argument shape without raw errors', () => {
  const f = routingCodeModeFixture(),
    rejected = structuredClone(f.records[3]!),
    item = requiredEvidenceRecord(rejected.payload['item']),
    args = requiredEvidenceRecord(item['arguments']),
    secret = 'private-native-error-and-grant-must-never-escape'
  item['id'] = 'diagnostic-validation-failure'
  item['status'] = 'failed'
  item['result'] = {
    isError: true,
    content: [{ type: 'text', text: `Input validation error: ${secret}` }],
  }
  args['document'] = { document: { secret } }
  f.records.splice(4, 0, rejected)
  const facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.allToolsAllowed).toBe(false)
  expect(facts.boundaryDiagnostics).toMatchObject({
    ledgerValid: false,
    reasons: ['mcp_leaf_boundary'],
    failedLeafCount: 1,
    failedLeaves: [
      {
        wrapper: 0,
        sameRoot: true,
        status: 'failed',
        arguments: { valid: false, documentKeys: ['document'] },
        result: { isError: true, validation: true },
      },
    ],
  })
  expect(JSON.stringify(facts.boundaryDiagnostics)).not.toContain(secret)
  expect(JSON.stringify(facts.boundaryDiagnostics)).not.toContain('Input validation error:')
})

test('rejected source grant relations retain only bounded hashes and equality facts', () => {
  const f = routingCodeModeFixture(),
    candidates = [
      f.expected.runId,
      f.expected.batchId,
      f.expected.commentId,
      '00000000-0000-0000-0000-000000000000',
    ]
  for (const [index, grant] of candidates.entries()) {
    const rejected = structuredClone(f.records[3]!),
      item = requiredEvidenceRecord(rejected.payload['item']),
      args = requiredEvidenceRecord(item['arguments'])
    item['id'] = `rejected-grant-relation-${index}`
    item['status'] = 'failed'
    item['result'] = { isError: true, content: [{ type: 'text', text: 'validation error' }] }
    args['grant'] = grant
    f.records.splice(4 + index, 0, rejected)
  }
  const facts = inspectRoutingSourceRecords(f.records, f.expected),
    relations = facts.boundaryDiagnostics.failedLeaves.map((leaf) => leaf.requestedGrantRelations)
  expect(facts.allToolsAllowed).toBe(false)
  expect(facts.boundaryDiagnostics.failedLeafCount).toBe(4)
  for (const [index, grant] of candidates.entries()) {
    expect(relations[index]).toMatchObject({
      sha256: createHash('sha256').update(grant).digest('hex'),
      utf8Bytes: Buffer.byteLength(grant),
      matchesRunId: index === 0,
      matchesBatchId: index === 1,
      matchesCommentId: index === 2,
      isNilUuid: index === 3,
      matchesPriorRootGrant: null,
    })
    expect(JSON.stringify(relations)).not.toContain(grant)
  }
})

test.each(['top-level', 'nested'] as const)(
  'source failure diagnostics retain a %s RPC error code without the private message',
  (shape) => {
    const f = routingCodeModeFixture(),
      rejected = structuredClone(f.records[3]!),
      item = requiredEvidenceRecord(rejected.payload['item']),
      error = { code: -32603, message: 'private-rpc-message-must-not-escape' }
    item['id'] = 'diagnostic-rpc-code'
    item['status'] = 'failed'
    delete item['result']
    item['error'] = shape === 'top-level' ? error : { error }
    f.records.splice(4, 0, rejected)
    const facts = inspectRoutingSourceRecords(f.records, f.expected)
    expect(facts.allToolsAllowed).toBe(false)
    expect(facts.boundaryDiagnostics.failedLeaves[0]?.error).toMatchObject({ code: -32603 })
    expect(JSON.stringify(facts.boundaryDiagnostics)).not.toContain(error.message)
  },
)

test('an explicit refusal cannot establish reader ownership or fill missing complete sources', () => {
  const f = sourceRefusalFixture()
  f.records.splice(3, 3, f.rejected)
  const facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts).toMatchObject({
    allToolsAllowed: false,
    sourceGrantMatched: false,
    completeBatch: false,
    completeComment: false,
  })
})

test.each([
  'failed_status',
  'missing_result',
  'not_readonly',
  'foreign_root',
  'foreign_turn',
  'foreign_reader',
  'unknown_error',
  'extra_content',
  'extra_result_data',
] as const)('routing source refusal still rejects %s', (fault) => {
  const f = sourceRefusalFixture()
  if (fault === 'failed_status') f.item['status'] = 'failed'
  if (fault === 'missing_result') delete f.item['result']
  if (fault === 'not_readonly') f.item['readOnlyHint'] = false
  if (fault === 'foreign_root') f.rejected.payload['thread_id'] = randomUUID()
  if (fault === 'foreign_turn') f.rejected.payload['turn_id'] = randomUUID()
  if (fault === 'foreign_reader') f.item['server'] = `pact_peer_${'b'.repeat(32)}`
  const result = requiredEvidenceRecord(f.item['result'] ?? {})
  if (fault === 'unknown_error')
    result['content'] = [{ type: 'text', text: 'A generic native error is not a refusal proof.' }]
  if (fault === 'extra_content')
    result['content'] = [
      { type: 'text', text: nativeSourceRefusal },
      { type: 'text', text: 'Unverified additional data' },
    ]
  if (fault === 'extra_result_data') result['structuredContent'] = { accepted: true }
  expect(inspectRoutingSourceRecords(f.records, f.expected).allToolsAllowed).toBe(false)
})

test('routing metadata discovery accepts the observed pure JSON serialization without adding a tool', () => {
  const f = withSourceDiscovery(
    'const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(JSON.stringify(t));',
  )
  expect(inspectRoutingSourceRecords(f.records, f.expected)).toMatchObject({
    allToolsAllowed: true,
    sourceGrantMatched: true,
    completeBatch: true,
    completeComment: true,
  })
})

test.each([
  'const JSON = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(JSON.stringify(JSON));',
  'const t = ALL_TOOLS.filter(JSON => JSON.name.includes("read_collaboration_source")); text(JSON.stringify(t));',
  'const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(JSON["stringify"](t));',
  'const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(JSON?.stringify(t));',
  'const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(JSON.stringify?.(t));',
  'const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(JSON.stringify(t, null));',
  'const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(JSON.stringify(JSON.stringify(t)));',
  'const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(JSON.stringify(tools.other()));',
  'const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(globalThis.JSON.stringify(t));',
  'const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(JSON.parse(t));',
])('routing metadata serialization rejects any additional expression authority: %s', (script) => {
  const f = withSourceDiscovery(script)
  expect(inspectRoutingSourceRecords(f.records, f.expected).allToolsAllowed).toBe(false)
})

test('metadata discovery never authorizes a native metadata publication call', () => {
  const f = withSourceDiscovery(
      'const xs = ALL_TOOLS.filter(x => /read_collaboration_source|publish_session_title/i.test(x.name+" "+x.description)); text(xs);',
    ),
    leaf = structuredClone(f.records[5]!),
    item = requiredEvidenceRecord(leaf.payload['item'])
  item['id'] = 'unexpected-publication'
  item['tool'] = 'publish_session_title'
  f.records.splice(7, 0, leaf)
  const result = inspectRoutingSourceRecords(f.records, f.expected)
  expect(result.sourceGrantMatched && result.completeBatch && result.completeComment).toBe(true)
  expect(result.allToolsAllowed).toBe(false)
})

test('routing metadata discovery accepts the observed pure disjunction without allowing publication', () => {
  const f = withSourceDiscovery(
      'const xs = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source") || x.name.includes("publish_session_title")); text(xs);',
    ),
    accepted = inspectRoutingSourceRecords(f.records, f.expected)
  expect(accepted).toMatchObject({
    allToolsAllowed: true,
    sourceGrantMatched: true,
    completeBatch: true,
    completeComment: true,
  })
  const leaf = structuredClone(f.records[5]!),
    item = requiredEvidenceRecord(leaf.payload['item'])
  item['id'] = 'disjunction-does-not-authorize-publication'
  item['tool'] = 'publish_session_title'
  f.records.splice(7, 0, leaf)
  expect(inspectRoutingSourceRecords(f.records, f.expected).allToolsAllowed).toBe(false)
})

test.each([
  'x.name.includes("read_collaboration_source") || tools.other()',
  'tools.other() || x.name.includes("read_collaboration_source")',
  'x.name.includes("read_collaboration_source") || x["name"].includes("publish_session_title")',
  'x.name.includes("read_collaboration_source") || x.name.includes(tools.other())',
  'x.name.includes("read_collaboration_source") || (globalThis.changed = true)',
  'x.name.includes("read_collaboration_source") && x.name.includes("publish_session_title")',
  'x.name.includes("publish_session_title") || x.name.includes("other")',
])('routing metadata disjunction rejects additional authority: %s', (predicate) => {
  const f = withSourceDiscovery(`const xs = ALL_TOOLS.filter(x => ${predicate}); text(xs);`)
  expect(inspectRoutingSourceRecords(f.records, f.expected).allToolsAllowed).toBe(false)
})

test('a rejected current-root source read stays a failed gate even after complete source receipts', () => {
  const f = routingCodeModeFixture(),
    leaf = structuredClone(f.records[3]!),
    item = requiredEvidenceRecord(leaf.payload['item']),
    args = requiredEvidenceRecord(item['arguments'])
  item['id'] = 'rejected-workflow-inputs'
  item['result'] = { isError: true, content: [{ type: 'text', text: 'Scope unavailable' }] }
  args['source'] = 'inputs'
  f.records.splice(4, 0, leaf)
  const result = inspectRoutingSourceRecords(f.records, f.expected)
  expect(result.sourceGrantMatched && result.completeBatch && result.completeComment).toBe(true)
  expect(result.rejectedSourceReads).toEqual({
    document: 0,
    batch: 0,
    inputs: 1,
    handoff_sources: 0,
    other: 0,
  })
  expect(result.allToolsAllowed).toBe(false)
})

test.each([
  'const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(t); tools.other();',
  'const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(t); globalThis.changed = true;',
  'const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(t.constructor("return 1")());',
  'const t = ALL_TOOLS.filter(x => tools.other()); text(t);',
  'const t = ALL_TOOLS["filter"](x => x.name.includes("read_collaboration_source")); text(t);',
  '"unexpected directive"; const t = ALL_TOOLS.filter(x => x.name.includes("read_collaboration_source")); text(t);',
  'const t = ALL_TOOLS.filter(x => new RegExp("read_collaboration_source").test(x.name)); text(t);',
  'const t = ALL_TOOLS.filter(x => /read_collaboration_source/i.test(tools.other())); text(t);',
  'const t = ALL_TOOLS.filter(x => /read_collaboration_source/i.test(x["name"])); text(t);',
  'const t = ALL_TOOLS.filter(x => /read_collaboration_source/g.test(x.name)); text(t);',
  'const t = ALL_TOOLS.filter(x => /read_collaboration_source.*/i.test(x.name)); text(t);',
  'const t = ALL_TOOLS.filter(x => /publish_session_title/i.test(x.name)); text(t);',
  'const t = ALL_TOOLS.filter(x => /read_collaboration_source/i.test(x.name)); text(t); tools.publish_session_title({});',
  'const t = ALL_TOOLS.find(x => x.name.includes("read_collaboration_source")); text(t.constructor);',
  'const t = ALL_TOOLS.find(x => x.name.includes("read_collaboration_source")); text(t["name"]);',
  'const t = ALL_TOOLS.find(x => x.name.includes("read_collaboration_source")); if (!t) { tools.other(); exit(); } text(t.name);',
  'const t = ALL_TOOLS.find(x => x.name.includes("read_collaboration_source")); if (!t) { text("missing"); exit(tools.other()); } text(t.name);',
  'const t = ALL_TOOLS.find(x => x.name.includes("read_collaboration_source")); if (!t) { text("missing"); exit(); } else { tools.other(); } text(t.name);',
  'const exit = ALL_TOOLS.find(x => x.name.includes("read_collaboration_source")); text(exit);',
])('routing source evidence rejects arbitrary empty wrapper %s', (script) => {
  const f = withSourceDiscovery(script),
    result = inspectRoutingSourceRecords(f.records, f.expected)
  expect(result.completeBatch && result.completeComment && result.sourceGrantMatched).toBe(true)
  expect(result.allToolsAllowed).toBe(false)
})

test('routing usage keeps the last native values per source without summing cumulative counters', () => {
  const f = routingCodeModeFixture(),
    records = [
      ...f.records.slice(0, 3),
      {
        type: 'token_usage_record',
        usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
      },
      {
        type: 'token_usage_record',
        usage: { input_tokens: 17, output_tokens: 3, total_tokens: 20 },
        privateMetadata: 'not usage',
      },
      ...f.records.slice(3),
    ],
    result = inspectRoutingSourceRecords(records, f.expected)
  expect(result.allToolsAllowed).toBe(true)
  expect(result.nativeUsage.status).toBe('observed')
  expect(result.nativeUsage.lastBySource['codex.token_usage_record']?.values).toEqual({
    usage: { input_tokens: 17, output_tokens: 3, total_tokens: 20 },
  })
  expect(JSON.stringify(result.nativeUsage)).not.toContain('not usage')
})

test.each(['matching', 'wrong_thread', 'wrong_turn'] as const)(
  'routing usage projects native payload counters with %s scope',
  (scope) => {
    const f = routingCodeModeFixture(),
      base = { thread_id: f.expected.nativeSessionId, turn_id: f.expected.nativeTurnId },
      result = inspectRoutingSourceRecords(
        [
          ...f.records.slice(0, 3),
          {
            type: 'token_usage_record',
            payload: {
              ...base,
              usage: { input_tokens: 10 },
              turn_token_usage: { total_tokens: 20 },
              thread_token_usage: { total_tokens: 30 },
            },
          },
          {
            type: 'token_usage_record',
            payload: {
              ...base,
              thread_id: scope === 'wrong_thread' ? randomUUID() : base.thread_id,
              turn_id: scope === 'wrong_turn' ? randomUUID() : base.turn_id,
              usage: { input_tokens: 40 },
              turn_token_usage: { total_tokens: 50 },
              thread_token_usage: { total_tokens: 60 },
            },
          },
          ...f.records.slice(3),
        ],
        f.expected,
      )
    expect(result.nativeUsage.lastBySource['codex.token_usage_record']?.values).toEqual({
      usage: { input_tokens: scope === 'matching' ? 40 : 10 },
      turn_token_usage: { total_tokens: scope === 'matching' ? 50 : 20 },
      thread_token_usage: { total_tokens: scope === 'matching' ? 60 : 30 },
    })
  },
)

test('routing benefit references complete separately retained arms within the unchanged evidence budget', () => {
  const off = {
      manualRouteCorrections: 1,
      realBusinessTurns: 2,
      decisionCalls: 0,
      firstActualRecipient: 'claude',
      elapsedMs: 30,
      retainedNativeFacts: 'x'.repeat(12000),
    },
    on = {
      manualRouteCorrections: 0,
      realBusinessTurns: 1,
      decisionCalls: 1,
      firstActualRecipient: 'codex',
      elapsedMs: 20,
      retainedNativeFacts: 'y'.repeat(12000),
    },
    summary = routingBenefitSummary(off, on)
  expect(Buffer.byteLength(JSON.stringify({ off, on }))).toBeGreaterThan(16 * 1024)
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(16 * 1024)
  expect(summary).toMatchObject({ savedBusinessTurns: 1, savedManualCorrections: 1 })
  expect(summary.off.sha256).toBe(evidenceSha(JSON.stringify(off)))
  expect(summary.on.sha256).toBe(evidenceSha(JSON.stringify(on)))
  expect(summary.off.label).toBe('relay-routing-off')
  expect(summary.on.label).toBe('relay-routing-on')
  expect(JSON.stringify(summary)).not.toContain('retainedNativeFacts')
})

test.each([
  'complete',
  'missing-reference',
  'wrong-reference',
  'missing-read',
  'incomplete',
  'corrupt',
] as const)(
  'declared user information requires its own complete current-root document proof: %s',
  (mode) => {
    const f = routingBatchBodyFixture(),
      text = '{"question":"Which launch date?","state":"unanswered"}',
      document = {
        id: randomUUID(),
        sha256: f.sha(text),
        bytes: Buffer.byteLength(text),
        chars: text.length,
      }
    if (mode !== 'missing-reference')
      f.index['userInformation'] =
        mode === 'wrong-reference' ? { ...document, id: randomUUID() } : document
    f.indexPage['text'] = JSON.stringify(f.index)
    f.block['text'] = JSON.stringify(f.indexPage)
    if (mode !== 'missing-read')
      f.records.splice(
        5,
        0,
        f.bodyReceipt(
          mode === 'corrupt' ? `${text}x` : text,
          0,
          mode === 'incomplete' ? text.length : null,
          document,
        ),
      )
    const result = inspectRoutingSourceRecords(f.records, { ...f.expected, declaration: document })
    expect(result.allToolsAllowed).toBe(true)
    expect(result.completeDeclaredInformation).toBe(mode === 'complete')
  },
)

test.each([
  'complete',
  'mixed',
  'unprovided',
  'wrong-binding',
  'failed-leaf',
  'incomplete-body',
  'legacy-repeat',
  'batch-repeat',
] as const)(
  'reference source receipts preserve actual submission and reject %s evidence',
  (mode) => {
    const f = routingBatchBodyFixture()
    const reference = (value: unknown, signingKey = Buffer.alloc(32, 17)) => {
      const { offset: _offset, ...request } = collaborationSourceReadSchema.parse(value)
      if (request.runId !== f.expected.runId) throw Error('Foreign controlled signer root')
      const payload = Buffer.from(
        JSON.stringify({ version: 'pact-source-reference-v1', request }),
      ).toString('base64url')
      return {
        sourceReference: `p1.${payload}.${createHmac('sha256', signingKey).update(payload).digest('base64url')}`,
        offset: 0,
      }
    }
    const bound = { runId: f.expected.runId, grant: f.grant }
    const batchRead = reference({
      ...bound,
      source: 'batch',
      batchId: f.expected.batchId,
      offset: 0,
    })
    const bodyRead = reference({ ...bound, document: f.document, offset: 0 })
    const commentLeaf = requiredEvidenceRecord(f.records[4]!.payload['item'])
    const commentArgs = requiredEvidenceRecord(commentLeaf['arguments'])
    const commentRead = reference(commentArgs)
    f.index['bodyRead'] = bodyRead
    const members = f.index['members']
    if (!Array.isArray(members)) throw Error('Missing controlled index')
    requiredEvidenceRecord(members[0])['bodyRead'] = commentRead
    f.indexPage['text'] = JSON.stringify(f.index)
    f.block['text'] = JSON.stringify(f.indexPage)
    f.records.splice(
      5,
      0,
      f.bodyReceipt(f.body, 0, mode === 'incomplete-body' ? f.body.length : null),
    )
    for (const ordinal of [0, 1]) {
      const payload = f.records[ordinal]!.payload
      const owner =
        ordinal === 0 ? requiredEvidenceRecord(payload) : requiredEvidenceRecord(payload['item'])
      const content = owner['content']
      if (!Array.isArray(content)) throw Error('Missing controlled root input')
      const block = requiredEvidenceRecord(content[0]),
        text = String(block['text'])
      const start = text.indexOf('Pact context (JSON reference data;')
      const split = text.indexOf('\n', start) + 1
      const context = requiredEvidenceRecord(JSON.parse(text.slice(split)))
      context['sourceReadArguments'] = batchRead
      block['text'] = text.slice(0, split) + JSON.stringify(context)
    }
    for (const ordinal of [3, 4, 5]) {
      const item = requiredEvidenceRecord(f.records[ordinal]!.payload['item'])
      const request = item['arguments'],
        read = reference(request)
      item['arguments'] = read
      const result = requiredEvidenceRecord(item['result']),
        content = result['content']
      if (!Array.isArray(content)) throw Error('Missing controlled result')
      const block = requiredEvidenceRecord(content[0]),
        page = requiredEvidenceRecord(JSON.parse(String(block['text'])))
      page['binding'] = {
        submitted: 'sourceReference',
        callerRunId: f.expected.runId,
        grantSha256: evidenceSha(f.grant),
        referenceSha256: evidenceSha(read.sourceReference),
      }
      if (mode === 'wrong-binding' && ordinal === 3)
        requiredEvidenceRecord(page['binding'])['callerRunId'] = randomUUID()
      if (mode === 'mixed' && ordinal === 4)
        item['arguments'] = { ...read, runId: f.expected.runId }
      if (mode === 'unprovided' && ordinal === 4)
        item['arguments'] = reference(request, Buffer.alloc(32, 18))
      if (mode === 'failed-leaf' && ordinal === 4) item['status'] = 'failed'
      block['text'] = JSON.stringify(page)
    }
    if (mode === 'legacy-repeat') {
      const repeated = f.bodyReceipt(f.body, 0, null)
      requiredEvidenceRecord(repeated.payload['item'])['arguments'] = {
        ...bound,
        source: 'document',
        document: f.document,
        offset: 0,
      }
      f.records.splice(6, 0, repeated)
    }
    if (mode === 'batch-repeat') {
      const repeated = structuredClone(f.records[3]!),
        item = requiredEvidenceRecord(repeated.payload['item'])
      item['id'] = 'repeated-legacy-batch'
      item['arguments'] = { ...bound, source: 'batch', batchId: f.expected.batchId, offset: 0 }
      const page = structuredClone(f.indexPage),
        index = structuredClone(f.index)
      index['bodyRead'] = { ...bound, source: 'document', document: f.document, offset: 0 }
      const entries = index['members']
      if (!Array.isArray(entries)) throw Error('Missing controlled repeated members')
      for (const member of entries) {
        const value = requiredEvidenceRecord(member)
        value['bodyRead'] = { ...bound, source: 'document', document: value['body'], offset: 0 }
      }
      page['text'] = JSON.stringify(index)
      page['binding'] = {
        submitted: 'legacy',
        callerRunId: f.expected.runId,
        grantSha256: evidenceSha(f.grant),
        referenceSha256: null,
      }
      item['result'] = { content: [{ type: 'text', text: JSON.stringify(page) }] }
      f.records.splice(6, 0, repeated)
    }
    const facts = inspectRoutingSourceRecords(f.records, {
      ...f.expected,
      batchBodySha256: f.document.sha256,
    })
    expect(
      facts.sourceGrantMatched &&
        facts.completeBatch &&
        facts.completeComment &&
        facts.completeBatchBody &&
        facts.allToolsAllowed,
    ).toBe(mode === 'complete' || mode === 'legacy-repeat' || mode === 'batch-repeat')
    expect(
      facts.documents.find(
        (document) => document.referenceSha256 === evidenceSha(JSON.stringify(f.document)),
      )?.complete ?? false,
    ).toBe(facts.completeBatchBody)
    expect(facts.codeModeScripts.every((script) => script.sanitizedInput === null)).toBe(true)
    expect(facts.submittedForms.legacy).toBe(
      mode === 'legacy-repeat' || mode === 'batch-repeat' ? 1 : 0,
    )
    expect(facts.submittedForms.sourceReference).toBe(
      mode === 'complete' ||
        mode === 'incomplete-body' ||
        mode === 'legacy-repeat' ||
        mode === 'batch-repeat'
        ? 3
        : mode === 'wrong-binding'
          ? 0
          : 2,
    )
    expect(facts.boundaryDiagnostics.failedLeaves.map((leaf) => leaf.requestedRunMatched)).toEqual(
      mode === 'failed-leaf' ? [null] : [],
    )
    expect(
      facts.boundaryDiagnostics.failedLeaves.map((leaf) => leaf.requestedGrantMatched),
    ).toEqual(mode === 'failed-leaf' ? [null] : [])
  },
)

test.each([
  { mode: 'different-valid-boundaries', complete: true, error: null },
  { mode: 'cross-form-continuation', complete: true, error: null },
  { mode: 'reverse-continuation', complete: true, error: null },
  {
    mode: 'conflicting-member',
    complete: false,
    error: 'The frozen Batch member changed between authenticated reads',
  },
])('Batch form chains preserve immutable facts across $mode', ({ mode, complete, error }) => {
  const f = routingBatchBodyFixture(),
    bound = { runId: f.expected.runId, grant: f.grant }
  // Controlled protocol partitions exercise the observer; current Repository byte-induced splitting is not claimed.
  const payload = Buffer.from(
    JSON.stringify({
      version: 'pact-source-reference-v1',
      request: { ...bound, source: 'batch', batchId: f.expected.batchId },
    }),
  ).toString('base64url')
  const sourceReference = `p1.${payload}.${createHmac('sha256', Buffer.alloc(32, 23)).update(payload).digest('base64url')}`
  const members = f.index['members']
  if (!Array.isArray(members)) throw Error('Missing controlled Batch')
  const first = { ...requiredEvidenceRecord(members[0]), memberId: randomUUID(), ordinal: 0 }
  const second = { ...first, memberId: randomUUID(), commentId: randomUUID(), ordinal: 1 }
  const batch: Record<string, unknown> = {
    ...requiredEvidenceRecord(f.index['batch']),
    memberCount: 2,
  }
  const index = (entries: object[], next: number | null) => ({
    ...f.index,
    batch,
    members: entries,
    hasMore: next !== null,
    nextOrdinal: next === null ? 1 : next - 1,
  })
  const leaf = (
    form: 'legacy' | 'sourceReference',
    offset: number,
    nextOffset: number | null,
    entries: object[],
  ) => {
    const record = structuredClone(f.records[3]!),
      item = requiredEvidenceRecord(record.payload['item'])
    item['id'] = `${form}-batch-${offset}`
    item['arguments'] =
      form === 'legacy'
        ? { ...bound, source: 'batch', batchId: f.expected.batchId, offset }
        : { sourceReference, offset }
    const page = {
      source: 'batch',
      offset,
      nextOffset,
      text: JSON.stringify(index(entries, nextOffset)),
      binding: {
        submitted: form,
        callerRunId: f.expected.runId,
        grantSha256: evidenceSha(f.grant),
        referenceSha256: form === 'legacy' ? null : evidenceSha(sourceReference),
      },
    }
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(48 * 1024)
    item['result'] = { content: [{ type: 'text', text: JSON.stringify(page) }] }
    return record
  }
  const continuation = mode === 'cross-form-continuation' || mode === 'reverse-continuation'
  f.records[3] = leaf(mode === 'reverse-continuation' ? 'sourceReference' : 'legacy', 0, 1, [first])
  f.records.splice(5, 0, f.bodyReceipt(f.body, 0, null))
  if (!continuation) f.records.splice(6, 0, leaf('legacy', 1, null, [second]))
  f.records.splice(
    continuation ? 6 : 7,
    0,
    continuation
      ? leaf(mode === 'reverse-continuation' ? 'legacy' : 'sourceReference', 1, null, [second])
      : leaf('sourceReference', 0, null, [
          first,
          mode === 'conflicting-member' ? { ...second, revision: 99 } : second,
        ]),
  )
  for (const ordinal of [0, 1]) {
    const owner =
      ordinal === 0
        ? requiredEvidenceRecord(f.records[ordinal]!.payload)
        : requiredEvidenceRecord(f.records[ordinal]!.payload['item'])
    const content = owner['content']
    if (!Array.isArray(content)) throw Error('Missing root input')
    const block = requiredEvidenceRecord(content[0]),
      text = String(block['text'])
    const split = text.indexOf('\n', text.indexOf('Pact context (JSON reference data;')) + 1
    const context = requiredEvidenceRecord(JSON.parse(text.slice(split)))
    context['inputBatchRef'] = {
      id: batch['id'],
      revision: batch['revision'],
      memberCount: batch['memberCount'],
    }
    context['sourceReadArguments'] = { sourceReference, offset: 0 }
    block['text'] = text.slice(0, split) + JSON.stringify(context)
  }
  let problem: string | null = null,
    facts: ReturnType<typeof inspectRoutingSourceRecords> | undefined
  try {
    facts = inspectRoutingSourceRecords(f.records, f.expected)
  } catch (failure) {
    problem = failure instanceof Error ? failure.message : 'unknown'
  }
  expect(problem).toBe(error)
  expect(facts?.completeBatch ?? false).toBe(complete)
  expect(facts?.allToolsAllowed ?? false).toBe(error === null)
  expect(facts?.sourceGrantMatched ?? false).toBe(error === null)
})

function frozenBatchPagesFixture(count = 3) {
  const f = routingBatchBodyFixture(),
    header = { ...requiredEvidenceRecord(f.index['batch']), memberCount: count }
  const existing = f.index['members']
  if (!Array.isArray(existing)) throw Error('Missing complete member fixture')
  const member = requiredEvidenceRecord(existing[0])
  const members = Array.from({ length: count }, (_, ordinal) => {
    const id = randomUUID()
    return { ...member, memberId: id, commentId: id, ordinal }
  })
  return {
    expected: { id: f.expected.batchId, revision: 0, memberCount: count },
    members,
    page: (
      offset: number,
      length: number,
    ): import('../../packages/contracts/src/index.js').CollaborationSourceReadResult => {
      const selected = members.slice(offset, offset + length),
        last = selected.at(-1)?.ordinal ?? offset - 1
      const hasMore = selected.length > 0 && last + 1 < count
      return {
        source: 'batch',
        offset,
        nextOffset: hasMore ? last + 1 : null,
        text: JSON.stringify({
          ...f.index,
          batch: header,
          members: selected,
          hasMore,
          nextOrdinal: last,
        }),
      }
    },
  }
}

test.each(['missing-start', 'missing-cursor', 'missing-eof', 'union-without-edge'] as const)(
  'Batch completeness requires an actual cursor path: %s',
  (mode) => {
    const f = frozenBatchPagesFixture()
    const pages =
      mode === 'missing-start'
        ? [f.page(2, 1)]
        : mode === 'missing-cursor'
          ? [f.page(0, 1), f.page(2, 1)]
          : mode === 'union-without-edge'
            ? [f.page(0, 2), f.page(1, 2)]
            : [f.page(0, 2)]
    expect(assembleFrozenBatch(f.expected, pages).pages).toBeUndefined()
  },
)

test('Batch paths accept both form directions, consistent alternate edges and a genuine empty Batch', () => {
  const f = frozenBatchPagesFixture()
  const pages = [f.page(0, 1), f.page(0, 2), f.page(2, 1), f.page(9, 0)]
  const assembled = assembleFrozenBatch(f.expected, pages)
  expect(assembled.pages?.map((page) => page.offset)).toEqual([0, 2])
  const empty = frozenBatchPagesFixture(0)
  expect(
    assembleFrozenBatch(empty.expected, [empty.page(9, 0), empty.page(0, 0)]).pages,
  ).toHaveLength(1)
  expect(assembleFrozenBatch(empty.expected, [empty.page(9, 0)]).pages).toBeUndefined()
})

test.each([
  'member-omitted',
  'duplicate-member',
  'duplicate-comment',
  'header',
  'body',
  'unselected-conflict',
  'backward',
  'nextOrdinal',
  'hasMore',
] as const)('Batch evidence rejects invalid facts even outside the selected path: %s', (mode) => {
  const f = frozenBatchPagesFixture(),
    correct = f.page(0, 3),
    altered = f.page(0, 3)
  const index = requiredEvidenceRecord(JSON.parse(altered.text)),
    members = index['members']
  if (!Array.isArray(members)) throw Error('Missing controlled members')
  if (mode === 'member-omitted') members.splice(1, 1)
  if (mode === 'duplicate-member')
    requiredEvidenceRecord(members[1])['memberId'] = requiredEvidenceRecord(members[0])['memberId']
  if (mode === 'duplicate-comment')
    requiredEvidenceRecord(members[1])['commentId'] = requiredEvidenceRecord(members[0])[
      'commentId'
    ]
  if (mode === 'header') requiredEvidenceRecord(index['batch'])['revision'] = 1
  if (mode === 'body') requiredEvidenceRecord(index['body'])['id'] = randomUUID()
  if (mode === 'unselected-conflict') requiredEvidenceRecord(members[0])['revision'] = 1
  if (mode === 'backward') altered.nextOffset = 0
  if (mode === 'nextOrdinal') index['nextOrdinal'] = 999
  if (mode === 'hasMore') index['hasMore'] = true
  altered.text = JSON.stringify(index)
  expect(() => assembleFrozenBatch(f.expected, [correct, altered])).toThrow(/Batch|batch/u)
})

test('Batch assembly retains call bounds and does not allocate by an enormous frozen member count', () => {
  const f = frozenBatchPagesFixture()
  expect(() =>
    assembleFrozenBatch(
      f.expected,
      Array.from({ length: 257 }, () => f.page(0, 3)),
    ),
  ).toThrow(/call bound/u)
  const expected = { ...f.expected, memberCount: 1_000_000_000 },
    page = f.page(0, 3)
  const index = requiredEvidenceRecord(JSON.parse(page.text))
  requiredEvidenceRecord(index['batch'])['memberCount'] = expected.memberCount
  index['hasMore'] = true
  page.nextOffset = 3
  page.text = JSON.stringify(index)
  expect(assembleFrozenBatch(expected, [page]).pages).toBeUndefined()
})

test('Batch evidence rejects an enum-shaped array in the only complete page', () => {
  const f = frozenBatchPagesFixture(),
    page = f.page(0, 3),
    index = requiredEvidenceRecord(JSON.parse(page.text)),
    members = index['members']
  if (!Array.isArray(members)) throw Error('Missing controlled members')
  requiredEvidenceRecord(members[0])['state'] = ['resolved']
  page.text = JSON.stringify(index)
  expect(() => assembleFrozenBatch(f.expected, [page])).toThrow(
    /The frozen Batch member state is unavailable/u,
  )
})

test('source inspection retains bounded facts before cleanup and reports extraction failure explicitly', async () => {
  const f = routingCodeModeFixture(),
    root = await mkdtemp(join(tmpdir(), 'pact-source-retention-')),
    path = join(root, 'native.jsonl'),
    receipts: unknown[] = []
  try {
    await writeFile(path, f.records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    const native = await readNativeEvidence(path),
      result = await retainRoutingNativeSourceEvidence(native, f.expected, async (receipt) => {
        receipts.push(receipt)
      })
    expect(result.allToolsAllowed && result.completeBatch && result.completeComment).toBe(true)
    expect(receipts[0]).toMatchObject({
      status: 'observed',
      nativeFileSha256: native.sha256,
      allToolsAllowed: true,
      sourceGrantMatched: true,
      completeBatch: true,
      completeComment: true,
    })
    expect(Buffer.byteLength(JSON.stringify(receipts[0]))).toBeLessThanOrEqual(16 * 1024)
    expect(JSON.stringify(receipts)).not.toContain(f.grant)
    expect(JSON.stringify(receipts)).not.toContain(f.input)
    await rm(path)
    await expect(
      retainRoutingNativeSourceEvidence(native, f.expected, async (receipt) => {
        receipts.push(receipt)
      }),
    ).rejects.toThrow('Native source inspection failed; see the retained safe receipt')
    expect(receipts[1]).toMatchObject({ status: 'unavailable', nativeFileSha256: native.sha256 })
    expect(JSON.stringify(receipts[1])).not.toContain(root)
    expect(receipts).toHaveLength(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each([
  { mode: 'wrapper-lower-bound', before: true, start: 'wrapper_lower_bound' },
  { mode: 'same-wrapper-unknown', before: null, start: 'wrapper_lower_bound' },
  { mode: 'native-start-after-offer', before: true, start: 'native_item_started' },
  { mode: 'native-start-before-offer', before: false, start: 'native_item_started' },
  { mode: 'foreign-start', before: null, start: 'wrapper_lower_bound' },
  { mode: 'changed-reference', before: false, start: 'wrapper_lower_bound' },
  { mode: 'different-reader', before: null, start: 'wrapper_lower_bound' },
  { mode: 'provided-later', before: false, start: 'wrapper_lower_bound' },
])(
  'failed reference diagnostics preserve real timing and untrusted claims: $mode',
  ({ mode, before, start }) => {
    const f = routingBatchBodyFixture(),
      selection = {
        version: 'pact-source-reference-v1',
        request: {
          runId: f.expected.runId,
          grant: f.grant,
          source: 'document',
          document: f.document,
        },
      },
      payload = Buffer.from(JSON.stringify(selection)).toString('base64url'),
      reference = `p1.${payload}.${createHmac('sha256', Buffer.alloc(32, 19)).update(payload).digest('base64url')}`,
      args = { sourceReference: reference, offset: 0 }
    f.index['bodyRead'] = args
    f.indexPage['text'] = JSON.stringify(f.index)
    f.block['text'] = JSON.stringify(f.indexPage)
    const failure = structuredClone(f.records[4]!),
      item = requiredEvidenceRecord(failure.payload['item'])
    item['id'] = 'failed-reference-observation'
    item['status'] = 'failed'
    item['arguments'] = args
    item['error'] = { code: -32603, message: 'private-error-must-not-escape' }
    delete item['result']
    if (mode === 'changed-reference')
      item['arguments'] = {
        ...args,
        sourceReference: reference.slice(0, -1) + (reference.endsWith('A') ? 'B' : 'A'),
      }
    if (mode === 'different-reader') item['server'] = `pact_peer_${'b'.repeat(32)}`
    const started = structuredClone(failure)
    started.payload['type'] = 'item_started'
    if (mode === 'foreign-start') started.payload['turn_id'] = randomUUID()
    if (mode === 'wrapper-lower-bound') {
      const wrapper = structuredClone(f.records[2]!),
        end = structuredClone(f.records[5]!)
      requiredEvidenceRecord(wrapper.payload)['call_id'] = 'second-wrapper'
      requiredEvidenceRecord(end.payload)['call_id'] = 'second-wrapper'
      f.records.splice(6, 0, wrapper, failure, end)
    } else if (mode === 'provided-later') f.records.splice(3, 0, failure)
    else if (mode === 'native-start-before-offer') {
      f.records.splice(3, 0, started)
      f.records.splice(5, 0, failure)
    } else
      f.records.splice(
        4,
        0,
        ...(['native-start-after-offer', 'foreign-start'].includes(mode) ? [started] : []),
        failure,
      )
    const facts = inspectRoutingSourceRecords(f.records, f.expected),
      leaf = facts.boundaryDiagnostics.failedLeaves[0]!
    expect(facts.allToolsAllowed).toBe(false)
    expect(facts.sourceGrantMatched && facts.completeBatch && facts.completeComment).toBe(true)
    expect(leaf.startObservation.kind).toBe(start)
    expect(leaf.referenceObservation?.observedBeforeStart).toBe(before)
    expect(leaf.referenceObservation?.sameNativeReaderNameAsSuccessfulSource).toBe(
      mode !== 'different-reader',
    )
    expect(leaf.untrustedReferenceClaims).toEqual({
      signatureAuthentication: 'not_verified',
      payloadValid: true,
      source: 'document',
      runMatchesCurrent: true,
      grantMatchesCurrent: true,
    })
    expect(leaf.requestedRunMatched).toBeNull()
    expect(leaf.requestedGrantMatched).toBeNull()
    const encoded = JSON.stringify(facts.boundaryDiagnostics)
    expect(encoded).not.toContain(reference)
    expect(encoded).not.toContain(f.grant)
    expect(encoded).not.toContain('private-error-must-not-escape')
  },
)

function nativeRootSourceFixture(rootBatch = false) {
  const f = routingCodeModeFixture(),
    root = { threadId: f.expected.nativeSessionId, turnId: f.expected.nativeTurnId }
  for (const record of f.records) {
    const payload = requiredEvidenceRecord(record.payload)
    const item =
      payload['type'] === 'item_completed' ? requiredEvidenceRecord(payload['item']) : undefined
    const contents =
      item?.['type'] === 'UserMessage'
        ? item['content']
        : payload['type'] === 'message'
          ? payload['content']
          : undefined
    if (Array.isArray(contents))
      for (const part of contents) {
        const text = requiredEvidenceRecord(part)['text']
        if (typeof text !== 'string' || !text.includes('Pact context (JSON reference data;'))
          continue
        const at = text.indexOf('\n', text.indexOf('Pact context (JSON reference data;')) + 1,
          context = requiredEvidenceRecord(JSON.parse(text.slice(at)))
        context['sourceReadArguments'] = {
          context: 'native-root-v1',
          ...(rootBatch
            ? { source: 'root_batch' }
            : { source: 'batch', batchId: f.expected.batchId }),
          offset: 0,
        }
        requiredEvidenceRecord(part)['text'] = text.slice(0, at) + JSON.stringify(context)
      }
    if (item?.['type'] !== 'McpToolCall') continue
    const before = requiredEvidenceRecord(item['arguments']),
      { runId: _runId, grant: _grant, ...target } = before,
      args = collaborationSourceNativeReadSchema.parse({
        ...(rootBatch && target['source'] === 'batch'
          ? { source: 'root_batch', offset: target['offset'] }
          : target),
        context: 'native-root-v1',
      })
    item['arguments'] = args
    const result = requiredEvidenceRecord(item['result']),
      content = result['content']
    if (!Array.isArray(content)) throw Error('Missing controlled content')
    const body = requiredEvidenceRecord(content[0]),
      page = collaborationSourceWireResultSchema.parse({
        ...requiredEvidenceRecord(JSON.parse(String(body['text']))),
        binding: {
          submitted: 'nativeRoot',
          callerRunId: f.expected.runId,
          grantSha256: evidenceSha(f.grant),
          referenceSha256: null,
          nativeRoot: root,
        },
      })
    body['text'] = JSON.stringify(page)
    result['_meta'] = {
      pactSourceRoot: {
        version: 'pact-native-source-root-v1',
        root,
        callerRunId: f.expected.runId,
        grantSha256: evidenceSha(f.grant),
        requestSha256: evidenceSha(JSON.stringify(args)),
        pageSha256: evidenceSha(JSON.stringify(page)),
      },
    }
  }
  return f
}

test('native source proof joins genuine leaf scope, submitted selection and complete frozen content', () => {
  const f = nativeRootSourceFixture(),
    facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts).toMatchObject({
    allToolsAllowed: true,
    sourceGrantMatched: true,
    completeBatch: true,
    completeComment: true,
    submittedForms: { nativeRoot: 2, legacy: 0, sourceReference: 0 },
    boundaryDiagnostics: { rootSourceReadArgumentsMatched: true, failedLeafCount: 0 },
  })
})

test.each([
  'missing-proof',
  'thread',
  'turn',
  'request-hash',
  'page-hash',
  'grant-hash',
  'mixed-request',
  'page-binding',
] as const)('native source proof rejects %s without crediting its content', (fault) => {
  const f = nativeRootSourceFixture(),
    item = requiredEvidenceRecord(f.records[3]!.payload['item']),
    result = requiredEvidenceRecord(item['result']),
    meta = requiredEvidenceRecord(result['_meta']),
    proof = requiredEvidenceRecord(meta['pactSourceRoot'])
  if (fault === 'missing-proof') delete result['_meta']
  if (fault === 'thread') requiredEvidenceRecord(proof['root'])['threadId'] = randomUUID()
  if (fault === 'turn') requiredEvidenceRecord(proof['root'])['turnId'] = randomUUID()
  if (fault === 'request-hash') proof['requestSha256'] = '0'.repeat(64)
  if (fault === 'page-hash') proof['pageSha256'] = '0'.repeat(64)
  if (fault === 'grant-hash') proof['grantSha256'] = '0'.repeat(64)
  if (fault === 'mixed-request') requiredEvidenceRecord(item['arguments'])['grant'] = f.grant
  if (fault === 'page-binding') {
    const content = result['content']
    if (!Array.isArray(content)) throw Error('Missing controlled content')
    const body = requiredEvidenceRecord(content[0]),
      page = requiredEvidenceRecord(JSON.parse(String(body['text'])))
    requiredEvidenceRecord(requiredEvidenceRecord(page['binding'])['nativeRoot'])['turnId'] =
      randomUUID()
    body['text'] = JSON.stringify(page)
    proof['pageSha256'] = evidenceSha(JSON.stringify(page))
  }
  const facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.sourceGrantMatched && facts.completeBatch && facts.completeComment).toBe(false)
})

function extraLocalWrapper(script: string, failed = false, prefixOutput = false) {
  const f = routingCodeModeFixture(),
    id = 'additional-local-wrapper',
    metadata = { turn_id: f.expected.nativeTurnId }
  f.records.splice(
    2,
    0,
    evidenceResponse({
      type: 'custom_tool_call',
      namespace: 'functions',
      name: 'exec',
      call_id: id,
      input: script,
      internal_chat_message_metadata_passthrough: metadata,
    }),
    evidenceResponse({
      type: 'custom_tool_call_output',
      call_id: id,
      output: [
        {
          type: 'input_text',
          text: `Script ${failed ? 'failed' : 'completed'}\nWall time 0.0 seconds\nOutput:\n`,
        },
        ...(prefixOutput ? [{ type: 'input_text', text: 'CONTROLLED_LOCAL_PREFIX' }] : []),
        ...(failed
          ? [
              {
                type: 'input_text',
                text: 'Script error:\nSyntaxError: Controlled syntax rejection',
              },
            ]
          : []),
      ],
      internal_chat_message_metadata_passthrough: metadata,
    }),
  )
  return f
}

test.each([false, true])(
  'pure local JSON processing preserves its actual failed=%s status without inventing a source leaf',
  (failed) => {
    const f = extraLocalWrapper(
        failed
          ? 'text("CONTROLLED_LOCAL_PREFIX");JSON.parse("{")'
          : 'const value=JSON.parse("{\\\"body\\\":1}");text(JSON.stringify(value.body))',
        failed,
        failed,
      ),
      facts = inspectRoutingSourceRecords(f.records, f.expected)
    expect(facts).toMatchObject({
      allToolsAllowed: true,
      sourceGrantMatched: true,
      completeBatch: true,
      completeComment: true,
      boundaryDiagnostics: { failedLeafCount: 0 },
    })
    expect(facts.boundaryDiagnostics.wrappers[0]).toMatchObject({
      completed: !failed,
      admissible: true,
      classification: 'local_data',
      operations: 0,
      leaves: 0,
    })
    expect(facts.sourceToolCalls).toBe(2)
    expect(facts.codeModeScripts).toHaveLength(2)
  },
)

test.each([
  'accepted',
  'wrong-version',
  'prefix-output',
  'wrong-call',
  'missing-output',
  'operation-start',
] as const)(
  'dual compiler rejection requires a complete zero-operation Native boundary: %s',
  (variant) => {
    const f = extraLocalWrapper(
      'text("MUST_NOT_EXECUTE");const broken=`unterminated',
      true,
      variant === 'prefix-output',
    )
    const nativeId = f.expected.nativeSessionId
    f.records.unshift({
      type: 'session_meta',
      payload: { id: nativeId, cli_version: variant === 'wrong-version' ? '0.162.0' : '0.163.0' },
    })
    if (variant === 'wrong-call')
      requiredEvidenceRecord(f.records[4]!.payload)['call_id'] = 'wrong-call'
    if (variant === 'missing-output') f.records.splice(4, 1)
    if (variant === 'operation-start')
      f.records.splice(4, 0, {
        type: 'event_msg',
        payload: {
          type: 'item_started',
          thread_id: nativeId,
          turn_id: f.expected.nativeTurnId,
          item: { type: 'CommandExecution', id: 'unmatched-native-command' },
        },
      })
    const facts = inspectRoutingSourceRecords(f.records, f.expected)
    expect(facts.allToolsAllowed).toBe(variant === 'accepted')
    expect(facts.boundaryDiagnostics.wrappers[0]).toMatchObject({
      completed: false,
      admissible: variant === 'accepted',
    })
    expect(
      facts.boundaryDiagnostics.wrappers[0]?.classification === 'preexecution_syntax_failure',
    ).toBe(variant === 'accepted')
  },
)

test.each([
  'const fn=text;fn("data")',
  'const t=tools;text(t)',
  'text(unknownGlobal)',
  'eval("text(1)")',
  'const x={get value(){return 1}};text(x.value)',
  'const x={};text(x.constructor)',
  'const JSON={};text(JSON)',
  'const x={};text(x[unknownGlobal])',
  'const x=JSON.parse("{}");x.key=1;text(x)',
  'text((()=>1)())',
])('a zero-leaf completed wrapper cannot hide capability or unsupported syntax: %s', (script) => {
  const f = extraLocalWrapper(script),
    facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.allToolsAllowed).toBe(false)
  expect(facts.boundaryDiagnostics.wrappers[0]?.classification).toBe('unclassified_wrapper')
})

test('the named source snapshot exposes no command absence before exact ledger certification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-source-snapshot-'))
  try {
    const f = extraLocalWrapper('const broken=`unterminated', true),
      path = join(directory, 'native.jsonl')
    f.records.unshift({
      type: 'session_meta',
      payload: { id: f.expected.nativeSessionId, cli_version: '0.163.0' },
    })
    await writeFile(path, f.records.map((x) => JSON.stringify(x)).join('\n'))
    await expect(readNativeEvidence(path)).rejects.toThrow(
      /Native exec script syntax inspection failed/u,
    )
    const pending = await readNativeSourceEvidence(path)
    expect(Object.hasOwn(pending, 'shellCommands')).toBe(false)
    expect(pending.commandInspection.syntaxFailures).toHaveLength(1)
    const audit = await routingNativeSourceEvidence(pending, f.expected)
    expect(audit.allToolsAllowed).toBe(true)
    expect(pending.certifySourceAudit(audit).shellCommands).toEqual([])
    expect(() =>
      pending.certifySourceAudit({ ...audit, sourceFileSha256: '0'.repeat(64) }),
    ).toThrow(/requires the complete matching source audit/u)
    expect(() => pending.certifySourceAudit({ ...audit, allToolsAllowed: false })).toThrow(
      /requires the complete matching source audit/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('printed tool-looking text remains only local data and cannot create any source receipt', () => {
  const script =
      'text("const t = ALL_TOOLS.filter(x => x.name.includes(read_collaboration_source)); text(t)")',
    f = extraLocalWrapper(script),
    facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.allToolsAllowed).toBe(true)
  expect(facts.boundaryDiagnostics.wrappers[0]).toMatchObject({
    classification: 'local_data',
    leaves: 0,
  })
  expect(facts.sourceToolCalls).toBe(2)
  const withoutActualSources = f.records.filter(
      (record) =>
        record.payload['type'] !== 'item_completed' ||
        requiredEvidenceRecord(record.payload['item'])['type'] !== 'McpToolCall',
    ),
    absent = inspectRoutingSourceRecords(withoutActualSources, f.expected)
  expect(absent.sourceToolCalls).toBe(0)
  expect(absent.completeBatch || absent.completeComment || absent.sourceGrantMatched).toBe(false)
})

test('a runtime SyntaxError after successful source calls is still a failed source wrapper', () => {
  const f = routingCodeModeFixture(),
    start = requiredEvidenceRecord(f.records[2]!.payload),
    end = requiredEvidenceRecord(f.records[5]!.payload)
  start['input'] = String(start['input']) + 'throw new SyntaxError("CONTROLLED_AFTER_SOURCE");'
  end['output'] = [
    { type: 'input_text', text: 'Script failed\nWall time 0.0 seconds\nOutput:\n' },
    { type: 'input_text', text: 'CONTROLLED_SOURCE_OUTPUT' },
    { type: 'input_text', text: 'Script error:\nSyntaxError: Controlled runtime failure' },
  ]
  const facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.completeBatch && facts.completeComment && facts.sourceGrantMatched).toBe(true)
  expect(facts.allToolsAllowed).toBe(false)
  expect(facts.boundaryDiagnostics.wrappers[0]).toMatchObject({
    completed: false,
    admissible: false,
    classification: 'unclassified_wrapper',
    operations: 2,
    leaves: 2,
  })
})

test.each(['SyntaxError', 'TypeError', 'ReferenceError'])(
  'failed source wrapper diagnostics retain only the reported %s class',
  (errorClass) => {
    const f = routingCodeModeFixture(),
      end = requiredEvidenceRecord(f.records[5]!.payload)
    end['output'] = [
      { type: 'input_text', text: 'Script failed\nWall time 0.0 seconds\nOutput:\n' },
      { type: 'input_text', text: 'CONTROLLED_SOURCE_OUTPUT' },
      { type: 'input_text', text: `Script error:\n${errorClass}: PRIVATE_ERROR_${f.grant}` },
    ]
    const facts = inspectRoutingSourceRecords(f.records, f.expected)
    expect(facts.allToolsAllowed).toBe(false)
    expect(facts.boundaryDiagnostics.wrappers[0]).toMatchObject({
      completed: false,
      admissible: false,
      error: { scriptErrorClass: errorClass, contentCount: 2 },
    })
    expect(JSON.stringify(facts)).not.toContain('PRIVATE_ERROR_')
    expect(JSON.stringify(facts)).not.toContain(f.grant)
  },
)

test('catching a failed source MCP cannot turn it into admissible local data', () => {
  const f = routingCodeModeFixture(),
    item = requiredEvidenceRecord(f.records[3]!.payload['item'])
  item['status'] = 'failed'
  item['result'] = { isError: true, content: [{ type: 'text', text: 'Input validation failed' }] }
  const facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.allToolsAllowed).toBe(false)
  expect(facts.boundaryDiagnostics.failedLeafCount).toBe(1)
})

test.each([
  ['tools.read_collaboration_source', 'unqualified_source_reader'],
  ['tools.get', 'tool_lookup'],
  ['tools.call', 'generic_tool_call'],
  ['tools[reader]', 'computed_tool'],
  ['privateLocalValue', 'local_or_other'],
  [
    'tools.mcp__pact_peer_0123456789abcdef0123456789abcdef__read_collaboration_source',
    'qualified_source_reader',
  ],
])('failed source call diagnostics categorize %s without retaining it', (target, category) => {
  const f = routingCodeModeFixture(),
    end = requiredEvidenceRecord(f.records[5]!.payload)
  end['output'] = [
    { type: 'input_text', text: 'Script failed\nWall time 0.0 seconds\nOutput:\n' },
    {
      type: 'input_text',
      text: `Script error:\nTypeError: ${target} is not a function; PRIVATE_ERROR_${f.grant}`,
    },
  ]
  const facts = inspectRoutingSourceRecords(f.records, f.expected),
    diagnostic = facts.boundaryDiagnostics.wrappers[0]?.error
  expect(facts.allToolsAllowed).toBe(false)
  expect(diagnostic).toMatchObject({
    notFunction: true,
    notFunctionTarget: category,
    notFunctionReaderSha256:
      category === 'qualified_source_reader'
        ? createHash('sha256')
            .update(target.replace(/^tools\./u, ''))
            .digest('hex')
        : null,
    jsonParseFailure: false,
  })
  expect(JSON.stringify(diagnostic)).not.toContain(target)
  expect(JSON.stringify(facts)).not.toContain('PRIVATE_ERROR_')
  expect(JSON.stringify(facts)).not.toContain(f.grant)
})

test('failed source JSON parsing keeps only a category and never accepts the failed call', () => {
  const f = routingCodeModeFixture(),
    item = requiredEvidenceRecord(f.records[3]!.payload['item'])
  item['status'] = 'failed'
  item['result'] = null
  item['error'] = { message: `Unexpected token: PRIVATE_ERROR_${f.grant}; not valid JSON` }
  const facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.allToolsAllowed).toBe(false)
  expect(facts.boundaryDiagnostics.failedLeaves[0]?.error).toMatchObject({
    jsonParseFailure: true,
    notFunction: false,
    notFunctionTarget: null,
    notFunctionReaderSha256: null,
  })
  expect(JSON.stringify(facts)).not.toContain('PRIVATE_ERROR_')
  expect(JSON.stringify(facts)).not.toContain(f.grant)
})

test.each([
  ['HTTP status 404', 'http_404', 404],
  ['HTTP status 429', 'http_status', 429],
  ['Request timed out', 'timeout', null],
  ['Connection closed', 'connection_or_transport', null],
  ['Unexpected end of JSON input', 'json_decode', null],
  ['The peer Tool request failed.', 'host_json_error', null],
  ['tools.read_collaboration_source is not a function', 'not_function', null],
  ['An unclassified native failure', 'unknown', null],
])('failed native Source keeps the closed error category for %s', (message, kind, status) => {
  const f = routingCodeModeFixture(),
    item = requiredEvidenceRecord(f.records[3]!.payload['item'])
  item['status'] = 'failed'
  item['result'] = null
  item['error'] = { message: `${message}; PRIVATE_MESSAGE_${f.grant}` }
  const facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.allToolsAllowed).toBe(false)
  expect(facts.boundaryDiagnostics.failedLeaves[0]?.error).toMatchObject({
    nativeFailureKind: kind,
    nativeHttpStatus: status,
  })
  expect(JSON.stringify(facts)).not.toContain('PRIVATE_MESSAGE_')
  expect(JSON.stringify(facts)).not.toContain(f.grant)
})

test.each([
  ['await tools.read_collaboration_source({})', 'unqualified_reader', false],
  ['await tools[reader.name]({})', 'computed_tools', false],
  ['tools.get({name:"private_lookup"})', 'lookup', false],
  ['JSON.parse("{}")', 'json_parse', true],
  ['privateLocalCallable({privateArgument:1})', 'local_or_other', false],
])('Source call shapes remain diagnostic only: %s', (script, shape, allowed) => {
  const f = extraLocalWrapper(script, true),
    facts = inspectRoutingSourceRecords(f.records, f.expected),
    expected = allowed
      ? undefined
      : { shapes: [shape], readers: [], omittedReaderOccurrences: 0, executionProvenByShape: false }
  expect(facts.allToolsAllowed).toBe(allowed)
  expect(facts.boundaryDiagnostics.wrappers[0]?.callShapes).toEqual(expected)
  expect(JSON.stringify(facts)).not.toContain('private_lookup')
  expect(JSON.stringify(facts)).not.toContain('privateLocalCallable')
  expect(JSON.stringify(facts)).not.toContain('privateArgument')
})

test.each([true, false])(
  'qualified reader shape and actual error compare only with observed Source: matches=%s',
  (matches) => {
    const name = `mcp__pact_peer_${(matches ? 'a' : 'b').repeat(32)}__read_collaboration_source`,
      f = extraLocalWrapper(`text(await tools[${JSON.stringify(name)}]({}))`, true),
      end = requiredEvidenceRecord(f.records[3]!.payload)
    end['output'] = [
      { type: 'input_text', text: 'Script failed\nWall time 0.0 seconds\nOutput:\n' },
      { type: 'input_text', text: `Script error:\nTypeError: tools.${name} is not a function` },
    ]
    const facts = inspectRoutingSourceRecords(f.records, f.expected)
    expect(facts.allToolsAllowed).toBe(false)
    expect(facts.boundaryDiagnostics.wrappers[0]).toMatchObject({
      errorReaderMatchesSuccessfulSource: matches,
      callShapes: {
        shapes: expect.arrayContaining(['qualified_reader']),
        readers: [{ sha256: evidenceSha(name), matchesSuccessfulSource: matches }],
        executionProvenByShape: false,
      },
    })
    expect(JSON.stringify(facts)).not.toContain(name)
  },
)

test('quoted reader-looking data never creates a qualified call shape or name hash', () => {
  const name = `mcp__pact_peer_${'b'.repeat(32)}__read_collaboration_source`,
    f = extraLocalWrapper(
      `text(${JSON.stringify(`tools.${name}({})`)});await tools.other({})`,
      true,
    ),
    facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.allToolsAllowed).toBe(false)
  expect(facts.boundaryDiagnostics.wrappers[0]?.callShapes).toMatchObject({
    shapes: expect.arrayContaining(['local_or_other', 'other_tools']),
    readers: [],
    executionProvenByShape: false,
  })
})

test('healthy Source receipts omit new diagnostics, including an admissible failed local wrapper', () => {
  for (const f of [routingCodeModeFixture(), extraLocalWrapper('JSON.parse("{")', true)]) {
    const facts = inspectRoutingSourceRecords(f.records, f.expected)
    expect(facts.allToolsAllowed).toBe(true)
    for (const wrapper of facts.boundaryDiagnostics.wrappers) {
      expect(wrapper).not.toHaveProperty('callShapes')
      expect(wrapper).not.toHaveProperty('errorReaderMatchesSuccessfulSource')
      expect(wrapper.error).not.toHaveProperty('nativeFailureKind')
      expect(wrapper.error).not.toHaveProperty('nativeHttpStatus')
    }
  }
})

test('successful catalogue and Source output cannot create script or transport failures', () => {
  const f = routingCodeModeFixture(),
    end = requiredEvidenceRecord(f.records[5]!.payload)
  end['output'] = [
    { type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
    {
      type: 'input_text',
      text: 'Script error:\nTypeError: tools.read_collaboration_source is not a function; HTTP status404 JSON.parse connection',
    },
  ]
  const facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.allToolsAllowed).toBe(true)
  expect(facts.boundaryDiagnostics.wrappers[0]?.error).toMatchObject({
    scriptErrorClass: null,
    notFunction: false,
  })
  expect(facts.boundaryDiagnostics.wrappers[0]?.error).not.toHaveProperty('nativeFailureKind')
})

test('failed wrapper uses only its final Script error segment and never printed Source text', () => {
  const f = routingCodeModeFixture(),
    end = requiredEvidenceRecord(f.records[5]!.payload)
  end['output'] = [
    { type: 'input_text', text: 'Script failed\nWall time 0.0 seconds\nOutput:\n' },
    {
      type: 'input_text',
      text: 'Script error:\nTypeError: tools.read_collaboration_source is not a function; HTTP status404 JSON.parse connection',
    },
    { type: 'input_text', text: 'Script error:\nRangeError: CONTROLLED_FINAL_ERROR' },
  ]
  const facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.allToolsAllowed).toBe(false)
  expect(facts.boundaryDiagnostics.wrappers[0]?.error).toMatchObject({
    scriptErrorClass: 'RangeError',
    notFunction: false,
  })
  expect(facts.boundaryDiagnostics.wrappers[0]?.error).not.toHaveProperty('nativeFailureKind')
})

test.each([
  ['HTTP status429; other data404', 'http_status', 429],
  ['HTTP status 429; previous 404 Not Found', 'http_status', 429],
  ['An unclassified native failure mentioning404', 'unknown', null],
])('failed MCP transport category uses only error.message: %s', (message, kind, status) => {
  const f = routingCodeModeFixture(),
    item = requiredEvidenceRecord(f.records[3]!.payload['item'])
  item['status'] = 'failed'
  item['result'] = null
  item['error'] = {
    message,
    content: [{ type: 'text', text: 'HTTP status404 JSON.parse connection timeout' }],
  }
  const facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.allToolsAllowed).toBe(false)
  expect(facts.boundaryDiagnostics.failedLeaves[0]?.error).toMatchObject({
    nativeFailureKind: kind,
    nativeHttpStatus: status,
  })
})

test('arm evidence deduplicates two Root diagnostics while preserving exact receipt and benefit hashes', async () => {
  const captured: Array<{ name: string; body: Buffer }> = [],
    info = {
      attach: async (
        name: string,
        options?: { body?: string | Buffer; path?: string; contentType?: string },
      ) => {
        if (options?.body === undefined) throw Error('Controlled attachment body missing')
        captured.push({ name, body: Buffer.from(options.body) })
      },
    },
    nativeFacts = ['claude', 'codex'].map((actor) => ({
      actor,
      sourceAccess: {
        allToolsAllowed: true,
        sourceGrantMatched: true,
        completeBatch: true,
        completeComment: true,
        sourceFileSha256: evidenceSha(actor),
        boundaryDiagnostics: { explanation: 'CONTROLLED_DIAGNOSTIC_'.repeat(450) },
      },
    })),
    off = {
      manualRouteCorrections: 1,
      realBusinessTurns: 2,
      decisionCalls: 0,
      firstActualRecipient: 'claude',
      elapsedMs: 100,
      nativeFacts,
    },
    on = { ...off, manualRouteCorrections: 0, realBusinessTurns: 1, decisionCalls: 1 },
    original = JSON.stringify(off),
    silent = vi.spyOn(console, 'info').mockImplementation(() => {})
  try {
    expect(Buffer.byteLength(original)).toBeGreaterThan(16 * 1024)
    await Promise.all(
      nativeFacts.map((root) =>
        emitRoutingEvidence(info, 'native-source-access', {
          actor: root.actor,
          ...root.sourceAccess,
        }),
      ),
    )
    await emitRoutingEvidence(info, 'off', off)
    await emitRoutingEvidence(info, 'on', on)
    const offBody = captured.find((x) => x.name === 'relay-routing-off')!.body,
      onBody = captured.find((x) => x.name === 'relay-routing-on')!.body,
      summary = routingBenefitSummary(off, on),
      projected = JSON.parse(offBody.toString('utf8'))
    expect(offBody.byteLength).toBeLessThanOrEqual(16 * 1024)
    expect(onBody.byteLength).toBeLessThanOrEqual(16 * 1024)
    expect(summary.off.sha256).toBe(evidenceSha(offBody.toString('utf8')))
    expect(summary.on.sha256).toBe(evidenceSha(onBody.toString('utf8')))
    expect(summary.savedManualCorrections).toBe(1)
    expect(summary.savedBusinessTurns).toBe(1)
    for (const [index, root] of projected.nativeFacts.entries()) {
      expect(root.sourceAccess).not.toHaveProperty('boundaryDiagnostics')
      expect(root.sourceAccess).toMatchObject({
        allToolsAllowed: true,
        sourceGrantMatched: true,
        completeBatch: true,
        completeComment: true,
      })
      expect(root.sourceAccessReceiptSha256).toBe(
        evidenceSha(captured[index]!.body.toString('utf8')),
      )
    }
    await emitRoutingEvidence(info, 'off', projected)
    expect(captured.at(-1)!.body.equals(offBody)).toBe(true)
    expect(JSON.stringify(off)).toBe(original)
  } finally {
    silent.mockRestore()
  }
})

test('strict CodeMode inspection does not mistake JSON argument text for executable JavaScript', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-source-json-syntax-'))
  try {
    const f = extraLocalWrapper('{"data":1}', true),
      path = join(directory, 'native.jsonl')
    await writeFile(path, f.records.map((x) => JSON.stringify(x)).join('\n'))
    await expect(readNativeEvidence(path)).rejects.toThrow(
      /Native exec script syntax inspection failed/u,
    )
    const pending = await readNativeSourceEvidence(path)
    expect(pending.commandInspection.syntaxFailures).toHaveLength(1)
    expect(Object.hasOwn(pending, 'shellCommands')).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** START-only counter evidence must fail even when every required source is complete. */
test.each(['foreign-mcp', 'wrong-root-source', 'current-source-control', 'outside-command'])(
  'source-only audit rejects an unclosed native operation: %s',
  async (mode) => {
    const f = routingCodeModeFixture(),
      item =
        mode === 'outside-command'
          ? { type: 'CommandExecution', id: 'unclosed-command', command: 'true' }
          : {
              type: 'McpToolCall',
              id: 'unclosed-mcp',
              server: mode === 'foreign-mcp' ? 'other_server' : `pact_peer_${'a'.repeat(32)}`,
              tool: mode === 'foreign-mcp' ? 'write_external' : 'read_collaboration_source',
            }
    f.records.splice(mode === 'outside-command' ? 6 : 3, 0, {
      type: 'event_msg',
      payload: {
        type: 'item_started',
        thread_id: mode === 'wrong-root-source' ? randomUUID() : f.expected.nativeSessionId,
        turn_id: f.expected.nativeTurnId,
        item,
      },
    })
    const facts = inspectRoutingSourceRecords(f.records, f.expected)
    expect(facts.sourceGrantMatched).toBe(true)
    expect(facts.completeBatch).toBe(true)
    expect(facts.completeComment).toBe(true)
    expect(facts.allToolsAllowed).toBe(false)
    expect(facts.boundaryDiagnostics.ledgerValid).toBe(false)
    const directory = await mkdtemp(join(tmpdir(), 'pact-unclosed-source-'))
    try {
      const path = join(directory, 'native.jsonl')
      await writeFile(path, f.records.map((record) => JSON.stringify(record)).join('\n'))
      const pending = await readNativeSourceEvidence(path),
        audit = await routingNativeSourceEvidence(pending, f.expected)
      expect(audit.allToolsAllowed).toBe(false)
      expect(() => pending.certifySourceAudit(audit)).toThrow(
        /requires the complete matching source audit/u,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test('source-only audit accepts source starts matched within their original wrapper', () => {
  const f = routingCodeModeFixture()
  for (const index of [4, 3]) {
    const leaf = structuredClone(f.records[index]!)
    leaf.payload.type = 'item_started'
    f.records.splice(index, 0, leaf)
  }
  const facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.allToolsAllowed).toBe(true)
  expect(facts.boundaryDiagnostics.ledgerValid).toBe(true)
  expect(facts.completeBatch).toBe(true)
  expect(facts.completeComment).toBe(true)
})

test.each(['exact-completed', 'exact-failed', 'generic-completed'])(
  'source snapshot never certifies a refused source call after later complete reads: %s',
  async (mode) => {
    const f = sourceRefusalFixture(),
      directory = await mkdtemp(join(tmpdir(), 'pact-source-refusal-'))
    if (mode === 'exact-failed') f.item['status'] = 'failed'
    if (mode === 'generic-completed')
      f.item['result'] = {
        isError: true,
        content: [{ type: 'text', text: 'CONTROLLED_GENERIC_ERROR' }],
      }
    try {
      const path = join(directory, 'native.jsonl')
      await writeFile(path, f.records.map((record) => JSON.stringify(record)).join('\n'))
      const pending = await readNativeSourceEvidence(path),
        audit = await routingNativeSourceEvidence(pending, f.expected)
      expect(audit.sourceGrantMatched).toBe(true)
      expect(audit.completeBatch).toBe(true)
      expect(audit.completeComment).toBe(true)
      expect(audit.rejectedSourceReads.other).toBe(1)
      expect(audit.allToolsAllowed).toBe(false)
      expect(() => pending.certifySourceAudit(audit)).toThrow(
        /requires the complete matching source audit/u,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test.each([
  'valid',
  'canonical-proof',
  'wrong-batch-page',
  'explicit-next',
  'mixed-next',
  'terminal-next',
])(
  'native original Batch audit binds the submitted selection and immutable root target: %s',
  (mode) => {
    const f = nativeRootSourceFixture(true),
      item = requiredEvidenceRecord(f.records[3]!.payload['item']),
      result = requiredEvidenceRecord(item['result']),
      content = result['content']
    if (!Array.isArray(content)) throw Error('Missing controlled source page')
    const block = requiredEvidenceRecord(content[0]),
      page = requiredEvidenceRecord(JSON.parse(String(block['text']))),
      proof = requiredEvidenceRecord(requiredEvidenceRecord(result['_meta'])['pactSourceRoot'])
    if (mode === 'canonical-proof')
      proof['requestSha256'] = evidenceSha(
        JSON.stringify({
          runId: f.expected.runId,
          grant: f.grant,
          source: 'batch',
          batchId: f.expected.batchId,
          offset: 0,
        }),
      )
    if (mode === 'wrong-batch-page') {
      const index = requiredEvidenceRecord(JSON.parse(String(page['text'])))
      requiredEvidenceRecord(index['batch'])['id'] = randomUUID()
      page['text'] = JSON.stringify(index)
    }
    if (mode === 'explicit-next') {
      page['nextOffset'] = 1
      page['nextRead'] = {
        context: 'native-root-v1',
        source: 'batch',
        batchId: f.expected.batchId,
        offset: 1,
      }
    }
    if (mode === 'mixed-next') {
      page['nextOffset'] = 1
      page['nextRead'] = {
        context: 'native-root-v1',
        source: 'root_batch',
        batchId: f.expected.batchId,
        offset: 1,
      }
    }
    if (mode === 'terminal-next')
      page['nextRead'] = { context: 'native-root-v1', source: 'root_batch', offset: 1 }
    block['text'] = JSON.stringify(page)
    proof['pageSha256'] = evidenceSha(JSON.stringify(page))
    const facts = inspectRoutingSourceRecords(f.records, f.expected)
    expect(facts.sourceGrantMatched).toBe(mode === 'valid')
    expect(facts.allToolsAllowed).toBe(mode === 'valid')
    expect(mode !== 'valid' || (facts.completeBatch && facts.completeComment)).toBe(true)
  },
)

test.each([
  { source: 'root_batch', offset: 0, valid: true },
  { source: 'inputs', offset: 4096, valid: true },
  { source: 'handoff_sources', offset: 1, valid: true },
  { source: 'PRIVATE_SOURCE_CREDENTIAL', offset: 'PRIVATE_OFFSET_CREDENTIAL', valid: false },
])(
  'failed Native source diagnostics retain closed arguments for $source without raw values',
  ({ source, offset, valid }) => {
    const f = nativeRootSourceFixture(true),
      item = requiredEvidenceRecord(f.records[3]!.payload['item'])
    item['status'] = 'failed'
    delete item['result']
    item['error'] = { message: 'PRIVATE_NATIVE_ERROR' }
    item['arguments'] = { context: 'native-root-v1', source, offset }
    const facts = inspectRoutingSourceRecords(f.records, f.expected),
      failure = facts.boundaryDiagnostics.failedLeaves[0]!
    expect(facts.allToolsAllowed).toBe(false)
    expect(failure.arguments).toMatchObject({
      source: valid ? source : 'unknown',
      offset: valid ? offset : null,
    })
    const callIdentity = sourceReadCallIdentity(
      f.expected.nativeSessionId,
      f.expected.nativeTurnId,
      item['id'],
    )
    expect(failure.nativeCallSha256).toBe(callIdentity ? evidenceSha(callIdentity) : null)
    expect(failure.nativeCallUnique).toBe(true)
    expect(failure.requestSha256).toBe(
      valid
        ? evidenceSha(JSON.stringify(collaborationSourceNativeReadSchema.parse(item['arguments'])))
        : null,
    )
    for (const value of [
      'PRIVATE_SOURCE_CREDENTIAL',
      'PRIVATE_OFFSET_CREDENTIAL',
      'PRIVATE_NATIVE_ERROR',
    ])
      expect(JSON.stringify(failure)).not.toContain(value)
  },
)

test('diagnostic association follows unique Native call identities across reversed identical requests', () => {
  const requestSha256 = 'b'.repeat(64),
    first = 'a'.repeat(64),
    second = 'c'.repeat(64)
  const fact = (nativeCallSha256: string) =>
    sourceReadDiagnosticSchema.parse({
      version: 'source-read-failure-v1',
      form: 'nativeRoot',
      source: 'root_batch',
      offset: 0,
      nativeCallSha256,
      requestSha256,
      entryOwner: 'passed',
      rootBinding: 'passed',
      currentBeforeRead: 'passed',
      readerEntered: true,
      stage: 'repository_scope',
    })
  const observation = {
    status: 'bounded-tail',
    tailBytes: 1,
    events: [],
    sourceFailures: [fact(second), fact(first)],
    sourceFailuresOmitted: 0,
    sourceFailuresComplete: true,
    droppedObserved: false,
    diagnosticStatus: { state: 'ready', dropped: 0 },
  } as const
  const leaves = [first, second].map((nativeCallSha256) => ({
    nativeCallSha256,
    requestSha256,
    nativeCallUnique: true,
  }))
  const result = correlateSourceReadFailures(leaves, {
    ...observation,
    events: [],
    sourceFailures: [...observation.sourceFailures],
  })
  expect(
    result.map((value) =>
      value.status === 'matched_observed_failure' ? value.sourceRead.nativeCallSha256 : null,
    ),
  ).toEqual([first, second])
  for (const sourceFailures of [
    [],
    [fact(first), fact(first)],
    [{ ...fact(first), requestSha256: 'd'.repeat(64) }],
  ]) {
    expect(
      correlateSourceReadFailures(leaves, { ...observation, events: [], sourceFailures }).every(
        (value) => value.status === 'unknown',
      ),
    ).toBe(true)
  }
  for (const extra of [
    { sourceFailuresComplete: false },
    { droppedObserved: true },
    { sourceFailuresOmitted: 1, sourceFailuresComplete: false },
    { diagnosticStatus: null },
    { diagnosticStatus: { state: 'closed', dropped: 0 } },
    { diagnosticStatus: { state: 'ready', dropped: 1 } },
  ] as const)
    expect(
      correlateSourceReadFailures(leaves, {
        ...observation,
        events: [],
        sourceFailures: [...observation.sourceFailures],
        ...extra,
      }).every((value) => value.status === 'unknown'),
    ).toBe(true)
  expect(
    correlateSourceReadFailures([{ ...leaves[0]!, nativeCallUnique: false }], {
      ...observation,
      events: [],
      sourceFailures: [...observation.sourceFailures],
    })[0]?.status,
  ).toBe('unknown')
})

test('the bounded log collector preserves only closed source failures and exposes gaps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-source-failure-log-'))
  const directory = join(root, 'logs/development'),
    path = join(directory, 'pact-0.jsonl')
  const sourceRead = sourceReadDiagnosticSchema.parse({
    version: 'source-read-failure-v1',
    form: 'nativeRoot',
    source: 'inputs',
    offset: 4096,
    nativeCallSha256: 'a'.repeat(64),
    requestSha256: 'b'.repeat(64),
    entryOwner: 'passed',
    rootBinding: 'passed',
    currentBeforeRead: 'passed',
    readerEntered: true,
    stage: 'repository_scope',
  })
  const record = {
    timestamp: new Date().toISOString(),
    identity: { launchId: randomUUID(), appVersion: '0.4.0', process: 'utility', pid: 1 },
    operation: 'native_check',
    phase: 'failed',
    sourceRead,
  }
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(path, JSON.stringify(record) + '\n')
    const fixture = { databaseFile: join(root, 'fixture.sqlite') }
    const complete = await routingSafeLogPhases(fixture)
    expect(complete).toMatchObject({
      sourceFailures: [sourceRead],
      sourceFailuresComplete: true,
      droppedObserved: false,
      diagnosticStatus: null,
    })
    await writeFile(
      path,
      [
        record,
        { ...record, sourceRead: { ...sourceRead, message: 'PRIVATE_ERROR_MUST_NOT_ESCAPE' } },
        { ...record, operation: 'queue', phase: 'dropped', count: 1, sourceRead: undefined },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n',
    )
    const unsafe = await routingSafeLogPhases(fixture)
    expect(unsafe).toMatchObject({
      sourceFailures: [sourceRead],
      sourceFailuresComplete: false,
      droppedObserved: true,
    })
    expect(JSON.stringify(unsafe)).not.toContain('PRIVATE_ERROR_MUST_NOT_ESCAPE')
    await writeFile(path, Array.from({ length: 5 }, () => JSON.stringify(record)).join('\n') + '\n')
    expect(await routingSafeLogPhases(fixture)).toMatchObject({
      sourceFailuresOmitted: 1,
      sourceFailuresComplete: false,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed Source diagnostics distinguish an actual empty object from missing arguments', () => {
  const f = routingCodeModeFixture()
  const item = requiredEvidenceRecord(f.records[4]!.payload['item'])
  item['status'] = 'failed'
  item['arguments'] = {}
  item['error'] = { message: 'private-error-must-not-escape' }
  delete item['result']
  const facts = inspectRoutingSourceRecords(f.records, f.expected)
  expect(facts.allToolsAllowed).toBe(false)
  expect(Reflect.get(facts.boundaryDiagnostics.failedLeaves[0]!.arguments, 'kind')).toBe('object')
})

test('failed Source script diagnostics retain data flow without literal or identifier secrets', () => {
  const secret = 'private-token-must-not-leave-owner'
  const script = `const privateName = await tools.mcp__pact_peer_${'a'.repeat(32)}__read_collaboration_source({sourceReference: "${secret}", offset:0}); const parsedValue=JSON.parse(privateName.content[0].text); const index=JSON.parse(parsedValue.text); await tools.mcp__pact_peer_${'a'.repeat(32)}__read_collaboration_source(index.clarificationAnswerRead); // ${secret}`
  const result = sourceReadFailureScript(script)
  expect(result.status).toBe('observed')
  expect(result.skeleton).toContain('JSON.parse(')
  expect(result.skeleton).toContain('.clarificationAnswerRead)')
  expect(result.skeleton).toContain('.content[0].text')
  expect(result.skeleton).not.toContain(secret)
  expect(result.skeleton).not.toContain('privateName')
  expect(JSON.stringify(result)).not.toContain('pact_peer_')
  expect(sourceReadFailureScript(' '.repeat(8193)).status).toBe('unavailable')
})

test.each(['before', 'after', 'changed'] as const)(
  'Source fingerprint diagnostics do not trust a token offered %s',
  (mode) => {
    const f = routingBatchBodyFixture()
    const payload = Buffer.from(
      JSON.stringify({
        version: 'pact-source-reference-v1',
        request: {
          runId: f.expected.runId,
          grant: f.grant,
          source: 'document',
          document: f.document,
        },
      }),
    ).toString('base64url')
    const token = `p1.${payload}.${createHmac('sha256', Buffer.alloc(32, 19)).update(payload).digest('base64url')}`
    f.index['bodyRead'] = { sourceReference: token, offset: 0 }
    f.indexPage['text'] = JSON.stringify(f.index)
    f.block['text'] = JSON.stringify(f.indexPage)
    const failure = structuredClone(f.records[4]!)
    const item = requiredEvidenceRecord(failure.payload['item'])
    item['id'] = 'diagnostic-only-failed-reference'
    item['status'] = 'failed'
    item['arguments'] = {
      sourceReference:
        mode === 'changed' ? token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A') : token,
      offset: 0,
    }
    item['error'] = { message: 'private-error-must-not-escape' }
    delete item['result']
    f.records.splice(mode === 'after' ? 3 : 4, 0, failure)
    const result = inspectRoutingSourceRecords(f.records, f.expected)
    expect(result.allToolsAllowed).toBe(false)
    expect(result.sourceReferenceDiagnostics.issued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sha256: evidenceSha(token),
          chars: token.length,
          documentSha256: f.document.sha256,
        }),
      ]),
    )
    expect(result.sourceReferenceDiagnostics.submitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          encodingValid: true,
          exactIssuedBeforeObservedCallRecord: mode === 'before',
        }),
      ]),
    )
    expect(JSON.stringify(result.sourceReferenceDiagnostics)).not.toContain(token)
    expect(JSON.stringify(result.sourceReferenceDiagnostics)).not.toContain(f.grant)
  },
)

test.each(['exact', 'changed-id', 'changed-bytes'] as const)(
  'native Source fingerprints distinguish %s from offered arguments',
  (mode) => {
    const f = nativeRootSourceFixture(),
      indexItem = requiredEvidenceRecord(f.records[3]!.payload['item']),
      indexResult = requiredEvidenceRecord(indexItem['result']),
      indexContent = indexResult['content']
    if (!Array.isArray(indexContent)) throw Error('Missing controlled index content')
    const block = requiredEvidenceRecord(indexContent[0]),
      page = requiredEvidenceRecord(JSON.parse(String(block['text']))),
      index = requiredEvidenceRecord(JSON.parse(String(page['text'])))
    const original = requiredEvidenceRecord(f.records[4]!.payload['item']),
      provided = structuredClone(requiredEvidenceRecord(original['arguments']))
    if (!Array.isArray(index['members'])) throw Error('Missing controlled Source members')
    requiredEvidenceRecord(index['members'][0])['bodyRead'] = provided
    page['text'] = JSON.stringify(index)
    block['text'] = JSON.stringify(page)
    requiredEvidenceRecord(requiredEvidenceRecord(indexResult['_meta'])['pactSourceRoot'])[
      'pageSha256'
    ] = evidenceSha(JSON.stringify(collaborationSourceWireResultSchema.parse(page)))
    const failed = structuredClone(f.records[4]!),
      item = requiredEvidenceRecord(failed.payload['item']),
      argumentsValue = structuredClone(provided),
      doc = requiredEvidenceRecord(argumentsValue['document'])
    if (mode === 'changed-id') doc['id'] = randomUUID()
    if (mode === 'changed-bytes') doc['bytes'] = Number(doc['bytes']) + 1
    item['id'] = 'native-fingerprint-failure'
    item['arguments'] = argumentsValue
    item['status'] = 'failed'
    delete item['result']
    item['error'] = { message: 'The peer Tool request failed.' }
    f.records.splice(5, 0, failed)
    const facts = inspectRoutingSourceRecords(f.records, f.expected),
      native = facts.nativeArgumentDiagnostics
    const canonical = collaborationSourceNativeReadSchema.parse(argumentsValue),
      hash = evidenceSha(JSON.stringify(canonical)),
      submission = native.submitted.find((x) => x.requestSha256 === hash && x.callOrdinal === 6)
    expect(facts.allToolsAllowed).toBe(false)
    expect(native.offered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentIdSha256: evidenceSha(String(requiredEvidenceRecord(provided['document'])['id'])),
        }),
      ]),
    )
    expect(submission).toMatchObject({
      exactOfferedBeforeRecord: mode === 'exact',
      documentSha256: requiredEvidenceRecord(provided['document'])['sha256'],
    })
    expect(JSON.stringify(native)).not.toContain(f.grant)
    expect(JSON.stringify(native)).not.toContain(String(doc['id']))
  },
)

test.each([
  'valid',
  'valid-pages',
  'wrong-ordinal',
  'missing-part',
  'mixed-document',
  'wrong-document-page',
  'untrusted-index',
  'before-index',
  'canonical-proof',
  'explicit-next',
])(
  'current NativeRoot document audit requires authenticated original index mapping: %s',
  (mode) => {
    const f = nativeRootSourceFixture(true),
      batchItem = requiredEvidenceRecord(f.records[3]!.payload['item']),
      documentItem = requiredEvidenceRecord(f.records[4]!.payload['item']),
      batchResult = requiredEvidenceRecord(batchItem['result']),
      documentResult = requiredEvidenceRecord(documentItem['result'])
    const block = (result: Record<string, unknown>) => {
      const content = result['content']
      if (!Array.isArray(content)) throw Error('Missing controlled Native page')
      return requiredEvidenceRecord(content[0])
    }
    const batchBlock = block(batchResult),
      documentBlock = block(documentResult),
      batchPage = requiredEvidenceRecord(JSON.parse(String(batchBlock['text']))),
      index = requiredEvidenceRecord(JSON.parse(String(batchPage['text']))),
      members = index['members']
    if (!Array.isArray(members)) throw Error('Missing frozen members')
    const member = requiredEvidenceRecord(members[0]),
      selector = {
        context: 'native-root-v1',
        source: 'root_document',
        part: 'comment',
        ordinal: 0,
        offset: 0,
      }
    member['bodyRead'] = selector
    batchPage['text'] = JSON.stringify(index)
    batchPage['members'] = [{ commentId: member['commentId'], bodyRead: selector }]
    const authenticatedBatch = collaborationSourceWireResultSchema.parse(batchPage)
    batchBlock['text'] = JSON.stringify(authenticatedBatch)
    requiredEvidenceRecord(requiredEvidenceRecord(batchResult['_meta'])['pactSourceRoot'])[
      'pageSha256'
    ] =
      mode === 'untrusted-index' ? '0'.repeat(64) : evidenceSha(JSON.stringify(authenticatedBatch))
    documentItem['arguments'] = {
      ...selector,
      ...(mode === 'wrong-ordinal' ? { ordinal: 1 } : {}),
      ...(mode === 'missing-part' ? { part: undefined } : {}),
      ...(mode === 'mixed-document' ? { document: member['body'] } : {}),
    }
    const page = requiredEvidenceRecord(JSON.parse(String(documentBlock['text'])))
    if (mode === 'wrong-document-page')
      requiredEvidenceRecord(page['document'])['id'] = randomUUID()
    if (mode === 'explicit-next') {
      page['nextOffset'] = 1
      page['nextRead'] = {
        context: 'native-root-v1',
        source: 'document',
        document: member['body'],
        offset: 1,
      }
    }
    let continuation: (typeof f.records)[number] | undefined
    if (mode === 'valid-pages') {
      const complete = String(page['text']),
        split = 11
      page['text'] = complete.slice(0, split)
      page['nextOffset'] = split
      page['nextRead'] = { ...selector, offset: split }
      continuation = structuredClone(f.records[4]!)
      const tail = requiredEvidenceRecord(continuation.payload['item']),
        result = requiredEvidenceRecord(tail['result']),
        body = block(result),
        tailPage: Record<string, unknown> = {
          ...page,
          text: complete.slice(split),
          offset: split,
          nextOffset: null,
        }
      delete tailPage['nextRead']
      tail['id'] = 'current-selector-second-page'
      tail['arguments'] = { ...selector, offset: split }
      const wire = collaborationSourceWireResultSchema.parse(tailPage),
        proof = requiredEvidenceRecord(requiredEvidenceRecord(result['_meta'])['pactSourceRoot'])
      body['text'] = JSON.stringify(wire)
      proof['requestSha256'] = evidenceSha(
        JSON.stringify(collaborationSourceNativeReadSchema.parse(tail['arguments'])),
      )
      proof['pageSha256'] = evidenceSha(JSON.stringify(wire))
    }
    const wirePage = collaborationSourceWireResultSchema.parse(page)
    documentBlock['text'] = JSON.stringify(wirePage)
    const proof = requiredEvidenceRecord(
      requiredEvidenceRecord(documentResult['_meta'])['pactSourceRoot'],
    )
    proof['requestSha256'] = evidenceSha(
      JSON.stringify(
        mode === 'canonical-proof'
          ? {
              source: 'document',
              document: member['body'],
              offset: 0,
              runId: f.expected.runId,
              grant: f.grant,
            }
          : documentItem['arguments'],
      ),
    )
    proof['pageSha256'] = evidenceSha(JSON.stringify(wirePage))
    if (continuation) f.records.splice(5, 0, continuation)
    if (mode === 'before-index') [f.records[3], f.records[4]] = [f.records[4]!, f.records[3]!]
    const facts = inspectRoutingSourceRecords(f.records, f.expected),
      valid = mode === 'valid' || mode === 'valid-pages'
    expect(facts.allToolsAllowed).toBe(valid)
    expect(facts.sourceGrantMatched).toBe(valid)
    expect(!valid || facts.completeComment).toBe(true)
    expect(!valid || facts.submittedForms.nativeRoot === (mode === 'valid-pages' ? 3 : 2)).toBe(
      true,
    )
    expect(mode === 'valid' ? facts.nativeArgumentDiagnostics.submitted[1] : null).toEqual(
      mode === 'valid'
        ? {
            requestSha256: evidenceSha(
              JSON.stringify(collaborationSourceNativeReadSchema.parse(selector)),
            ),
            documentIdSha256: null,
            documentSha256: null,
            selector: { part: 'comment', ordinal: 0 },
            callOrdinal: 5,
            exactOfferedBeforeRecord: true,
          }
        : null,
    )
  },
)
