import type { Socket } from 'node:net'

import { createHash, randomUUID } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'

import { DECISION_INPUT_BYTES, DECISION_OUTPUT_BYTES, type SchedulingUsage } from '@pact/contracts'

import type { NativeMemoryAllocator } from './native-working-memory'

const WORKING_BYTES = 6 * 1024 * 1024
const ENVELOPE_BYTES = 256 * 1024
const MAX_EVENTS = 256
const EXACT_MODEL = /^claude-haiku-5-5(?:-\d{8})?$/u
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const record = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw Error('Invalid Claude envelope')
  return value
}

/** Admission precedes JSON.parse, including structural and decoded-string workspace. */
export function parseClaudeDecisionJson(text: string, budget?: { remaining: number }): unknown {
  let depth = 0,
    nodes = 0,
    quoted = false,
    escaped = false
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
    } else if (character === '"') {
      quoted = true
      nodes++
    } else if (character === '{' || character === '[') {
      depth++
      nodes++
    } else if (character === '}' || character === ']') depth--
    else if (character === ':' || character === ',') nodes++
    if (depth > 32 || nodes > Math.min(8192, budget?.remaining ?? 8192))
      throw Error('Claude structure capacity')
  }
  if (budget) budget.remaining -= nodes
  return JSON.parse(text)
}

/** Hash all values, retaining neither credentials nor an additional normalized DTO. */
export function claudeDecisionFingerprint(root: unknown): string {
  const digest = createHash('sha256')
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      digest.update('[')
      value.forEach((item, index) => {
        if (index) digest.update(',')
        visit(item)
      })
      digest.update(']')
    } else if (value && typeof value === 'object') {
      digest.update('{')
      Object.keys(value)
        .toSorted()
        .forEach((key, index) => {
          if (index) digest.update(',')
          digest.update(JSON.stringify(key)).update(':')
          visit(Reflect.get(value, key))
        })
      digest.update('}')
    } else digest.update(JSON.stringify(value) ?? 'null')
  }
  visit(root)
  return digest.digest('hex')
}

async function boundedRead(stream: IncomingMessage, limit: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(limit)
  let length = 0
  for await (const value of stream) {
    const chunk: unknown = value
    if (!Buffer.isBuffer(chunk) || length + chunk.length > limit) {
      stream.destroy()
      throw Error('Claude HTTP capacity')
    }
    chunk.copy(buffer, length)
    length += chunk.length
  }
  if (!stream.complete) throw Error('Incomplete Claude response')
  return buffer.subarray(0, length)
}

const text = (value: unknown): string => {
  if (typeof value !== 'string') throw Error('Invalid Claude text')
  return value
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) {
    const recognized = [
      'container',
      'context_management',
      'stop_details',
      'input_transformations',
      'citations',
      'cache_control',
      'service_tier',
      'inference_geo',
      'output_tokens_details',
    ]
    throw Error('Unsupported Claude envelope:' + (recognized.includes(unknown) ? unknown : 'other'))
  }
}
function requestBody(bytes: Buffer, model: string, prompt: string) {
  const body = record(
    parseClaudeDecisionJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  )
  onlyKeys(body, [
    'model',
    'messages',
    'system',
    'tools',
    'metadata',
    'max_tokens',
    'temperature',
    'top_p',
    'top_k',
    'stream',
    'thinking',
    'output_config',
    'context_management',
    'stop_sequences',
    'service_tier',
    'cache_control',
  ])
  if (body.model !== model || body.stream !== true || !Array.isArray(body.messages))
    throw Error('Invalid Claude request')
  // A fresh native context contributes one user message, possibly with native system reminders.
  if (body.messages.length < 1 || body.messages.length > 8) throw Error('Unexpected Claude history')
  let inputBytes = 0,
    promptCount = 0
  const part = (value: unknown, user: boolean): void => {
    const block = record(value)
    onlyKeys(block, ['type', 'text', 'cache_control'])
    if (block.type !== 'text') throw Error('Unexpected Claude input')
    const content = text(block.text)
    inputBytes += Buffer.byteLength(content)
    if (user && content === prompt) promptCount++
  }
  let userMessages = 0
  for (const raw of body.messages) {
    const message = record(raw)
    onlyKeys(message, ['role', 'content'])
    if (message.role !== 'user' && message.role !== 'system')
      throw Error('Unexpected Claude history')
    const user = message.role === 'user'
    if (user) userMessages++
    if (typeof message.content === 'string') {
      inputBytes += Buffer.byteLength(message.content)
      if (user && message.content === prompt) promptCount++
    } else if (Array.isArray(message.content)) message.content.forEach((value) => part(value, user))
    else throw Error('Unexpected Claude input')
  }
  if (userMessages !== 1) throw Error('Unexpected Claude history')
  if (typeof body.system === 'string') inputBytes += Buffer.byteLength(body.system)
  else if (Array.isArray(body.system)) body.system.forEach((value) => part(value, false))
  else if (body.system !== undefined) throw Error('Unexpected Claude system')
  if (promptCount !== 1 || inputBytes > DECISION_INPUT_BYTES)
    throw Error('Claude input capacity or identity')
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 64)
      throw Error('Unsupported Claude tools')
    for (const raw of body.tools) {
      const tool = record(raw)
      onlyKeys(tool, [
        'name',
        'description',
        'input_schema',
        'cache_control',
        'defer_loading',
        'strict',
      ])
      // These are local tool descriptions only. Any response invoking one is withheld.
      if (
        typeof tool.name !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(tool.name) ||
        tool.name.startsWith('mcp_') ||
        record(tool.input_schema).type !== 'object'
      )
        throw Error('Unsupported Claude tools')
    }
  }
  return { body, inputBytes }
}

function observedUsage(
  value: unknown,
  previous: SchedulingUsage | undefined,
): SchedulingUsage | undefined {
  if (!isRecord(value)) return previous
  const raw = value
  const count = (key: string) =>
    typeof raw[key] === 'number' && Number.isSafeInteger(raw[key]) && raw[key] >= 0
      ? raw[key]
      : undefined
  const input = count('input_tokens'),
    output = count('output_tokens')
  if (input === undefined && output === undefined) return previous
  const usage = { ...previous }
  if (input !== undefined) {
    const total =
      input + (count('cache_creation_input_tokens') ?? 0) + (count('cache_read_input_tokens') ?? 0)
    if (Number.isSafeInteger(total)) usage.inputTokens = total
  }
  if (output !== undefined) usage.outputTokens = output
  return usage
}

function responseBody(bytes: Buffer, model: string, observe: (value: unknown) => void): string {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n')
  const frames = source.split('\n\n')
  if (frames.length > MAX_EVENTS + 1) throw Error('Claude SSE capacity')
  const events: Array<Record<string, unknown>> = []
  const structure = { remaining: 8192 }
  for (const frame of frames) {
    if (!frame) continue
    let event: string | undefined, data: string | undefined
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event: ') && event === undefined) event = line.slice(7)
      else if (line.startsWith('data: ') && data === undefined) data = line.slice(6)
      else throw Error('Unsupported Claude SSE')
    }
    if (event === undefined && data === undefined) continue
    if (!data || !event) throw Error('Invalid Claude SSE')
    const value = record(parseClaudeDecisionJson(data, structure))
    if (value.type !== event) throw Error('Invalid Claude SSE identity')
    events.push(value)
    // Count actual observable usage even when a later validation rejects a tool or unknown block.
    if (value.type === 'message_start' && value.message && typeof value.message === 'object')
      observe(Reflect.get(value.message, 'usage'))
    if (value.type === 'message_delta') observe(value.usage)
  }
  if (!source.endsWith('\n\n') || source.includes('\r')) throw Error('Incomplete Claude SSE')
  let started = false,
    stopped = false,
    ended = false,
    nextIndex = 0,
    block: 'text' | 'thinking' | undefined,
    outputBytes = 0,
    answer = ''
  const add = (value: unknown, visible: boolean): void => {
    const content = text(value)
    outputBytes += Buffer.byteLength(content)
    if (outputBytes > DECISION_OUTPUT_BYTES) throw Error('Claude output capacity')
    if (visible) answer += content
  }
  for (const value of events) {
    if (ended) throw Error('Extra Claude response')
    switch (value.type) {
      case 'ping':
        onlyKeys(value, ['type'])
        break
      case 'message_start': {
        if (started) throw Error('Extra Claude message')
        onlyKeys(value, ['type', 'message'])
        const message = record(value.message)
        onlyKeys(message, [
          'id',
          'type',
          'role',
          'model',
          'content',
          'stop_reason',
          'stop_sequence',
          'usage',
          'container',
          'context_management',
          'stop_details',
          'input_transformations',
        ])
        for (const key of ['container', 'stop_details'])
          if (message[key] !== undefined && message[key] !== null)
            throw Error('Unsafe Claude response')
        if (message.context_management !== undefined && message.context_management !== null) {
          const context = record(message.context_management)
          onlyKeys(context, ['applied_edits'])
          if (!Array.isArray(context.applied_edits) || context.applied_edits.length)
            throw Error('Unsafe Claude response')
        }
        if (
          message.input_transformations !== undefined &&
          (!Array.isArray(message.input_transformations) || message.input_transformations.length)
        )
          throw Error('Unsafe Claude response')
        if (
          message.type !== 'message' ||
          message.role !== 'assistant' ||
          message.model !== model ||
          typeof message.id !== 'string' ||
          message.id.length > 256 ||
          !message.id ||
          !Array.isArray(message.content) ||
          message.content.length ||
          message.stop_reason !== null ||
          message.stop_sequence !== null
        )
          throw Error('Invalid Claude message')
        started = true
        break
      }
      case 'content_block_start': {
        onlyKeys(value, ['type', 'index', 'content_block'])
        if (!started || stopped || block || value.index !== nextIndex || nextIndex >= 64)
          throw Error('Invalid Claude block order')
        const content = record(value.content_block)
        if (content.type === 'text') {
          onlyKeys(content, ['type', 'text'])
          block = 'text'
          add(content.text, true)
        } else if (content.type === 'thinking') {
          onlyKeys(content, ['type', 'thinking', 'signature'])
          block = 'thinking'
          add(content.thinking, false)
          if (content.signature !== undefined) add(content.signature, false)
        } else throw Error('Unsafe Claude response')
        break
      }
      case 'content_block_delta': {
        onlyKeys(value, ['type', 'index', 'delta'])
        if (!block || stopped || value.index !== nextIndex)
          throw Error('Invalid Claude block order')
        const delta = record(value.delta)
        if (block === 'text' && delta.type === 'text_delta') {
          onlyKeys(delta, ['type', 'text'])
          add(delta.text, true)
        } else if (block === 'thinking' && delta.type === 'thinking_delta') {
          onlyKeys(delta, ['type', 'thinking'])
          add(delta.thinking, false)
        } else if (block === 'thinking' && delta.type === 'signature_delta') {
          onlyKeys(delta, ['type', 'signature'])
          add(delta.signature, false)
        } else throw Error('Unsafe Claude delta')
        break
      }
      case 'content_block_stop':
        onlyKeys(value, ['type', 'index'])
        if (!block || stopped || value.index !== nextIndex)
          throw Error('Invalid Claude block order')
        block = undefined
        nextIndex++
        break
      case 'message_delta': {
        onlyKeys(value, ['type', 'delta', 'usage', 'context_management'])
        if (value.context_management !== undefined && value.context_management !== null) {
          const context = record(value.context_management)
          onlyKeys(context, ['applied_edits'])
          if (!Array.isArray(context.applied_edits) || context.applied_edits.length)
            throw Error('Unsafe Claude response')
        }
        const delta = record(value.delta)
        onlyKeys(delta, ['stop_reason', 'stop_sequence', 'container', 'stop_details'])
        if (
          ['container', 'stop_details'].some(
            (key) => delta[key] !== undefined && delta[key] !== null,
          )
        )
          throw Error('Unsafe Claude response')
        if (
          !started ||
          stopped ||
          block ||
          !nextIndex ||
          delta.stop_reason !== 'end_turn' ||
          delta.stop_sequence !== null
        )
          throw Error('Incomplete Claude message')
        stopped = true
        break
      }
      case 'message_stop':
        onlyKeys(value, ['type'])
        if (!stopped || block) throw Error('Incomplete Claude message')
        ended = true
        break
      default:
        throw Error('Unsupported Claude event')
    }
  }
  if (!ended || !answer) throw Error('Incomplete Claude message')
  return answer
}

export interface ClaudeDecisionGuardAuthority {
  modelId: string
  prompt: string
  current: () => boolean | Promise<boolean>
  dispatch: () => void
}

/** One frozen destination and one inference, with at most one complete-401 native auth recovery. */
export async function createClaudeDecisionResponseGuard(
  upstreamBase: string,
  memory: NativeMemoryAllocator,
  deadlineAt: number,
) {
  const destination = new URL(upstreamBase)
  if (
    destination.username ||
    destination.password ||
    destination.search ||
    destination.hash ||
    (destination.protocol !== 'https:' &&
      !(destination.protocol === 'http:' && destination.hostname === '127.0.0.1'))
  )
    throw Error('Unsupported Claude destination')
  const workspace = memory.reserve(WORKING_BYTES)
  const noncePath = `/${randomUUID()}`,
    path = `${noncePath}/v1/messages`,
    sockets = new Set<Socket>(),
    closures = new Set<Promise<void>>(),
    handlers = new Set<Promise<void>>(),
    abort = new AbortController()
  const facts = {
    forwarded: 0,
    rejectedRequests: 0,
    rejectedResponses: 0,
    acceptedResponses: 0,
    nativeBytes: 0,
    active: 0,
    peakActive: 0,
    upgrades: 0,
    auth401: 0,
    authChanged: false,
    inputBytes: null as number | null,
    physicalReleased: false,
    refusal: undefined as 'request' | 'response' | 'replay' | 'authority' | 'transport' | undefined,
    upstreamStatus: undefined as number | undefined,
    validation: undefined as string | undefined,
  }
  let accepting = true,
    authority: ClaudeDecisionGuardAuthority | undefined,
    bodyDigest: string | undefined,
    headerDigest: string | undefined,
    rejectedCredential: string | undefined,
    recoverable = false,
    usage: SchedulingUsage | undefined,
    answer: string | undefined
  const track = (socket: Socket) => {
    sockets.add(socket)
    const closed = new Promise<void>((resolve) =>
      socket.once('close', () => {
        sockets.delete(socket)
        resolve()
      }),
    )
    closures.add(closed)
    void closed.then(() => closures.delete(closed))
  }
  const stop = () => {
    accepting = false
    abort.abort()
    for (const socket of sockets) socket.destroy()
  }
  const timer = setTimeout(stop, Math.max(0, deadlineAt - Date.now()))
  timer.unref()
  const server = createServer(
    { maxHeaderSize: 16 * 1024, highWaterMark: 16 * 1024 },
    (incoming, outgoing) => {
      const fail = (status = 422) => {
        if (!outgoing.headersSent)
          outgoing.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
        outgoing.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: status === 401 ? 'authentication_error' : 'invalid_request_error',
              message: 'Decision request unavailable.',
            },
          }),
        )
      }
      if (
        !accepting ||
        facts.active ||
        incoming.method !== 'POST' ||
        (incoming.url !== path && incoming.url !== `${path}?beta=true`) ||
        incoming.headers['content-encoding'] !== undefined ||
        incoming.headers.upgrade !== undefined ||
        incoming.headers.cookie !== undefined ||
        incoming.headers['proxy-authorization'] !== undefined
      ) {
        facts.rejectedRequests++
        fail()
        incoming.resume()
        return
      }
      facts.active++
      facts.peakActive = Math.max(facts.peakActive, facts.active)
      const handler = (async () => {
        try {
          facts.refusal = 'request'
          const bytes = await boundedRead(incoming, ENVELOPE_BYTES),
            current = authority
          if (!current) throw Error('Unbound Claude request')
          const validated = requestBody(bytes, current.modelId, current.prompt)
          facts.inputBytes = validated.inputBytes
          const bodyHash = claudeDecisionFingerprint(validated.body),
            stable = Object.fromEntries(
              Object.entries(incoming.headers).filter(
                ([key]) =>
                  ![
                    'authorization',
                    'x-api-key',
                    'x-stainless-retry-count',
                    'x-request-id',
                  ].includes(key),
              ),
            ),
            headersHash = claudeDecisionFingerprint(stable),
            credential = claudeDecisionFingerprint([
              incoming.headers.authorization ?? null,
              incoming.headers['x-api-key'] ?? null,
            ])
          if (!incoming.headers.authorization && !incoming.headers['x-api-key'])
            throw Error('Missing Claude auth')
          facts.refusal = 'replay'
          if (
            (bodyDigest !== undefined && bodyDigest !== bodyHash) ||
            (headerDigest !== undefined && headerDigest !== headersHash) ||
            (facts.forwarded > 0 &&
              !(facts.forwarded === 1 && recoverable && rejectedCredential !== credential))
          )
            throw Error('Claude replay refused')
          facts.refusal = 'authority'
          if (!(await current.current()) || !accepting || Date.now() >= deadlineAt)
            throw Error('Obsolete Claude authority')
          bodyDigest ??= bodyHash
          headerDigest ??= headersHash
          if (facts.forwarded) facts.authChanged = true
          recoverable = false
          const headers = {
            ...incoming.headers,
            host: destination.host,
            connection: 'close',
            'content-length': String(bytes.length),
            'accept-encoding': 'identity',
          }
          delete headers['transfer-encoding']
          const target = new URL(
            `${destination.pathname.replace(/\/$/u, '')}/v1/messages${incoming.url?.endsWith('?beta=true') ? '?beta=true' : ''}`,
            destination,
          )
          const transport = destination.protocol === 'https:' ? httpsRequest : httpRequest
          facts.refusal = 'transport'
          const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
            const request = transport(
              target,
              {
                method: 'POST',
                headers,
                signal: abort.signal,
                agent: false,
                maxHeaderSize: 16 * 1024,
              },
              resolve,
            )
            request.once('socket', track)
            request.once('error', reject)
            request.once('upgrade', (_response, socket) => {
              facts.upgrades++
              socket.destroy()
              request.destroy()
              reject(Error('Claude upstream upgrade'))
            })
            let received = false
            request.once('response', () => {
              received = true
            })
            const closed = new Promise<void>((done) =>
              request.once('close', () => {
                if (!received) reject(Error('Claude upstream closed'))
                done()
              }),
            )
            closures.add(closed)
            void closed.then(() => closures.delete(closed))
            try {
              // The durable receipt is the last synchronous operation before possible dispatch.
              if (!facts.forwarded) current.dispatch()
              facts.forwarded++
              request.end(bytes)
            } catch (error) {
              request.destroy()
              reject(error)
            }
          })
          facts.upstreamStatus = upstream.statusCode
          const bytesOut = await boundedRead(upstream, ENVELOPE_BYTES)
          if (
            upstream.headers['content-encoding'] !== undefined &&
            upstream.headers['content-encoding'] !== 'identity'
          )
            throw Error('Claude response encoding')
          if (upstream.statusCode === 401 && facts.forwarded === 1) {
            facts.auth401++
            rejectedCredential = credential
            recoverable = true
            facts.refusal = undefined
            fail(401)
            return
          }
          facts.refusal = 'response'
          try {
            if (
              upstream.statusCode !== 200 ||
              (upstream.headers['content-type'] !== undefined &&
                !/^text\/event-stream(?:;|$)/iu.test(upstream.headers['content-type']))
            )
              throw Error('Claude response status')
            answer = responseBody(bytesOut, current.modelId, (value) => {
              usage = observedUsage(value, usage)
            })
          } catch (error) {
            facts.rejectedResponses++
            throw error
          }
          if (
            !accepting ||
            abort.signal.aborted ||
            Date.now() >= deadlineAt ||
            !(await current.current())
          )
            throw Error('Obsolete Claude response')
          facts.acceptedResponses++
          facts.refusal = undefined
          outgoing.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
          facts.nativeBytes += bytesOut.length
          outgoing.end(bytesOut)
        } catch (error) {
          const known = new Set([
            'Claude HTTP capacity',
            'Claude SSE capacity',
            'Claude guard release unconfirmed',
            'Claude guard unavailable',
            'Claude input capacity or identity',
            'Claude output capacity',
            'Claude replay refused',
            'Claude response encoding',
            'Claude response status',
            'Claude structure capacity',
            'Extra Claude message',
            'Extra Claude response',
            'Incomplete Claude SSE',
            'Incomplete Claude message',
            'Incomplete Claude response',
            'Invalid Claude SSE',
            'Invalid Claude SSE identity',
            'Invalid Claude block order',
            'Invalid Claude envelope',
            'Invalid Claude guard authority',
            'Invalid Claude message',
            'Invalid Claude request',
            'Invalid Claude text',
            'Missing Claude auth',
            'Obsolete Claude authority',
            'Obsolete Claude response',
            'Unbound Claude request',
            'Unexpected Claude history',
            'Unexpected Claude input',
            'Unexpected Claude system',
            'Unsafe Claude delta',
            'Unsafe Claude response',
            'Unsupported Claude SSE',
            'Unsupported Claude destination',
            'Unsupported Claude event',
            'Unsupported Claude tools',
          ])
          if (
            error instanceof Error &&
            (known.has(error.message) ||
              /^Unsupported Claude envelope:(?:container|context_management|stop_details|input_transformations|citations|cache_control|service_tier|inference_geo|output_tokens_details|other)$/u.test(
                error.message,
              ))
          )
            facts.validation = error.message
          recoverable = false
          accepting = false
          facts.rejectedRequests++
          fail()
        } finally {
          facts.active--
        }
      })()
      handlers.add(handler)
      void handler.finally(() => handlers.delete(handler))
    },
  )
  server.on('connection', track)
  server.on('connect', (_request, socket) => {
    facts.upgrades++
    socket.destroy()
  })
  server.on('upgrade', (_request, socket) => {
    facts.upgrades++
    socket.destroy()
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('dropRequest', (_request, socket) => socket.destroy())
  server.maxConnections = 2
  server.maxRequestsPerSocket = 1
  server.requestTimeout = Math.max(1, deadlineAt - Date.now())
  server.headersTimeout = Math.min(5000, server.requestTimeout)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    clearTimeout(timer)
    stop()
    workspace.release()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Claude guard unavailable')
  let closing: Promise<void> | undefined
  return {
    baseUrl: `http://127.0.0.1:${address.port}${noncePath}`,
    facts,
    port: address.port,
    stopForwarding: stop,
    get usage() {
      return usage ? { ...usage } : undefined
    },
    get answer() {
      return answer
    },
    bind(value: ClaudeDecisionGuardAuthority) {
      if (authority || !accepting || facts.forwarded || !EXACT_MODEL.test(value.modelId))
        throw Error('Invalid Claude guard authority')
      authority = Object.freeze({ ...value })
    },
    close(): Promise<void> {
      closing ??= (async () => {
        clearTimeout(timer)
        stop()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await Promise.all(handlers)
        await Promise.all(closures)
        if (facts.active || sockets.size || handlers.size || closures.size)
          throw Error('Claude guard release unconfirmed')
        authority = undefined
        facts.physicalReleased = true
        workspace.release()
      })()
      return closing
    },
  }
}
