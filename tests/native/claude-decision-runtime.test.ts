import { createHash, randomUUID } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import type { DecisionPhysicalWitness } from '../../packages/contracts/src/index.js'

import {
  claudeDecisionFingerprint,
  createClaudeDecisionResponseGuard,
  parseClaudeDecisionJson,
} from '../../apps/desktop/src/utility/conversation/claude-decision-response-guard.js'
import {
  ClaudeDecisionRuntime,
  type ClaudeDecisionRuntimeContext,
} from '../../apps/desktop/src/utility/conversation/claude-decision-runtime.js'
import {
  DecisionMemoryLease,
  nativeWorkingMemoryCapacities,
} from '../../apps/desktop/src/utility/conversation/native-working-memory.js'
import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import { decisionFixture } from '../../packages/persistence/src/decision-fixture.test-support.js'
import { cleanupNativeFixture, executable, isolatedEnv, ownedRoot } from './native-harness.js'

const MODEL = 'claude-haiku-5-5'
const ANSWER = '{"candidateId":"wait","highlights":[]}'
const PROMPT =
  'Owned protocol fixture. Return the supplied decision JSON. This fixture authorizes only the supplied owned Bash canary.'
const SETTINGS = {
  disableAllHooks: true,
  autoMemoryEnabled: false,
  disableWorkflows: true,
  disableRemoteControl: true,
  fallbackModel: [],
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Owned native metadata invalid')
  return Object.fromEntries(Object.entries(value))
}
const event = (type: string, fields: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
function sse(canary?: string, thinking = false): string {
  return (
    event('message_start', {
      message: {
        id: 'msg_owned_relay',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    }) +
    (thinking
      ? event('content_block_start', {
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }) +
        event('content_block_delta', {
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Owned invisible reasoning block.' },
        }) +
        event('content_block_stop', { index: 0 })
      : '') +
    event('content_block_start', {
      index: thinking ? 1 : 0,
      content_block: canary
        ? { type: 'tool_use', id: 'toolu_owned_relay', name: 'Bash', input: {} }
        : { type: 'text', text: '' },
    }) +
    event('content_block_delta', {
      index: thinking ? 1 : 0,
      delta: canary
        ? {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              command: `printf 'owned-canary\n' > ${quote(canary)}`,
              description: 'Write the owned test canary',
              timeout: 1000,
            }),
          }
        : { type: 'text_delta', text: ANSWER },
    }) +
    event('content_block_stop', { index: thinking ? 1 : 0 }) +
    event('message_delta', {
      delta: { stop_reason: canary ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 3 },
    }) +
    event('message_stop')
  )
}
async function provider(
  handler: (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    body: Record<string, unknown>,
    attempt: number,
  ) => void,
) {
  let requests = 0,
    global = false,
    project = false
  const server = createServer((incoming, outgoing) => {
    if (incoming.method === 'HEAD') {
      incoming.resume()
      outgoing.end()
      return
    }
    const task = (async () => {
      const bytes = Buffer.allocUnsafe(256 * 1024)
      let size = 0
      for await (const raw of incoming) {
        const chunk: unknown = raw
        if (!Buffer.isBuffer(chunk) || size + chunk.length > bytes.length)
          throw Error('Owned provider capacity')
        chunk.copy(bytes, size)
        size += chunk.length
      }
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
      global ||= source.includes('PACT_OWNED_GLOBAL_MARKER')
      project ||= source.includes('PACT_OWNED_PROJECT_MARKER')
      const parsed = record(parseClaudeDecisionJson(source))
      handler(incoming, outgoing, parsed, ++requests)
    })()
    void task.catch(() => {
      outgoing.writeHead(400)
      outgoing.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Owned provider unavailable')
  return {
    url: `http://127.0.0.1:${address.port}`,
    get requests() {
      return requests
    },
    get global() {
      return global
    },
    get project() {
      return project
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
function environment(
  owned: Awaited<ReturnType<typeof ownedRoot>>,
  baseUrl: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...isolatedEnv(owned.root, owned.home),
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_MAX_RETRIES: '1',
    DISABLE_AUTOUPDATER: '1',
  }
  delete result.ANTHROPIC_AUTH_TOKEN
  return result
}
function context(
  owned: Awaited<ReturnType<typeof ownedRoot>>,
  selected: string,
  baseUrl: string,
  source: Awaited<ReturnType<typeof decisionFixture>>,
  kind: 'probe' | 'evaluation',
) {
  const repo = source.repo
  repo.saveSchedulingSettings({
    expectedRevision: repo.schedulingSettings().revision,
    selection: { target: 'claude_haiku_5_5', provider: 'claude', modelId: MODEL },
  })
  let operationId: string = randomUUID()
  const deadlineAt = Date.now() + 15_000
  if (kind === 'probe')
    // oxlint-disable-next-line vitest/no-conditional-expect -- Probe fixtures reserve before construction; evaluation fixtures reserve inside the runtime.
    expect(
      repo.reserveSchedulingProbe({
        id: operationId,
        sessionId: source.sessionId,
        provider: 'claude',
        model: MODEL,
        configurationFingerprint: 'c'.repeat(64),
        deadlineAt,
      }),
    ).toBe(true)
  const stages: string[] = [],
    dispatch = vi.fn<() => void>(() => {
      expect(repo.dispatchEvaluation(operationId).created).toBe(true)
    }),
    prepared = vi.fn<ClaudeDecisionRuntimeContext['prepared']>((facts) => {
      if (kind === 'probe') repo.recordSchedulingRuntimeWitness(operationId, facts)
      else repo.recordEvaluationPhysicalWitness(operationId, facts)
    })
  const retirePhysicalReceipts: NonNullable<
    ClaudeDecisionRuntimeContext['retirePhysicalReceipts']
  > = async (facts) => {
    let cursor: string | undefined
    for (
      let index = 0;
      index < 32 && Date.now() < facts.deadlineAt && !facts.signal?.aborted;
      index++
    ) {
      const receipt = repo.claimSchedulingPhysicalReceipt(cursor)
      if (!receipt) break
      cursor = receipt.receiptId
      // oxlint-disable-next-line no-await-in-loop -- Real native receipt operations remain serial inside the runtime's current lease/deadline.
      const result = await OwnedProcessGroup.cleanupPhysicalReceipt(
        receipt.witness,
        undefined,
        facts.memory,
        {
          deadlineAt: facts.deadlineAt,
          ...(facts.signal ? { signal: facts.signal } : {}),
        },
      )
      if (result === 'removed' || result === 'already_absent')
        // oxlint-disable-next-line vitest/no-conditional-expect -- Only proven deletion may acknowledge a retiring receipt; uncertain receipts remain for the final assertion.
        expect(
          repo.acknowledgeSchedulingPhysicalReceipt(receipt.receiptId, receipt.witnessJson),
        ).toBe(true)
    }
    return repo.schedulingPhysicalReceiptCapacityAvailable()
  }
  let generation = 0,
    witness: DecisionPhysicalWitness | null = null
  const value: ClaudeDecisionRuntimeContext = {
    modelId: MODEL,
    ownerId: randomUUID(),
    executable: selected,
    cwd: owned.cwd,
    deadlineAt,
    current: () => true,
    dispatch,
    prepared,
    reserve: (input, facts) => {
      const reservation = repo.reserveEvaluation({
        handoff: input.handoff,
        provider: 'claude',
        model: MODEL,
        configurationFingerprint: 'c'.repeat(64),
        deadlineAt: facts.deadlineAt,
        inputSha256: hash(JSON.stringify(input)),
      })
      if (reservation.status === 'reserved') operationId = reservation.evaluation.id
      return reservation.status === 'reserved' || reservation.status === 'duplicate'
        ? reservation.status
        : 'busy'
    },
    retirePhysicalReceipts,
    async physicalCompletion(facts) {
      repo.completeSchedulingRuntimePhysical(operationId, {
        nativeGeneration: facts.nativeGeneration,
        witness: facts.witness,
        completed: facts.outcome?.kind === 'recommendation',
        candidateId:
          facts.outcome?.kind === 'recommendation'
            ? facts.outcome.recommendation.candidateId
            : null,
        ...(facts.usage ? { usage: facts.usage } : {}),
      })
      await retirePhysicalReceipts(facts)
    },
    environment: environment(owned, baseUrl),
    beginNativeStage(facts) {
      expect(facts.expectedGeneration).toBe(generation)
      expect(facts.previousWitness).toEqual(witness)
      expect(facts.previousPhysicalReleased).toBe(true)
      stages.push(facts.stage)
      generation = repo.beginSchedulingNativeStage(operationId, facts)
      return generation
    },
    physicalPrepared(facts) {
      expect(facts.nativeGeneration).toBe(generation)
      expect(facts.witness.ownerId).toBe(value.ownerId)
      witness = facts.witness
      repo.recordSchedulingRuntimeWitness(operationId, facts)
    },
  }
  return { value, stages, dispatch, prepared }
}

it('Claude decision inspects the actual catalog without substituting Haiku 4.5 or dispatching inference', async () => {
  const owned = await ownedRoot(),
    upstream = await provider((_incoming, outgoing) => {
      outgoing.writeHead(422)
      outgoing.end()
    }),
    source = await decisionFixture(':memory:', owned.cwd)
  let runtime: ClaudeDecisionRuntime | undefined
  try {
    const selected = await executable('claude', owned),
      f = context(owned, selected, upstream.url, source, 'probe')
    const original = await nativeTurn(
      owned,
      selected,
      environment(owned, upstream.url),
      false,
      true,
    )
    expect(
      Array.isArray(original.models) &&
        original.models.some(
          (row) =>
            record(row).value === 'haiku' &&
            record(row).resolvedModel === 'claude-haiku-4-5-20251001',
        ),
    ).toBe(true)
    expect(
      Array.isArray(original.models) &&
        original.models.some(
          (row) => record(row).value === MODEL && record(row).resolvedModel === MODEL,
        ),
    ).toBe(true)
    runtime = new ClaudeDecisionRuntime(f.value)
    const capability = await runtime.probeAdmission()
    expect(capability).toMatchObject({
      provider: 'claude',
      modelId: MODEL,
      supported: true,
      reason: 'supported',
      physicalReleased: true,
    })
    expect(upstream.requests).toBe(0)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.stages).toEqual(['host_metadata', 'project_metadata', 'guarded_context'])
    expect(source.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(source.repo.hasSchedulingPhysicalReceipts()).toBe(false)
  } finally {
    await runtime?.dispose()
    source.db.close()
    await upstream.close()
    await cleanupNativeFixture(owned)
  }
})

async function verifyNativeTextTurn(thinking: boolean) {
  const owned = await ownedRoot(),
    upstream = await provider((_incoming, outgoing) => {
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
      outgoing.end(sse(undefined, thinking))
    }),
    source = await decisionFixture(':memory:', owned.cwd)
  let runtime: ClaudeDecisionRuntime | undefined
  try {
    const selected = await executable('claude', owned)
    await writeFile(
      join(owned.home, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL } }),
    )
    await writeFile(join(owned.home, 'CLAUDE.md'), 'PACT_OWNED_GLOBAL_MARKER\n')
    await writeFile(join(owned.cwd, 'CLAUDE.md'), 'PACT_OWNED_PROJECT_MARKER\n')
    const f = context(owned, selected, upstream.url, source, 'evaluation')
    runtime = new ClaudeDecisionRuntime(f.value)
    const result = await runtime.evaluateDecision(source.input, new AbortController().signal)
    console.info('Claude bounded native diagnostics', JSON.stringify(runtime.diagnostics()))
    expect({ result, diagnostics: runtime.diagnostics() }).toMatchObject({
      result: { kind: 'recommendation', recommendation: { candidateId: 'wait', highlights: [] } },
    })
    expect(upstream.requests).toBe(1)
    expect(upstream.global).toBe(true)
    expect(upstream.project).toBe(false)
    expect(f.stages).toEqual([
      'host_metadata',
      'project_metadata',
      'guarded_context',
      'project_verification',
    ])
    expect(f.dispatch).toHaveBeenCalledOnce()
    expect(runtime.usage).toEqual({ inputTokens: 2, outputTokens: 3 })
    expect(await runtime.settlement()).toBe(true)
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
    expect(source.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(source.repo.hasSchedulingPhysicalReceipts()).toBe(false)
    return result
  } finally {
    await runtime?.dispose()
    source.db.close()
    await upstream.close()
    await cleanupNativeFixture(owned)
  }
}
it('Claude decision completes one actual native text turn through the production guard with owned synthetic catalog and global instructions', async () => {
  expect((await verifyNativeTextTurn(false)).kind).toBe('recommendation')
})
it('Claude decision preserves same-message thinking and text frames through the production guard', async () => {
  expect((await verifyNativeTextTurn(true)).kind).toBe('recommendation')
})

/** Test-side bounded actual native protocol driver; production runtime has its own transport. */
async function nativeTurn(
  owned: Awaited<ReturnType<typeof ownedRoot>>,
  selected: string,
  env: NodeJS.ProcessEnv,
  tools: boolean,
  metadataOnly = false,
) {
  const session = randomUUID(),
    group = new OwnedProcessGroup({ startupObservationMs: 2000 })
  const child = group.spawn(
    selected,
    [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--session-id',
      session,
      '--model',
      MODEL,
      '--tools',
      tools ? 'Bash' : '',
      ...(tools ? ['--allowedTools', 'Bash'] : ['--disallowedTools', '*']),
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--disable-slash-commands',
      '--setting-sources',
      'user',
      '--settings',
      JSON.stringify({
        ...SETTINGS,
        env: { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL, CLAUDE_CODE_MAX_RETRIES: '1' },
      }),
    ],
    { cwd: owned.cwd, env },
  )
  const done = Promise.withResolvers<Record<string, unknown>>(),
    initialized = Promise.withResolvers<void>()
  const buffer = Buffer.allocUnsafe(256 * 1024)
  let size = 0,
    total = 0,
    frames = 0,
    stderr = 0
  const fail = () => {
    initialized.reject(Error('Owned native protocol failed'))
    done.reject(Error('Owned native protocol failed'))
  }
  void done.promise.catch(() => undefined)
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.length
    if (stderr > 16 * 1024) fail()
  })
  child.stdout.on('data', (chunk: Buffer) => {
    total += chunk.length
    if (total > 2 * 1024 * 1024) {
      fail()
      return
    }
    let offset = 0
    try {
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset),
          end = newline < 0 ? chunk.length : newline
        if (size + end - offset > buffer.length) throw Error('Owned native frame overflow')
        chunk.copy(buffer, size, offset, end)
        size += end - offset
        offset = end + 1
        if (newline < 0) break
        if (++frames > 256) throw Error('Owned native event overflow')
        const frame = record(
          parseClaudeDecisionJson(
            new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)),
          ),
        )
        size = 0
        if (frame.type === 'control_response') {
          if (record(frame.response).subtype !== 'success')
            throw Error('Owned native initialization failed')
          if (metadataOnly) done.resolve(record(record(frame.response).response))
          initialized.resolve()
        }
        if (frame.type === 'result') done.resolve(frame)
      }
    } catch {
      fail()
    }
  })
  const timer = setTimeout(fail, 15_000)
  try {
    await group.observe()
    child.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: 'owned-init', request: { subtype: 'initialize', title: 'Pact Relay', skills: [], promptSuggestions: false, agentProgressSummaries: false } })}\n`,
    )
    await initialized.promise
    if (metadataOnly) return await done.promise
    child.stdin.write(
      `${JSON.stringify({ type: 'user', uuid: randomUUID(), session_id: session, parent_tool_use_id: null, message: { role: 'user', content: PROMPT } })}\n`,
    )
    return await done.promise
  } finally {
    clearTimeout(timer)
    child.stdin.end()
    await group.close()
    expect(group.released).toBe(true)
  }
}

it('Claude production guard blocks a preauthorized native Bash response after a positive two-request tool canary', async () => {
  const owned = await ownedRoot()
  let guard: Awaited<ReturnType<typeof createClaudeDecisionResponseGuard>> | undefined,
    lease: DecisionMemoryLease | undefined
  const positiveCanary = join(owned.root, 'positive-canary'),
    deniedCanary = join(owned.root, 'denied-canary')
  let activeCanary = positiveCanary
  const upstream = await provider((_incoming, outgoing, _body, attempt) => {
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
    outgoing.end(sse(attempt === 2 ? undefined : activeCanary))
  })
  try {
    const selected = await executable('claude', owned)
    await writeFile(
      join(owned.home, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL } }),
    )
    const positive = await nativeTurn(owned, selected, environment(owned, upstream.url), true)
    expect(positive).toMatchObject({ subtype: 'success', is_error: false, num_turns: 2 })
    expect(await readFile(positiveCanary, 'utf8')).toBe('owned-canary\n')
    expect(upstream.requests).toBe(2)
    activeCanary = deniedCanary
    lease = new DecisionMemoryLease()
    guard = await createClaudeDecisionResponseGuard(upstream.url, lease, Date.now() + 15_000)
    const dispatch = vi.fn<() => void>()
    guard.bind({ modelId: MODEL, prompt: PROMPT, current: () => true, dispatch })
    const negative = await nativeTurn(owned, selected, environment(owned, guard.baseUrl), true)
    expect(negative.is_error).toBe(true)
    expect(
      await access(deniedCanary).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect(upstream.requests).toBe(3)
    expect(guard.facts).toMatchObject({
      forwarded: 1,
      nativeBytes: 0,
      rejectedResponses: 1,
      acceptedResponses: 0,
    })
    expect(guard.usage).toEqual({ inputTokens: 2, outputTokens: 3 })
    expect(dispatch).toHaveBeenCalledOnce()
  } finally {
    await guard?.close()
    lease?.release()
    await upstream.close()
    await cleanupNativeFixture(owned)
  }
})

it('Claude production guard preserves native helper refresh for one complete 401 with identical semantic input', async () => {
  const owned = await ownedRoot(),
    counter = join(owned.root, 'helper-count'),
    helper = join(owned.root, 'helper.mjs')
  const bodyHashes: string[] = [],
    credentialHashes: string[] = []
  const upstream = await provider((incoming, outgoing, body, attempt) => {
    bodyHashes.push(claudeDecisionFingerprint(body))
    credentialHashes.push(
      hash(String(incoming.headers['x-api-key'] ?? incoming.headers.authorization ?? '')),
    )
    outgoing.writeHead(attempt === 1 ? 401 : 200, {
      'content-type': attempt === 1 ? 'application/json' : 'text/event-stream',
    })
    outgoing.end(
      attempt === 1
        ? '{"type":"error","error":{"type":"authentication_error","message":"Owned expired key"}}'
        : sse(),
    )
  })
  let guard: Awaited<ReturnType<typeof createClaudeDecisionResponseGuard>> | undefined,
    lease: DecisionMemoryLease | undefined
  try {
    const selected = await executable('claude', owned)
    await writeFile(
      helper,
      `import{readFileSync,writeFileSync}from'node:fs';const p=${JSON.stringify(counter)};let n=0;try{n=Number(readFileSync(p,'utf8'))}catch{};writeFileSync(p,String(++n));process.stdout.write('OWNED-DUMMY-KEY-'+n);`,
    )
    await writeFile(
      join(owned.home, 'settings.json'),
      JSON.stringify({
        env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL },
        apiKeyHelper: `${quote(process.execPath)} ${quote(helper)}`,
      }),
    )
    lease = new DecisionMemoryLease()
    guard = await createClaudeDecisionResponseGuard(upstream.url, lease, Date.now() + 15_000)
    const dispatch = vi.fn<() => void>()
    guard.bind({ modelId: MODEL, prompt: PROMPT, current: () => true, dispatch })
    const env = environment(owned, guard.baseUrl)
    delete env.ANTHROPIC_API_KEY
    const result = await nativeTurn(owned, selected, env, false)
    expect({
      result: { subtype: result.subtype, is_error: result.is_error, num_turns: result.num_turns },
      guard: guard.facts,
    }).toMatchObject({
      result: { subtype: 'success', is_error: false, num_turns: 1 },
      guard: { forwarded: 2, auth401: 1, authChanged: true },
    })
    expect(bodyHashes).toHaveLength(2)
    expect(bodyHashes[0]).toBe(bodyHashes[1])
    expect(credentialHashes[0]).not.toBe(credentialHashes[1])
    expect(Number(await readFile(counter, 'utf8'))).toBe(2)
    expect(dispatch).toHaveBeenCalledOnce()
  } finally {
    await guard?.close()
    lease?.release()
    await upstream.close()
    await cleanupNativeFixture(owned)
  }
})

it('Claude production runtime rejects executable credential helpers without upstream requests or native mutations', async () => {
  const owned = await ownedRoot(),
    counter = join(owned.root, 'blocked-helper-count'),
    helper = join(owned.root, 'blocked-helper.mjs'),
    upstream = await provider((_incoming, outgoing) => {
      outgoing.writeHead(500)
      outgoing.end()
    }),
    source = await decisionFixture(':memory:', owned.cwd)
  let runtime: ClaudeDecisionRuntime | undefined
  try {
    const selected = await executable('claude', owned)
    await writeFile(
      helper,
      `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(counter)},'forbidden');process.stdout.write('OWNED-DUMMY-KEY')`,
    )
    const settings = JSON.stringify({
      env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL },
      apiKeyHelper: `${quote(process.execPath)} ${quote(helper)}`,
    })
    await writeFile(join(owned.home, 'settings.json'), settings)
    const f = context(owned, selected, upstream.url, source, 'evaluation')
    delete f.value.environment!.ANTHROPIC_API_KEY
    runtime = new ClaudeDecisionRuntime(f.value)
    expect(
      await runtime.evaluateDecision(source.input, new AbortController().signal),
    ).toMatchObject({ kind: 'unavailable' })
    expect(await runtime.settlement()).toBe(true)
    expect(upstream.requests).toBe(0)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(
      await readFile(counter).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect(await readFile(join(owned.home, 'settings.json'), 'utf8')).toBe(settings)
  } finally {
    await runtime?.dispose()
    source.db.close()
    await upstream.close()
    await cleanupNativeFixture(owned)
  }
})
