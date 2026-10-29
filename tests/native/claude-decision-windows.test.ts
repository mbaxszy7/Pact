import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { createHash, randomUUID } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import type { DecisionPhysicalWitness } from '../../packages/contracts/src/index.js'

import {
  ClaudeDecisionRuntime,
  type ClaudeDecisionRuntimeContext,
} from '../../apps/desktop/src/utility/conversation/claude-decision-runtime.js'
import {
  DecisionMemoryLease,
  nativeWorkingMemoryCapacities,
} from '../../apps/desktop/src/utility/conversation/native-working-memory.js'
import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import { RuntimePreparation } from '../../apps/desktop/src/utility/runtime-preparation/runtime-preparation.js'
import { decisionFixture } from '../../packages/persistence/src/decision-fixture.test-support.js'
import { actualSdk, cleanupNativeFixture, isolatedEnv, ownedRoot } from './native-harness.js'

const MODEL = 'claude-haiku-5-5'
const ANSWER = '{"candidateId":"wait","highlights":[]}'
const event = (type: string, fields: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`

function response(options: { text?: string; model?: string; tool?: string } = {}): string {
  return (
    event('message_start', {
      message: {
        id: 'msg_owned_windows_relay',
        type: 'message',
        role: 'assistant',
        model: options.model ?? MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    }) +
    event('content_block_start', {
      index: 0,
      content_block: options.tool
        ? { type: 'tool_use', id: 'toolu_owned_windows_relay', name: 'Bash', input: {} }
        : { type: 'text', text: '' },
    }) +
    event('content_block_delta', {
      index: 0,
      delta: options.tool
        ? {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              command: options.tool,
              description: 'Owned canary',
              timeout: 1000,
            }),
          }
        : { type: 'text_delta', text: options.text ?? ANSWER },
    }) +
    event('content_block_stop', { index: 0 }) +
    event('message_delta', {
      delta: { stop_reason: options.tool ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 3 },
    }) +
    event('message_stop')
  )
}

async function fixture(handler: (response: ServerResponse, attempt: number) => void) {
  const owned = await ownedRoot()
  let requests = 0,
    unexpectedTools = false,
    globalInstructions = false,
    projectInstructions = false
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    if (incoming.method !== 'POST' || !incoming.url?.startsWith('/v1/messages')) {
      incoming.resume()
      outgoing.writeHead(200, { 'content-type': 'application/json' })
      outgoing.end('{}')
      return
    }
    void (async () => {
      const chunks: Buffer[] = []
      let size = 0
      for await (const raw of incoming) {
        const chunk: unknown = raw
        if (!Buffer.isBuffer(chunk) || (size += chunk.length) > 256 * 1024)
          throw new Error('Owned request overflow')
        chunks.push(chunk)
      }
      const text = Buffer.concat(chunks).toString('utf8'),
        body: unknown = JSON.parse(text)
      if (!body || typeof body !== 'object') throw new Error('Owned request invalid')
      const tools = Reflect.get(body, 'tools')
      unexpectedTools ||= Array.isArray(tools) && tools.length > 0
      globalInstructions ||= text.includes('OWNED_GLOBAL_RELAY_MARKER')
      projectInstructions ||= text.includes('OWNED_PROJECT_RELAY_MARKER')
      handler(outgoing, ++requests)
    })().catch(() => {
      outgoing.writeHead(400)
      outgoing.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Owned provider unavailable')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const selected =
    process.env.PACT_WINDOWS_CLAUDE_EXECUTABLE ??
    (await new RuntimePreparation({
      hasCompletedFirstUseSetup: () => true,
      readSelectedExecutablePath: () => undefined,
      saveSelectedExecutablePath: () => {
        throw new Error('Read-only discovery')
      },
    }).findRecoveryExecutable('claude', new AbortController().signal))
  if (!selected) throw new Error('A compatible installed Claude Code executable is required')
  await writeFile(join(owned.home, 'CLAUDE.md'), 'OWNED_GLOBAL_RELAY_MARKER')
  await writeFile(join(owned.cwd, 'CLAUDE.md'), 'OWNED_PROJECT_RELAY_MARKER')
  const source = await decisionFixture(':memory:', owned.cwd),
    repo = source.repo
  repo.saveSchedulingSettings({
    expectedRevision: repo.schedulingSettings().revision,
    selection: { target: 'claude_haiku_5_5', provider: 'claude', modelId: MODEL },
  })
  let operationId: string = randomUUID(),
    generation = 0,
    latest: DecisionPhysicalWitness | null = null
  const stages: string[] = []
  let probing = false
  const retire: NonNullable<ClaudeDecisionRuntimeContext['retirePhysicalReceipts']> = async (
    facts,
  ) => {
    let cursor: string | undefined
    for (let index = 0; index < 32 && Date.now() < facts.deadlineAt; index++) {
      const receipt = repo.claimSchedulingPhysicalReceipt(cursor)
      if (!receipt) break
      cursor = receipt.receiptId
      // oxlint-disable-next-line no-await-in-loop -- Receipt deletion shares the runtime's original cleanup lease and deadline.
      const result = await OwnedProcessGroup.cleanupPhysicalReceipt(
        receipt.witness,
        undefined,
        facts.memory,
        { deadlineAt: facts.deadlineAt, ...(facts.signal ? { signal: facts.signal } : {}) },
      )
      if (result !== 'removed' && result !== 'already_absent') return false
      repo.acknowledgeSchedulingPhysicalReceipt(receipt.receiptId, receipt.witnessJson)
    }
    return repo.schedulingPhysicalReceiptCapacityAvailable()
  }
  const dispatch = vi.fn<() => void>(() => {
    expect(repo.dispatchEvaluation(operationId).created).toBe(true)
  })
  const context: ClaudeDecisionRuntimeContext = {
    executable: selected,
    modelId: MODEL,
    ownerId: randomUUID(),
    cwd: owned.cwd,
    current: () => true,
    dispatch,
    environment: {
      ...isolatedEnv(owned.root, owned.home),
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_BASE_URL: baseUrl,
      CLAUDE_CODE_MAX_RETRIES: '1',
      DISABLE_AUTOUPDATER: '1',
    },
    reserve(input, facts) {
      const result = repo.reserveEvaluation({
        handoff: input.handoff,
        provider: 'claude',
        model: MODEL,
        configurationFingerprint: 'c'.repeat(64),
        deadlineAt: facts.deadlineAt,
        inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      })
      if (result.status === 'reserved') operationId = result.evaluation.id
      return result.status === 'reserved' || result.status === 'duplicate' ? result.status : 'busy'
    },
    beginNativeStage(facts) {
      expect(facts.expectedGeneration).toBe(generation)
      expect(facts.previousWitness).toEqual(latest)
      expect(facts.previousPhysicalReleased).toBe(true)
      stages.push(facts.stage)
      generation = repo.beginSchedulingNativeStage(operationId, facts)
      return generation
    },
    physicalPrepared(facts) {
      latest = facts.witness
      repo.recordSchedulingRuntimeWitness(operationId, facts)
    },
    prepared(facts) {
      if (probing) repo.recordSchedulingRuntimeWitness(operationId, facts)
      else repo.recordEvaluationPhysicalWitness(operationId, facts)
    },
    retirePhysicalReceipts: retire,
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
      if (!(await retire(facts))) throw new Error('Owned physical receipts did not retire')
    },
  }
  return {
    owned,
    source,
    context,
    stages,
    dispatch,
    server,
    selected,
    probeContext() {
      probing = true
      expect(
        repo.reserveSchedulingProbe({
          id: operationId,
          sessionId: source.sessionId,
          provider: 'claude',
          model: MODEL,
          configurationFingerprint: 'c'.repeat(64),
          deadlineAt: Date.now() + 15_000,
        }),
      ).toBe(true)
      return context
    },
    get requests() {
      return requests
    },
    get unexpectedTools() {
      return unexpectedTools
    },
    get globalInstructions() {
      return globalInstructions
    },
    get projectInstructions() {
      return projectInstructions
    },
    async close(runtime?: ClaudeDecisionRuntime) {
      if (runtime) expect(await runtime.dispose()).toBe(true)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      const active = repo.activeSchedulingRuntimeOwner()
      source.db.close()
      await cleanupNativeFixture(owned)
      expect(active).toBeUndefined()
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
    },
  }
}

it('Windows Claude uses one actual native turn, no tools or development instructions, and durable physical receipts', async () => {
  const f = await fixture((outgoing) => {
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
    outgoing.end(response())
  })
  const runtime = new ClaudeDecisionRuntime(f.context)
  try {
    const outcome = await runtime.evaluateDecision(f.source.input, new AbortController().signal)
    expect(outcome).toEqual({
      kind: 'recommendation',
      recommendation: { candidateId: 'wait', highlights: [] },
    })
    expect(await runtime.settlement()).toBe(true)
    expect(f.stages).toEqual(['native_context'])
    expect(f.requests).toBe(1)
    expect(f.unexpectedTools).toBe(false)
    expect(f.globalInstructions).toBe(false)
    expect(f.projectInstructions).toBe(false)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(runtime.usage).toEqual({ inputTokens: 2, outputTokens: 3 })
  } finally {
    await f.close(runtime)
  }
})

it('Windows Claude inspects native capability without any inference or development history', async () => {
  const f = await fixture((outgoing) => {
    outgoing.writeHead(500)
    outgoing.end()
  })
  const runtime = new ClaudeDecisionRuntime(f.probeContext())
  try {
    expect(await runtime.probeAdmission()).toMatchObject({
      supported: true,
      physicalReleased: true,
    })
    expect(await runtime.settlement()).toBe(true)
    expect(f.requests).toBe(0)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.stages).toEqual(['native_context'])
  } finally {
    await f.close(runtime)
  }
})

it('Windows native tool canary executes with tools enabled before the Relay denial control', async () => {
  let command = ''
  const f = await fixture((outgoing, attempt) => {
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
    outgoing.end(response(attempt === 1 ? { tool: command } : {}))
  })
  const canary = join(f.owned.cwd, 'owned-positive-tool-canary')
  command = `printf owned > '${canary.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`
  const environment = f.context.environment
  if (!environment) throw new Error('The positive control requires its owned environment')
  const memory = new DecisionMemoryLease(),
    controller = new AbortController()
  const group = new OwnedProcessGroup({
    ownerId: randomUUID(),
    memory,
    deadlineAt: Date.now() + 15_000,
  })
  const session = actualSdk().query({
    prompt: 'Owned protocol test. Execute only the provided owned canary tool.',
    options: {
      model: MODEL,
      cwd: f.owned.cwd,
      pathToClaudeCodeExecutable: f.selected,
      abortController: controller,
      env: environment,
      tools: ['Bash'],
      permissionMode: 'bypassPermissions',
      persistSession: false,
      maxTurns: 2,
      settingSources: [],
      extraArgs: {
        'safe-mode': null,
        'strict-mcp-config': null,
        'mcp-config': '{"mcpServers":{}}',
      },
      spawnClaudeCodeProcess: (spec: {
        command: string
        args: string[]
        cwd?: string
        env?: NodeJS.ProcessEnv
        signal?: AbortSignal
      }): ChildProcessWithoutNullStreams =>
        group.spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          signal: spec.signal,
          windowsHide: true,
        }),
    },
  })
  try {
    let results = 0,
      subtype: unknown
    for await (const frame of session) {
      if (frame && typeof frame === 'object' && Reflect.get(frame, 'type') === 'result') {
        results++
        subtype = Reflect.get(frame, 'subtype')
      }
    }
    expect(results).toBe(1)
    expect(subtype).toBe('success')
    expect(await readFile(canary, 'utf8')).toBe('owned')
    expect(f.requests).toBe(2)
    expect(f.unexpectedTools).toBe(true)
  } finally {
    controller.abort()
    session.close()
    await group.close()
    expect(group.released).toBe(true)
    memory.release()
    await f.close()
  }
})

it.each(['tool', 'candidate', 'model'] as const)(
  'Windows Claude rejects an actual native %s response without adopting advice',
  async (kind) => {
    const canaryName = 'owned-relay-tool-canary'
    let command = ''
    const f = await fixture((outgoing) => {
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
      outgoing.end(
        response(
          kind === 'tool'
            ? { tool: command }
            : kind === 'candidate'
              ? { text: '{"candidateId":"unadmitted","highlights":[]}' }
              : { model: 'claude-sonnet-5-5' },
        ),
      )
    })
    command = `printf unauthorized > '${join(f.owned.cwd, canaryName).replaceAll('\\', '/').replaceAll("'", "'\\''")}'`
    const runtime = new ClaudeDecisionRuntime(f.context)
    try {
      expect(
        (await runtime.evaluateDecision(f.source.input, new AbortController().signal)).kind,
      ).toBe('unavailable')
      expect(await runtime.settlement()).toBe(true)
      expect(f.requests).toBe(1)
      expect(f.unexpectedTools).toBe(false)
      await expect(access(join(f.owned.cwd, canaryName))).rejects.toThrow(/ENOENT/u)
    } finally {
      await f.close(runtime)
    }
  },
)

it('Windows Claude discards completed advice after host freshness changes', async () => {
  let current = true
  const f = await fixture((outgoing) => {
    current = false
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
    outgoing.end(response())
  })
  const runtime = new ClaudeDecisionRuntime({ ...f.context, current: () => current })
  try {
    expect(await runtime.evaluateDecision(f.source.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'stale',
    })
    expect(await runtime.settlement()).toBe(true)
    expect(f.requests).toBe(1)
    expect(runtime.usage).toEqual({ inputTokens: 2, outputTokens: 3 })
  } finally {
    await f.close(runtime)
  }
})

it('Windows Claude cancellation retains the owner until the native Job and receipt cleanup finish', async () => {
  const entered = Promise.withResolvers<void>()
  const f = await fixture(() => {
      entered.resolve()
    }),
    runtime = new ClaudeDecisionRuntime(f.context),
    controller = new AbortController()
  try {
    const pending = runtime.evaluateDecision(f.source.input, controller.signal)
    await Promise.race([
      entered.promise,
      pending.then((result) => {
        throw new Error(
          `Native decision ended before the provider was entered: ${JSON.stringify({ result, diagnostics: runtime.diagnostics() })}`,
        )
      }),
    ])
    controller.abort()
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'cancelled' })
    expect(await runtime.settlement()).toBe(true)
    expect(f.requests).toBe(1)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  } finally {
    await f.close(runtime)
  }
})
