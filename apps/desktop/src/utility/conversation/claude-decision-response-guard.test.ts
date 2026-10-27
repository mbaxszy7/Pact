/* oxlint-disable no-await-in-loop -- Each protocol refusal must physically close before the next socket. */
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { expect, it, vi } from 'vitest'

import { createClaudeDecisionResponseGuard } from './claude-decision-response-guard.js'
import { DecisionMemoryLease, nativeWorkingMemoryCapacities } from './native-working-memory.js'

const MODEL = 'claude-haiku-5-5'
const PROMPT = 'Complete owned decision context.'
const ANSWER = '{"candidateId":null,"highlights":[]}'
const event = (type: string, fields: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
function sse(block = 'text', answer = ANSWER): string {
  return (
    event('message_start', {
      message: {
        id: 'msg_owned',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 0 },
      },
    }) +
    event('content_block_start', {
      index: 0,
      content_block:
        block === 'text'
          ? { type: block, text: '' }
          : { type: block, id: 'tool_owned', name: 'Bash', input: {} },
    }) +
    event('content_block_delta', {
      index: 0,
      delta:
        block === 'text'
          ? { type: 'text_delta', text: answer }
          : { type: 'input_json_delta', partial_json: '{"command":"fixture"}' },
    }) +
    event('content_block_stop', { index: 0 }) +
    event('message_delta', {
      delta: { stop_reason: block === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null },
      usage: { output_tokens: 7 },
    }) +
    event('message_stop')
  )
}
async function fixture(
  handler: (incoming: IncomingMessage, outgoing: ServerResponse, attempt: number) => void,
  duration = 5000,
) {
  let requests = 0
  const provider = createServer((incoming, outgoing) => {
    incoming.resume()
    handler(incoming, outgoing, ++requests)
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address()
  if (!address || typeof address === 'string') throw Error('Missing owned provider')
  const lease = new DecisionMemoryLease(),
    dispatch = vi.fn<() => void>(),
    guard = await createClaudeDecisionResponseGuard(
      `http://127.0.0.1:${address.port}`,
      lease,
      Date.now() + duration,
    )
  guard.bind({ modelId: MODEL, prompt: PROMPT, current: () => true, dispatch })
  const body = {
    model: MODEL,
    stream: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
    system: [{ type: 'text', text: 'Owned global instructions.' }],
    max_tokens: 128,
    tools: [],
  }
  return {
    guard,
    lease,
    dispatch,
    body,
    provider,
    get requests() {
      return requests
    },
    async post(options: { body?: unknown; key?: string; headers?: Record<string, string> } = {}) {
      return fetch(`${guard.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.key ?? 'OWNED-DUMMY-KEY-1',
          ...options.headers,
        },
        body: JSON.stringify(options.body ?? body),
      })
    },
    async close() {
      await guard.close()
      provider.closeAllConnections()
      await new Promise<void>((resolve) => provider.close(() => resolve()))
      lease.release()
    },
  }
}

it('withholds every model byte until a complete exact-model text response validates', async () => {
  const waiting = Promise.withResolvers<ServerResponse>()
  const f = await fixture((_incoming, outgoing) => {
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
    outgoing.write(sse().slice(0, -event('message_stop').length))
    waiting.resolve(outgoing)
  })
  try {
    let received = false
    const pending = f.post().then((response) => {
      received = true
      return response
    })
    const outgoing = await waiting.promise
    expect(received).toBe(false)
    expect(f.guard.facts.nativeBytes).toBe(0)
    outgoing.end(event('message_stop'))
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(sse())
    expect(f.guard.answer).toBe(ANSWER)
    expect(f.guard.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
    expect(f.dispatch).toHaveBeenCalledOnce()
    expect(f.requests).toBe(1)
    expect(f.guard.facts.nativeBytes).toBe(Buffer.byteLength(sse()))
  } finally {
    await f.close()
  }
  expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
})

it.each([
  ['tool use', () => sse('tool_use')],
  ['unknown block', () => sse('future_execution')],
  ['wrong model', () => sse().replace(MODEL, 'claude-haiku-4-5')],
  ['missing terminal blank line', () => sse().slice(0, -1)],
  ['missing message stop', () => sse().slice(0, -event('message_stop').length)],
  ['second message', () => sse() + sse()],
  [
    'unknown event',
    () => sse().replace(event('message_stop'), event('future_event') + event('message_stop')),
  ],
  ['bad UTF-8', () => Buffer.concat([Buffer.from(sse()), Buffer.from([0xff])])],
  ['output overflow', () => sse('text', 'x'.repeat(16 * 1024 + 1))],
  ['wrong index', () => sse().replaceAll('"index":0', '"index":1')],
] as const)('rejects %s before any model response byte reaches native', async (_label, source) => {
  const f = await fixture((_incoming, outgoing) => {
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
    outgoing.end(source())
  })
  try {
    const response = await f.post()
    expect(response.status).toBe(422)
    expect(f.guard.facts).toMatchObject({
      forwarded: 1,
      nativeBytes: 0,
      acceptedResponses: 0,
      rejectedResponses: 1,
    })
    expect(
      _label !== 'tool use' ||
        (f.guard.usage?.inputTokens === 11 && f.guard.usage.outputTokens === 7),
    ).toBe(true)
    await f.post()
    expect(f.requests).toBe(1)
  } finally {
    await f.close()
  }
})

it('counts text and thinking together across blocks while preserving usage on overflow', async () => {
  const stream = sse('text', 'x'.repeat(9000))
    .replaceAll('"index":0', '"index":1')
    .replace(
      'event: content_block_start',
      event('content_block_start', {
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }) +
        event('content_block_delta', {
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'x'.repeat(9000) },
        }) +
        event('content_block_stop', { index: 0 }) +
        'event: content_block_start',
    )
  const f = await fixture((_incoming, outgoing) => {
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
    outgoing.end(stream)
  })
  try {
    expect((await f.post()).status).toBe(422)
    expect(f.guard.facts.nativeBytes).toBe(0)
    expect(f.guard.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
  } finally {
    await f.close()
  }
})

it('retains observed usage when the final SSE event lacks its required blank terminator', async () => {
  const f = await fixture((_incoming, outgoing) => {
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
    outgoing.end(sse().slice(0, -1))
  })
  try {
    expect((await f.post()).status).toBe(422)
    expect(f.guard.facts.nativeBytes).toBe(0)
    expect(f.guard.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
  } finally {
    await f.close()
  }
})

it.each(['history', 'image', 'server tool', 'wrong model', 'global overflow', 'envelope overflow'])(
  'rejects %s before dispatch',
  async (variant) => {
    const f = await fixture((_incoming, outgoing) => outgoing.end(sse()))
    try {
      const body: Record<string, unknown> = { ...f.body }
      if (variant === 'history')
        body.messages = [...f.body.messages, { role: 'assistant', content: 'old' }]
      if (variant === 'image')
        body.messages = [
          { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: '' } }] },
        ]
      if (variant === 'server tool')
        body.tools = [{ type: 'web_search_20250305', name: 'web_search' }]
      if (variant === 'wrong model') body.model = 'haiku'
      if (variant === 'global overflow')
        body.system = [{ type: 'text', text: 'x'.repeat(128 * 1024) }]
      if (variant === 'envelope overflow') body.metadata = { padding: 'x'.repeat(256 * 1024) }
      await f.post({ body }).catch(() => undefined)
      expect(f.requests).toBe(0)
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(f.guard.usage).toBeUndefined()
    } finally {
      await f.close()
    }
  },
)

it('permits one native auth recovery only after a complete 401 and changed credentials', async () => {
  const f = await fixture((_incoming, outgoing, attempt) => {
    outgoing.writeHead(attempt === 1 ? 401 : 200, {
      'content-type': attempt === 1 ? 'application/json' : 'text/event-stream',
    })
    outgoing.end(attempt === 1 ? '{"type":"error"}' : sse())
  })
  try {
    expect((await f.post()).status).toBe(401)
    expect(
      (await f.post({ key: 'OWNED-DUMMY-KEY-2', body: { ...f.body, system: f.body.system } }))
        .status,
    ).toBe(200)
    expect((await f.post({ key: 'OWNED-DUMMY-KEY-3' })).status).toBe(422)
    expect(f.requests).toBe(2)
    expect(f.dispatch).toHaveBeenCalledOnce()
    expect(f.guard.facts).toMatchObject({ auth401: 1, authChanged: true, forwarded: 2 })
  } finally {
    await f.close()
  }
})

it.each(['same credentials', 'changed body', 'changed stable header', 'second 401'])(
  'refuses 401 recovery with %s',
  async (variant) => {
    const f = await fixture((_incoming, outgoing) => {
      outgoing.writeHead(401)
      outgoing.end('{}')
    })
    try {
      expect((await f.post()).status).toBe(401)
      const response = await f.post({
        key: variant === 'same credentials' ? 'OWNED-DUMMY-KEY-1' : 'OWNED-DUMMY-KEY-2',
        ...(variant === 'changed body' ? { body: { ...f.body, max_tokens: 129 } } : {}),
        ...(variant === 'changed stable header'
          ? { headers: { 'anthropic-version': 'changed' } }
          : {}),
      })
      expect(response.status).toBe(422)
      expect(f.requests).toBe(variant === 'second 401' ? 2 : 1)
      expect((await f.post({ key: 'OWNED-DUMMY-KEY-3' })).status).toBe(422)
    } finally {
      await f.close()
    }
  },
)

it('rejects parallel requests and joins in-flight handlers on close', async () => {
  const reached = Promise.withResolvers<void>()
  const f = await fixture(() => reached.resolve())
  try {
    const first = f.post().catch(() => undefined)
    await reached.promise
    expect((await f.post()).status).toBe(422)
    expect(f.requests).toBe(1)
    await f.guard.close()
    await first
    expect(f.guard.facts).toMatchObject({ physicalReleased: true, active: 0, peakActive: 1 })
  } finally {
    await f.close()
  }
})

it('refuses CONNECT and protocol upgrades without dispatch', async () => {
  const f = await fixture((_incoming, outgoing) => outgoing.end(sse()))
  try {
    const url = new URL(f.guard.baseUrl)
    for (const method of ['CONNECT', 'GET']) {
      await new Promise<void>((resolve) => {
        const socket = connect(Number(url.port), '127.0.0.1', () =>
          socket.write(
            `${method} ${url.pathname}/v1/messages HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
          ),
        )
        socket.on('error', () => undefined)
        socket.on('close', () => resolve())
      })
    }
    expect(f.requests).toBe(0)
    expect(f.guard.facts.upgrades).toBe(2)
  } finally {
    await f.close()
  }
})

it.each(['redirect', 'upgrade', 'reset', 'encoding'])(
  'does not replay after upstream %s',
  async (variant) => {
    const f = await fixture((_incoming, outgoing) => {
      if (variant === 'reset') {
        outgoing.destroy()
        return
      }
      outgoing.writeHead(variant === 'redirect' ? 307 : variant === 'upgrade' ? 101 : 200, {
        'content-type': 'text/event-stream',
        ...(variant === 'redirect' ? { location: 'https://invalid.example' } : {}),
        ...(variant === 'upgrade' ? { connection: 'Upgrade', upgrade: 'websocket' } : {}),
        ...(variant === 'encoding' ? { 'content-encoding': 'gzip' } : {}),
      })
      outgoing.end(sse())
    })
    try {
      expect((await f.post()).status).toBe(422)
      expect((await f.post({ key: 'OWNED-DUMMY-KEY-2' })).status).toBe(422)
      expect(f.requests).toBe(1)
      expect(f.guard.facts.nativeBytes).toBe(0)
    } finally {
      await f.close()
    }
  },
)

it('bounds a slow request by the original guard deadline', async () => {
  const f = await fixture((_incoming, outgoing) => outgoing.end(sse()), 100)
  try {
    await new Promise<void>((resolve) => {
      const req = request(`${f.guard.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      req.on('error', () => resolve())
      req.write('{')
    })
    expect(f.requests).toBe(0)
  } finally {
    await f.close()
  }
})

it.each([false, true])(
  'accepts documented empty metadata but blocks container execution evidence (%s)',
  async (unsafe) => {
    const response = sse()
      .replace(
        '"usage":{"input_tokens":11',
        '"container":' +
          (unsafe ? '{}' : 'null') +
          ',"context_management":{"applied_edits":[]},"stop_details":null,"usage":{"input_tokens":11',
      )
      .replace(
        '"delta":{"stop_reason":"end_turn","stop_sequence":null}',
        '"context_management":{"applied_edits":[]},"delta":{"container":null,"stop_details":null,"stop_reason":"end_turn","stop_sequence":null}',
      )
    const f = await fixture((_incoming, outgoing) => {
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
      outgoing.end(response)
    })
    try {
      const reply = await f.post()
      expect(reply.status).toBe(unsafe ? 422 : 200)
      expect(f.guard.facts.acceptedResponses).toBe(unsafe ? 0 : 1)
      expect(f.guard.facts.rejectedResponses).toBe(unsafe ? 1 : 0)
    } finally {
      await f.close()
    }
  },
)
