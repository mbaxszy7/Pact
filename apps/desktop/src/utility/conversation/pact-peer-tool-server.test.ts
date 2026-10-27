import { createHash, randomUUID } from 'node:crypto'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { setImmediate as immediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  collaborationSourceReadSchema,
  type CollaborationSourceReadResult,
  type CollaborationTask,
} from '@pact/contracts'

import { planRunInput } from './collaboration-fixture.test-support.js'
import { PactPeerToolServer } from './pact-peer-tool-server.js'

const servers: PactPeerToolServer[] = []
const jsonRpcResult = (
  value: unknown,
): { result: { isError: boolean; structuredContent?: unknown } } => {
  if (!value || typeof value !== 'object') throw new Error('Invalid JSON-RPC result.')
  const result = Reflect.get(value, 'result')
  if (!result || typeof result !== 'object') throw new Error('Invalid JSON-RPC result body.')
  const isError = Reflect.get(result, 'isError')
  if (typeof isError !== 'boolean') throw new Error('Invalid JSON-RPC error flag.')
  return { result: { isError, structuredContent: Reflect.get(result, 'structuredContent') } }
}

async function callSource(target: string, args: unknown) {
  const response = await fetch(target, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_collaboration_source', arguments: args },
      }),
    }),
    value: unknown = response.status === 200 ? await response.json() : undefined
  return { status: response.status, value }
}
function sourcePage(value: unknown): { text: string; nextOffset: number | null; sha256: string } {
  if (!value || typeof value !== 'object') throw Error('Invalid source response')
  const result: unknown = Reflect.get(value, 'result')
  if (!result || typeof result !== 'object') throw Error('Invalid source result')
  const content: unknown = Reflect.get(result, 'content')
  if (!Array.isArray(content) || !content[0] || typeof content[0] !== 'object')
    throw Error('Invalid source content')
  const text: unknown = Reflect.get(content[0], 'text')
  if (typeof text !== 'string') throw Error('Invalid source content')
  const page: unknown = JSON.parse(text)
  if (!page || typeof page !== 'object') throw Error('Invalid source page')
  const body: unknown = Reflect.get(page, 'text'),
    nextOffset: unknown = Reflect.get(page, 'nextOffset'),
    document: unknown = Reflect.get(page, 'document'),
    sha256: unknown =
      document && typeof document === 'object' ? Reflect.get(document, 'sha256') : undefined
  if (
    typeof body !== 'string' ||
    typeof sha256 !== 'string' ||
    !(nextOffset === null || typeof nextOffset === 'number')
  )
    throw Error('Invalid source page')
  return { text: body, nextOffset, sha256 }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(servers.splice(0).map((server) => server.dispose()))
})

describe('PactPeerToolServer', () => {
  it('advertises flat source arguments and refuses a nested capability envelope before reading', async () => {
    const server = new PactPeerToolServer()
    servers.push(server)
    const target = await server.start(),
      owner = { runId: randomUUID(), grant: randomUUID() },
      batchId = randomUUID(),
      reader = vi.fn<(raw: unknown) => CollaborationSourceReadResult>((raw) => {
        const request = collaborationSourceReadSchema.parse(raw)
        return { source: request.source, offset: request.offset, nextOffset: null, text: '{}' }
      })
    server.beginTurn('claude', false, undefined, false, reader, owner)
    const response = await fetch(target, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const listing: unknown = await response.json()
    if (!listing || typeof listing !== 'object') throw new Error('Missing native tool metadata')
    const result: unknown = Reflect.get(listing, 'result')
    const tools: unknown =
      result && typeof result === 'object' ? Reflect.get(result, 'tools') : null
    if (!Array.isArray(tools)) throw new Error('Missing native tools')
    const tool: unknown = tools.find(
      (value: unknown) =>
        value &&
        typeof value === 'object' &&
        Reflect.get(value, 'name') === 'read_collaboration_source',
    )
    if (!tool || typeof tool !== 'object') throw new Error('Missing native source tool')
    const description: unknown = Reflect.get(tool, 'description')
    const schema: unknown = Reflect.get(tool, 'inputSchema')
    const properties: unknown =
      schema && typeof schema === 'object' ? Reflect.get(schema, 'properties') : null
    if (typeof description !== 'string' || !properties || typeof properties !== 'object')
      throw new Error('Incomplete native source argument metadata')
    for (const name of ['runId', 'grant', 'batchId', 'document', 'offset']) {
      expect(Object.hasOwn(properties, name)).toBe(true)
      expect(description).toContain(name)
    }
    expect(reader).not.toHaveBeenCalled()
    const refused = await callSource(target, {
      source: 'batch',
      id: batchId,
      sourceGrant: owner,
      offset: 0,
    })
    expect(refused.value).toMatchObject({ result: { isError: true } })
    expect(reader).not.toHaveBeenCalled()
    const accepted = await callSource(target, { ...owner, source: 'batch', batchId, offset: 0 })
    expect(accepted.value).toMatchObject({ result: { content: [{ type: 'text' }] } })
    expect(reader).toHaveBeenCalledTimes(1)
  })

  it.each(['inputs', 'handoff_sources', 'batch'] as const)(
    'reads the frozen %s index when its request also carries a contextual document reference',
    async (source) => {
      const server = new PactPeerToolServer()
      servers.push(server)
      const url = await server.start()
      const owner = { runId: randomUUID(), grant: randomUUID() }
      const document = { id: randomUUID(), sha256: 'a'.repeat(64), bytes: 1, chars: 1 }
      server.beginTurn(
        'claude',
        false,
        undefined,
        false,
        (raw) => {
          const request = collaborationSourceReadSchema.parse(raw)
          return {
            source: request.source,
            offset: request.offset,
            nextOffset: null,
            text: '{"items":[]}',
          }
        },
        owner,
      )
      const response = await callSource(url, { ...owner, source, document, offset: 0 })
      expect(response.value).toMatchObject({ result: { content: [{ type: 'text' }] } })
      expect(response.value).not.toHaveProperty('error')
    },
  )
  it('reads a complete frozen source in readonly ordered segments until its exact native root retires', async () => {
    const server = new PactPeerToolServer()
    servers.push(server)
    const url = await server.start(),
      text = 'Immutable source 😀\n'.repeat(5000),
      document = {
        id: randomUUID(),
        sha256: createHash('sha256').update(text).digest('hex'),
        chars: text.length,
        bytes: Buffer.byteLength(text),
      },
      owner = { runId: randomUUID(), grant: randomUUID() },
      reader = vi.fn<(input: unknown) => CollaborationSourceReadResult>((raw) => {
        const input = collaborationSourceReadSchema.parse(raw),
          offset = input.offset
        if (input.document?.id !== document.id) throw Error('Foreign source')
        let end = Math.min(text.length, offset + 4096)
        if (/[\uD800-\uDBFF]/u.test(text.at(end - 1)!)) end--
        return {
          text: text.slice(offset, end),
          source: 'document',
          offset,
          nextOffset: end < text.length ? end : null,
          document,
        }
      }),
      receipt = server.beginTurn(
        'claude',
        false,
        planRunInput('codex').promptEnvelope.collaboration,
        false,
        reader,
        owner,
      )
    const target = `${url}/${receipt}`,
      toolsReply: unknown = await fetch(target, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }).then((response) => response.json())
    expect(toolsReply).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: 'read_collaboration_source',
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          }),
        ]),
      },
    })
    expect(JSON.stringify(toolsReply)).not.toContain('publish_collaboration_result')
    let restored = '',
      offset = 0
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- Follow the source's authoritative next offset until its true EOF.
      const response = await callSource(target, { ...owner, document, offset }),
        page = sourcePage(response.value)
      expect(Buffer.byteLength(JSON.stringify(response.value))).toBeLessThan(48 * 1024)
      expect(page.sha256).toBe(document.sha256)
      restored += page.text
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    }
    expect(restored).toBe(text)
    expect(createHash('sha256').update(restored).digest('hex')).toBe(document.sha256)
    const before = reader.mock.calls.length
    const foreign = await callSource(target, {
      ...owner,
      document: { ...document, id: randomUUID() },
      offset: 0,
    })
    expect(foreign.value).toMatchObject({ error: { code: -32603 } })
    expect(reader).toHaveBeenCalledTimes(before + 1)
    expect(
      (await callSource(target, { ...owner, grant: randomUUID(), document, offset: 0 })).value,
    ).toMatchObject({ result: { isError: true } })
    expect(reader).toHaveBeenCalledTimes(before + 1)
    server.endTurn(receipt)
    expect((await callSource(target, { ...owner, document, offset: 0 })).status).toBe(404)
    expect(sourcePage((await callSource(url, { ...owner, document, offset: 0 })).value).text).toBe(
      text.slice(0, 4096),
    )
    expect(() => server.beginTurn('claude', false)).toThrow(/still owns its source grant/u)
    server.retireSourceReader({ ...owner, grant: randomUUID() })
    expect(server.hasSourceGrant()).toBe(true)
    server.retireSourceReader(owner)
    expect(server.hasSourceGrant()).toBe(false)
    server.beginTurn('claude', false)
    expect((await callSource(url, { ...owner, document, offset: 0 })).value).toMatchObject({
      result: { isError: true },
    })
    expect(reader).toHaveBeenCalledTimes(before + 2)
  })
  it('validates optional title metadata without adopting it until the owning root completion', async () => {
    const server = new PactPeerToolServer()
    servers.push(server)
    const url = await server.start()
    const call = async (args: unknown) =>
      jsonRpcResult(
        await fetch(url, {
          method: 'POST',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'publish_session_title', arguments: args },
          }),
        }).then((response) => response.json()),
      )
    const args = { title: 'Session metadata' }
    const disabled = server.beginTurn('claude', true)
    expect((await call(args)).result.isError).toBe(true)
    expect(server.acceptSessionTitle(args, disabled)).toBeUndefined()
    const receipt = server.beginTurn('claude', false, undefined, true)
    expect((await call({ ...args, sessionId: 'foreign' })).result.isError).toBe(true)
    expect((await call(args)).result.structuredContent).toEqual({
      pactSessionTitle: { accepted: true, receipt: server.capabilityReceipt },
    })
    expect(server.acceptSessionTitle(args, disabled)).toBeUndefined()
    expect(server.acceptSessionTitle(args, receipt)).toBe('Session metadata')
    expect(server.acceptSessionTitle(args, receipt)).toBeUndefined()
    server.endTurn(receipt)
    expect(server.acceptSessionTitle(args, receipt)).toBeUndefined()
    expect((await call(args)).result.isError).toBe(true)
  })
  it('rejects delayed HTTP calls captured in an earlier Turn without consuming a replacement Turn', async () => {
    const server = new PactPeerToolServer()
    servers.push(server)
    const url = await server.start()
    server.beginTurn('claude', true)
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'request_peer_assistance', arguments: { target: 'claude', kind: 'review' } },
    })
    const requests: ClientRequest[] = []
    const replies = Array.from(
      { length: 4 },
      () =>
        new Promise<unknown>((resolve, reject) => {
          const request = httpRequest(
            url,
            { method: 'POST', headers: { 'content-length': Buffer.byteLength(body) } },
            (response) => {
              let text = ''
              response.on('data', (chunk: Buffer) => {
                text += chunk.toString('utf8')
              })
              response.on('end', () => resolve(JSON.parse(text)))
            },
          )
          request.on('error', reject)
          request.write(body.slice(0, 8))
          requests.push(request)
        }),
    )
    await immediate()
    await immediate()
    const saturated = await fetch(url, { method: 'POST', body })
    expect(saturated.status).toBe(429)
    const current = server.beginTurn('claude', true)
    for (const request of requests) request.end(body.slice(8))
    const results = await Promise.all(replies)
    expect(results.map((value) => jsonRpcResult(value).result.isError)).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(server.acceptCompleted({ target: 'claude', kind: 'review' }, current)).toBe(true)
  })

  it.each(['abort', 'timeout'])(
    'settles saturated incomplete requests once after %s',
    async (path) => {
      if (path === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const server = new PactPeerToolServer()
      servers.push(server)
      const url = await server.start()
      server.beginTurn('claude', true)
      const requests: ClientRequest[] = []
      const closed = Array.from(
        { length: 4 },
        () =>
          new Promise<void>((resolve) => {
            const request = httpRequest(url, {
              method: 'POST',
              headers: { 'content-length': '100' },
            })
            request.on('error', () => undefined)
            request.on('close', resolve)
            request.write('{')
            requests.push(request)
          }),
      )
      await immediate()
      await immediate()
      expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(429)
      if (path === 'abort') for (const request of requests) request.destroy()
      else await vi.advanceTimersByTimeAsync(10_001)
      await Promise.all(closed)
      await immediate()
      vi.useRealTimers()
      const healthy = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      })
      expect(healthy.status).toBe(200)
    },
  )

  it('returns the structured receipt and settles requests for later calls', async () => {
    const server = new PactPeerToolServer()
    servers.push(server)
    const url = await server.start()
    const receipt = server.beginTurn('claude', true)
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'request_peer_assistance',
        arguments: { target: 'claude', kind: 'review', reason: 'Check the design.' },
      },
    }
    const first = jsonRpcResult(
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }).then((response) => response.json()),
    )
    expect(first.result.isError).toBe(false)
    expect(first.result.structuredContent).toEqual({
      pactPeerProposal: { accepted: true, receipt: server.capabilityReceipt },
    })
    expect(server.acceptCompleted(request.params.arguments, receipt)).toBe(true)
    expect(server.acceptCompleted(request.params.arguments, receipt)).toBe(false)

    const duplicate = jsonRpcResult(
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, id: 2 }),
      }).then((response) => response.json()),
    )
    // Native child/background Tool validation does not consume the root quota.
    expect(duplicate.result.isError).toBe(false)

    server.beginTurn('claude', true)
    for (let id = 3; id < 8; id += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Sequential requests verify that a settled slot is reusable.
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, id }),
      })
      expect(response.status).toBe(200)
    }
  })

  it('keeps the capability stable and rejects an expired completion without consuming the new Turn', async () => {
    const server = new PactPeerToolServer()
    servers.push(server)
    const url = await server.start()
    const first = server.beginTurn('claude', true)
    const second = server.beginTurn('claude', true)
    const proposal = { target: 'claude', kind: 'review' }
    expect(await server.start()).toBe(url)
    expect(server.acceptCompleted(proposal, first)).toBe(false)
    expect(server.acceptCompleted(proposal, second)).toBe(true)
    expect(server.acceptCompleted(proposal, second)).toBe(false)
    server.endTurn(second)
    expect(server.acceptCompleted(proposal, second)).toBe(false)
  })

  it('rejects proposals when the current route disallows peer assistance', async () => {
    const server = new PactPeerToolServer()
    servers.push(server)
    const url = await server.start()
    server.beginTurn('claude', false)
    const response = jsonRpcResult(
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'request_peer_assistance',
            arguments: { target: 'claude', kind: 'review' },
          },
        }),
      }).then((result) => result.json()),
    )
    expect(response.result.isError).toBe(true)
    expect(response.result.structuredContent).toBeUndefined()
  })
})

function workflowTask(fields: Partial<CollaborationTask> = {}): CollaborationTask {
  return { ...planRunInput('codex').promptEnvelope.collaboration!, ...fields }
}
async function workflowCall(url: string, name: string, args: unknown) {
  return jsonRpcResult(
    await fetch(url, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }).then((response) => response.json()),
  ).result
}
const workflowQuestions = [
  {
    prompt: 'Which scope?',
    selection: 'single' as const,
    options: [{ label: 'Current' }, { label: 'All' }],
  },
]

describe('workflow tool root capabilities', () => {
  it.each(['plan_review', 'code_review'] as const)(
    'authenticates %s against the host reviewer and rejects model-supplied authority',
    async (stage) => {
      const server = new PactPeerToolServer()
      servers.push(server)
      const url = await server.start(),
        task = workflowTask({ stage, actor: 'claude' }),
        receipt = server.beginTurn('codex', true, task)
      const valid = { verdict: 'accepted' }
      expect(await workflowCall(`${url}/${receipt}`, 'submit_review', valid)).toEqual({
        isError: false,
        structuredContent: {
          pactReview: { verdict: 'accepted', receipt: server.capabilityReceipt },
        },
      })
      for (const authority of [
        { actor: 'claude' },
        { stage },
        { runId: task.runId },
        { taskId: task.id },
        { inputSequence: 0 },
        { receipt },
      ]) {
        expect(server.acceptReview({ ...valid, ...authority }, receipt)).toBeUndefined()
      }
      expect(await workflowCall(url, 'submit_review', { ...valid, actor: 'claude' })).toEqual({
        isError: true,
        structuredContent: undefined,
      })
      expect(server.acceptReview(valid, randomUUID())).toBeUndefined()
      const wrongActor = server.beginTurn('codex', false, { ...task, actor: 'codex' })
      expect(server.acceptReview(valid, wrongActor)).toBeUndefined()
      expect((await workflowCall(url, 'submit_review', valid)).isError).toBe(true)
    },
  )

  it.each(['plan', 'implement', 'respond', 'repair', 'reply'] as const)(
    'does not admit a review verdict from %s',
    async (stage) => {
      const server = new PactPeerToolServer()
      servers.push(server)
      const url = await server.start(),
        receipt = server.beginTurn('codex', false, workflowTask({ stage, actor: 'claude' }))
      expect(server.acceptReview({ verdict: 'accepted' }, receipt)).toBeUndefined()
      expect((await workflowCall(url, 'submit_review', { verdict: 'accepted' })).isError).toBe(true)
    },
  )

  it('validates bounded question content and requires questions exactly for needs_user', async () => {
    const server = new PactPeerToolServer()
    servers.push(server)
    const url = await server.start(),
      receipt = server.beginTurn(
        'codex',
        false,
        workflowTask({ stage: 'plan_review', actor: 'claude' }),
      )
    expect(
      await workflowCall(url, 'submit_review', {
        verdict: 'needs_user',
        questions: workflowQuestions,
      }),
    ).toEqual({
      isError: false,
      structuredContent: {
        pactReview: {
          verdict: 'needs_user',
          questions: workflowQuestions,
          receipt: server.capabilityReceipt,
        },
      },
    })
    for (const invalid of [
      { verdict: 'needs_user' },
      { verdict: 'accepted', questions: workflowQuestions },
      { verdict: 'needs_user', questions: [] },
      {
        verdict: 'needs_user',
        questions: Array.from({ length: 4 }, () => ({ ...workflowQuestions[0] })),
      },
      { verdict: 'needs_user', questions: [{ ...workflowQuestions[0], prompt: 'x'.repeat(2049) }] },
      {
        verdict: 'needs_user',
        questions: [{ ...workflowQuestions[0], options: [{ label: 'Only option' }] }],
      },
      { verdict: 'needs_user', questions: [{ ...workflowQuestions[0], id: 'q1' }] },
    ])
      expect(server.acceptReview(invalid, receipt)).toBeUndefined()
  })

  it('permits planner questions but never a planner claim that input was processed', async () => {
    const server = new PactPeerToolServer()
    servers.push(server)
    const url = await server.start(),
      receipt = server.beginTurn('claude', false, workflowTask())
    expect(server.acceptInputResult({ outcome: 'processed' }, receipt)).toBeUndefined()
    expect((await workflowCall(url, 'submit_input_result', { outcome: 'processed' })).isError).toBe(
      true,
    )
    expect(
      await workflowCall(url, 'submit_input_result', {
        outcome: 'needs_user',
        questions: workflowQuestions,
      }),
    ).toEqual({
      isError: false,
      structuredContent: {
        pactInputResult: {
          outcome: 'needs_user',
          questions: workflowQuestions,
          receipt: server.capabilityReceipt,
        },
      },
    })
    expect(server.acceptInputResult({ outcome: 'needs_user' }, receipt)).toBeUndefined()
    expect(
      server.acceptInputResult(
        { outcome: 'needs_user', questions: workflowQuestions, actor: 'codex' },
        receipt,
      ),
    ).toBeUndefined()
  })

  it('requires host pending input and a reply stage for processed observations', async () => {
    const server = new PactPeerToolServer()
    servers.push(server)
    const url = await server.start(),
      task = workflowTask({
        kind: 'build',
        stage: 'reply',
        inputProcessing: { pending: { inputId: randomUUID(), inputSequence: 1 } },
      })
    const receipt = server.beginTurn('claude', false, task)
    expect(await workflowCall(url, 'submit_input_result', { outcome: 'processed' })).toEqual({
      isError: false,
      structuredContent: {
        pactInputResult: { outcome: 'processed', receipt: server.capabilityReceipt },
      },
    })
    for (const invalid of [
      { outcome: 'processed', questions: workflowQuestions },
      { outcome: 'incomplete' },
      { outcome: 'processed', runId: task.runId },
    ])
      expect(server.acceptInputResult(invalid, receipt)).toBeUndefined()
    const noPending = server.beginTurn('claude', false, { ...task, inputProcessing: {} })
    expect(server.acceptInputResult({ outcome: 'processed' }, noPending)).toBeUndefined()
    const notReply = server.beginTurn('claude', false, { ...task, stage: 'implement' })
    expect(server.acceptInputResult({ outcome: 'processed' }, notReply)).toBeUndefined()
    expect((await workflowCall(url, 'submit_input_result', { outcome: 'processed' })).isError).toBe(
      true,
    )
  })

  it('preserves repeated and conflicting observations for the durable settlement owner instead of consuming a one-shot quota', async () => {
    const server = new PactPeerToolServer()
    servers.push(server)
    const url = await server.start()
    const receipt = server.beginTurn(
      'codex',
      false,
      workflowTask({ stage: 'plan_review', actor: 'claude' }),
    )
    const first = { verdict: 'accepted' },
      conflict = { verdict: 'changes_requested' }
    expect(server.acceptReview(first, receipt)).toEqual(first)
    expect(server.acceptReview(first, receipt)).toEqual(first)
    expect(server.acceptReview(conflict, receipt)).toEqual(conflict)
    expect((await workflowCall(url, 'submit_review', conflict)).structuredContent).toEqual({
      pactReview: { ...conflict, receipt: server.capabilityReceipt },
    })
    const reply = server.beginTurn(
      'claude',
      false,
      workflowTask({
        kind: 'build',
        stage: 'reply',
        inputProcessing: { pending: { inputId: randomUUID(), inputSequence: 1 } },
      }),
    )
    expect(server.acceptInputResult({ outcome: 'processed' }, reply)).toEqual({
      outcome: 'processed',
    })
    expect(server.acceptInputResult({ outcome: 'processed' }, reply)).toEqual({
      outcome: 'processed',
    })
    expect(
      server.acceptInputResult({ outcome: 'needs_user', questions: workflowQuestions }, reply),
    ).toEqual({ outcome: 'needs_user', questions: workflowQuestions })
  })

  it('revokes review and input receipts at cancellation, retaining no authority in cached tool names', async () => {
    const server = new PactPeerToolServer()
    servers.push(server)
    const url = await server.start(),
      first = server.beginTurn(
        'codex',
        false,
        workflowTask({ stage: 'plan_review', actor: 'claude' }),
      )
    server.endTurn(first)
    expect(server.acceptReview({ verdict: 'accepted' }, first)).toBeUndefined()
    expect((await workflowCall(url, 'submit_review', { verdict: 'accepted' })).isError).toBe(true)
    expect((await fetch(`${url}/${first}`, { method: 'POST', body: '{}' })).status).toBe(404)
    const next = server.beginTurn('claude', false, workflowTask())
    server.endTurn(first)
    expect(
      server.acceptInputResult({ outcome: 'needs_user', questions: workflowQuestions }, next),
    ).toBeDefined()
    server.endTurn(next)
    expect(
      server.acceptInputResult({ outcome: 'needs_user', questions: workflowQuestions }, next),
    ).toBeUndefined()
    expect(
      (
        await workflowCall(url, 'submit_input_result', {
          outcome: 'needs_user',
          questions: workflowQuestions,
        })
      ).isError,
    ).toBe(true)
  })

  it.each(['submit_review', 'submit_input_result'] as const)(
    'rejects delayed %s requests after root replacement',
    async (name) => {
      const server = new PactPeerToolServer()
      servers.push(server)
      const url = await server.start()
      const task =
        name === 'submit_review'
          ? workflowTask({ stage: 'plan_review', actor: 'claude' })
          : workflowTask()
      const args =
        name === 'submit_review'
          ? { verdict: 'accepted' }
          : { outcome: 'needs_user', questions: workflowQuestions }
      server.beginTurn('claude', false, task)
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      })
      const requests: ClientRequest[] = []
      const replies = Array.from(
        { length: 4 },
        () =>
          new Promise<unknown>((resolve, reject) => {
            const request = httpRequest(
              url,
              { method: 'POST', headers: { 'content-length': Buffer.byteLength(body) } },
              (response) => {
                let text = ''
                response.on('data', (chunk: Buffer) => {
                  text += chunk.toString('utf8')
                })
                response.on('end', () => resolve(JSON.parse(text)))
              },
            )
            request.on('error', reject)
            request.write(body.slice(0, 8))
            requests.push(request)
          }),
      )
      await immediate()
      await immediate()
      expect((await fetch(url, { method: 'POST', body })).status).toBe(429)
      const current = server.beginTurn('claude', false, task)
      for (const request of requests) request.end(body.slice(8))
      expect(
        (await Promise.all(replies)).map((value) => jsonRpcResult(value).result.isError),
      ).toEqual([true, true, true, true])
      expect((await workflowCall(`${url}/${current}`, name, args)).isError).toBe(false)
    },
  )
})
