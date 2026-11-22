import Database from 'better-sqlite3'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

import type { ClaudePlanCheckpointSource } from '@pact/agent-runtime'
import type { AgentNativeForkWitness } from '@pact/contracts'

import { LogicalIpcWorkerTraffic } from '../../shared/logical-ipc-traffic'
import {
  CORTEX_STEP_STATUS_DONE,
  CORTEX_STEP_TYPE_PLANNER_RESPONSE,
  CORTEX_STEP_TYPE_USER_INPUT,
  EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
  encodeAgyPlannerResponseStep,
  encodeAgyUserInputStep,
  encodeBytesField,
  encodeCortexStepMetadata,
  encodeExecutorMetadata,
  encodeProtobufFields,
  encodeStringField,
  encodeVarintField,
} from './agy-native-storage'
import {
  AgyStorageRunner,
  configureAgyStorageChildScriptForTesting,
  getNodeAgyStorageChildStatsForTesting,
  type AgyStorageTransport,
} from './agy-storage-runner'
import { claudePlanInputFingerprint, claudePlanSubmissionFingerprint } from './claude-native-plan'
import {
  NativeForkFiles,
  type NativeForkFileInput,
  type NativeForkHistoryReference,
  type NativeForkFileResult,
} from './native-fork-files'
import { nativeWorkerFixture } from './native-workers-fixture.test-support'
import {
  NativeWorkingMemory,
  NATIVE_OWNER_WORKING_BYTES,
  nativeWorkingMemoryDiagnostics,
} from './native-working-memory'

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
let bundledWorkers: Awaited<ReturnType<typeof nativeWorkerFixture>> | undefined
let agyChildBundlePath = ''
const traffic = new LogicalIpcWorkerTraffic(
  ['utility-native-fork'],
  '00000000-0000-4000-8000-000000000001',
)
let files = new NativeForkFiles(traffic)
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pact-fork-worker-test-'))
  bundledWorkers = await nativeWorkerFixture(['native-fork-worker', 'agy-storage-child'])
  workerLocation.path = bundledWorkers.paths['native-fork-worker']!
  agyChildBundlePath = bundledWorkers.paths['agy-storage-child']!
  configureAgyStorageChildScriptForTesting(agyChildBundlePath)
}, 30_000)
afterAll(async () => {
  await files.dispose()
  configureAgyStorageChildScriptForTesting(undefined)
  await bundledWorkers?.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
})
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

async function publishedCheckpointFixture(mode = 'valid') {
  const profile = join(directory, randomUUID()),
    nativeSessionId = randomUUID(),
    sourceRoot = randomUUID(),
    targetRoot = randomUUID(),
    planPath = join(profile, 'plan.md'),
    sourcePrompt = randomUUID(),
    targetPrompt = randomUUID(),
    project = join(profile, 'projects', (await realpath(directory)).replace(/[^a-z0-9]/giu, '-'))
  await mkdir(project, { recursive: true })
  await writeFile(planPath, 'An unrelated filesystem plan is never a recovery authority.')
  const base = 'Scope\nA1\nB1\n',
    expected = 'Scope\nA2\nB1\n'
  const records: Record<string, unknown>[] = []
  let parent: string | null = null
  const add = (record: Record<string, unknown>) => {
    const uuid = typeof record.uuid === 'string' ? record.uuid : randomUUID()
    const row: Record<string, unknown> = {
      sessionId: nativeSessionId,
      cwd: directory,
      timestamp,
      uuid,
      parentUuid: parent,
      ...record,
    }
    records.push(row)
    parent = uuid
    return row
  }
  const edit = (id: string, old: string, next: string) => ({
    type: 'tool_use',
    id,
    name: 'Edit',
    input: { file_path: planPath, old_string: old, new_string: next },
  })
  const call = (block: ReturnType<typeof edit> | Array<ReturnType<typeof edit>>) =>
    add({
      type: 'assistant',
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: Array.isArray(block) ? block : [block],
      },
    })
  const ack = (block: ReturnType<typeof edit>, extra: object = {}) =>
    add({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: block.id, content: 'Done', ...extra }],
      },
      toolUseResult: {
        filePath: planPath,
        oldString: block.input.old_string,
        newString: block.input.new_string,
        originalFile: null,
        userModified: false,
        replaceAll: false,
      },
    })
  let oldCall: Record<string, unknown> | undefined
  const oldEdit = edit('old-edit', 'B1', 'B2')
  if (mode === 'late_old_receipt') {
    add({ type: 'user', promptId: randomUUID(), message: { role: 'user', content: 'Older root.' } })
    oldCall = call(oldEdit)
  }
  if (mode === 'old_finished_overlap') {
    add({
      type: 'user',
      promptId: randomUUID(),
      message: { role: 'user', content: 'Older ambiguous root.' },
    })
    const other = edit('old-other', 'A1', 'A2')
    call(oldEdit)
    call(other)
    ack(oldEdit)
    ack(other)
  }
  add({
    type: 'user',
    uuid: sourceRoot,
    promptId: sourcePrompt,
    message: { role: 'user', content: 'Previous planning root.' },
  })
  add({
    type: 'attachment',
    attachment: { type: 'plan_mode', isSubAgent: false, planFilePath: planPath },
  })
  const anchor = edit('source-edit', 'B0', 'B1')
  const anchorCall = call(
    mode === 'anchor_frame_write' ? [anchor, edit('after-anchor', 'B1', 'changed')] : anchor,
  )
  const receipt = ack(anchor, mode === 'failed_receipt' ? { is_error: true } : {})
  if (oldCall) {
    const tail = parent
    ack(oldEdit).parentUuid = oldCall.uuid
    parent = tail
  }
  if (mode === 'late_unknown_receipt') ack(edit('unknown-old-operation', 'B1', 'changed'))
  if (mode === 'duplicate_receipt') ack(anchor)
  if (mode === 'wrong_receipt_path') {
    const response = receipt.toolUseResult
    if (!response || typeof response !== 'object') throw Error('Missing fixture receipt.')
    Reflect.set(response, 'filePath', '/foreign/plan.md')
  }
  if (mode === 'foreign_receipt') receipt.sessionId = randomUUID()
  if (mode === 'late_sibling_write') {
    const tail = parent
    add({
      type: 'assistant',
      parentUuid: sourceRoot,
      isSidechain: true,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: [edit('hidden-write', 'B1', 'lost')],
      },
    })
    parent = tail
  }
  if (mode === 'intervening_input')
    add({
      type: 'user',
      promptId: randomUUID(),
      message: { role: 'user', content: 'Another root.' },
    })
  // Current Claude may record the tool result beside the main chain while still
  // linking it to the exact authenticated tool use.
  if (mode === 'sibling_receipt') parent = String(anchorCall.uuid)
  if (mode === 'request_blob') {
    const tail = parent
    add({
      type: 'api-request-blob',
      parentUuid: undefined,
      message: { role: 'assistant', content: [anchor] },
    })
    add({
      type: 'api-request-blob',
      parentUuid: undefined,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: anchor.id }] },
    })
    parent = tail
  }
  add({
    type: 'user',
    uuid: targetRoot,
    promptId: targetPrompt,
    message: { role: 'user', content: 'Current planning root.' },
  })
  const current = edit('target-edit', 'A1', 'A2')
  call(current)
  if (mode === 'overlap') call(edit('other-edit', 'B1', 'B2'))
  if (mode !== 'missing_result') ack(current)
  if (mode === 'overlap') ack(edit('other-edit', 'B1', 'B2'))
  if (mode === 'target_sidechain') {
    const tail = parent,
      child = edit('child-edit', 'B1', 'B2')
    call(child).isSidechain = true
    ack(child).isSidechain = true
    parent = tail
  }
  if (mode === 'target_unknown_receipt') ack(edit('unknown-target-operation', 'B1', 'changed'))
  if (mode === 'target_receipt_without_id') {
    const row = ack(edit('unattributed', 'B1', 'changed'))
    row.message = { role: 'user', content: [{ type: 'tool_result', content: 'Done' }] }
  }
  await writeFile(
    join(project, `${nativeSessionId}.jsonl`),
    records.map((row) => JSON.stringify(row)).join('\n') + '\n',
  )
  const read = vi.fn<(signal: AbortSignal) => Promise<string>>(async (_signal) =>
    mode === 'wrong_body' ? base + 'forged' : base,
  )
  const planCheckpoint: ClaudePlanCheckpointSource = {
    checkpoint: {
      targetRunId: targetRoot,
      targetNativeTurnId: mode === 'wrong_target' ? randomUUID() : targetRoot,
      nativeSessionId,
      bindingGeneration: 1,
      sourceNativeTurnId: mode === 'wrong_source' ? randomUUID() : sourceRoot,
      sourceNativeId: mode === 'wrong_anchor' ? 'missing-anchor' : anchor.id,
      basis: {
        version: 6,
        sourceRunId: sourceRoot,
        sourceMessageId: randomUUID(),
        document: {
          id: randomUUID(),
          sha256: hash(base),
          bytes: mode === 'capacity' ? 128 * 1024 * 1024 : Buffer.byteLength(base),
          chars: base.length,
        },
      },
    },
    read,
  }
  vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
  return {
    request: { cwd: directory, nativeSessionId, nativeTurnId: targetRoot, planCheckpoint },
    read,
    base,
    expected,
    current,
  }
}

it.each([
  'valid',
  'wrong_target',
  'wrong_source',
  'wrong_anchor',
  'duplicate_receipt',
  'failed_receipt',
  'foreign_receipt',
  'wrong_receipt_path',
  'late_sibling_write',
  'intervening_input',
  'wrong_body',
  'capacity',
  'missing_result',
  'overlap',
  'late_old_receipt',
  'target_sidechain',
  'anchor_frame_write',
  'late_unknown_receipt',
  'target_unknown_receipt',
  'old_finished_overlap',
  'target_receipt_without_id',
  'sibling_receipt',
  'request_blob',
] as const)(
  'recovers a published checkpoint through the actual native Worker without trusting disk: %s',
  async (mode) => {
    const f = await publishedCheckpointFixture(mode)
    try {
      const success = [
        'valid',
        'old_finished_overlap',
        'missing_result',
        'overlap',
        'sibling_receipt',
        'request_blob',
      ].includes(mode)
      const complete = [
        'valid',
        'old_finished_overlap',
        'sibling_receipt',
        'request_blob',
      ].includes(mode)
      const outcome = await files.readAnswer(f.request, new AbortController().signal).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      )
      const failure = expect.objectContaining({
        message: expect.stringMatching(
          mode === 'foreign_receipt' ? /ancestry/iu : /checkpoint|reconstruction working memory/iu,
        ),
      })
      expect(outcome.error).toEqual(success ? undefined : failure)
      expect(outcome.value?.plan?.text).toBe(complete ? f.expected : undefined)
      expect(outcome.value?.planUnavailable).toBe(success && !complete ? true : undefined)
      expect(f.read).toHaveBeenCalledTimes(success || mode === 'wrong_body' ? 1 : 0)
      expect(workerLocation.live).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  },
)

it('uses the same authenticated checkpoint for live Hook prefixes and complete cold readback', async () => {
  const f = await publishedCheckpointFixture()
  try {
    const original = await files.readAnswer(
      { ...f.request, planCheckpoint: undefined },
      new AbortController().signal,
    )
    expect(original.planUnavailable).toBe(true)
    expect(original.plan).toBeUndefined()
    expect(f.read).not.toHaveBeenCalled()
    const prefix = await files.readAnswer(
      {
        ...f.request,
        planHook: {
          id: f.current.id,
          inputFingerprint: claudePlanInputFingerprint('Edit', f.current.input),
        },
      },
      new AbortController().signal,
    )
    expect(prefix.planState).toMatchObject({ text: f.base, complete: true, pending: [] })
    const complete = await files.readAnswer(f.request, new AbortController().signal)
    expect(complete.plan?.text).toBe(f.expected)
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(workerLocation.live).toBe(0)
  } finally {
    vi.unstubAllEnvs()
  }
})

it('retains the native owner until a cancelled checkpoint reader physically settles', async () => {
  const f = await publishedCheckpointFixture(),
    localFiles = new NativeForkFiles(traffic),
    controller = new AbortController(),
    held = Promise.withResolvers<string>()
  f.read.mockImplementation(() => held.promise)
  try {
    const reading = localFiles.readAnswer(f.request, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1))
    controller.abort()
    expect(await reading).toMatchObject({ message: expect.stringMatching(/cancelled/iu) })
    expect(localFiles.active).toBe(true)
    await expect(localFiles.readAnswer(f.request, new AbortController().signal)).rejects.toThrow(
      /already active/iu,
    )
    held.resolve(f.base)
    await vi.waitFor(() => expect(localFiles.active).toBe(false))
    expect(workerLocation.live).toBe(0)
  } finally {
    held.resolve(f.base)
    await localFiles.dispose()
    vi.unstubAllEnvs()
  }
})

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

it.each(['empty', 'positive'] as const)(
  'Claude Fork accepts exact %s accounting without changing its frozen history',
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
  'ignores legacy structured attachments and validates natural Claude root %s Fork proof',
  async (proof) => {
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
        { cwd: directory, nativeSessionId, nativeTurnId },
        new AbortController().signal,
      )
      expect(restored.answer).toBe('Original prose.')
      expect(hash(restored.answer!)).toBe(hash('Original prose.'))
      expect(restored.plan).toBeUndefined()
      const preparation = files.execute(
        {
          provider: 'claude',
          action: 'prepare',
          cwd: directory,
          nativeSessionId,
          nativeTurnId,
          responseHash: hash(proof === 'natural' ? 'Original prose.' : 'Foreign answer'),
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
it.each(['complete', 'failed', 'pending', 'foreign', 'unbound', 'hook', 'wrong_hook'] as const)(
  'reconstructs only authenticated Claude root plan operations: %s',
  async (mode) => {
    const profile = join(directory, randomUUID())
    const nativeSessionId = randomUUID(),
      nativeTurnId = randomUUID(),
      promptId = randomUUID()
    const project = join(
      profile,
      'projects',
      (await realpath(directory)).replace(/[^a-z0-9]/giu, '-'),
    )
    await mkdir(project, { recursive: true })
    const planPath = join(profile, 'plan.md'),
      attachmentId = randomUUID(),
      callId = randomUUID(),
      receiptId = randomUUID()
    await writeFile(planPath, 'Unrelated newer filesystem content must not be read.')
    const text = 'Complete authenticated plan.\n'.repeat(3000)
    const operation = { file_path: planPath, content: text }
    const records = [
      {
        type: 'user',
        uuid: nativeTurnId,
        parentUuid: null,
        promptId,
        message: { role: 'user', content: 'Plan the change.' },
      },
      {
        type: 'attachment',
        uuid: attachmentId,
        parentUuid: nativeTurnId,
        attachment: {
          type: mode === 'unbound' ? 'unknown' : 'plan_mode',
          isSubAgent: false,
          planFilePath: planPath,
        },
      },
      {
        type: 'assistant',
        uuid: callId,
        parentUuid: mode === 'foreign' ? randomUUID() : attachmentId,
        message: {
          id: 'plan-call',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'write-plan', name: 'Write', input: operation }],
        },
      },
      ...(mode === 'pending'
        ? []
        : [
            {
              type: 'user',
              uuid: receiptId,
              parentUuid: callId,
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'write-plan',
                    is_error: mode === 'failed',
                    content: 'Written',
                  },
                ],
              },
              toolUseResult: { filePath: planPath, content: text, userModified: false },
            },
          ]),
      {
        type: 'assistant',
        uuid: randomUUID(),
        parentUuid: mode === 'pending' ? callId : receiptId,
        message: {
          id: 'natural',
          role: 'assistant',
          content: [{ type: 'text', text: 'Plan ready.' }],
        },
      },
    ]
    await writeFile(
      join(project, `${nativeSessionId}.jsonl`),
      records
        .map((record) =>
          JSON.stringify({ ...record, sessionId: nativeSessionId, cwd: directory, timestamp }),
        )
        .join('\n') + '\n',
    )
    vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
    try {
      const reading = files.readAnswer(
        {
          cwd: directory,
          nativeSessionId,
          nativeTurnId,
          ...(['hook', 'wrong_hook'].includes(mode)
            ? {
                planHook: {
                  id: 'write-plan',
                  inputFingerprint: claudePlanInputFingerprint(
                    'Write',
                    mode === 'hook' ? operation : { ...operation, content: 'Forged' },
                  ),
                },
              }
            : {}),
        },
        new AbortController().signal,
      )
      const outcome = await reading.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({
          value: undefined,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      expect(Boolean(outcome.error)).toBe(mode === 'wrong_hook')
      expect(outcome.error ?? '').toContain(
        mode === 'wrong_hook' ? 'differs from its recorded operation' : '',
      )
      expect(outcome.value?.plan).toEqual(
        mode === 'complete' ? { nativeId: 'write-plan', text } : undefined,
      )
      expect(outcome.value?.answer).toBe(
        ['complete', 'failed', 'pending', 'unbound'].includes(mode) ? 'Plan ready.' : undefined,
      )
      expect(outcome.value?.planUnavailable).toBe(
        ['failed', 'pending'].includes(mode) ? true : undefined,
      )
      expect(outcome.value?.planState).toEqual(
        mode === 'hook'
          ? { complete: false, unavailable: false, overlapped: false, operations: [], pending: [] }
          : undefined,
      )
      expect(outcome.value?.planBinding).toEqual(
        ['complete', 'failed', 'pending', 'foreign', 'hook'].includes(mode)
          ? { path: planPath, promptId }
          : undefined,
      )
      expect(workerLocation.live).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  },
)
it.each([
  'valid',
  'late_write',
  'late_edit',
  'failed_write',
  'pending_write',
  'wrong_prompt',
  'wrong_name',
  'extra_args',
  'missing_result',
  'failed_result',
  'duplicate_call',
  'duplicate_result',
  'foreign_root',
  'child',
  'different_retain',
  'child_duplicate',
  'child_write',
] as const)(
  'authenticates host retention from the entire current root without ancestor body: %s',
  async (mode) => {
    const profile = join(directory, randomUUID()),
      nativeSessionId = randomUUID(),
      nativeTurnId = randomUUID(),
      promptId = randomUUID(),
      toolName = 'mcp__owned__retain_current_plan'
    const project = join(
      profile,
      'projects',
      (await realpath(directory)).replace(/[^a-z0-9]/giu, '-'),
    )
    await mkdir(project, { recursive: true })
    const records: Record<string, unknown>[] = []
    let parent: string | null = null
    const append = (record: Record<string, unknown>) => {
      const id = typeof record.uuid === 'string' ? record.uuid : randomUUID()
      records.push({
        uuid: id,
        parentUuid: parent,
        ...record,
        sessionId: nativeSessionId,
        cwd: directory,
        timestamp,
      })
      parent = id
    }
    append({
      type: 'user',
      uuid: nativeTurnId,
      promptId,
      message: { role: 'user', content: 'Keep the frozen plan' },
    })
    const call = (id: string, name: string, toolInput: unknown, extra: object = {}) =>
      append({
        type: 'assistant',
        ...extra,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'tool_use', id, name, input: toolInput }],
        },
      })
    const result = (id: string, failed = false) =>
      append({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: 'ack' }],
        },
      })
    if (mode === 'pending_write' || mode === 'failed_write') {
      call('write', 'Write', { file_path: '/native/current.md', content: 'Unchanged' })
      if (mode === 'failed_write') result('write', true)
    }
    call(
      'retain',
      mode === 'wrong_name' ? 'mcp__foreign__retain_current_plan' : toolName,
      mode === 'extra_args' ? { planVersion: 2 } : {},
      mode === 'foreign_root'
        ? { parentUuid: randomUUID() }
        : mode === 'child'
          ? { isSidechain: true }
          : {},
    )
    if (mode === 'duplicate_call') call('retain', toolName, {})
    if (mode !== 'missing_result') result('retain', mode === 'failed_result')
    if (mode === 'duplicate_result') result('retain')
    if (mode === 'child_duplicate') call('retain', toolName, {}, { isSidechain: true })
    if (mode === 'child_write')
      call(
        'child-write',
        'Write',
        { file_path: '/native/current.md', content: 'Changed' },
        { isSidechain: true },
      )
    if (mode === 'different_retain') call('other', toolName, {})
    if (mode === 'late_write' || mode === 'late_edit')
      call('late', mode === 'late_write' ? 'Write' : 'Edit', {
        file_path: '/native/current.md',
        content: 'Later',
      })
    await writeFile(
      join(project, `${nativeSessionId}.jsonl`),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    )
    vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
    try {
      const intent = {
        id: 'retain',
        promptId: mode === 'wrong_prompt' ? randomUUID() : promptId,
        toolName,
        inputFingerprint: claudePlanInputFingerprint(toolName, {}),
      }
      const reading = files.readAnswer(
        { cwd: directory, nativeSessionId, nativeTurnId, terminalPlanRetention: intent },
        new AbortController().signal,
      )
      const outcome = await reading.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      )
      expect(Boolean(outcome.error)).toBe(mode !== 'valid')
      expect(outcome.value?.terminalPlanRetention).toEqual(mode === 'valid' ? intent : undefined)
      expect(outcome.value?.plan).toBeUndefined()
      expect(outcome.value?.retainedPlan).toBeUndefined()
      expect(outcome.value?.planState).toBeUndefined()
      expect(workerLocation.live).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  },
)
it.each([
  'complete',
  'retained',
  'missing',
  'duplicate',
  'wrong_prompt',
  'wrong_input',
  'wrong_body',
  'wrong_path',
  'foreign',
  'failed_write',
  'pending_write',
  'post_edit',
  'post_failed_edit',
  'post_pending_edit',
  'later_exit',
  'question',
  'answered_question',
  'termination_rejected',
] as const)('authenticates the entire terminated native plan root: %s', async (mode) => {
  const profile = join(directory, randomUUID()),
    nativeSessionId = randomUUID(),
    nativeTurnId = randomUUID(),
    promptId = randomUUID()
  const project = join(
    profile,
    'projects',
    (await realpath(directory)).replace(/[^a-z0-9]/giu, '-'),
  )
  await mkdir(project, { recursive: true })
  const path = join(profile, 'plan.md'),
    text = 'An authenticated plan with a bounded cleanup path.'
  // A newer file is deliberately unrelated; terminal authentication never opens it.
  await writeFile(path, 'Forged disk-only plan')
  const records: Record<string, unknown>[] = []
  let parent: string | null = null
  const append = (
    type: string,
    value: Record<string, unknown>,
    uuid: string = randomUUID(),
  ): void => {
    records.push({ type, uuid, parentUuid: parent, ...value })
    parent = uuid
  }
  const root = (id: string, prompt: string): void => {
    append('user', { promptId: prompt, message: { role: 'user', content: 'Plan' } }, id)
    append('attachment', {
      attachment: { type: 'plan_mode', isSubAgent: false, planFilePath: path },
    })
  }
  const call = (id: string, name: string, operationInput: unknown, foreign = false): void => {
    append('assistant', {
      ...(foreign ? { parentUuid: randomUUID() } : {}),
      message: {
        id: `message-${records.length}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input: operationInput }],
      },
    })
  }
  const receipt = (id: string, response: unknown, failed = false): void => {
    append('user', {
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: 'ack' }],
      },
      toolUseResult: response,
    })
  }
  const write = (): void => {
    call('write-plan', 'Write', { file_path: path, content: text })
    if (mode !== 'pending_write')
      receipt(
        'write-plan',
        { filePath: path, content: text, userModified: false },
        mode === 'failed_write',
      )
  }
  if (mode === 'answered_question') {
    root(nativeTurnId, promptId)
    call('earlier-question', 'AskUserQuestion', { questions: [{ question: 'Which owner?' }] })
    receipt('earlier-question', { answers: { 'Which owner?': 'The requester owner' } })
    write()
  } else if (mode === 'retained') {
    root(randomUUID(), randomUUID())
    write()
    root(nativeTurnId, promptId)
  } else {
    root(nativeTurnId, promptId)
    write()
  }
  const intent = {
    plan: mode === 'wrong_body' ? 'Forged' : text,
    planFilePath: mode === 'wrong_path' ? join(profile, 'other.md') : path,
  }
  if (mode !== 'missing') call('exit-plan', 'ExitPlanMode', intent, mode === 'foreign')
  if (mode === 'duplicate') call('exit-plan', 'ExitPlanMode', intent)
  if (mode.startsWith('post_')) {
    call('later-edit', 'Edit', {
      file_path: path,
      old_string: text,
      new_string: 'Changed after submission',
    })
    if (mode !== 'post_pending_edit')
      receipt(
        'later-edit',
        {
          filePath: path,
          oldString: text,
          newString: 'Changed after submission',
          userModified: false,
        },
        mode === 'post_failed_edit',
      )
  }
  if (mode === 'later_exit') call('another-exit', 'ExitPlanMode', intent)
  if (mode === 'question') call('question', 'AskUserQuestion', { questions: [] })
  await writeFile(
    join(project, `${nativeSessionId}.jsonl`),
    records
      .map((record) =>
        JSON.stringify({ ...record, cwd: directory, sessionId: nativeSessionId, timestamp }),
      )
      .join('\n') + '\n',
  )
  vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
  try {
    const submission = {
      id: 'exit-plan',
      promptId: mode === 'wrong_prompt' ? randomUUID() : promptId,
      inputFingerprint: claudePlanSubmissionFingerprint(
        mode === 'wrong_input' ? { ...intent, extra: true } : intent,
      ),
    }
    const reading = files.readAnswer(
      { cwd: directory, nativeSessionId, nativeTurnId, terminalPlanSubmission: submission },
      new AbortController().signal,
    )
    let settled = false
    const outcomePromise = reading.then(
      (value) => {
        settled = true
        return { value, error: undefined }
      },
      (error: unknown) => {
        settled = true
        return { value: undefined, error }
      },
    )
    let retainedOwner: { active: boolean; settled: boolean; live: number } | undefined
    if (mode === 'termination_rejected') {
      const worker = workerLocation.last!,
        requested = Promise.withResolvers<void>()
      const termination = vi.spyOn(worker, 'terminate').mockImplementation(() => {
        requested.resolve()
        return Promise.reject(new Error('Controlled terminal termination rejection'))
      })
      try {
        await requested.promise
        await Promise.resolve()
        retainedOwner = { active: files.active, settled, live: workerLocation.live }
      } finally {
        termination.mockRestore()
        await worker.terminate()
      }
    }
    const outcome = await outcomePromise
    expect(retainedOwner).toEqual(
      mode === 'termination_rejected' ? { active: true, settled: false, live: 1 } : undefined,
    )
    const accepted = ['complete', 'retained', 'answered_question'].includes(mode)
    expect(Boolean(outcome.error)).toBe(!accepted)
    expect(outcome.value?.terminalPlanSubmission).toEqual(accepted ? submission : undefined)
    expect(outcome.value?.planState).toBeUndefined()
    expect(outcome.value?.planUnavailable).toBeUndefined()
    expect(outcome.value?.plan).toEqual(
      ['complete', 'answered_question'].includes(mode)
        ? { nativeId: 'write-plan', text }
        : undefined,
    )
    expect(outcome.value?.retainedPlan).toEqual(
      mode === 'retained'
        ? {
            nativeId: 'exit-plan',
            sha256: hash(text),
            bytes: Buffer.byteLength(text),
            chars: text.length,
          }
        : undefined,
    )
    expect(workerLocation.live).toBe(0)
  } finally {
    vi.unstubAllEnvs()
  }
})

it('binds every ExitPlanMode JSON field without changing the live Write/Edit prefix fingerprint', () => {
  const intent = {
    plan: 'Body',
    planFilePath: '/native/plan.md',
    allowedPrompts: [{ tool: 'Bash', prompt: 'test' }],
  }
  expect(claudePlanSubmissionFingerprint(intent)).toBe(
    claudePlanSubmissionFingerprint({
      allowedPrompts: intent.allowedPrompts,
      planFilePath: intent.planFilePath,
      plan: intent.plan,
    }),
  )
  for (const changed of [
    { ...intent, plan: 'Other' },
    { ...intent, planFilePath: '/other' },
    { ...intent, extra: null },
    { ...intent, allowedPrompts: [] },
  ]) {
    expect(claudePlanSubmissionFingerprint(changed)).not.toBe(
      claudePlanSubmissionFingerprint(intent),
    )
  }
  expect(claudePlanInputFingerprint('ExitPlanMode', intent)).toBe(
    claudePlanInputFingerprint('ExitPlanMode', { ...intent, plan: 'Other' }),
  )
})

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
  files = new NativeForkFiles(traffic)
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
    expect(owner.active).toBe(false)
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

it.each([false, true])(
  'cold Claude text grouping preserves both API blocks and only known consumed Steer inputs (%s)',
  async (includeSteer) => {
    const cwd = await realpath(directory),
      profile = join(directory, randomUUID()),
      nativeSessionId = randomUUID(),
      root = randomUUID(),
      first = randomUUID(),
      second = randomUUID(),
      steer = randomUUID(),
      third = randomUUID(),
      later = randomUUID(),
      last = randomUUID(),
      project = join(profile, 'projects', cwd.replace(/[^a-z0-9]/giu, '-')),
      sourceTimestamp = new Date().toISOString()
    await mkdir(project, { recursive: true })
    const user = (uuid: string, parentUuid: string | null, content: string) => ({
      type: 'user',
      sessionId: nativeSessionId,
      cwd,
      timestamp: sourceTimestamp,
      uuid,
      parentUuid,
      message: { role: 'user', content },
    })
    const assistant = (uuid: string, parentUuid: string, id: string, text: string) => ({
      type: 'assistant',
      sessionId: nativeSessionId,
      cwd,
      timestamp: sourceTimestamp,
      uuid,
      parentUuid,
      message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    })
    const entries = [
      user(root, null, 'Original input'),
      assistant(first, root, 'api-1', 'First.'),
      assistant(second, first, 'api-1', ' Second.'),
      user(steer, second, 'Consumed Steer input'),
      assistant(third, steer, 'api-2', 'Final.'),
      user(later, third, 'Unrelated later input'),
      assistant(last, later, 'api-3', 'Must not borrow this later reply.'),
    ]
    const body =
        entries
          .map((entry) =>
            JSON.stringify({
              ...entry,
              sessionId: nativeSessionId,
              cwd,
              timestamp: sourceTimestamp,
            }),
          )
          .join('\n') + '\n',
      path = join(project, nativeSessionId + '.jsonl')
    await writeFile(path, body)
    vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
    try {
      const answer = await files.readAnswer(
        {
          cwd,
          nativeSessionId,
          nativeTurnId: root,
          ...(includeSteer ? { nativeInputIds: [root, steer] } : {}),
        },
        new AbortController().signal,
      )
      expect(answer.answer).toBe(includeSteer ? 'First. Second.\n\nFinal.' : 'First. Second.')
      expect(await readFile(path, 'utf8')).toBe(body)
      expect(workerLocation.live).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  },
)

async function createAgyWorkerShellFixture(storageRoot: string, sessionId: string) {
  await mkdir(join(storageRoot, 'conversations'), { recursive: true })
  await mkdir(join(storageRoot, 'brain'), { recursive: true })
  const summariesPath = join(storageRoot, 'conversation_summaries.db')
  const trajectoryId = randomUUID()
  const rawSummary = encodeProtobufFields([
    encodeStringField(4, trajectoryId),
    encodeBytesField(15, Buffer.alloc(0)),
    encodeBytesField(
      17,
      encodeProtobufFields([
        encodeStringField(6, sessionId),
        encodeBytesField(90, Buffer.alloc(560, 0x2a)),
      ]),
    ),
    encodeVarintField(22, 1),
  ])
  const sumDb = new Database(summariesPath)
  try {
    sumDb.pragma('journal_mode = WAL')
    sumDb.exec(`
      CREATE TABLE IF NOT EXISTS "conversation_summaries" (
        "conversation_id" TEXT PRIMARY KEY,
        "title" TEXT,
        "step_count" INTEGER NOT NULL DEFAULT 0,
        "last_user_input_step_index" INTEGER NOT NULL DEFAULT 0,
        "raw_summary" BLOB,
        "parent_conversation_id" TEXT
      );
    `)
    sumDb
      .prepare(
        'INSERT INTO "conversation_summaries" ("conversation_id", "title", "step_count", "last_user_input_step_index", "raw_summary") VALUES (?, ?, 0, 0, ?)',
      )
      .run(sessionId, '', rawSummary)
  } finally {
    sumDb.close()
  }

  const dbPath = join(storageRoot, 'conversations', `${sessionId}.db`)
  const db = new Database(dbPath)
  try {
    db.pragma('page_size = 32768')
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE "trajectory_meta" (
        "trajectory_id" TEXT PRIMARY KEY,
        "cascade_id" TEXT NOT NULL,
        "step_format" INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE "steps" (
        "idx" INTEGER PRIMARY KEY,
        "step_type" INTEGER NOT NULL,
        "status" INTEGER NOT NULL,
        "has_subtrajectory" INTEGER NOT NULL DEFAULT 0,
        "metadata" BLOB,
        "error_details" BLOB,
        "permissions" BLOB,
        "task_details" BLOB,
        "render_info" BLOB,
        "step_payload" BLOB,
        "step_format" INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE "gen_metadata" (
        "idx" INTEGER PRIMARY KEY,
        "data" BLOB NOT NULL,
        "size" INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE "executor_metadata" (
        "idx" INTEGER PRIMARY KEY,
        "data" BLOB NOT NULL,
        "size" INTEGER NOT NULL DEFAULT 0
      );
    `)
    db.prepare(
      'INSERT INTO "trajectory_meta" ("trajectory_id", "cascade_id", "step_format") VALUES (?, ?, 0)',
    ).run(trajectoryId, sessionId)
  } finally {
    db.close()
  }
  return { dbPath, trajectoryId }
}

it('executes Antigravity rebuildAgySeed, verifyAgySeed, exists, and inspectAgyRun through the real Worker', async () => {
  const storageRoot = join(directory, randomUUID())
  const cwd = await realpath(directory)
  const candidateSid = randomUUID()
  const rebuildId = randomUUID()
  const msgId = randomUUID()
  const imgId = randomUUID()
  await createAgyWorkerShellFixture(storageRoot, candidateSid)

  const imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 3, 2, 1])
  const imgPath = join(storageRoot, `${imgId}.png`)
  await writeFile(imgPath, imgBytes, { mode: 0o600 })
  const imgSha = createHash('sha256').update(imgBytes).digest('hex')

  const chunks = [
    {
      kind: 'image' as const,
      messageId: msgId,
      sequence: 1,
      image: {
        id: imgId,
        name: 'worker-seed.png',
        mediaType: 'image/png' as const,
        bytes: imgBytes.byteLength,
        width: 16,
        height: 16,
        sha256: imgSha,
      },
    },
    {
      kind: 'message' as const,
      messageId: msgId,
      sequence: 1,
      speaker: 'agy' as const,
      state: 'complete' as const,
      part: 0,
      final: true,
      content: 'Worker rebuild seed payload.',
    },
  ]

  expect(
    await files.exists(
      { cwd, nativeSessionId: randomUUID(), provider: 'agy', storageRoot },
      new AbortController().signal,
    ),
  ).toBe(false)
  expect(
    await files.exists(
      { cwd, nativeSessionId: candidateSid, provider: 'agy', storageRoot },
      new AbortController().signal,
    ),
  ).toBe(true)

  const sourceHash = hash('worker-rebuild-source-v1')
  const seeded = await files.rebuildAgySeed(
    {
      cwd,
      storageRoot,
      nativeSessionId: candidateSid,
      rebuildId,
      sourceHash,
      chunks,
      images: [
        {
          id: imgId,
          name: 'worker-seed.png',
          path: imgPath,
          mediaType: 'image/png',
          bytes: imgBytes.byteLength,
          width: 16,
          height: 16,
          sha256: imgSha,
        },
      ],
    },
    new AbortController().signal,
  )
  expect(seeded.stepCount).toBe(2)
  expect(seeded.chunkCount).toBe(2)
  expect(seeded.initializationWitness).toBeUndefined()
  expect(workerLocation.live).toBe(0)

  // Before cold-load verification receipt is sealed, read-only `rejectAdditionalWork: true` check MUST reject!
  await expect(
    files.verifyAgySeed(
      {
        cwd,
        storageRoot,
        nativeSessionId: candidateSid,
        rebuildId,
        sourceHash,
        chunks,
        rejectAdditionalWork: true,
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/cold-load verification receipt/iu)

  const confirmedWitness = await files.confirmAgyRebuildColdLoad(
    {
      cwd,
      appDataDir: storageRoot,
      nativeSessionId: candidateSid,
      sourceHash,
      pbSha256: seeded.pbSha256,
      pbBytes: seeded.pbBytes,
      stepCount: 2,
    },
    new AbortController().signal,
  )
  expect(confirmedWitness).toMatchObject({
    kind: 'agy_rebuild_v1',
    nativeSessionId: candidateSid,
    sourceHash,
    pbSha256: seeded.pbSha256,
    pbBytes: seeded.pbBytes,
    stepCount: 2,
  })
  expect(confirmedWitness.coldLoadVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u)

  const verified = await files.verifyAgySeed(
    {
      cwd,
      storageRoot,
      nativeSessionId: candidateSid,
      rebuildId,
      sourceHash,
      chunks,
      rejectAdditionalWork: true,
      expectedSeedHash: seeded.seedHash,
      expectedTrajectoryId: seeded.trajectoryId,
      expectedPbSha256: seeded.pbSha256,
      expectedPbBytes: seeded.pbBytes,
      expectedVerifiedPrefixSha256: seeded.verifiedPrefixSha256,
      expectedVerifiedPrefixBytes: seeded.verifiedPrefixBytes,
      expectedRecordCount: seeded.recordCount,
    },
    new AbortController().signal,
  )
  expect(verified).toEqual({
    ...seeded,
    initializationWitness: confirmedWitness,
  })
  expect(workerLocation.live).toBe(0)
})

it('executes Antigravity prepare, two-phase forkAgy, and inspect through the real Worker', async () => {
  const storageRoot = join(directory, randomUUID())
  const cwd = await realpath(directory)
  const sourceSid = randomUUID()
  const candidateSid = randomUUID()
  const { dbPath: sourceDbPath, trajectoryId: sourceTrajId } = await createAgyWorkerShellFixture(
    storageRoot,
    sourceSid,
  )
  await createAgyWorkerShellFixture(storageRoot, candidateSid)

  const pactRunId = randomUUID()
  const pactMsgId = randomUUID()
  const db = new Database(sourceDbPath)
  try {
    const u0Meta = encodeCortexStepMetadata({
      createdAtSeconds: 1_710_000_500n,
      source: 1,
      executionId: 'exec-worker-1',
      trajectoryId: sourceTrajId,
      stepIndex: 0,
      cascadeId: sourceSid,
      stepId: 'step-w0',
    })
    const u0Data = encodeAgyUserInputStep({
      metadata: u0Meta,
      text: `Worker prompt mentioning ${sourceSid} and ${sourceTrajId}\n${JSON.stringify({
        version: 'pact-agent-prompt-v1',
        messageId: pactMsgId,
        pactRunId,
      })}`,
    })
    const p1Meta = encodeCortexStepMetadata({
      createdAtSeconds: 1_710_000_501n,
      source: 2,
      executionId: 'exec-worker-1',
      trajectoryId: sourceTrajId,
      stepIndex: 1,
      cascadeId: sourceSid,
      stepId: 'step-w1',
    })
    const p1Data = encodeAgyPlannerResponseStep({
      metadata: p1Meta,
      response: 'Worker Fork canonical answer.',
    })
    const insertStep = db.prepare(
      'INSERT INTO "steps" ("idx", "step_type", "status", "has_subtrajectory", "metadata", "step_payload", "step_format") VALUES (?, ?, ?, 0, ?, ?, 0)',
    )
    insertStep.run(0, CORTEX_STEP_TYPE_USER_INPUT, CORTEX_STEP_STATUS_DONE, u0Meta, u0Data)
    insertStep.run(1, CORTEX_STEP_TYPE_PLANNER_RESPONSE, CORTEX_STEP_STATUS_DONE, p1Meta, p1Data)

    const genData = encodeProtobufFields([
      encodeBytesField(
        1,
        encodeProtobufFields([
          encodeBytesField(
            20,
            encodeProtobufFields([
              encodeStringField(1, 'trajectory_id'),
              encodeStringField(2, sourceTrajId),
            ]),
          ),
          encodeBytesField(
            20,
            encodeProtobufFields([
              encodeStringField(1, 'cascade_id'),
              encodeStringField(2, sourceSid),
            ]),
          ),
        ]),
      ),
      encodeVarintField(2, 1),
      encodeStringField(4, 'exec-worker-1'),
    ])
    db.prepare('INSERT INTO "gen_metadata" ("idx", "data", "size") VALUES (0, ?, ?)').run(
      genData,
      genData.byteLength,
    )
    const execData = encodeExecutorMetadata({
      terminationReason: EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
      numGeneratorInvocations: 1,
      lastStepIdx: 1,
      executionId: 'exec-worker-1',
    })
    db.prepare('INSERT INTO "executor_metadata" ("idx", "data", "size") VALUES (0, ?, ?)').run(
      execData,
      execData.byteLength,
    )
  } finally {
    db.close()
  }

  const coldRun = await files.inspectAgyRun(
    {
      cwd,
      storageRoot,
      nativeSessionId: sourceSid,
      nativeTurnId: pactRunId,
    },
    new AbortController().signal,
  )
  expect(coldRun.terminalState?.status).toBe('completed')
  expect(coldRun.terminalState?.executionId).toBe('exec-worker-1')
  expect(coldRun.terminalState?.consumedInputs[0]?.pactRunId).toBe(pactRunId)
  expect(coldRun.terminalState?.answer).toBe('Worker Fork canonical answer.')

  const responseHash = hash('Worker Fork canonical answer.')
  const boundary = await files.prepareAgyBoundary(
    {
      cwd,
      storageRoot,
      nativeSessionId: sourceSid,
      nativeTurnId: pactRunId,
      nativeInputIds: [pactRunId],
      bindingGeneration: 1,
      throughSequence: 2,
      deliveryCursor: 2,
      responseHash,
    },
    new AbortController().signal,
  )
  expect(boundary.provider).toBe('agy')
  expect(boundary.nativeCutId).toBe('exec-worker-1')
  expect(boundary.agyCut?.version).toBe('pact-agy-fork-cut-v1')
  expect(boundary.agyCut?.executionId).toBe('exec-worker-1')
  expect(boundary.agyCut?.cutStepIdx).toBe(1)

  const candidateCallbacks: string[] = []
  const forked = await files.forkAgy(
    {
      cwd,
      storageRoot,
      candidateNativeSessionId: candidateSid,
      source: boundary,
      responseHash,
      model: 'gemini-3-flash',
      effort: 'high',
      permissionMode: 'auto',
      markInitialized: true,
      onCandidate: async (sid, candidateWitness) => {
        candidateCallbacks.push(sid)
        expect(candidateWitness.sourceNativeSessionId).toBe(sourceSid)
        expect(candidateWitness.provider).toBe('agy')
        expect(candidateWitness.initializedAt).toBeUndefined()
      },
    },
    new AbortController().signal,
  )
  expect(candidateCallbacks).toEqual([candidateSid])
  expect(forked.witness.initializedAt).toBeDefined()
  expect(forked.witness.provider).toBe('agy')
  expect(forked.witness.sourceTrajectoryId).toBe(sourceTrajId)
  expect(forked.witness.candidateTrajectoryId).toBeTruthy()
  expect(forked.witness.cutStepIdx).toBe(1)
  expect(forked.witness.agyCut).toMatchObject({
    version: 'pact-agy-fork-cut-v1',
    trajectoryId: forked.witness.candidateTrajectoryId,
    executionId: 'exec-worker-1',
    cutStepIdx: 1,
  })
  expect(workerLocation.live).toBe(0)

  const inspected = await files.execute(
    {
      provider: 'agy',
      action: 'inspect',
      cwd,
      storageRoot,
      nativeSessionId: candidateSid,
      source: boundary,
      witness: forked.witness,
    },
    new AbortController().signal,
  )
  expect(inspected.initializedVerified).toBe(true)
  expect(workerLocation.live).toBe(0)

  await expect(
    files.forkAgy(
      {
        cwd,
        storageRoot,
        candidateNativeSessionId: randomUUID(),
        source: {
          ...boundary,
          agyCut: { ...boundary.agyCut!, trajectoryId: 'traj-mismatch-worker' },
        },
        responseHash,
        model: 'gemini-3-flash',
        effort: 'high',
        permissionMode: 'auto',
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/changed before Fork|disagrees/iu)
  expect(workerLocation.live).toBe(0)
})

it('reads Antigravity trajectory identity through native-fork-worker for >64 MiB DB with uncheckpointed WAL and zero sidefiles', async () => {
  const storageRoot = join(directory, `agy-worker-identity-${randomUUID()}`)
  const cwd = join(directory, `agy-worker-identity-cwd-${randomUUID()}`)
  await mkdir(cwd, { recursive: true })
  const sessionId = randomUUID()
  const fixture = await createAgyWorkerShellFixture(storageRoot, sessionId)

  const largeBlob = Buffer.alloc(1_600_000, 0x33)
  const writer = new Database(fixture.dbPath)
  let reader: Database.Database | undefined
  try {
    writer.pragma('journal_mode = WAL')
    writer.pragma('wal_autocheckpoint = 0')
    const insertStep = writer.prepare(
      'INSERT INTO "steps" ("idx", "step_type", "status", "step_payload") VALUES (?, ?, ?, ?)',
    )
    const writeBatch = writer.transaction(() => {
      for (let idx = 0; idx < 44; idx += 1) {
        insertStep.run(
          idx,
          idx % 2 === 0 ? CORTEX_STEP_TYPE_USER_INPUT : CORTEX_STEP_TYPE_PLANNER_RESPONSE,
          CORTEX_STEP_STATUS_DONE,
          largeBlob,
        )
      }
    })
    writeBatch()
    writer.pragma('wal_checkpoint(TRUNCATE)')

    reader = new Database(fixture.dbPath, { readonly: true })
    reader.prepare('SELECT COUNT(*) FROM "steps"').get()

    insertStep.run(44, CORTEX_STEP_TYPE_USER_INPUT, CORTEX_STEP_STATUS_DONE, largeBlob)
    insertStep.run(45, CORTEX_STEP_TYPE_PLANNER_RESPONSE, CORTEX_STEP_STATUS_DONE, largeBlob)
  } finally {
    writer.close()
    reader?.close()
  }

  await rm(`${fixture.dbPath}-shm`, { force: true })
  expect((await stat(fixture.dbPath)).size).toBeGreaterThan(64 * 1024 * 1024)
  const beforeConv = (await readdir(join(storageRoot, 'conversations'))).toSorted()
  expect(beforeConv).toContain(`${sessionId}.db-wal`)
  expect(beforeConv).not.toContain(`${sessionId}.db-shm`)

  const result = await files.readAgyTrajectoryIdentity(
    { cwd, storageRoot, nativeSessionId: sessionId },
    new AbortController().signal,
  )
  expect(result).toEqual({
    nativeSessionId: sessionId,
    status: 'ok',
    trajectoryId: fixture.trajectoryId,
    stepCount: 46,
  })
  expect((await readdir(join(storageRoot, 'conversations'))).toSorted()).toEqual(beforeConv)
  expect(workerLocation.live).toBe(0)
})

const BETTER_SQLITE3_ENTRY = createRequire(import.meta.url).resolve('better-sqlite3')

interface ExternalWorkerTestSqliteProcess {
  readonly pid: number
  pragma: (expr: string) => Promise<unknown>
  seedLargeWalSteps: (count: number, payloadBytes: number) => Promise<void>
  close: () => Promise<void>
}

async function openExternalWorkerTestSqliteProcess(
  dbPath: string,
): Promise<ExternalWorkerTestSqliteProcess> {
  const script = `
    const readline = require('node:readline');
    const Database = require(${JSON.stringify(BETTER_SQLITE3_ENTRY)});
    const db = new Database(${JSON.stringify(dbPath)});
    const rl = readline.createInterface({ input: process.stdin });
    const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
    send({ ready: true, pid: process.pid });
    rl.on('line', (line) => {
      let req;
      try {
        req = JSON.parse(line);
      } catch (err) {
        send({ id: -1, error: String(err) });
        return;
      }
      try {
        if (req.cmd === 'pragma') {
          send({ id: req.id, ok: true, value: db.pragma(req.expr) });
        } else if (req.cmd === 'seedLargeWalSteps') {
          const payload = Buffer.alloc(req.payloadBytes, 0x62);
          const ins = db.prepare(
            'INSERT INTO "steps" ("idx", "step_type", "status", "step_payload") VALUES (?, ?, ?, ?)',
          );
          db.transaction(() => {
            for (let i = 0; i < req.count; i += 1) {
              ins.run(i, ${CORTEX_STEP_TYPE_USER_INPUT}, ${CORTEX_STEP_STATUS_DONE}, payload);
            }
          })();
          send({ id: req.id, ok: true });
        } else if (req.cmd === 'close') {
          db.close();
          send({ id: req.id, ok: true });
          process.exit(0);
        } else {
          send({ id: req.id, error: 'unknown cmd' });
        }
      } catch (err) {
        send({ id: req.id, error: err instanceof Error ? err.message : String(err) });
      }
    });
  `
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (child.pid === undefined) {
    throw new Error('Failed to spawn external SQLite child process.')
  }
  const childPid = child.pid
  let nextId = 1
  const pending = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >()
  let readyResolve: (() => void) | undefined
  let readyReject: ((err: Error) => void) | undefined
  const readyPromise = new Promise<void>((res, rej) => {
    readyResolve = res
    readyReject = rej
  })
  let stderrBuf = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8')
  })
  let stdoutBuf = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8')
    let nl = stdoutBuf.indexOf('\n')
    while (nl >= 0) {
      const line = stdoutBuf.slice(0, nl).trim()
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (line) {
        const parsed: unknown = JSON.parse(line)
        if (parsed !== null && typeof parsed === 'object') {
          if (Reflect.get(parsed, 'ready') === true) {
            readyResolve?.()
            readyResolve = undefined
            readyReject = undefined
          } else {
            const id = Reflect.get(parsed, 'id')
            if (typeof id === 'number') {
              const entry = pending.get(id)
              if (entry) {
                pending.delete(id)
                if (Reflect.get(parsed, 'ok') === true) {
                  entry.resolve(Reflect.get(parsed, 'value'))
                } else {
                  const errMsg = Reflect.get(parsed, 'error')
                  entry.reject(
                    new Error(typeof errMsg === 'string' ? errMsg : 'External SQLite child error'),
                  )
                }
              }
            }
          }
        }
      }
      nl = stdoutBuf.indexOf('\n')
    }
  })
  let exited = false
  let exitError: Error | undefined
  let resolveExit!: () => void
  const exitPromise = new Promise<void>((res) => {
    resolveExit = res
  })
  const markExited = (reason: string): void => {
    if (exited) return
    exited = true
    exitError = new Error(reason)
    readyReject?.(exitError)
    readyResolve = undefined
    readyReject = undefined
    for (const [, entry] of pending) {
      entry.reject(exitError)
    }
    pending.clear()
    resolveExit()
  }
  child.stdin.on('error', () => {
    /* Ignore EPIPE on killed test child. */
  })
  child.once('exit', (code, signal) => {
    markExited(
      `External SQLite child exited (code=${String(code)}, signal=${String(signal)}): ${stderrBuf}`,
    )
  })
  child.once('error', (err) => {
    markExited(`External SQLite child error: ${err.message}`)
  })
  await readyPromise
  const send = (payload: Record<string, unknown>): Promise<unknown> => {
    if (exited || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(exitError ?? new Error('External SQLite child has already exited.'))
    }
    return new Promise((res, rej) => {
      const id = nextId++
      pending.set(id, { resolve: res, reject: rej })
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (writeErr) => {
        if (writeErr) {
          const entry = pending.get(id)
          if (entry) {
            pending.delete(id)
            entry.reject(writeErr)
          }
        }
      })
    })
  }
  let closed = false
  return {
    pid: childPid,
    pragma: async (expr) => send({ cmd: 'pragma', expr }),
    seedLargeWalSteps: async (count, payloadBytes) => {
      await send({ cmd: 'seedLargeWalSteps', count, payloadBytes })
    },
    close: async () => {
      if (closed) return
      closed = true
      const waitExitBounded = async (deadlineMs: number): Promise<boolean> => {
        if (exited) return true
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            exitPromise.then(() => true),
            new Promise<boolean>((res) => {
              timer = setTimeout(() => res(false), deadlineMs)
            }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }
      if (!exited) {
        try {
          await Promise.race([
            send({ cmd: 'close' }),
            waitExitBounded(1_500).then((done) => {
              if (!done) throw new Error('External SQLite child close timed out.')
              return undefined
            }),
          ])
        } catch {
          try {
            child.kill('SIGKILL')
          } catch {
            /* Already exited. */
          }
        }
      }
      if (!(await waitExitBounded(1_500))) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* Best-effort kill. */
        }
        await waitExitBounded(1_000)
      }
    },
  }
}

function observeWorkerTestPosixFcntlLock(
  filePath: string,
  byteOffset: number,
): { lockType: number; pid: number; fRdlck: number; fWrlck: number; fUnlck: number } {
  const probe = spawnSync(
    'python3',
    [
      '-c',
      `
import fcntl, os, struct, sys
p = sys.argv[1]
off = int(sys.argv[2])
fd = os.open(p, os.O_RDWR)
try:
    if sys.platform == 'darwin':
        req = struct.pack('qqihh', off, 1, 0, fcntl.F_WRLCK, os.SEEK_SET)
        out = fcntl.fcntl(fd, fcntl.F_GETLK, req)
        l_start, l_len, l_pid, l_type, l_whence = struct.unpack('qqihh', out)
    else:
        req = struct.pack('hh4xqqi', fcntl.F_WRLCK, os.SEEK_SET, off, 1, 0)
        out = fcntl.fcntl(fd, fcntl.F_GETLK, req)
        l_type, l_whence, l_start, l_len, l_pid = struct.unpack('hh4xqqi', out)
    print(f'{l_type},{l_pid},{fcntl.F_RDLCK},{fcntl.F_WRLCK},{fcntl.F_UNLCK}')
finally:
    os.close(fd)
`,
      filePath,
      String(byteOffset),
    ],
    { encoding: 'utf8' },
  )
  if (probe.status !== 0) {
    throw new Error(`POSIX fcntl probe failed: ${probe.stderr}`)
  }
  const [lockType, pid, fRdlck, fWrlck, fUnlck] = probe.stdout
    .trim()
    .split(',')
    .map((part) => Number(part))
  return {
    lockType: lockType!,
    pid: pid!,
    fRdlck: fRdlck!,
    fWrlck: fWrlck!,
    fUnlck: fUnlck!,
  }
}

it('propagates all 6 Antigravity trajectory identity statuses, bounded budget_exceeded reason, online -shm mxFrame bounds, and VIRTUAL fallback through the real Worker', async () => {
  const cwd = join(directory, `agy-worker-statuses-cwd-${randomUUID()}`)
  await mkdir(cwd, { recursive: true })

  // 1. no_storage_root (missing appDataDir / conversations/) vs missing (conversations/ exists, <sid>.db missing).
  const absentRoot = join(directory, `agy-no-root-${randomUUID()}`)
  const sidMissing = randomUUID()
  expect(
    await files.readAgyTrajectoryIdentity(
      { cwd, storageRoot: absentRoot, nativeSessionId: sidMissing },
      new AbortController().signal,
    ),
  ).toEqual({
    nativeSessionId: sidMissing,
    status: 'no_storage_root',
  })

  const storageRoot = join(directory, `agy-worker-statuses-${randomUUID()}`)
  await mkdir(join(storageRoot, 'conversations'), { recursive: true })
  expect(
    await files.readAgyTrajectoryIdentity(
      { cwd, storageRoot, nativeSessionId: sidMissing },
      new AbortController().signal,
    ),
  ).toEqual({
    nativeSessionId: sidMissing,
    status: 'missing',
  })

  // 2. invalid (missing steps table).
  const invalidSid = randomUUID()
  const invalidDb = new Database(join(storageRoot, 'conversations', `${invalidSid}.db`))
  try {
    invalidDb.exec(
      'CREATE TABLE "trajectory_meta" ("trajectory_id" TEXT PRIMARY KEY, "cascade_id" TEXT NOT NULL);',
    )
    invalidDb
      .prepare('INSERT INTO "trajectory_meta" ("trajectory_id", "cascade_id") VALUES (?, ?)')
      .run(randomUUID(), invalidSid)
  } finally {
    invalidDb.close()
  }
  expect(
    await files.readAgyTrajectoryIdentity(
      { cwd, storageRoot, nativeSessionId: invalidSid },
      new AbortController().signal,
    ),
  ).toEqual({
    nativeSessionId: invalidSid,
    status: 'invalid',
  })

  // 3. transient_churn (hot rollback -journal).
  const churnSid = randomUUID()
  const churnFixture = await createAgyWorkerShellFixture(storageRoot, churnSid)
  await writeFile(`${churnFixture.dbPath}-journal`, Buffer.from('hot-journal'))
  expect(
    await files.readAgyTrajectoryIdentity(
      { cwd, storageRoot, nativeSessionId: churnSid },
      new AbortController().signal,
    ),
  ).toEqual({
    nativeSessionId: churnSid,
    status: 'transient_churn',
  })
  await rm(`${churnFixture.dbPath}-journal`, { force: true })

  // 4. budget_exceeded (active uncheckpointed WAL > 64 MiB) with bounded <= 512B reason,
  //    held open by an independent OS child process (separate PID) so POSIX fcntl locks stay intact!
  const budgetSid = randomUUID()
  const budgetFixture = await createAgyWorkerShellFixture(storageRoot, budgetSid)
  const budgetWriter = await openExternalWorkerTestSqliteProcess(budgetFixture.dbPath)
  try {
    expect(budgetWriter.pid).not.toBe(process.pid)
    await budgetWriter.pragma('journal_mode = WAL')
    await budgetWriter.pragma('wal_autocheckpoint = 0')
    await budgetWriter.seedLargeWalSteps(66, 1_048_576)
    const beforeLock =
      process.platform !== 'win32'
        ? observeWorkerTestPosixFcntlLock(`${budgetFixture.dbPath}-shm`, 128)
        : { lockType: 1, pid: budgetWriter.pid, fRdlck: 1, fWrlck: 3, fUnlck: 2 }
    expect(beforeLock.lockType).toBe(beforeLock.fRdlck)
    expect(beforeLock.pid).toBe(budgetWriter.pid)
    const budgetResult = await files.readAgyTrajectoryIdentity(
      { cwd, storageRoot, nativeSessionId: budgetSid },
      new AbortController().signal,
    )
    expect(budgetResult).toEqual({
      nativeSessionId: budgetSid,
      status: 'budget_exceeded',
      reason: expect.any(String),
    })
    const budgetReason =
      budgetResult.status === 'budget_exceeded' ? (budgetResult.reason ?? '') : ''
    expect(Buffer.byteLength(budgetReason, 'utf8')).toBeLessThanOrEqual(512)
    const afterLock =
      process.platform !== 'win32'
        ? observeWorkerTestPosixFcntlLock(`${budgetFixture.dbPath}-shm`, 128)
        : { lockType: 1, pid: budgetWriter.pid, fRdlck: 1, fWrlck: 3, fUnlck: 2 }
    expect(afterLock.lockType).toBe(afterLock.fRdlck)
    expect(afterLock.pid).toBe(budgetWriter.pid)
  } finally {
    await budgetWriter.close()
  }

  // 5. VIRTUAL generated column + online -shm boundary through the real worker:
  //    (a) aligned SHM & WAL -> ok (stepCount 6);
  //    (b) WAL committed frames beyond published SHM mxFrame (orphan/unpublished SHM) -> transient_churn!
  const virtualSid = randomUUID()
  const virtualTraj = randomUUID()
  const virtualDbPath = join(storageRoot, 'conversations', `${virtualSid}.db`)
  const virtualWriter = new Database(virtualDbPath)
  try {
    virtualWriter.pragma('journal_mode = WAL')
    virtualWriter.pragma('wal_autocheckpoint = 0')
    virtualWriter.exec(`
      CREATE TABLE "trajectory_meta" (
        "v_tag" TEXT GENERATED ALWAYS AS ('v') VIRTUAL,
        "trajectory_id" TEXT PRIMARY KEY,
        "cascade_id" TEXT NOT NULL
      );
      CREATE TABLE "steps" ("idx" INTEGER VARYING PRIMARY KEY, "step_type" INTEGER NOT NULL);
    `)
    virtualWriter
      .prepare('INSERT INTO "trajectory_meta" ("trajectory_id", "cascade_id") VALUES (?, ?)')
      .run(virtualTraj, virtualSid)
    virtualWriter.prepare('INSERT INTO "steps" ("idx", "step_type") VALUES (5, 14)').run()
    const dbAtOne = await readFile(virtualDbPath)
    const walAtOne = await readFile(`${virtualDbPath}-wal`)
    const shmAtOne = await readFile(`${virtualDbPath}-shm`)

    // (a) Aligned SHM & WAL snapshot -> returns ok with exact stepCount 6 and zero sidefiles.
    const alignedRoot = join(directory, `agy-worker-virtual-aligned-${randomUUID()}`)
    await mkdir(join(alignedRoot, 'conversations'), { recursive: true })
    const alignedDbPath = join(alignedRoot, 'conversations', `${virtualSid}.db`)
    await writeFile(alignedDbPath, dbAtOne)
    await writeFile(`${alignedDbPath}-wal`, walAtOne)
    await writeFile(`${alignedDbPath}-shm`, shmAtOne)
    const beforeAligned = (await readdir(join(alignedRoot, 'conversations'))).toSorted()
    expect(
      await files.readAgyTrajectoryIdentity(
        { cwd, storageRoot: alignedRoot, nativeSessionId: virtualSid },
        new AbortController().signal,
      ),
    ).toEqual({
      nativeSessionId: virtualSid,
      status: 'ok',
      trajectoryId: virtualTraj,
      stepCount: 6,
    })
    expect((await readdir(join(alignedRoot, 'conversations'))).toSorted()).toEqual(beforeAligned)

    // (b) Write step 11 into WAL while retaining `shmAtOne` (orphan/unpublished SHM boundary):
    //     MUST return `transient_churn` with `wal_exceeds_published_shm_boundary`, NEVER stale `ok`!
    virtualWriter.prepare('INSERT INTO "steps" ("idx", "step_type") VALUES (11, 15)').run()
    const isolatedRoot = join(directory, `agy-worker-virtual-${randomUUID()}`)
    await mkdir(join(isolatedRoot, 'conversations'), { recursive: true })
    const isoDbPath = join(isolatedRoot, 'conversations', `${virtualSid}.db`)
    await writeFile(isoDbPath, await readFile(virtualDbPath))
    await writeFile(`${isoDbPath}-wal`, await readFile(`${virtualDbPath}-wal`))
    await writeFile(`${isoDbPath}-shm`, shmAtOne)

    const beforeIso = (await readdir(join(isolatedRoot, 'conversations'))).toSorted()
    expect(
      await files.readAgyTrajectoryIdentity(
        { cwd, storageRoot: isolatedRoot, nativeSessionId: virtualSid },
        new AbortController().signal,
      ),
    ).toEqual({
      nativeSessionId: virtualSid,
      status: 'transient_churn',
      reason: 'wal_exceeds_published_shm_boundary',
    })
    expect((await readdir(join(isolatedRoot, 'conversations'))).toSorted()).toEqual(beforeIso)
  } finally {
    virtualWriter.close()
  }
  expect(workerLocation.live).toBe(0)
})

it('enforces Worker memory bounds on oversized fallback values, respects PACT_AGY_APP_DATA_DIR when storageRoot is omitted, rejects relative storageRoot, rejects malformed trajectoryId replies, and refuses POSIX FIFO without blocking', async () => {
  const cwd = join(directory, `agy-worker-hardening-cwd-${randomUUID()}`)
  await mkdir(cwd, { recursive: true })
  const storageRoot = join(directory, `agy-worker-hardening-${randomUUID()}`)
  await mkdir(join(storageRoot, 'conversations'), { recursive: true })

  // 1. Oversized (> 2 MiB) TEXT/BLOB in trajectory_id & steps.idx routed through staged SQLite
  //    fallback inside the 128 MiB Worker -> cleanly rejected as `invalid` without OOM.
  const assertOversizedFallbackRejected = async (
    kind: 'text_tid' | 'blob_tid' | 'blob_idx',
  ): Promise<void> => {
    const sid = randomUUID()
    const tid = randomUUID()
    const dbPath = join(storageRoot, 'conversations', `${sid}.db`)
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE "trajectory_meta" (
          "v_tag" TEXT GENERATED ALWAYS AS ('v') VIRTUAL,
          "trajectory_id" BLOB,
          "cascade_id" TEXT NOT NULL
        );
        CREATE TABLE "steps" ("row_id" INTEGER PRIMARY KEY, "idx" BLOB);
      `)
      if (kind === 'text_tid') {
        db.prepare(
          'INSERT INTO "trajectory_meta" ("trajectory_id", "cascade_id") VALUES (?, ?)',
        ).run('x'.repeat(2 * 1024 * 1024), sid)
      } else if (kind === 'blob_tid') {
        db.prepare(
          'INSERT INTO "trajectory_meta" ("trajectory_id", "cascade_id") VALUES (?, ?)',
        ).run(Buffer.alloc(2 * 1024 * 1024, 0x55), sid)
      } else {
        db.prepare(
          'INSERT INTO "trajectory_meta" ("trajectory_id", "cascade_id") VALUES (?, ?)',
        ).run(tid, sid)
        db.prepare('INSERT INTO "steps" ("row_id", "idx") VALUES (1, ?)').run(
          Buffer.alloc(2 * 1024 * 1024, 0x66),
        )
      }
    } finally {
      db.close()
    }
    expect(
      await files.readAgyTrajectoryIdentity(
        { cwd, storageRoot, nativeSessionId: sid },
        new AbortController().signal,
      ),
    ).toEqual({
      nativeSessionId: sid,
      status: 'invalid',
    })
    expect(workerLocation.live).toBe(0)
  }
  await assertOversizedFallbackRejected('text_tid')
  await assertOversizedFallbackRejected('blob_tid')
  await assertOversizedFallbackRejected('blob_idx')

  // 2. Omitted storageRoot honors PACT_AGY_APP_DATA_DIR (consistent with `exists`).
  const envSid = randomUUID()
  const envFixture = await createAgyWorkerShellFixture(storageRoot, envSid)
  const prevEnv = process.env['PACT_AGY_APP_DATA_DIR']
  process.env['PACT_AGY_APP_DATA_DIR'] = storageRoot
  try {
    expect(
      await files.exists(
        { provider: 'agy', cwd, nativeSessionId: envSid },
        new AbortController().signal,
      ),
    ).toBe(true)
    expect(
      await files.readAgyTrajectoryIdentity(
        { cwd, nativeSessionId: envSid },
        new AbortController().signal,
      ),
    ).toEqual({
      nativeSessionId: envSid,
      status: 'ok',
      trajectoryId: envFixture.trajectoryId,
      stepCount: 0,
    })
  } finally {
    if (prevEnv === undefined) delete process.env['PACT_AGY_APP_DATA_DIR']
    else process.env['PACT_AGY_APP_DATA_DIR'] = prevEnv
  }
  expect(workerLocation.live).toBe(0)

  // 3. Relative storageRoot is rejected consistently with other Antigravity storage actions.
  await expect(
    files.readAgyTrajectoryIdentity(
      { cwd, storageRoot: 'relative/agy-store', nativeSessionId: envSid },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/not absolute/iu)
  expect(workerLocation.live).toBe(0)

  // 4. Malformed isolated child success reply containing whitespace / control / non-ASCII trajectoryId is rejected!
  const fakeChildPath = join(directory, `fake-bad-tid-child-${randomUUID()}.mjs`)
  const assertMalformedReplyRejected = async (badTrajectoryId: string): Promise<void> => {
    await writeFile(
      fakeChildPath,
      `process.on('message', (msg) => {
        if (msg?.type === 'request') {
          process.send({
            type: 'result',
            jobKey: msg.jobKey,
            action: msg.input.action,
            result: {
              nativeSessionId: msg.input.nativeSessionId,
              status: 'ok',
              trajectoryId: ${JSON.stringify(badTrajectoryId)},
              stepCount: 1,
            },
            ...(msg.measure ? { ipcMeasurement: { complete: true, jsonBytes: 64, binaryBytes: 0, totalBytes: 64 } } : {}),
          }, () => process.exit(0));
        }
      });`,
    )
    configureAgyStorageChildScriptForTesting(fakeChildPath)
    await expect(
      files.readAgyTrajectoryIdentity(
        { cwd, storageRoot, nativeSessionId: envSid },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Invalid Antigravity/iu)
    expect(getNodeAgyStorageChildStatsForTesting().live).toBe(0)
  }
  try {
    await assertMalformedReplyRejected('bad id')
    await assertMalformedReplyRejected('bad\nid')
    await assertMalformedReplyRejected('bad\tid')
    await assertMalformedReplyRejected('bad_é')
    await assertMalformedReplyRejected('\uFEFFbad')
  } finally {
    configureAgyStorageChildScriptForTesting(agyChildBundlePath)
    await rm(fakeChildPath, { force: true })
  }
})

it.skipIf(process.platform === 'win32')(
  'refuses POSIX FIFO source paths without blocking isolated child termination',
  async () => {
    const cwd = join(directory, `agy-worker-fifo-cwd-${randomUUID()}`)
    await mkdir(cwd, { recursive: true })
    const storageRoot = join(directory, `agy-worker-fifo-${randomUUID()}`)
    await mkdir(join(storageRoot, 'conversations'), { recursive: true })

    const fifoSid = randomUUID()
    const fifoPath = join(storageRoot, 'conversations', `${fifoSid}.db`)
    const mk = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' })
    expect(mk.status).toBe(0)
    const started = performance.now()
    expect(
      await files.readAgyTrajectoryIdentity(
        { cwd, storageRoot, nativeSessionId: fifoSid },
        new AbortController().signal,
      ),
    ).toEqual({
      nativeSessionId: fifoSid,
      status: 'invalid',
    })
    expect(performance.now() - started).toBeLessThan(2_500)
    expect(getNodeAgyStorageChildStatsForTesting().live).toBe(0)
    expect(workerLocation.live).toBe(0)
  },
)

function countAgySteps(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM "steps"').get()
    return row && typeof row === 'object' ? Number(Reflect.get(row, 'count')) : -1
  } finally {
    db.close()
  }
}

it.skipIf(process.platform === 'win32')(
  'preserves core PID exclusive POSIX lock on .pact-writer.sqlite across 3 real OS PIDs when isolated storage child rejects symlink and hardlink aliases',
  async () => {
    const workRoot = join(directory, `agy-3pid-lock-${randomUUID()}`)
    const storageRoot = join(workRoot, 'agy-root')
    const cwd = await realpath(directory)
    await mkdir(join(storageRoot, 'conversations'), { recursive: true })

    // PID #1 (this Vitest/Utility process): hold an exclusive SQLite write lock on `.pact-writer.sqlite`.
    const writerDbPath = join(workRoot, '.pact-writer.sqlite')
    const writerDb = new Database(writerDbPath)
    try {
      writerDb.pragma('journal_mode = DELETE')
      writerDb.exec('CREATE TABLE "lock_probe" ("id" INTEGER PRIMARY KEY, "val" TEXT);')
      writerDb.exec('BEGIN EXCLUSIVE')
      writerDb.prepare('INSERT INTO "lock_probe" ("id", "val") VALUES (1, ?)').run('held-by-core')

      const probeContender = (): { busy: boolean; pid: number } => {
        const res = spawnSync(
          process.execPath,
          [
            '-e',
            `
            const Database = require(${JSON.stringify(BETTER_SQLITE3_ENTRY)});
            const db = new Database(${JSON.stringify(writerDbPath)}, { timeout: 50 });
            try {
              db.exec('BEGIN IMMEDIATE');
              db.exec('ROLLBACK');
              process.stdout.write(JSON.stringify({ busy: false, pid: process.pid }));
            } catch (err) {
              process.stdout.write(JSON.stringify({ busy: true, code: err?.code ?? '', pid: process.pid }));
            } finally {
              db.close();
            }
          `,
          ],
          { encoding: 'utf8' },
        )
        expect(res.status).toBe(0)
        const parsed: unknown = JSON.parse(res.stdout.trim())
        if (typeof parsed !== 'object' || parsed === null) {
          throw new Error('Unexpected contender probe output.')
        }
        const busy = Reflect.get(parsed, 'busy')
        const pid = Reflect.get(parsed, 'pid')
        expect(typeof busy).toBe('boolean')
        expect(typeof pid).toBe('number')
        return { busy: Boolean(busy), pid: Number(pid) }
      }

      // Baseline: PID #3 (independent contender) is blocked by PID #1's exclusive lock.
      const before = probeContender()
      expect(before.pid).not.toBe(process.pid)
      expect(before.busy).toBe(true)

      // Create BOTH symlink and hardlink targets inside conversations/ pointing to `.pact-writer.sqlite`.
      const symlinkSid = randomUUID()
      const hardlinkSid = randomUUID()
      await symlink(writerDbPath, join(storageRoot, 'conversations', `${symlinkSid}.db`))
      await link(writerDbPath, join(storageRoot, 'conversations', `${hardlinkSid}.db`))

      // PID #2 (isolated agy-storage-child): rejects symlink & hardlink cleanly without releasing PID #1's POSIX lock!
      const symlinkRes = await files.readAgyTrajectoryIdentity(
        { cwd, storageRoot, nativeSessionId: symlinkSid },
        new AbortController().signal,
      )
      expect(symlinkRes).toEqual({ nativeSessionId: symlinkSid, status: 'invalid' })
      const pidAfterSymlink = getNodeAgyStorageChildStatsForTesting().lastPid
      expect(pidAfterSymlink).toBeDefined()
      expect(pidAfterSymlink).not.toBe(process.pid)

      const hardlinkRes = await files.readAgyTrajectoryIdentity(
        { cwd, storageRoot, nativeSessionId: hardlinkSid },
        new AbortController().signal,
      )
      expect(hardlinkRes).toEqual({ nativeSessionId: hardlinkSid, status: 'invalid' })
      const pidAfterHardlink = getNodeAgyStorageChildStatsForTesting().lastPid
      expect(pidAfterHardlink).toBeDefined()
      expect(pidAfterHardlink).not.toBe(process.pid)
      expect(pidAfterHardlink).not.toBe(pidAfterSymlink)

      await expect(
        files.inspectAgyRun(
          { cwd, storageRoot, nativeSessionId: hardlinkSid },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/link|invalid|ordinary|storage|single/iu)

      // PID #3 MUST STILL fail to acquire write lock because PID #1's POSIX fcntl lock stayed intact!
      const afterChildReads = probeContender()
      expect(afterChildReads.pid).not.toBe(process.pid)
      expect(afterChildReads.pid).not.toBe(pidAfterHardlink)
      expect(afterChildReads.busy).toBe(true)

      // Release PID #1's exclusive lock -> PID #3 now acquires cleanly.
      writerDb.exec('ROLLBACK')
      const afterRelease = probeContender()
      expect(afterRelease.busy).toBe(false)
      expect(getNodeAgyStorageChildStatsForTesting().live).toBe(0)
    } finally {
      writerDb.close()
    }
  },
)

it('runs concurrent isolated-PID Antigravity Fork and identity reads without blocking and enforces candidate_committed ACK before atomic publish', async () => {
  const storageRoot = join(directory, `agy-isolated-concurrent-${randomUUID()}`)
  const cwd = await realpath(directory)
  const sourceSid = randomUUID()
  const candidateSid = randomUUID()
  const rejectedCandidateSid = randomUUID()
  const { dbPath: sourceDbPath, trajectoryId: sourceTrajId } = await createAgyWorkerShellFixture(
    storageRoot,
    sourceSid,
  )
  const candidateFixture = await createAgyWorkerShellFixture(storageRoot, candidateSid)
  const rejectedFixture = await createAgyWorkerShellFixture(storageRoot, rejectedCandidateSid)

  const pactRunId = randomUUID()
  const pactMsgId = randomUUID()
  const db = new Database(sourceDbPath)
  try {
    const u0Meta = encodeCortexStepMetadata({
      createdAtSeconds: 1_710_000_600n,
      source: 1,
      executionId: 'exec-iso-1',
      trajectoryId: sourceTrajId,
      stepIndex: 0,
      cascadeId: sourceSid,
      stepId: 'step-i0',
    })
    const u0Data = encodeAgyUserInputStep({
      metadata: u0Meta,
      text: `Isolated prompt\n${JSON.stringify({
        version: 'pact-agent-prompt-v1',
        messageId: pactMsgId,
        pactRunId,
      })}`,
    })
    const p1Meta = encodeCortexStepMetadata({
      createdAtSeconds: 1_710_000_601n,
      source: 2,
      executionId: 'exec-iso-1',
      trajectoryId: sourceTrajId,
      stepIndex: 1,
      cascadeId: sourceSid,
      stepId: 'step-i1',
    })
    const p1Data = encodeAgyPlannerResponseStep({
      metadata: p1Meta,
      response: 'Isolated answer.',
    })
    const insertStep = db.prepare(
      'INSERT INTO "steps" ("idx", "step_type", "status", "has_subtrajectory", "metadata", "step_payload", "step_format") VALUES (?, ?, ?, 0, ?, ?, 0)',
    )
    insertStep.run(0, CORTEX_STEP_TYPE_USER_INPUT, CORTEX_STEP_STATUS_DONE, u0Meta, u0Data)
    insertStep.run(1, CORTEX_STEP_TYPE_PLANNER_RESPONSE, CORTEX_STEP_STATUS_DONE, p1Meta, p1Data)
    const genData = encodeProtobufFields([
      encodeBytesField(
        1,
        encodeProtobufFields([
          encodeBytesField(
            20,
            encodeProtobufFields([
              encodeStringField(1, 'trajectory_id'),
              encodeStringField(2, sourceTrajId),
            ]),
          ),
          encodeBytesField(
            20,
            encodeProtobufFields([
              encodeStringField(1, 'cascade_id'),
              encodeStringField(2, sourceSid),
            ]),
          ),
        ]),
      ),
      encodeVarintField(2, 1),
      encodeStringField(4, 'exec-iso-1'),
    ])
    db.prepare('INSERT INTO "gen_metadata" ("idx", "data", "size") VALUES (0, ?, ?)').run(
      genData,
      genData.byteLength,
    )
    const execData = encodeExecutorMetadata({
      terminationReason: EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
      numGeneratorInvocations: 1,
      lastStepIdx: 1,
      executionId: 'exec-iso-1',
    })
    db.prepare('INSERT INTO "executor_metadata" ("idx", "data", "size") VALUES (0, ?, ?)').run(
      execData,
      execData.byteLength,
    )
  } finally {
    db.close()
  }

  const filesA = new NativeForkFiles(traffic)
  const filesB = new NativeForkFiles(traffic)
  try {
    const responseHash = hash('Isolated answer.')
    const boundary = await filesA.prepareAgyBoundary(
      {
        cwd,
        storageRoot,
        nativeSessionId: sourceSid,
        nativeTurnId: pactRunId,
        nativeInputIds: [pactRunId],
        bindingGeneration: 1,
        throughSequence: 2,
        deliveryCursor: 2,
        responseHash,
      },
      new AbortController().signal,
    )

    // Pause Fork inside onCandidate BEFORE atomic publish: candidate DB MUST still have 0 steps,
    // AND a concurrent isolated-PID readAgyTrajectoryIdentity on filesB succeeds simultaneously!
    const candidateEntered = Promise.withResolvers<void>()
    const releaseCandidate = Promise.withResolvers<void>()
    const forkPromise = filesA.forkAgy(
      {
        cwd,
        storageRoot,
        candidateNativeSessionId: candidateSid,
        source: boundary,
        responseHash,
        model: 'gemini-3-flash',
        effort: 'high',
        permissionMode: 'auto',
        markInitialized: true,
        onCandidate: async () => {
          expect(countAgySteps(candidateFixture.dbPath)).toBe(0)
          candidateEntered.resolve()
          await releaseCandidate.promise
        },
      },
      new AbortController().signal,
    )
    await candidateEntered.promise
    expect(getNodeAgyStorageChildStatsForTesting().live).toBe(1)

    const concurrentIdentity = await filesB.readAgyTrajectoryIdentity(
      { cwd, storageRoot, nativeSessionId: sourceSid },
      new AbortController().signal,
    )
    expect(concurrentIdentity).toEqual({
      nativeSessionId: sourceSid,
      status: 'ok',
      trajectoryId: sourceTrajId,
      stepCount: 2,
    })

    // Still 0 steps before candidate_committed ACK is sent.
    expect(countAgySteps(candidateFixture.dbPath)).toBe(0)
    releaseCandidate.resolve()
    const forked = await forkPromise
    expect(forked.nativeSessionId).toBe(candidateSid)
    expect(countAgySteps(candidateFixture.dbPath)).toBe(2)
    expect(getNodeAgyStorageChildStatsForTesting().live).toBe(0)

    // Rejecting onCandidate MUST prevent atomic publish (candidate DB stays at 0 steps) and reap child PID.
    await expect(
      filesA.forkAgy(
        {
          cwd,
          storageRoot,
          candidateNativeSessionId: rejectedCandidateSid,
          source: boundary,
          responseHash,
          model: 'gemini-3-flash',
          effort: 'high',
          permissionMode: 'auto',
          onCandidate: async () => {
            throw new Error('Simulated Repository witness persistence failure')
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Simulated Repository witness persistence failure/u)
    expect(countAgySteps(rejectedFixture.dbPath)).toBe(0)
    expect(getNodeAgyStorageChildStatsForTesting().live).toBe(0)
  } finally {
    await filesA.dispose()
    await filesB.dispose()
  }
})

it('cancels and reaps isolated child PID when a physical operation observer throws, settles cleanly on immediate child exit, and releases once on cancel vs result race', async () => {
  const cwd = await realpath(directory)
  const storageRoot = join(directory, `agy-lifecycle-${randomUUID()}`)
  const sid = randomUUID()
  await createAgyWorkerShellFixture(storageRoot, sid)

  const memBefore = nativeWorkingMemoryDiagnostics().chargedBytes ?? 0

  // 1. Observer throwing synchronously on registration MUST still cancel & reap the isolated child PID!
  const throwingOwner = new NativeForkFiles(traffic, () => {
    throw new Error('Observer exploded during registration')
  })
  await expect(
    throwingOwner.readAgyTrajectoryIdentity(
      { cwd, storageRoot, nativeSessionId: sid },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/Observer exploded during registration/u)
  expect(getNodeAgyStorageChildStatsForTesting().live).toBe(0)
  expect(nativeWorkingMemoryDiagnostics().chargedBytes).toBe(memBefore)
  await throwingOwner.dispose()

  // 2. Isolated child exiting immediately on start settles both result and physical cleanly.
  const immediateExitChild = join(directory, `immediate-exit-child-${randomUUID()}.mjs`)
  await writeFile(immediateExitChild, `process.exit(1);\n`)
  try {
    configureAgyStorageChildScriptForTesting(immediateExitChild)
    const runner = new AgyStorageRunner({ ipcTraffic: traffic })
    const handle = runner.start(
      { action: 'read-agy-trajectory-identity', cwd, storageRoot, nativeSessionId: sid },
      { signal: new AbortController().signal, deadlineAt: Date.now() + 5_000 },
    )
    await expect(handle.result).rejects.toThrow(/ended without a result/iu)
    await handle.physical
    expect(getNodeAgyStorageChildStatsForTesting().live).toBe(0)
    expect(nativeWorkingMemoryDiagnostics().chargedBytes).toBe(memBefore)
    await runner.dispose()
  } finally {
    configureAgyStorageChildScriptForTesting(agyChildBundlePath)
    await rm(immediateExitChild, { force: true })
  }

  // 3. Cancel vs result race on a controlled transport settles and releases memory & traffic EXACTLY ONCE.
  const raceTraffic = new LogicalIpcWorkerTraffic(
    ['utility-native-fork'],
    '00000000-0000-4000-8000-000000000009',
  )
  const exitDeferred = Promise.withResolvers<import('@pact/contracts').AgyStorageClosedEvent>()
  let portListener: ((msg: unknown) => void) | undefined
  let cancelCount = 0
  let capturedJobKey: import('@pact/contracts').AgyStorageJobKey | undefined
  const raceTransport: AgyStorageTransport = {
    generation: randomUUID(),
    open: async (openReq) => {
      capturedJobKey = openReq.jobKey
      return {
        port: {
          onMessage: (listener) => {
            portListener = listener
          },
          postMessage: () => undefined,
          close: () => undefined,
        },
        exited: exitDeferred.promise,
        cancel: () => {
          cancelCount += 1
        },
      }
    },
  }

  const raceRunner = new AgyStorageRunner({ ipcTraffic: raceTraffic, transport: raceTransport })
  const observedPhysical: Promise<void>[] = []
  const unsub = raceRunner.addPhysicalOperationObserver((_sig, physical) => {
    observedPhysical.push(physical)
  })
  const handle = raceRunner.start(
    { action: 'exists', cwd, storageRoot, nativeSessionId: sid },
    { signal: new AbortController().signal, deadlineAt: Date.now() + 5_000 },
  )
  await vi.waitFor(() => expect(portListener).toBeDefined())
  expect(observedPhysical).toHaveLength(1)
  expect(nativeWorkingMemoryDiagnostics().chargedBytes).toBe(memBefore + NATIVE_OWNER_WORKING_BYTES)

  let physicalSettled = false
  void handle.physical.then(() => {
    physicalSettled = true
    return undefined
  })

  // Race: result arrives immediately followed by cancel() (and a duplicate cancel()).
  portListener!({
    type: 'result',
    jobKey: capturedJobKey!,
    action: 'exists',
    result: { nativeSessionId: sid, exists: true },
    ipcMeasurement: { complete: true, jsonBytes: 48, binaryBytes: 0, totalBytes: 48 },
  })
  handle.cancel()
  handle.cancel()

  await expect(handle.result).resolves.toEqual({ nativeSessionId: sid, exists: true })
  await new Promise<void>((res) => setTimeout(res, 20))
  // Physical completion MUST stay pending until confirmed exit!
  expect(physicalSettled).toBe(false)
  expect(cancelCount).toBeGreaterThanOrEqual(1)

  exitDeferred.resolve({
    type: 'agy-storage.closed.event',
    jobKey: capturedJobKey!,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: true,
  })
  await handle.physical
  await observedPhysical[0]
  expect(physicalSettled).toBe(true)
  expect(nativeWorkingMemoryDiagnostics().chargedBytes).toBe(memBefore)

  const snap = raceTraffic.collector('utility-native-fork')!.snapshot()
  expect(snap.startedTransports).toBe(1)
  expect(snap.settledTransports).toBe(1)
  expect(snap.activeTransports).toBe(0)
  unsub()
  await raceRunner.dispose()
})

function canonicalJsonForAgyTest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonForAgyTest)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([l], [r]) => (l < r ? -1 : l > r ? 1 : 0))
        .map(([k, v]) => [k, canonicalJsonForAgyTest(v)]),
    )
  }
  return value
}

it('admits concurrent independent Agy reads on one shared NativeForkFiles instance, serializes mutations per candidate key, and persists the exact acknowledged witness', async () => {
  const cwd = await realpath(directory)
  const storageRoot = join(directory, `agy-shared-concurrency-${randomUUID()}`)
  const sourceSid = randomUUID()
  const candidateSidA = randomUUID()
  const candidateSidB = randomUUID()
  const sourceTrajId = `traj-src-${randomUUID().slice(0, 8)}`
  const candTrajIdA = `traj-cand-a-${randomUUID().slice(0, 8)}`
  const candTrajIdB = `traj-cand-b-${randomUUID().slice(0, 8)}`
  const prefixHash = hash('shared-instance-prefix')
  const rawHash = hash('shared-instance-raw')

  const digestOf = (value: unknown): string => hash(JSON.stringify(canonicalJsonForAgyTest(value)))

  const sourceBoundary: import('@pact/agent-runtime').AgentNativeForkBoundary = {
    provider: 'agy',
    nativeSessionId: sourceSid,
    nativeTurnId: 'exec-1',
    nativeCutId: 'exec-1',
    agyCut: {
      version: 'pact-agy-fork-cut-v1',
      trajectoryId: sourceTrajId,
      executionId: 'exec-1',
      cutStepIdx: 1,
      genMetadataCount: 0,
      executorMetadataCount: 1,
      mediaCount: 0,
    },
    bindingGeneration: 1,
    throughSequence: 2,
    deliveryCursor: 2,
    prefixHash,
    prefixRecords: 3,
    prefixBytes: 256,
  }

  let openedJobs = 0
  let maxConcurrentJobs = 0
  let liveJobs = 0
  const pendingExits: Array<() => void> = []

  const controlledTransport: AgyStorageTransport = {
    generation: randomUUID(),
    open: async (openReq) => {
      openedJobs += 1
      liveJobs += 1
      maxConcurrentJobs = Math.max(maxConcurrentJobs, liveJobs)
      const exitDeferred = Promise.withResolvers<import('@pact/contracts').AgyStorageClosedEvent>()
      let listener: ((msg: unknown) => void) | undefined
      const finishExit = (cancelled = false): void => {
        liveJobs = Math.max(0, liveJobs - 1)
        exitDeferred.resolve({
          type: 'agy-storage.closed.event',
          jobKey: openReq.jobKey,
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled,
        })
      }
      pendingExits.push(() => finishExit(true))

      return {
        port: {
          onMessage: (fn) => {
            listener = fn
          },
          postMessage: (msg) => {
            const msgType = Reflect.get(msg, 'type')
            if (msgType === 'request') {
              const reqInput = Reflect.get(msg, 'input')
              if (!reqInput || typeof reqInput !== 'object') return
              const reqAction = Reflect.get(reqInput, 'action')
              if (reqAction === 'read-agy-trajectory-identity') {
                const reqSid = String(Reflect.get(reqInput, 'nativeSessionId'))
                queueMicrotask(() => {
                  listener?.({
                    type: 'result',
                    jobKey: openReq.jobKey,
                    action: 'read-agy-trajectory-identity',
                    result: {
                      nativeSessionId: reqSid,
                      status: 'ok',
                      trajectoryId: sourceTrajId,
                      stepCount: 2,
                    },
                  })
                  queueMicrotask(() => finishExit(false))
                })
                return
              }
              if (reqAction === 'fork') {
                const candSid = String(Reflect.get(reqInput, 'candidateNativeSessionId'))
                const candTraj = candSid === candidateSidA ? candTrajIdA : candTrajIdB
                const candFile = {
                  nativeSessionId: candSid,
                  nativeCutId: 'exec-1',
                  prefixHash,
                  prefixBytes: 256,
                  prefixRecords: 3,
                  idMap: [['exec-1', 'exec-1']] as Array<[string, string]>,
                  rawHash: '',
                  rawBytes: 0,
                  rawRecords: 3,
                  nativeStorageRoot: storageRoot,
                  nativePath: join(storageRoot, 'conversations', `${candSid}.db`),
                  cutStep: 1,
                  trajectoryId: candTraj,
                  sourceTrajectoryId: sourceTrajId,
                  agyCut: {
                    version: 'pact-agy-fork-cut-v1' as const,
                    trajectoryId: candTraj,
                    executionId: 'exec-1',
                    cutStepIdx: 1,
                    genMetadataCount: 0,
                    executorMetadataCount: 1,
                    mediaCount: 0,
                  },
                }
                const candWitness = {
                  version: 'pact-native-fork-v1' as const,
                  provider: 'agy' as const,
                  nativeSessionId: candSid,
                  sourceNativeSessionId: sourceSid,
                  sourceCutId: 'exec-1',
                  sourceTrajectoryId: sourceTrajId,
                  candidateTrajectoryId: candTraj,
                  cutStepIdx: 1,
                  agyCut: candFile.agyCut,
                  sourcePrefixHash: prefixHash,
                  candidatePrefixHash: prefixHash,
                  idMap: candFile.idMap,
                  candidatePrefixRecords: 3,
                  nativeStorageRoot: storageRoot,
                  nativePath: candFile.nativePath,
                  model: 'gemini-3-flash',
                  effort: 'high',
                  permissionMode: 'auto' as const,
                }
                const witnessDigest = digestOf(candWitness)
                queueMicrotask(() => {
                  listener?.({
                    type: 'candidate',
                    jobKey: openReq.jobKey,
                    candidateNativeSessionId: candSid,
                    witnessDigest,
                    witness: candWitness,
                    candidate: candFile,
                  })
                })
                return
              }
            }
            if (msgType === 'candidate_committed') {
              const candSid = String(Reflect.get(msg, 'candidateNativeSessionId'))
              const candTraj = candSid === candidateSidA ? candTrajIdA : candTrajIdB
              queueMicrotask(() => {
                listener?.({
                  type: 'result',
                  jobKey: openReq.jobKey,
                  action: 'fork',
                  result: {
                    nativeSessionId: candSid,
                    nativeCutId: 'exec-1',
                    prefixHash,
                    prefixBytes: 256,
                    prefixRecords: 3,
                    idMap: [['exec-1', 'exec-1']],
                    rawHash,
                    rawBytes: 1024,
                    rawRecords: 3,
                    nativeStorageRoot: storageRoot,
                    nativePath: join(storageRoot, 'conversations', `${candSid}.db`),
                    cutStep: 1,
                    trajectoryId: candTraj,
                    sourceTrajectoryId: sourceTrajId,
                    agyCut: {
                      version: 'pact-agy-fork-cut-v1',
                      trajectoryId: candTraj,
                      executionId: 'exec-1',
                      cutStepIdx: 1,
                      genMetadataCount: 0,
                      executorMetadataCount: 1,
                      mediaCount: 0,
                    },
                  },
                })
                queueMicrotask(() => finishExit(false))
              })
            }
          },
          close: () => undefined,
        },
        exited: exitDeferred.promise,
        cancel: () => finishExit(true),
      }
    },
  }

  const sharedFiles = new NativeForkFiles(undefined, undefined, controlledTransport)
  try {
    const forkAEntered = Promise.withResolvers<void>()
    const releaseForkA = Promise.withResolvers<void>()
    let persistedWitnessA: unknown

    const forkAPromise = sharedFiles.forkAgy(
      {
        cwd,
        storageRoot,
        candidateNativeSessionId: candidateSidA,
        source: sourceBoundary,
        model: 'gemini-3-flash',
        effort: 'high',
        permissionMode: 'auto',
        markInitialized: true,
        onCandidate: async (_sid, receivedWitness) => {
          persistedWitnessA = receivedWitness
          forkAEntered.resolve()
          await releaseForkA.promise
        },
      },
      new AbortController().signal,
    )

    await forkAEntered.promise

    // 1. Concurrent independent Agy read on the SAME shared NativeForkFiles instance MUST succeed!
    const readWhileForkActive = await sharedFiles.readAgyTrajectoryIdentity(
      { cwd, storageRoot, nativeSessionId: sourceSid },
      new AbortController().signal,
    )
    expect(readWhileForkActive).toEqual({
      nativeSessionId: sourceSid,
      status: 'ok',
      trajectoryId: sourceTrajId,
      stepCount: 2,
    })
    expect(maxConcurrentJobs).toBeGreaterThanOrEqual(2)

    // 2. Concurrent mutation targeting the SAME candidateSidA MUST be rejected immediately!
    await expect(
      sharedFiles.forkAgy(
        {
          cwd,
          storageRoot,
          candidateNativeSessionId: candidateSidA,
          source: sourceBoundary,
          model: 'gemini-3-flash',
          effort: 'high',
          permissionMode: 'auto',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/already active/iu)

    // 3. Concurrent mutation targeting a DIFFERENT candidateSidB is admitted independently!
    const forkBResult = await sharedFiles.forkAgy(
      {
        cwd,
        storageRoot,
        candidateNativeSessionId: candidateSidB,
        source: sourceBoundary,
        model: 'gemini-3-flash',
        effort: 'high',
        permissionMode: 'auto',
        onCandidate: async () => undefined,
      },
      new AbortController().signal,
    )
    expect(forkBResult.nativeSessionId).toBe(candidateSidB)

    releaseForkA.resolve()
    const forkAResult = await forkAPromise
    expect(forkAResult.nativeSessionId).toBe(candidateSidA)
    expect(persistedWitnessA).toMatchObject({
      nativeSessionId: candidateSidA,
      candidateTrajectoryId: candTrajIdA,
      sourceTrajectoryId: sourceTrajId,
      candidatePrefixHash: prefixHash,
    })
    expect(openedJobs).toBe(3)
    expect(sharedFiles.active).toBe(false)
  } finally {
    await sharedFiles.dispose()
  }
})

it('recovers interrupted Claude Fork deterministic staging link (nlink === 2 -> 1) without deleting unrelated files', async () => {
  const profile = join(directory, randomUUID())
  const project = join(
    profile,
    'projects',
    (await realpath(directory)).replace(/[^a-z0-9]/giu, '-'),
  )
  await mkdir(project, { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
  const signal = new AbortController().signal

  try {
    // 1. Interrupted link -> unlink crash: <sid>.jsonl and .pact-fork-<sid>.tmp share the same inode (nlink === 2).
    const recoveredSid = randomUUID()
    const recoveredTurnId = randomUUID()
    const recoveredTranscript =
      [
        {
          type: 'user',
          uuid: recoveredTurnId,
          parentUuid: null,
          message: { role: 'user', content: 'Recover deterministic staging link' },
        },
        {
          type: 'assistant',
          uuid: randomUUID(),
          parentUuid: recoveredTurnId,
          message: {
            id: 'answer-recover',
            role: 'assistant',
            content: [{ type: 'text', text: 'Recovered answer' }],
          },
        },
      ]
        .map((row) =>
          JSON.stringify({
            ...row,
            sessionId: recoveredSid,
            cwd: directory,
            timestamp: new Date().toISOString(),
          }),
        )
        .join('\n') + '\n'
    const recoveredPath = join(project, `${recoveredSid}.jsonl`)
    const deterministicStagePath = join(project, `.pact-fork-${recoveredSid}.tmp`)
    const unrelatedSiblingPath = join(project, 'unrelated-keep.txt')
    await writeFile(unrelatedSiblingPath, 'preserve-me')
    await writeFile(recoveredPath, recoveredTranscript)
    await link(recoveredPath, deterministicStagePath)
    expect((await stat(recoveredPath)).nlink).toBe(2)

    const prepared = await files.execute(
      {
        provider: 'claude',
        action: 'prepare',
        cwd: directory,
        nativeSessionId: recoveredSid,
        nativeTurnId: recoveredTurnId,
        responseHash: hash('Recovered answer'),
      },
      signal,
    )
    expect(prepared.prefixRecords).toBeGreaterThan(0)
    expect((await stat(recoveredPath)).nlink).toBe(1)
    await expect(stat(deterministicStagePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(unrelatedSiblingPath, 'utf8')).toBe('preserve-me')

    // 2. External hardlink (nlink === 2 via unrelated name) with an unrelated file at .pact-fork-<sid>.tmp:
    //    MUST reject the linked transcript AND NEVER delete the unrelated file at the staging path!
    const linkedSid = randomUUID()
    const linkedTurnId = randomUUID()
    const linkedTranscript =
      [
        {
          type: 'user',
          uuid: linkedTurnId,
          parentUuid: null,
          message: { role: 'user', content: 'External hardlink' },
        },
        {
          type: 'assistant',
          uuid: randomUUID(),
          parentUuid: linkedTurnId,
          message: {
            id: 'answer-linked',
            role: 'assistant',
            content: [{ type: 'text', text: 'External answer' }],
          },
        },
      ]
        .map((row) =>
          JSON.stringify({
            ...row,
            sessionId: linkedSid,
            cwd: directory,
            timestamp: new Date().toISOString(),
          }),
        )
        .join('\n') + '\n'
    const linkedPath = join(project, `${linkedSid}.jsonl`)
    const externalAliasPath = join(project, 'external-alias.jsonl')
    const unrelatedAtStagePath = join(project, `.pact-fork-${linkedSid}.tmp`)
    await writeFile(linkedPath, linkedTranscript)
    await link(linkedPath, externalAliasPath)
    await writeFile(unrelatedAtStagePath, 'unrelated-staging-occupant')
    expect((await stat(linkedPath)).nlink).toBe(2)

    await expect(
      files.execute(
        {
          provider: 'claude',
          action: 'prepare',
          cwd: directory,
          nativeSessionId: linkedSid,
          nativeTurnId: linkedTurnId,
          responseHash: hash('External answer'),
        },
        signal,
      ),
    ).rejects.toThrow(/linked|unsupported/iu)
    expect((await stat(linkedPath)).nlink).toBe(2)
    expect(await readFile(unrelatedAtStagePath, 'utf8')).toBe('unrelated-staging-occupant')
  } finally {
    vi.unstubAllEnvs()
  }
})
