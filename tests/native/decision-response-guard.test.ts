/* oxlint-disable no-await-in-loop -- Physically owned fixture cleanup follows reverse ownership order. */
import { EventEmitter } from 'node:events'
import {
  createServer,
  request as upstreamRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { connect, type Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'

import type { SchedulingUsage } from '../../packages/contracts/src/index.js'

import {
  createDecisionResponseGuard,
  validateResponse,
} from '../../apps/desktop/src/utility/conversation/decision-response-guard.js'
import {
  DecisionMemoryLease,
  nativeWorkingMemoryCapacities,
  NativeWorkingMemory,
  NATIVE_OWNER_WORKING_BYTES,
} from '../../apps/desktop/src/utility/conversation/native-working-memory.js'

vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>()
  return { ...actual, request: vi.fn<typeof actual.request>(actual.request) }
})

const prompt = 'Owned bounded advice.'
const request = () => ({
  model: 'gpt-6-luna',
  stream: true,
  store: false,
  prompt_cache_key: 'owned-thread',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
})
const headers = {
  authorization: 'Bearer owned-initial',
  'chatgpt-account-id': 'owned-account',
  'content-type': 'application/json',
}
const sse = (type: string, payload: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
const reply = (type = 'message', text = '{"candidateId":null,"highlights":[]}') => {
  const item =
    type === 'message'
      ? { id: 'owned-answer', type, role: 'assistant', content: [{ type: 'output_text', text }] }
      : { type, id: 'owned-call', name: 'mark', call_id: 'owned-call', arguments: '{}' }
  return (
    sse('response.output_item.done', { item, output_index: 0 }) +
    sse('response.completed', {
      response: {
        status: 'completed',
        output: [item],
        usage: { input_tokens: 17, output_tokens: 5 },
      },
    })
  )
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
  vi.mocked(upstreamRequest).mockReset()
})
async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  deadline = 2000,
) {
  const sockets = new Set<Socket>(),
    server = createServer(handler)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Owned fixture unavailable')
  const memory = new DecisionMemoryLease(),
    guard = await createDecisionResponseGuard(
      `http://127.0.0.1:${address.port}/v1`,
      memory,
      deadline,
    )
  let dispatches = 0,
    current = true
  guard.bind({
    threadId: 'owned-thread',
    accountId: 'owned-account',
    routingOverride: 'NO_CONSTRAINT',
    prompt,
    current: async () => current,
    dispatch: () => {
      dispatches++
    },
  })
  cleanup.push(async () => {
    await guard.close()
    memory.release()
  })
  const invoke = (
    body: unknown = request(),
    authorization = headers.authorization,
    route = '/responses',
  ) =>
    fetch(guard.baseUrl + route, {
      method: 'POST',
      headers: { ...headers, authorization },
      body: JSON.stringify(body),
    })
  return {
    guard,
    invoke,
    memory,
    dispatches: () => dispatches,
    obsolete: () => {
      current = false
    },
  }
}
it.each([{ type: 'refusal', refusal: 'Owned refusal.' }, { type: 'unknown_owned_part' }, null])(
  'observes terminal usage while rejecting unsafe content %j',
  (part) => {
    const observeUsage = vi.fn<(usage: SchedulingUsage) => void>()
    const response =
      sse('response.content_part.added', { part, output_index: 0, content_index: 0 }) +
      sse('response.completed', {
        response: {
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [part] }],
          usage: { input_tokens: 17, output_tokens: 5 },
        },
      })
    expect(() => validateResponse(Buffer.from(response), observeUsage)).toThrow(
      'Non-text or unknown response',
    )
    expect(observeUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 17, outputTokens: 5 })
  },
)

it('withholds an entire valid reply, preserves observable usage, and denies inference replay', async () => {
  let calls = 0
  const f = await fixture((_request, response) => {
    calls++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(reply())
  })
  expect((await f.invoke()).status).toBe(200)
  expect(f.guard.usage).toEqual({ inputTokens: 17, outputTokens: 5 })
  expect(f.guard.facts).toMatchObject({
    upstreamStatus: 200,
    upstreamContentType: 'event_stream',
    upstreamContentEncoding: 'absent',
    transportError: undefined,
  })
  expect((await f.invoke()).status).toBe(502)
  expect(calls).toBe(1)
  expect(f.dispatches()).toBe(1)
})
it('validates a complete SSE reply without Content-Type before releasing native bytes', async () => {
  const f = await fixture((_request, response) => {
    response.writeHead(200)
    response.end(reply())
  })
  const response = await f.invoke()
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  expect(await response.text()).toBe(reply())
  expect(f.guard.usage).toEqual({ inputTokens: 17, outputTokens: 5 })
  await f.guard.close()
  expect(f.guard.facts).toMatchObject({
    upstreamStatus: 200,
    upstreamContentType: 'absent',
    upstreamContentEncoding: 'absent',
    forwarded: 1,
    acceptedResponses: 1,
    rejectedResponses: 0,
    physicalReleased: true,
    active: 0,
  })
  expect(f.guard.facts.nativeBytes).toBeGreaterThan(0)
  expect(f.dispatches()).toBe(1)
})
it.each(
  ['event_stream', 'absent'].flatMap((mime) =>
    [
      { lineEnding: 'LF', newline: '\n' },
      { lineEnding: 'CRLF', newline: '\r\n' },
    ].flatMap(({ lineEnding, newline }) =>
      [true, false].map((complete) => ({
        mime,
        lineEnding,
        newline,
        complete,
        ending: complete ? 'complete' : 'truncated',
      })),
    ),
  ),
)(
  'requires a final $lineEnding blank line before native delivery (MIME: $mime, terminal: $ending)',
  async ({ mime, newline, complete }) => {
    const normalized = reply(),
      completeBody = normalized.replaceAll('\n', newline),
      body = complete ? completeBody : completeBody.slice(0, -2 * newline.length)
    const f = await fixture((_request, response) => {
      response.writeHead(
        200,
        mime === 'event_stream' ? { 'content-type': 'text/event-stream' } : {},
      )
      response.end(body)
    })
    const response = await f.invoke()
    expect(response.status).toBe(complete ? 200 : 502)
    expect(await response.text()).toBe(complete ? normalized : '')
    await f.guard.close()
    expect(f.guard.facts).toMatchObject({
      upstreamStatus: 200,
      upstreamContentType: mime,
      forwarded: 1,
      acceptedResponses: complete ? 1 : 0,
      rejectedResponses: complete ? 0 : 1,
      nativeBytes: complete ? Buffer.byteLength(normalized) : 0,
      physicalReleased: true,
      active: 0,
      refusal: complete ? undefined : 'response',
    })
    expect(f.dispatches()).toBe(1)
    expect(f.memory.diagnostics()).toMatchObject({ heldBytes: 0, items: 0, released: false })
    f.memory.release()
    expect(f.memory.diagnostics().released).toBe(true)
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
  },
)
it.each(
  ['event_stream', 'absent'].flatMap((mime) =>
    [
      { scope: 'message parts', separateMessages: false },
      { scope: 'terminal messages', separateMessages: true },
    ].flatMap(({ scope, separateMessages }) =>
      [0, 1].map((extraBytes) => ({ mime, scope, separateMessages, extraBytes })),
    ),
  ),
)(
  'bounds UTF-8 $scope at 16 KiB plus $extraBytes byte without double counting repeated events (MIME: $mime)',
  async ({ mime, separateMessages, extraBytes }) => {
    const texts = ['界'.repeat(2730) + 'aa', '🙂'.repeat(2048) + 'x'.repeat(extraBytes)]
    expect(texts.map((text) => Buffer.byteLength(text))).toEqual([8192, 8192 + extraBytes])
    const output = (separateMessages ? texts.map((text) => [text]) : [texts]).map(
      (parts, index) => ({
        id: `owned-answer-${index}`,
        type: 'message',
        role: 'assistant',
        content: parts.map((text) => ({ type: 'output_text', text })),
      }),
    )
    const body =
      output
        .map((item, output_index) => sse('response.output_item.done', { item, output_index }))
        .join('') +
      sse('response.completed', {
        response: {
          status: 'completed',
          output,
          usage: { input_tokens: 17, output_tokens: 5 },
        },
      })
    const f = await fixture((_request, response) => {
      response.writeHead(
        200,
        mime === 'event_stream' ? { 'content-type': 'text/event-stream' } : {},
      )
      response.end(body)
    })
    const business = Array.from({ length: 4 }, () =>
      new NativeWorkingMemory().reserve(NATIVE_OWNER_WORKING_BYTES),
    )
    try {
      expect(nativeWorkingMemoryCapacities().chargedBytes).toBe(528 * 1024 * 1024)
      const response = await f.invoke(),
        accepted = extraBytes === 0
      expect(response.status).toBe(accepted ? 200 : 502)
      expect(await response.text()).toBe(accepted ? body : '')
      expect(f.guard.usage).toEqual({ inputTokens: 17, outputTokens: 5 })
      await f.guard.close()
      expect(f.guard.facts).toMatchObject({
        upstreamStatus: 200,
        upstreamContentType: mime,
        forwarded: 1,
        acceptedResponses: accepted ? 1 : 0,
        rejectedResponses: accepted ? 0 : 1,
        nativeBytes: accepted ? Buffer.byteLength(body) : 0,
        physicalReleased: true,
        active: 0,
        refusal: accepted ? undefined : 'response',
      })
      expect(f.dispatches()).toBe(1)
      expect(f.memory.diagnostics()).toMatchObject({ heldBytes: 0, items: 0, released: false })
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
      f.memory.release()
      expect(f.memory.diagnostics().released).toBe(true)
      expect(nativeWorkingMemoryCapacities()).toMatchObject({
        chargedBytes: 512 * 1024 * 1024,
        business: { chargedBytes: 512 * 1024 * 1024 },
        decision: { chargedBytes: 0 },
      })
    } finally {
      business.forEach((item) => item.release())
    }
  },
)
it.each([
  { kind: 'empty', body: '', observedUsage: false },
  {
    kind: 'HTML',
    body: '<!doctype html><html><body>Owned error</body></html>',
    observedUsage: false,
  },
  { kind: 'JSON', body: '{"candidateId":null,"highlights":[]}', observedUsage: false },
  {
    kind: 'malformed SSE JSON',
    body: 'event: response.completed\ndata: {"type":"response.completed"\n\n',
    observedUsage: false,
  },
  { kind: 'truncated SSE', body: reply().slice(0, -40), observedUsage: false },
  {
    kind: 'SSE without a terminal event',
    body: reply().split('event: response.completed')[0]!,
    observedUsage: false,
  },
  { kind: 'tool-call output', body: reply('function_call'), observedUsage: true },
  { kind: 'unknown output', body: reply('unknown_call'), observedUsage: true },
  {
    kind: 'output above 16 KiB',
    body: reply('message', 'x'.repeat(16 * 1024 + 1)),
    observedUsage: true,
  },
  { kind: 'response above 256 KiB', body: 'x'.repeat(256 * 1024 + 1), observedUsage: false },
])(
  'withholds invalid $kind without Content-Type until full body validation',
  async ({ body, observedUsage }) => {
    const f = await fixture((_request, response) => {
      response.writeHead(200)
      response.end(body)
    })
    expect((await f.invoke()).status).toBe(502)
    await f.guard.close()
    expect(f.guard.facts).toMatchObject({
      upstreamStatus: 200,
      upstreamContentType: 'absent',
      upstreamContentEncoding: 'absent',
      forwarded: 1,
      acceptedResponses: 0,
      nativeBytes: 0,
      physicalReleased: true,
      active: 0,
      refusal: 'response',
    })
    expect(f.guard.facts.rejectedResponses).toBeGreaterThan(0)
    expect(f.guard.usage).toEqual(observedUsage ? { inputTokens: 17, outputTokens: 5 } : undefined)
  },
)
it.each([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'web_search_call',
  'image_generation_call',
  'unknown_call',
])(
  'blocks %s before any native response byte while preserving consumed token usage',
  async (type) => {
    const f = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(reply(type))
    })
    expect((await f.invoke()).status).toBe(502)
    expect(f.guard.facts).toMatchObject({ nativeBytes: 0, rejectedResponses: 1, forwarded: 1 })
    expect(f.guard.usage).toEqual({ inputTokens: 17, outputTokens: 5 })
  },
)
it('allows only native same-request 401 recovery with changed credentials and the same current identity', async () => {
  let calls = 0
  const f = await fixture((_request, response) => {
    calls++
    if (calls === 1) {
      response.writeHead(401)
      response.end('{}')
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(reply())
    }
  })
  expect((await f.invoke()).status).toBe(401)
  expect(f.guard.facts).toMatchObject({
    upstreamStatus: 401,
    upstreamContentType: 'absent',
    upstreamContentEncoding: 'absent',
  })
  expect((await f.invoke()).status).toBe(401)
  expect(calls).toBe(1)
  expect((await f.invoke(request(), 'Bearer owned-refreshed')).status).toBe(200)
  expect(calls).toBe(2)
  expect(f.dispatches()).toBe(1)
  expect(f.guard.facts).toMatchObject({ auth401: 1, authReload401: 1, authChanged: true })
  expect(f.guard.facts).toMatchObject({ upstreamStatus: 200, upstreamContentType: 'event_stream' })
})
it.each([
  { status: 503, type: 'application/json; owned=private', encoding: undefined, content: 'json' },
  { status: 200, type: 'text/html; owned=private', encoding: undefined, content: 'html' },
  { status: 200, type: 'text/plain; owned=private', encoding: undefined, content: 'text' },
  { status: 200, type: 'application/owned-private', encoding: undefined, content: 'other' },
  { status: 200, type: 'text/event-stream', encoding: 'gzip', content: 'event_stream' },
  { status: 200, type: 'text/event-stream', encoding: 'owned-private', content: 'event_stream' },
])('observes only bounded upstream status and header classes for %j', async (observation) => {
  const f = await fixture((_request, response) => {
    response.writeHead(observation.status, {
      'content-type': observation.type,
      ...(observation.encoding ? { 'content-encoding': observation.encoding } : {}),
    })
    response.end('owned-private-response-body')
  })
  expect((await f.invoke()).status).toBe(502)
  expect(f.guard.facts).toMatchObject({
    upstreamStatus: observation.status,
    upstreamContentType: observation.content,
    upstreamContentEncoding:
      observation.encoding === undefined
        ? 'absent'
        : observation.encoding === 'gzip'
          ? 'gzip'
          : 'other',
    nativeBytes: 0,
    transportError: undefined,
  })
  expect(JSON.stringify(f.guard.facts)).not.toContain('private')
})
it.each([
  { phase: 'constructor', code: 'ENOTFOUND', classification: 'dns' },
  { phase: 'error', code: 'ECONNRESET', classification: 'connection_reset' },
  { phase: 'error', code: 'ERR_TLS_CERT_ALTNAME_INVALID', classification: 'tls' },
  { phase: 'error', code: 'OWNED_PRIVATE_CODE', classification: 'other' },
  { phase: 'close', code: undefined, classification: 'closed_without_response' },
])(
  'observes only an allowlisted transport class for %j',
  async ({ phase, code, classification }) => {
    const f = await fixture((_request, response) => response.end())
    vi.mocked(upstreamRequest).mockImplementationOnce(() => {
      const cause = Object.assign(Error('owned-private-error-message'), { code })
      if (phase === 'constructor') throw cause
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Owned transport seam supplies only the ClientRequest events/end consumed by the primary guard interface.
      const pendingRequest = new EventEmitter() as ClientRequest
      pendingRequest.end = () => {
        queueMicrotask(() => {
          if (phase === 'error') pendingRequest.emit('error', cause)
          pendingRequest.emit('close')
        })
        return pendingRequest
      }
      return pendingRequest
    })
    expect((await f.invoke()).status).toBe(502)
    await f.guard.close()
    expect(f.guard.facts).toMatchObject({
      forwarded: 1,
      upstreamStatus: undefined,
      upstreamContentType: undefined,
      upstreamContentEncoding: undefined,
      transportError: classification,
      nativeBytes: 0,
      physicalReleased: true,
    })
    expect(JSON.stringify(f.guard.facts)).not.toContain('private')
    expect(JSON.stringify(f.guard.facts)).not.toContain('OWNED_PRIVATE_CODE')
  },
)
it.each(['web_search', 'image_generation', 'unknown_hosted'])(
  'rejects hosted request %s before upstream or a dispatch receipt',
  async (type) => {
    let calls = 0
    const f = await fixture((_request, response) => {
      calls++
      response.end()
    })
    expect((await f.invoke({ ...request(), tools: [{ type }] })).status).toBe(502)
    expect({ calls, dispatches: f.dispatches() }).toEqual({ calls: 0, dispatches: 0 })
  },
)
it('rejects full inherited input above 128 KiB while keeping its separate 256 KiB transport bound', async () => {
  let calls = 0
  const f = await fixture((_request, response) => {
    calls++
    response.end()
  })
  const body = request()
  body.input.push({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'x'.repeat(128 * 1024) }],
  })
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(256 * 1024)
  expect((await f.invoke(body)).status).toBe(502)
  expect({ calls, dispatches: f.dispatches(), bytes: f.guard.facts.nativeBytes }).toEqual({
    calls: 0,
    dispatches: 0,
    bytes: 0,
  })
})
it('does not follow redirects or let a changed account/request recover a 401', async () => {
  let calls = 0
  const f = await fixture((_request, response) => {
    calls++
    response.writeHead(401)
    response.end('{}')
  })
  expect((await f.invoke()).status).toBe(401)
  expect(
    (await f.invoke({ ...request(), prompt_cache_key: 'different' }, 'Bearer changed')).status,
  ).toBe(502)
  f.obsolete()
  expect((await f.invoke(request(), 'Bearer changed')).status).toBe(502)
  expect(calls).toBe(1)
  await f.guard.close()
  f.memory.release()
  const redirect = await fixture((_request, response) => {
    response.writeHead(307, { location: 'http://127.0.0.1:1/forbidden' })
    response.end()
  })
  expect((await redirect.invoke()).status).toBe(502)
  expect(redirect.guard.facts.nativeBytes).toBe(0)
})
it.each([false, true])(
  'releases real sockets and handlers after deadline/late output without releasing the App lease early or blocking the original business capacity (untyped headers sent: %s)',
  async (sendHeaders) => {
    let late: ServerResponse | undefined
    const f = await fixture((_request, response) => {
      late = response
      if (sendHeaders) {
        response.writeHead(200)
        response.flushHeaders()
      }
    }, 150)
    const pending = f.invoke().then(
      (response) => response.status,
      () => 0,
    )
    await vi.waitFor(() => expect(late).toBeDefined())
    const business = Array.from({ length: 4 }, () =>
      new NativeWorkingMemory().reserve(NATIVE_OWNER_WORKING_BYTES),
    )
    try {
      expect(nativeWorkingMemoryCapacities().chargedBytes).toBe(528 * 1024 * 1024)
      expect(f.memory.diagnostics().released).toBe(false)
      await pending
      if (!late) throw Error('Owned upstream did not start')
      late.end(reply())
      await f.guard.close()
      expect(f.guard.facts).toMatchObject({
        active: 0,
        physicalReleased: true,
        nativeBytes: 0,
        transportError: 'aborted',
      })
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
    } finally {
      business.forEach((item) => item.release())
    }
  },
)
it('bounds malformed SSE structure, output, fragmented bodies and pipelined inbound requests', async () => {
  expect(() => validateResponse(Buffer.from(reply('message', 'x'.repeat(16 * 1024 + 1))))).toThrow(
    /Non-text|Frame capacity/u,
  )
  expect(() =>
    validateResponse(
      Buffer.from(
        'event: response.created\ndata: ' +
          JSON.stringify({ type: 'response.created', response: { output: [] } }) +
          '\n\n'.repeat(300),
      ),
    ),
  ).toThrow(/Non-text|Frame capacity/u)
  const f = await fixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(reply())
  })
  const url = new URL(f.guard.baseUrl + '/responses'),
    socket = connect(Number(url.port), '127.0.0.1')
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  socket.on('error', () => undefined)
  socket.write(
    Array.from({ length: 128 }, () => `GET /unknown HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`).join(
      '',
    ),
  )
  await closed
  await f.guard.close()
  expect(f.guard.facts).toMatchObject({
    active: 0,
    physicalReleased: true,
    forwarded: 0,
    nativeBytes: 0,
  })
  expect(f.guard.facts.peakActive).toBeLessThanOrEqual(1)
})
it('denies inbound websocket upgrades without forwarding', async () => {
  let calls = 0
  const f = await fixture((_request, response) => {
    calls++
    response.end()
  })
  const url = new URL(f.guard.baseUrl),
    socket = connect(Number(url.port), '127.0.0.1')
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  socket.on('error', () => undefined)
  socket.write(
    `GET ${url.pathname}/responses HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
  )
  await closed
  expect(calls).toBe(0)
  expect(f.guard.facts).toMatchObject({ upgrades: 1, nativeBytes: 0 })
})
