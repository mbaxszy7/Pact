import { build } from 'electron-vite'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

import type { AgentNativeForkWitness } from '@pact/contracts'

import { LogicalIpcWorkerTraffic } from '../../shared/logical-ipc-traffic'
import {
  NativeForkFiles,
  type NativeForkFileInput,
  type NativeForkHistoryReference,
  type NativeForkFileResult,
} from './native-fork-files'
import { NativeWorkingMemory, NATIVE_OWNER_WORKING_BYTES } from './native-working-memory'

const workerLocation = vi.hoisted(() => ({
  path: '',
  live: 0,
  started: 0,
  throwNext: false,
  last: undefined as import('node:worker_threads').Worker | undefined,
}))
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(
        _filename: ConstructorParameters<typeof actual.Worker>[0],
        options?: ConstructorParameters<typeof actual.Worker>[1],
      ) {
        if (workerLocation.throwNext) {
          workerLocation.throwNext = false
          throw new Error('Controlled Worker construction failure')
        }
        super(workerLocation.path, options)
        workerLocation.live += 1
        workerLocation.started += 1
        workerLocation.last = this
        this.once('exit', () => {
          workerLocation.live -= 1
        })
      }
    },
  }
})
let directory: string
const traffic = new LogicalIpcWorkerTraffic(
  ['utility-native-fork'],
  '00000000-0000-4000-8000-000000000001',
)
const files = new NativeForkFiles(traffic)
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pact-fork-worker-test-'))
  const desktopRoot = resolve(import.meta.dirname, '../../..')
  const require = createRequire(join(desktopRoot, 'package.json'))
  const configFile = join(directory, 'worker.config.mjs')
  await writeFile(
    configFile,
    `import {externalizeDepsPlugin} from ${JSON.stringify(pathToFileURL(require.resolve('electron-vite')).href)}; export default {main:{plugins:[externalizeDepsPlugin({exclude:['@pact/contracts']})],build:{outDir:${JSON.stringify(join(directory, 'bundle'))},rollupOptions:{input:{'native-fork-worker':${JSON.stringify(join(import.meta.dirname, 'native-fork-worker.ts'))}}}}}};`,
  )
  await build({ root: desktopRoot, configFile, ignoreConfigWarning: true, logLevel: 'silent' })
  workerLocation.path = join(directory, 'bundle', 'native-fork-worker.js')
}, 20_000)
afterAll(async () => {
  await files.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
})
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

async function claudeAccountingFixture() {
  const profile = join(directory, randomUUID()),
    nativeSessionId = randomUUID(),
    nativeTurnId = randomUUID()
  const project = join(
    profile,
    'projects',
    (await realpath(directory)).replace(/[^a-z0-9]/giu, '-'),
  )
  await mkdir(project, { recursive: true })
  const original =
    [
      {
        type: 'user',
        uuid: nativeTurnId,
        parentUuid: null,
        message: { role: 'user', content: 'Original request' },
      },
      {
        type: 'assistant',
        uuid: randomUUID(),
        parentUuid: nativeTurnId,
        message: {
          id: 'answer',
          role: 'assistant',
          content: [{ type: 'text', text: 'Original answer' }],
        },
      },
    ]
      .map((row) =>
        JSON.stringify({
          ...row,
          sessionId: nativeSessionId,
          cwd: directory,
          timestamp: new Date().toISOString(),
        }),
      )
      .join('\n') + '\n'
  const sourcePath = join(project, nativeSessionId + '.jsonl')
  await writeFile(sourcePath, original)
  vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
  const signal = new AbortController().signal
  const prepared = await files.execute(
    {
      provider: 'claude',
      action: 'prepare',
      cwd: directory,
      nativeSessionId,
      nativeTurnId,
      responseHash: hash('Original answer'),
    },
    signal,
  )
  const source = {
    nativeSessionId,
    nativeTurnId,
    nativeCutId: prepared.nativeCutId,
    prefixHash: prepared.prefixHash,
    prefixBytes: prepared.prefixBytes,
    prefixRecords: prepared.prefixRecords,
    bindingGeneration: 1,
    throughSequence: 1,
    deliveryCursor: 1,
  }
  const candidate = await files.execute(
    { provider: 'claude', action: 'fork', cwd: directory, nativeSessionId, nativeTurnId, source },
    signal,
    async () => {},
  )
  const candidateWitness: AgentNativeForkWitness = {
    version: 'pact-native-fork-v1',
    nativeSessionId: candidate.nativeSessionId,
    sourceNativeSessionId: nativeSessionId,
    sourceCutId: source.nativeCutId,
    sourcePrefixHash: prepared.prefixHash,
    candidatePrefixHash: candidate.prefixHash,
    candidatePrefixRecords: candidate.rawRecords,
    idMap: candidate.idMap,
    model: null,
    effort: null,
    permissionMode: 'native',
  }
  const witnessPath = join(profile, 'witness.json')
  await writeFile(witnessPath, JSON.stringify(candidateWitness))
  const saved: AgentNativeForkWitness = JSON.parse(await readFile(witnessPath, 'utf8'))
  const inspect: NativeForkFileInput = {
    provider: 'claude',
    action: 'inspect',
    cwd: directory,
    nativeSessionId: candidate.nativeSessionId,
    source,
    witness: saved,
  }
  return {
    sourcePath,
    original,
    candidate,
    inspect,
    signal,
    accounting: {
      type: 'cost-state',
      sessionId: candidate.nativeSessionId,
      totalCostUSD: 0,
      totalAPIDuration: 0,
      totalAPIDurationWithoutRetries: 0,
      totalToolDuration: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalDuration: 729,
      startTime: 1791863570955,
      modelUsage: {},
      hasUnknownModelCost: false,
    } as Record<string, unknown>,
  }
}

it.skipIf(process.platform !== 'win32').each(['empty', 'positive'] as const)(
  'Windows Claude Fork accepts exact %s accounting without changing its frozen history',
  async (shape) => {
    try {
      const fixture = await claudeAccountingFixture()
      if (shape === 'positive')
        Object.assign(fixture.accounting, {
          totalCostUSD: 1,
          totalAPIDuration: 10,
          modelUsage: {
            model: {
              inputTokens: 1,
              outputTokens: 2,
              thinkingTokens: 1,
              cacheReadInputTokens: 3,
              cacheCreationInputTokens: 4,
              webSearchRequests: 0,
              costUSD: 1,
            },
          },
        })
      await appendFile(fixture.candidate.nativePath!, JSON.stringify(fixture.accounting) + '\n')
      const bytes = await readFile(fixture.candidate.nativePath!, 'utf8')
      const checked = await files.execute(fixture.inspect, fixture.signal)
      expect(checked.prefixHash).toBe(fixture.candidate.prefixHash)
      expect(checked.idMap).toEqual(fixture.candidate.idMap)
      expect(checked.initializedVerified).toBe(false)
      const ready = {
        ...fixture.inspect,
        witness: {
          ...fixture.inspect.witness!,
          initializedAt: new Date().toISOString(),
          initializedPrefixHash: checked.rawHash,
          initializedPrefixBytes: checked.rawBytes,
          initializedPrefixRecords: checked.rawRecords,
        },
      }
      expect((await files.execute(ready, fixture.signal)).initializedVerified).toBe(true)
      expect(await readFile(fixture.candidate.nativePath!, 'utf8')).toBe(bytes)
      await appendFile(
        fixture.candidate.nativePath!,
        JSON.stringify({
          type: 'custom-title',
          sessionId: fixture.candidate.nativeSessionId,
          customTitle: 'Later title',
        }) + '\n',
      )
      expect((await files.execute(ready, fixture.signal)).initializedVerified).toBe(false)
      expect(await readFile(fixture.sourcePath, 'utf8')).toBe(fixture.original)
      expect(workerLocation.live).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  },
)

it.each([
  'identity',
  'missing',
  'extra',
  'negative',
  'overflow',
  'usd',
  'usage_array',
  'usage_extra',
  'usage_tokens',
  'user',
  'assistant',
  'compact',
  'prefix',
] as const)('Claude Fork still rejects %s changes beside accounting metadata', async (change) => {
  try {
    const fixture = await claudeAccountingFixture()
    const row = fixture.accounting
    if (change === 'identity') row.sessionId = randomUUID()
    if (change === 'missing') delete row.totalDuration
    if (change === 'extra') row.message = 'Extra context'
    if (change === 'negative') row.totalDuration = -1
    if (change === 'overflow') row.totalDuration = 1e15 + 1
    if (change === 'usd') row.totalCostUSD = 1e9 + 1
    if (change === 'usage_array') row.modelUsage = []
    if (change === 'usage_extra')
      row.modelUsage = {
        model: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0,
          message: 'Extra context',
        },
      }
    if (change === 'usage_tokens')
      row.modelUsage = Object.fromEntries(
        ['first', 'second'].map((model) => [
          model,
          {
            inputTokens: 1e15,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0,
          },
        ]),
      )
    await appendFile(fixture.candidate.nativePath!, JSON.stringify(row) + '\n')
    if (change === 'user' || change === 'assistant' || change === 'compact')
      await appendFile(
        fixture.candidate.nativePath!,
        JSON.stringify({
          type: change === 'compact' ? 'system' : change,
          uuid: randomUUID(),
          sessionId: fixture.candidate.nativeSessionId,
          ...(change === 'compact'
            ? { compactMetadata: {} }
            : { message: { role: change, content: 'Another turn' } }),
        }) + '\n',
      )
    if (change === 'prefix') {
      const bytes = await readFile(fixture.candidate.nativePath!, 'utf8')
      await writeFile(
        fixture.candidate.nativePath!,
        bytes.replace('Original request', 'Changed request'),
      )
    }
    await expect(files.execute(fixture.inspect, fixture.signal)).rejects.toThrow(
      /cutoff|prefix|changed/iu,
    )
    expect(await readFile(fixture.sourcePath, 'utf8')).toBe(fixture.original)
    expect(workerLocation.live).toBe(0)
  } finally {
    vi.unstubAllEnvs()
  }
})

it.skipIf(process.platform === 'win32')(
  'non-Windows Claude Fork retains its original accounting rejection',
  async () => {
    try {
      const fixture = await claudeAccountingFixture()
      await appendFile(fixture.candidate.nativePath!, JSON.stringify(fixture.accounting) + '\n')
      await expect(files.execute(fixture.inspect, fixture.signal)).rejects.toThrow(/cutoff/iu)
    } finally {
      vi.unstubAllEnvs()
    }
  },
)
const claudeForkProof = {
  natural: async (
    preparation: ReturnType<typeof files.execute>,
    sessionId: string,
    turnId: string,
  ) => {
    const prepared = await preparation
    expect(prepared.nativeSessionId).toMatch(/^[a-f0-9-]{36}$/u)
    expect(prepared.nativeSessionId).not.toBe(sessionId)
    expect(prepared.idMap.map(([source]) => source)).toContain(turnId)
    expect(prepared.prefixHash).toMatch(/^[a-f0-9]{64}$/u)
  },
  wrong_hash: async (
    preparation: ReturnType<typeof files.execute>,
    _sessionId: string,
    _turnId: string,
  ) => {
    await expect(preparation).rejects.toThrow(/does not match the complete selected Pact answer/iu)
  },
}
it.each(['natural', 'wrong_hash'] as const)(
  'reads the exact v5 Claude root and validates its %s Fork proof without a Query',
  async (proof) => {
    const answerFormat = 'collaboration_envelope_v5' as const
    const profile = join(directory, randomUUID()),
      nativeSessionId = randomUUID(),
      nativeTurnId = randomUUID(),
      answerId = randomUUID(),
      projectDirectory = join(
        profile,
        'projects',
        (await realpath(directory)).replace(/[^a-z0-9]/giu, '-'),
      ),
      plan = 'The full plan exists only in the submitted report.\n'.repeat(2000),
      report = {
        submission: 'plan_submission',
        inputResponses: [],
        outcome: 'complete',
        summary: 'Plan inspected.',
        plan,
        todoDeltas: [],
      },
      envelope = {
        version: 'pact-collaboration-envelope-v5',
        answer: 'Natural argument.',
        result: report,
      }
    await mkdir(projectDirectory, { recursive: true })
    const records =
      [
        {
          type: 'user',
          uuid: nativeTurnId,
          parentUuid: null,
          message: { role: 'user', content: 'Inspect scope.' },
        },
        {
          type: 'assistant',
          uuid: answerId,
          parentUuid: nativeTurnId,
          message: {
            id: 'native-answer',
            role: 'assistant',
            content: [{ type: 'text', text: 'Original prose.' }],
          },
        },
        {
          type: 'attachment',
          uuid: randomUUID(),
          parentUuid: answerId,
          attachment: { type: 'structured_output', data: envelope },
        },
        {
          type: 'attachment',
          uuid: randomUUID(),
          parentUuid: randomUUID(),
          attachment: {
            type: 'structured_output',
            data: { ...envelope, answer: 'Detached wrong source.' },
          },
        },
      ]
        .map((record) =>
          JSON.stringify({ ...record, sessionId: nativeSessionId, cwd: directory, timestamp }),
        )
        .join('\n') + '\n'
    await writeFile(join(projectDirectory, `${nativeSessionId}.jsonl`), records)
    vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
    try {
      const restored = await files.readAnswer(
        { cwd: directory, nativeSessionId, nativeTurnId, answerFormat },
        new AbortController().signal,
      )
      expect(restored.answer).toBe(envelope.answer)
      expect(hash(restored.answer!)).toBe(hash(envelope.answer))
      expect(restored.submittedReport).toEqual(report)
      const preparation = files.execute(
        {
          provider: 'claude',
          action: 'prepare',
          cwd: directory,
          nativeSessionId,
          nativeTurnId,
          answerFormat,
          responseHash: hash(proof === 'natural' ? envelope.answer : 'Foreign answer'),
        },
        new AbortController().signal,
      )
      await claudeForkProof[proof](preparation, nativeSessionId, nativeTurnId)
      expect(workerLocation.live).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  },
)
const timestamp = '2026-10-04T00:00:00.000Z'
const start = (turnId: string) => ({
  type: 'event_msg',
  payload: { type: 'task_started', turn_id: turnId },
})
const complete = (turnId: string) => ({
  type: 'event_msg',
  payload: { type: 'task_complete', turn_id: turnId },
})
const compact = () => ({
  type: 'compacted',
  payload: {
    message: 'Summary',
    replacement_history: [{ type: 'context_compaction', encrypted_content: 'OPAQUE_A' }],
    replacement_history_metadata: [{ client_authored: false }],
    window_number: 1,
    compaction_response_id: null,
    latest_token_usage_record: null,
  },
})
const baseline = () => [
  { type: 'session_meta', payload: { id: 'source', history_mode: 'legacy' } },
  start('t0'),
  { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't0', reason: 'interrupted' } },
  start('t1'),
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Answer' }],
    },
    metadata: { client_authored: false },
  },
  complete('t1'),
  compact(),
  start('t2'),
]
async function input(records: unknown[], nativeSessionId = 'source'): Promise<NativeForkFileInput> {
  const storageRoot = join(directory, randomUUID())
  await mkdir(storageRoot)
  const path = join(storageRoot, 'rollout.jsonl')
  await writeFile(
    path,
    records
      .map((record) => {
        if (!record || typeof record !== 'object' || Array.isArray(record))
          throw new TypeError('Invalid native fixture record.')
        return JSON.stringify({ timestamp, ...record })
      })
      .join('\n') + '\n',
  )
  return {
    provider: 'codex',
    action: 'prepare',
    cwd: directory,
    nativeSessionId,
    nativeTurnId: 't1',
    responseHash: hash('Answer'),
    storageRoot,
    path,
  }
}
function witness(prefix: {
  prefixHash: string
  idMap: Array<[string, string]>
}): AgentNativeForkWitness {
  return {
    version: 'pact-native-fork-v1',
    sourceNativeSessionId: 'source',
    nativeSessionId: 'child',
    sourceCutId: 't1',
    sourcePrefixHash: prefix.prefixHash,
    candidatePrefixHash: prefix.prefixHash,
    idMap: prefix.idMap,
    model: null,
    effort: null,
    permissionMode: 'native',
  }
}
it('retains opaque gap compaction and every real inherited turn, including interrupted history', async () => {
  const source = await input(baseline())
  const prefix = await files.execute(source, new AbortController().signal)
  expect(prefix.idMap).toEqual([
    ['t0', 't0'],
    ['t1', 't1'],
  ])
  const childRecords = [
    {
      type: 'session_meta',
      payload: { id: 'child', history_mode: 'legacy', forked_from_id: 'source' },
    },
    ...baseline().slice(0, -1),
  ]
  const candidate = await input(childRecords, 'child')
  expect(
    (
      await files.execute(
        { ...candidate, action: 'inspect', witness: witness(prefix) },
        new AbortController().signal,
      )
    ).prefixHash,
  ).toBe(prefix.prefixHash)
})
it.each(['opaque', 'metadata', 'marker', 'extra_compaction', 'extra_turn'] as const)(
  'rejects candidate %s changes before initialization',
  async (change) => {
    const prefix = await files.execute(await input(baseline()), new AbortController().signal)
    const records: unknown[] = [
      { type: 'session_meta', payload: { id: 'child', forked_from_id: 'source' } },
      ...baseline().slice(0, -1),
    ]
    if (change === 'opaque')
      records[records.length - 1] = {
        ...compact(),
        payload: {
          ...compact().payload,
          replacement_history: [{ type: 'context_compaction', encrypted_content: 'OPAQUE_B' }],
        },
      }
    if (change === 'metadata')
      records[records.length - 1] = {
        ...compact(),
        payload: {
          ...compact().payload,
          replacement_history_metadata: [{ client_authored: true }],
        },
      }
    if (change === 'marker')
      records[2] = {
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 'forged', reason: 'interrupted' },
      }
    if (change === 'extra_compaction') records.push(compact())
    if (change === 'extra_turn') records.push(start('t2'), complete('t2'))
    const candidate = await input(records, 'child')
    await expect(
      files.execute(
        { ...candidate, action: 'inspect', witness: witness(prefix) },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/prefix|identity|turn|marker|pair/iu)
  },
)
it.each([
  { history_mode: 'paginated' },
  { history_mode: null },
  { history_mode: 'unknown' },
  { history_base: { thread_id: 'ancestor', end_ordinal_exclusive: 1, end_byte_offset: 100 } },
])('refuses incomplete root history %j before producing a prefix', async (header) => {
  const records: unknown[] = baseline()
  records[0] = { type: 'session_meta', payload: { id: 'source', ...header } }
  await expect(files.execute(await input(records), new AbortController().signal)).rejects.toThrow(
    /history|reference|legacy/iu,
  )
})
it('rejects an unknown field on an error record and honours cancellation without retaining a worker', async () => {
  const records: unknown[] = baseline()
  records.splice(5, 0, {
    type: 'event_msg',
    payload: { type: 'error', message: 'Control', context: 'unverified' },
  })
  await expect(files.execute(await input(records), new AbortController().signal)).rejects.toThrow(
    /error|unsupported|context|field/iu,
  )
  const controller = new AbortController()
  controller.abort(new Error('Cancelled fork preparation'))
  await expect(files.execute(await input(baseline()), controller.signal)).rejects.toThrow(
    /Cancelled/u,
  )
  expect(
    (await files.execute(await input(baseline()), new AbortController().signal)).idMap,
  ).toHaveLength(2)
})

it('returns owned workers to zero across 100 success, error and cancellation cycles', async () => {
  const valid = await input(baseline()),
    invalid = await input([
      { type: 'session_meta', payload: { id: 'source', history_mode: 'paginated' } },
      ...baseline().slice(1),
    ])
  const before = workerLocation.started
  // oxlint-disable no-await-in-loop -- Each lifecycle cycle must release its worker before the next admission.
  for (let cycle = 0; cycle < 100; cycle++) {
    const controller = new AbortController()
    if (cycle % 3 === 2) controller.abort(new Error('Lifecycle cancellation'))
    const outcome = await files.execute(cycle % 3 === 1 ? invalid : valid, controller.signal).then(
      () => ({ ok: true, error: '' }),
      (error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    expect(outcome.ok).toBe(cycle % 3 === 0)
    expect(outcome.error).toMatch(
      cycle % 3 === 0 ? /^$/u : cycle % 3 === 1 ? /history|legacy/iu : /Lifecycle cancellation/u,
    )
    expect(workerLocation.live).toBe(0)
  }
  // oxlint-enable no-await-in-loop
  expect(workerLocation.started - before).toBe(67)
}, 15_000)

type PagedRecord = { type: string; payload: Record<string, unknown>; [key: string]: unknown }
const pagedText = (records: PagedRecord[], first = 0) =>
  records
    .map((record, index) => JSON.stringify({ timestamp, ordinal: first + index, ...record }))
    .join('\n') + '\n'
async function pagedFixture() {
  const sourceId = randomUUID(),
    childId = randomUUID()
  const records: PagedRecord[] = [
    {
      type: 'session_meta',
      payload: { id: sourceId, session_id: sourceId, history_mode: 'paginated' },
    },
    start('t1'),
    { type: 'world_state', payload: { full: true, state: { opaque: 'A' } } },
    { type: 'turn_context', payload: { turn_id: 't1', private_context: 'A' } },
    {
      type: 'response_item',
      payload: { type: 'reasoning', encrypted_content: 'OPAQUE_A' },
      metadata: { retained_source: { revision: 'A' } },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call', name: 'owned', call_id: 'c1', arguments: '{}' },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c1', output: 'OPAQUE_TOOL' },
    },
    { type: 'token_usage_record', payload: { turn_id: 't1', private_usage: 'A' } },
    compact(),
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Answer' }],
      },
    },
    complete('t1'),
    start('t2'),
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Later' }],
      },
    },
    complete('t2'),
  ]
  const source = await input([], sourceId)
  source.historyMode = 'paginated'
  await writeFile(source.path!, pagedText(records))
  const prefix = await files.execute(source, new AbortController().signal)
  const historyBase: {
    thread_id: string
    end_ordinal_exclusive: number
    end_byte_offset: number
  } = {
    thread_id: sourceId,
    end_ordinal_exclusive: 11,
    end_byte_offset: Buffer.byteLength(pagedText(records.slice(0, 11))),
  }
  const own: PagedRecord[] = [
    {
      type: 'session_meta',
      payload: {
        id: childId,
        session_id: childId,
        history_mode: 'paginated',
        forked_from_id: sourceId,
        forked_from_ordinal_exclusive: 11,
        history_base: historyBase,
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_id: childId,
        thread_settings: { model: 'owned' },
      },
    },
  ]
  const child: NativeForkFileInput = {
    provider: 'codex',
    action: 'inspect',
    cwd: directory,
    nativeSessionId: childId,
    nativeTurnId: 't1',
    historyMode: 'paginated',
    storageRoot: source.storageRoot!,
    path: join(source.storageRoot!, 'child.jsonl'),
  }
  await writeFile(child.path!, pagedText(own, 11))
  child.witness = { ...witness(prefix), nativeSessionId: childId, sourceNativeSessionId: sourceId }
  const resolveReference = async (id: string): Promise<NativeForkHistoryReference> => ({
    nativeSessionId: id,
    path: source.path!,
    historyMode: 'paginated',
  })
  return { source, child, prefix, own, records, historyBase, resolveReference }
}

it('verifies paginated opaque byte prefixes, flattened lineage and cold readiness while the parent grows', async () => {
  const fixture = await pagedFixture()
  const candidate = await files.execute(
    fixture.child,
    new AbortController().signal,
    undefined,
    fixture.resolveReference,
  )
  expect(candidate.prefixHash).toBe(fixture.prefix.prefixHash)
  expect(candidate.prefixBytes).toBe(Buffer.byteLength(pagedText(fixture.records.slice(0, 11))))
  expect(candidate.idMap).toEqual([['t1', 't1']])
  // The frozen reference stays small even when the parent's later history is oversized.
  await appendFile(fixture.source.path!, `${'x'.repeat(8 * 1024 * 1024)}\n`)
  const initialized = {
    ...fixture.child,
    witness: {
      ...fixture.child.witness!,
      nativeStorageRoot: candidate.nativeStorageRoot!,
      nativePath: candidate.nativePath!,
      initializedAt: new Date().toISOString(),
      initializedPrefixHash: candidate.rawHash,
      initializedPrefixBytes: candidate.rawBytes,
      initializedPrefixRecords: candidate.rawRecords,
    },
  }
  expect(
    (
      await files.execute(
        initialized,
        new AbortController().signal,
        undefined,
        fixture.resolveReference,
      )
    ).initializedVerified,
  ).toBe(true)
  const grandchildId = randomUUID()
  fixture.own[0]!.payload.id = grandchildId
  fixture.own[0]!.payload.session_id = grandchildId
  fixture.own[0]!.payload.forked_from_id = fixture.child.nativeSessionId
  fixture.own[1]!.payload.thread_id = grandchildId
  await writeFile(fixture.child.path!, pagedText(fixture.own, 11))
  const grandchild = {
    ...fixture.child,
    nativeSessionId: grandchildId,
    witness: {
      ...fixture.child.witness!,
      nativeSessionId: grandchildId,
      sourceNativeSessionId: fixture.child.nativeSessionId,
    },
  }
  expect(
    (
      await files.execute(
        grandchild,
        new AbortController().signal,
        undefined,
        fixture.resolveReference,
      )
    ).prefixHash,
  ).toBe(fixture.prefix.prefixHash)
})

it.each(['reasoning', 'world', 'compaction', 'token'] as const)(
  'rejects a paginated inherited %s mutation with unchanged visible answer',
  async (change) => {
    const fixture = await pagedFixture()
    if (change === 'reasoning') fixture.records[4]!.payload.encrypted_content = 'OPAQUE_B'
    if (change === 'world') fixture.records[2]!.payload.state = { opaque: 'B' }
    if (change === 'compaction')
      fixture.records[8] = {
        ...compact(),
        payload: {
          ...compact().payload,
          replacement_history: [{ type: 'context_compaction', encrypted_content: 'OPAQUE_B' }],
        },
      }
    if (change === 'token') fixture.records[7]!.payload.private_usage = 'B'
    await writeFile(fixture.source.path!, pagedText(fixture.records))
    await expect(
      files.execute(
        fixture.child,
        new AbortController().signal,
        undefined,
        fixture.resolveReference,
      ),
    ).rejects.toThrow(/frozen source/iu)
  },
)

it('retains a new branch Turn through two physical history references with local byte offsets', async () => {
  const fixture = await pagedFixture()
  fixture.own.push(
    start('t3'),
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Child' }],
      },
    },
    complete('t3'),
  )
  const childText = pagedText(fixture.own, 11)
  await writeFile(fixture.child.path!, childText)
  const sourceChild: NativeForkFileInput = {
    ...fixture.child,
    action: 'prepare',
    nativeTurnId: 't3',
    responseHash: hash('Child'),
  }
  delete sourceChild.witness
  const prefix = await files.execute(
    sourceChild,
    new AbortController().signal,
    undefined,
    fixture.resolveReference,
  )
  expect(prefix.idMap).toEqual([
    ['t1', 't1'],
    ['t3', 't3'],
  ])
  const grandchildId = randomUUID(),
    grandPath = join(fixture.source.storageRoot!, 'grandchild.jsonl')
  const own: PagedRecord[] = [
    {
      type: 'session_meta',
      payload: {
        id: grandchildId,
        session_id: grandchildId,
        history_mode: 'paginated',
        forked_from_id: fixture.child.nativeSessionId,
        forked_from_ordinal_exclusive: 16,
        history_base: {
          thread_id: fixture.child.nativeSessionId,
          end_ordinal_exclusive: 16,
          end_byte_offset: Buffer.byteLength(childText),
        },
      },
    },
    {
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_id: grandchildId, thread_settings: {} },
    },
  ]
  await writeFile(grandPath, pagedText(own, 16))
  const grandchild: NativeForkFileInput = {
    ...sourceChild,
    action: 'inspect',
    nativeSessionId: grandchildId,
    path: grandPath,
    witness: {
      ...witness(prefix),
      sourceNativeSessionId: fixture.child.nativeSessionId,
      nativeSessionId: grandchildId,
      sourceCutId: 't3',
    },
  }
  const result = await files.execute(
    grandchild,
    new AbortController().signal,
    undefined,
    async (id) => ({
      nativeSessionId: id,
      path: id === fixture.child.nativeSessionId ? fixture.child.path! : fixture.source.path!,
      historyMode: 'paginated',
    }),
  )
  expect(result.prefixHash).toBe(prefix.prefixHash)
  expect(result.prefixBytes).toBe(fixture.prefix.prefixBytes + Buffer.byteLength(childText))
})

it.each(['extra_history', 'partial_byte', 'extra_setup', 'cycle', 'wrong_parent'] as const)(
  'rejects paginated %s before readiness',
  async (change) => {
    const fixture = await pagedFixture()
    const base = fixture.historyBase
    let first = 11
    if (change === 'extra_history') {
      first = fixture.records.length
      base.end_ordinal_exclusive = first
      base.end_byte_offset = Buffer.byteLength(pagedText(fixture.records))
      fixture.own[0]!.payload.forked_from_ordinal_exclusive = first
    }
    if (change === 'partial_byte') base.end_byte_offset -= 1
    if (change === 'extra_setup')
      fixture.own.push({
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [] },
      })
    if (change === 'cycle') base.thread_id = fixture.child.nativeSessionId
    if (change === 'wrong_parent') {
      fixture.records[0]!.payload.id = fixture.child.nativeSessionId
      fixture.records[0]!.payload.session_id = fixture.child.nativeSessionId
      await writeFile(fixture.source.path!, pagedText(fixture.records))
    }
    await writeFile(fixture.child.path!, pagedText(fixture.own, first))
    const resolver =
      change === 'cycle'
        ? async (id: string): Promise<NativeForkHistoryReference> => ({
            nativeSessionId: id,
            path: fixture.child.path!,
            historyMode: 'paginated',
          })
        : fixture.resolveReference
    await expect(
      files.execute(fixture.child, new AbortController().signal, undefined, resolver),
    ).rejects.toThrow(
      /frozen completed Turn|byte boundary|extra Turn|unknown setup|cycle|header identity/iu,
    )
  },
)

it('rejects a candidate append while its history reference is resolving and releases its worker', async () => {
  const fixture = await pagedFixture()
  await expect(
    files.execute(fixture.child, new AbortController().signal, undefined, async (id) => {
      await appendFile(fixture.child.path!, pagedText([start('t2'), complete('t2')], 13))
      return fixture.resolveReference(id)
    }),
  ).rejects.toThrow(/changed while its reference closure/iu)
  expect(workerLocation.live).toBe(0)
})

it('cancels the sole pending parent read and cleans up the worker before another admission', async () => {
  const fixture = await pagedFixture()
  const entered = Promise.withResolvers<void>(),
    controller = new AbortController()
  let aborted = false
  const execution = files.execute(
    fixture.child,
    controller.signal,
    undefined,
    (_id, signal) =>
      new Promise<NativeForkHistoryReference>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new Error('Parent cancelled'))
          },
          { once: true },
        )
        entered.resolve()
      }),
  )
  const outcome = execution.catch((error: unknown) => error)
  await entered.promise
  controller.abort()
  expect(await outcome).toBeInstanceOf(Error)
  expect(aborted).toBe(true)
  expect(workerLocation.live).toBe(0)
  expect(
    (
      await files.execute(
        fixture.child,
        new AbortController().signal,
        undefined,
        fixture.resolveReference,
      )
    ).prefixHash,
  ).toBe(fixture.prefix.prefixHash)
})

it('keeps all actual Fork candidate/reference/ACK traffic and physical exits in one group', async () => {
  await files.dispose()
  expect(traffic.snapshots()[0]).toMatchObject({
    complete: true,
    activeTransports: 0,
    startedTransports: workerLocation.started,
    settledTransports: workerLocation.started,
  })
  expect(traffic.snapshots()[0]!.counters[0]!.business.messages).toBe(workerLocation.started)
  expect(traffic.snapshots()[0]!.counters[1]!.business.messages).toBeGreaterThan(0)
  expect(traffic.snapshots()[0]!.counters[2]!.business.messages).toBeGreaterThan(
    workerLocation.started,
  )
})

it('retains a rejected termination owner and shared reservation until the exact real Worker exits', async () => {
  const fixture = await pagedFixture()
  const owner = new NativeForkFiles()
  const entered = Promise.withResolvers<void>()
  const controller = new AbortController()
  const persistCandidate = vi.fn<(value: NativeForkFileResult) => Promise<void>>(
    async () => undefined,
  )
  const execution = owner.execute(
    fixture.child,
    controller.signal,
    persistCandidate,
    (_id, signal) =>
      new Promise<NativeForkHistoryReference>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('Controlled parent cancellation')),
          { once: true },
        )
        entered.resolve()
      }),
  )
  const outcome = execution.catch((error: unknown) => error)
  await entered.promise
  const worker = workerLocation.last!
  const termination = vi
    .spyOn(worker, 'terminate')
    .mockRejectedValue(new Error('Controlled termination rejection'))
  const retained = Array.from({ length: 3 }, () =>
    new NativeWorkingMemory().reserve(NATIVE_OWNER_WORKING_BYTES),
  )
  let additional: ReturnType<NativeWorkingMemory['reserve']> | undefined
  try {
    controller.abort()
    expect(await outcome).toBeInstanceOf(Error)
    expect(workerLocation.live).toBe(1)
    expect(() => {
      additional = new NativeWorkingMemory().reserve(NATIVE_OWNER_WORKING_BYTES)
    }).toThrow(/capacity is full/u)
    const started = workerLocation.started
    await expect(
      owner.execute(
        fixture.child,
        new AbortController().signal,
        undefined,
        fixture.resolveReference,
      ),
    ).rejects.toThrow(/already active/u)
    expect(workerLocation.started).toBe(started)
    worker.emit('message', {
      type: 'candidate',
      result: { ...fixture.prefix, nativeSessionId: fixture.child.nativeSessionId },
    })
    await Promise.resolve()
    expect(persistCandidate).not.toHaveBeenCalled()
    termination.mockRestore()
    await worker.terminate()
    expect(workerLocation.live).toBe(0)
    additional = new NativeWorkingMemory().reserve(NATIVE_OWNER_WORKING_BYTES)
    expect(retained.every((reservation) => reservation.bytes === NATIVE_OWNER_WORKING_BYTES)).toBe(
      true,
    )
  } finally {
    termination.mockRestore()
    await worker.terminate()
    additional?.release()
    for (const reservation of retained) reservation.release()
    await owner.dispose()
  }
}, 15_000)

it('shares pending termination between abort and disposal while replacement remains refused', async () => {
  const fixture = await pagedFixture()
  const owner = new NativeForkFiles()
  const controller = new AbortController()
  const entered = Promise.withResolvers<void>()
  const heldTermination = Promise.withResolvers<number>()
  const execution = owner.execute(
    fixture.child,
    controller.signal,
    undefined,
    (_id, signal) =>
      new Promise<NativeForkHistoryReference>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('Controlled parent cancellation')),
          { once: true },
        )
        entered.resolve()
      }),
  )
  const outcome = execution.catch((error: unknown) => error)
  await entered.promise
  const worker = workerLocation.last!
  const actualTerminate = worker.terminate.bind(worker)
  const termination = vi
    .spyOn(worker, 'terminate')
    .mockImplementation(() => heldTermination.promise)
  let closed = false
  const closing = owner.dispose().then(() => {
    closed = true
    return undefined
  })
  try {
    controller.abort()
    await Promise.resolve()
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(workerLocation.live).toBe(1)
    const started = workerLocation.started
    await expect(
      owner.execute(
        fixture.child,
        new AbortController().signal,
        undefined,
        fixture.resolveReference,
      ),
    ).rejects.toThrow(/already active/u)
    expect(workerLocation.started).toBe(started)
    expect(termination).toHaveBeenCalledTimes(1)
    heldTermination.resolve(await actualTerminate())
    expect(await outcome).toBeInstanceOf(Error)
    await closing
    expect(closed).toBe(true)
    expect(workerLocation.live).toBe(0)
  } finally {
    termination.mockRestore()
    heldTermination.resolve(await actualTerminate())
    await closing
    await outcome
    await owner.dispose()
  }
}, 15_000)

it('constructor failure retains no Worker or shared reservation and permits the next real operation', async () => {
  const fixture = await pagedFixture()
  const owner = new NativeForkFiles()
  const retained = Array.from({ length: 3 }, () =>
    new NativeWorkingMemory().reserve(NATIVE_OWNER_WORKING_BYTES),
  )
  let additional: ReturnType<NativeWorkingMemory['reserve']> | undefined
  try {
    workerLocation.throwNext = true
    await expect(
      owner.execute(
        fixture.child,
        new AbortController().signal,
        undefined,
        fixture.resolveReference,
      ),
    ).rejects.toThrow('Controlled Worker construction failure')
    expect(workerLocation.live).toBe(0)
    additional = new NativeWorkingMemory().reserve(NATIVE_OWNER_WORKING_BYTES)
    additional.release()
    expect(
      (
        await owner.execute(
          fixture.child,
          new AbortController().signal,
          undefined,
          fixture.resolveReference,
        )
      ).prefixHash,
    ).toBe(fixture.prefix.prefixHash)
    expect(workerLocation.live).toBe(0)
  } finally {
    workerLocation.throwNext = false
    additional?.release()
    for (const reservation of retained) reservation.release()
    await owner.dispose()
  }
}, 15_000)
