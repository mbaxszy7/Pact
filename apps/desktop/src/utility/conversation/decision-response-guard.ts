import type { Socket } from 'node:net'

import { createHash, randomUUID } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'

import { DECISION_INPUT_BYTES, DECISION_OUTPUT_BYTES, type SchedulingUsage } from '@pact/contracts'

import type { NativeMemoryAllocator } from './native-working-memory'

// No credential/header/body logging. The runtime owner supplies the frozen native authority.
export const DECISION_GUARD_WORKING_BYTES = 6 * 1024 * 1024
const REQUEST_BYTES = 256 * 1024
const RESPONSE_BYTES = 256 * 1024
const FRAME_BYTES = 64 * 1024
const MAX_FRAMES = 256
const SAFE_EVENTS = new Set([
  'response.created',
  'response.in_progress',
  'response.completed',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
])

function json(text: string): unknown {
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
      if (nodes > 8192) throw Error('JSON structure capacity')
    } else if (character === '{' || character === '[') {
      depth++
      nodes++
      if (depth > 32 || nodes > 8192) throw Error('JSON structure capacity')
    } else if (character === '}' || character === ']') depth--
    else if (character === ':' || character === ',') {
      nodes++
      if (nodes > 8192) throw Error('JSON structure capacity')
    }
  }
  return JSON.parse(text)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
type TransportError =
  | 'dns'
  | 'connection_refused'
  | 'connection_reset'
  | 'unreachable'
  | 'timeout'
  | 'tls'
  | 'aborted'
  | 'closed_without_response'
  | 'protocol_upgrade'
  | 'other'
type UpstreamContentType = 'absent' | 'event_stream' | 'json' | 'html' | 'text' | 'other'
type UpstreamContentEncoding = 'absent' | 'identity' | 'gzip' | 'deflate' | 'br' | 'other'

// Never retain the native error code/message or the response header values.
function transportError(cause: unknown): TransportError {
  const code: unknown =
    cause instanceof Error ? Object.getOwnPropertyDescriptor(cause, 'code')?.value : undefined
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'dns'
    case 'ECONNREFUSED':
      return 'connection_refused'
    case 'ECONNRESET':
    case 'EPIPE':
      return 'connection_reset'
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return 'unreachable'
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return 'timeout'
    case 'CERT_HAS_EXPIRED':
    case 'CERT_NOT_YET_VALID':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
      return 'tls'
    case 'ABORT_ERR':
      return 'aborted'
    default:
      return 'other'
  }
}
function contentType(value: unknown): UpstreamContentType {
  if (value === undefined) return 'absent'
  if (typeof value !== 'string') return 'other'
  switch (value.split(';', 1)[0]?.trim().toLowerCase()) {
    case 'text/event-stream':
      return 'event_stream'
    case 'application/json':
    case 'application/problem+json':
      return 'json'
    case 'text/html':
      return 'html'
    case 'text/plain':
      return 'text'
    default:
      return 'other'
  }
}
function contentEncoding(value: unknown): UpstreamContentEncoding {
  if (value === undefined) return 'absent'
  if (typeof value !== 'string') return 'other'
  switch (value.trim().toLowerCase()) {
    case 'identity':
      return 'identity'
    case 'gzip':
      return 'gzip'
    case 'deflate':
      return 'deflate'
    case 'br':
      return 'br'
    default:
      return 'other'
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw Error('Invalid envelope')
  return value
}
/** Freeze every JSON value while treating object-key ordering as semantically identical. */
function requestFingerprint(root: unknown): string {
  const digest = createHash('sha256')
  const visit = (value: unknown) => {
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
    } else digest.update(JSON.stringify(value))
  }
  visit(root)
  return digest.digest('hex')
}
function safeItem(value: unknown): number {
  const item = record(value)
  let outputBytes = 0
  if (item.type === 'message') {
    if (item.role !== 'assistant' || !Array.isArray(item.content)) throw Error('Invalid message')
    for (const raw of item.content) {
      const part = record(raw)
      if (part.type !== 'output_text' || typeof part.text !== 'string')
        throw Error('Invalid content')
      outputBytes += Buffer.byteLength(part.text)
      if (outputBytes > DECISION_OUTPUT_BYTES) throw Error('Invalid content')
    }
  } else if (item.type !== 'reasoning') throw Error('Non-text output item')
  return outputBytes
}

/** Entire response is withheld until its terminal output and every frame pass the allowlist. */
export function validateResponse(
  bytes: Buffer,
  observeUsage?: (usage: SchedulingUsage) => void,
): Buffer {
  if (bytes.length > RESPONSE_BYTES) throw Error('Response capacity')
  let delimiters = 0
  for (let index = 1; index < bytes.length; index++)
    if (
      bytes[index] === 10 &&
      (bytes[index - 1] === 10 || (bytes[index - 1] === 13 && bytes[index - 2] === 10)) &&
      ++delimiters > MAX_FRAMES
    )
      throw Error('Frame capacity')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  // EOF never dispatches an unterminated SSE event. Check before normalization adds delimiters.
  if (!/(?:\r?\n){2}$/u.test(text)) throw Error('Incomplete response')
  const frames = text.split(/\r?\n\r?\n/u).filter(Boolean)
  if (frames.length > MAX_FRAMES) throw Error('Frame capacity')
  let completed = false
  let unsafe = false
  let usage: SchedulingUsage | undefined
  const checkItem = (item: unknown) => {
    try {
      return safeItem(item)
    } catch {
      unsafe = true
      return 0
    }
  }
  const normalized: string[] = []
  for (const frame of frames) {
    if (Buffer.byteLength(frame) > FRAME_BYTES || completed)
      throw Error('Frame capacity or ordering')
    let event: string | undefined
    const data: string[] = []
    for (const line of frame.split(/\r?\n/u)) {
      if (line.startsWith('event:')) {
        if (event) throw Error('Duplicate event')
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      else throw Error('Unknown SSE field')
    }
    if (!event || !data.length) throw Error('Unknown response event')
    if (!SAFE_EVENTS.has(event)) unsafe = true
    const value = record(json(data.join('\n')))
    if (value.type !== event) throw Error('Event mismatch')
    if (value.item !== undefined) checkItem(value.item)
    if (value.part !== undefined) {
      try {
        if (
          !['output_text', 'summary_text', 'reasoning_text'].includes(
            String(record(value.part).type),
          )
        )
          unsafe = true
      } catch {
        unsafe = true
      }
    }
    if (value.response !== undefined) {
      const response = record(value.response)
      if (response.model !== undefined && response.model !== 'gpt-6-luna')
        throw Error('Native response model changed')
      if (!Array.isArray(response.output)) throw Error('Invalid output')
      // Each response snapshot describes the same output, not additional generated text.
      let outputBytes = 0
      for (const item of response.output) outputBytes += checkItem(item)
      if (outputBytes > DECISION_OUTPUT_BYTES) unsafe = true
      if (event === 'response.completed') {
        if (response.status !== 'completed') throw Error('Invalid terminal response')
        completed = true
        if (response.usage && typeof response.usage === 'object') {
          const reported = record(response.usage),
            counts: SchedulingUsage = {}
          if (
            typeof reported.input_tokens === 'number' &&
            Number.isSafeInteger(reported.input_tokens) &&
            reported.input_tokens >= 0
          )
            counts.inputTokens = reported.input_tokens
          if (
            typeof reported.output_tokens === 'number' &&
            Number.isSafeInteger(reported.output_tokens) &&
            reported.output_tokens >= 0
          )
            counts.outputTokens = reported.output_tokens
          if (Object.keys(counts).length) usage = counts
        }
      }
    }
    normalized.push(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
  }
  if (!completed) throw Error('Incomplete response')
  if (usage) observeUsage?.(usage)
  if (unsafe) throw Error('Non-text or unknown response')
  return Buffer.from(normalized.join(''))
}

function localToolSpec(value: unknown): void {
  const tool = record(value)
  if (tool.type === 'namespace') {
    if (!Array.isArray(tool.tools)) throw Error('Invalid namespace')
    for (const nested of tool.tools) localToolSpec(nested)
  } else if (tool.type !== 'function' && tool.type !== 'custom')
    throw Error('Hosted or unknown tool')
}
function validateRequest(bytes: Buffer): { body: Record<string, unknown>; inputBytes: number } {
  const body = record(json(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  const allowedKeys = new Set([
    'model',
    'stream',
    'input',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'reasoning',
    'store',
    'include',
    'prompt_cache_key',
    'text',
    'client_metadata',
    'max_output_tokens',
  ])
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw Error('Unknown request field')
  if (body.model !== 'gpt-6-luna' || body.stream !== true || body.store !== false)
    throw Error('Invalid request identity')
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw Error('Invalid tools')
    for (const spec of body.tools) localToolSpec(spec)
  }
  if (!Array.isArray(body.input)) throw Error('Invalid input')
  let inputBytes = 2,
    inputItems = 0
  for (const raw of body.input) {
    const input = record(raw)
    if (
      input.type !== 'message' &&
      input.type !== 'additional_tools' &&
      !(input.type === undefined && ['system', 'developer', 'user'].includes(String(input.role)))
    )
      throw Error('Unknown request input')
    if (input.type === 'additional_tools') {
      if (!Array.isArray(input.tools)) throw Error('Invalid additional tools')
      for (const tool of input.tools) localToolSpec(tool)
    } else {
      inputBytes += Buffer.byteLength(JSON.stringify(input)) + (inputItems++ ? 1 : 0)
      if (inputBytes > DECISION_INPUT_BYTES) throw Error('Complete native context capacity')
    }
  }
  return { body, inputBytes }
}
async function boundedRead(message: IncomingMessage, limit: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(limit)
  let held = 0
  await new Promise<void>((resolve, reject) => {
    const clear = () => {
      message.off('data', data)
      message.off('end', end)
      message.off('error', error)
      message.off('aborted', aborted)
    }
    const error = (cause: Error) => {
      clear()
      reject(cause)
    }
    const aborted = () => error(Error('Body interrupted'))
    const end = () => {
      clear()
      resolve()
    }
    const data = (chunk: Buffer) => {
      if (held + chunk.length > limit) {
        error(Error('Body capacity'))
        message.destroy()
        return
      }
      chunk.copy(bytes, held)
      held += chunk.length
    }
    message.on('data', data)
    message.once('end', end)
    message.once('error', error)
    message.once('aborted', aborted)
  })
  return bytes.subarray(0, held)
}

/** Frozen destination; no outgoing retries/redirects, websocket, generic forwarding or raw diagnostics. */
export interface DecisionGuardAuthority {
  threadId: string
  accountId: string | null
  routingOverride: 'NO_CONSTRAINT' | 'us' | 'us_cr'
  prompt: string
  current: () => Promise<boolean>
  dispatch: () => void
}

const parseDestination = (value: string) => {
  const parsed = new URL(value)
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'))
  )
    throw Error('Invalid upstream')
  return parsed
}

export async function createDecisionResponseGuard(
  upstreamBase: string | undefined,
  memory: NativeMemoryAllocator,
  deadlineMs = 15_000,
) {
  let destination = upstreamBase === undefined ? undefined : parseDestination(upstreamBase)
  // Includes both raw bodies, UTF-8/JSON/SSE/counting workspace, normalized reply,
  // <=8192 structural/string tokens, HTTP headers and bounded socket queues.
  // The independent App lease owns this allowance until real physical joins.
  const workspace = memory.reserve(DECISION_GUARD_WORKING_BYTES)
  const path = `/${randomUUID()}/v1/responses`
  const sockets = new Set<Socket>()
  const socketClosures = new Set<Promise<void>>()
  const handlers = new Set<Promise<void>>()
  const upstreamClosures = new Set<Promise<void>>()
  const abort = new AbortController()
  const facts = {
    received: 0,
    metadataForwarded: 0,
    inputBytes: null as number | null,
    forwarded: 0,
    rejectedRequests: 0,
    rejectedResponses: 0,
    acceptedResponses: 0,
    nativeBytes: 0,
    upgrades: 0,
    active: 0,
    peakActive: 0,
    auth401: 0,
    authReload401: 0,
    authChanged: false,
    reorderedRequest: false,
    physicalReleased: false,
    // The current upstream attempt replaces these bounded scalar observations.
    transportError: undefined as TransportError | undefined,
    upstreamStatus: undefined as number | undefined,
    upstreamContentType: undefined as UpstreamContentType | undefined,
    upstreamContentEncoding: undefined as UpstreamContentEncoding | undefined,
    refusal: undefined as
      | 'identity'
      | 'body'
      | 'headers'
      | 'authority'
      | 'replay'
      | 'response'
      | undefined,
  }
  let metadataDestination: URL | undefined,
    metadataEnabled = false
  const metadataPath = path.slice(0, -'/v1/responses'.length) + '/metadata/backend-api'
  let accepting = true
  let mayRecover401 = false
  let rejectedAuthDigest: string | undefined
  let authority: DecisionGuardAuthority | undefined
  let requestDigest: string | undefined
  let wireDigest: string | undefined
  let headerDigest: string | undefined
  let usage: SchedulingUsage | undefined
  const deadline = setTimeout(() => {
    accepting = false
    abort.abort()
    for (const socket of sockets) socket.destroy()
  }, deadlineMs)
  deadline.unref()
  const server = createServer(
    { maxHeaderSize: 16 * 1024, highWaterMark: 16 * 1024 },
    (incoming, outgoing) => {
      const handler = (async () => {
        facts.received++
        if (incoming.method === 'GET' && incoming.url === metadataPath + '/wham/accounts/check') {
          const allowedHeaders = new Set([
            'host',
            'authorization',
            'chatgpt-account-id',
            'user-agent',
            'accept',
            'accept-encoding',
            'connection',
            'content-length',
            'x-openai-fedramp',
            'traceparent',
            'tracestate',
            'originator',
            'version',
          ])
          if (
            !accepting ||
            !metadataEnabled ||
            !metadataDestination ||
            facts.active ||
            facts.metadataForwarded >= 4 ||
            Object.keys(incoming.headers).some((name) => !allowedHeaders.has(name)) ||
            typeof incoming.headers.authorization !== 'string' ||
            !incoming.headers.authorization.startsWith('Bearer ') ||
            incoming.headers['transfer-encoding'] !== undefined ||
            (incoming.headers['content-length'] !== undefined &&
              incoming.headers['content-length'] !== '0')
          ) {
            facts.rejectedRequests++
            incoming.socket.destroy()
            return
          }
          facts.active++
          try {
            if ((await boundedRead(incoming, 1)).length) throw Error('Metadata body rejected')
            const target = new URL(metadataDestination.href)
            let base = target.pathname.replace(/\/$/u, '')
            if (
              ['chatgpt.com', 'chat.openai.com'].includes(target.hostname) &&
              !base.includes('/backend-api')
            )
              base += '/backend-api'
            target.pathname =
              base +
              (base.includes('/backend-api') ? '/wham/accounts/check' : '/api/codex/accounts/check')
            const headers = { ...incoming.headers, host: target.host, connection: 'close' }
            delete headers['accept-encoding']
            const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
            const response = await new Promise<IncomingMessage>((resolve, reject) => {
              const request = transport(
                target,
                {
                  method: 'GET',
                  headers,
                  signal: abort.signal,
                  agent: false,
                  maxHeaderSize: 16384,
                },
                resolve,
              )
              const closed = new Promise<void>((done) => request.once('close', done))
              upstreamClosures.add(closed)
              void closed.then(() => upstreamClosures.delete(closed))
              request.once('socket', (socket) => {
                const socketClosed = new Promise<void>((yes) => socket.once('close', yes))
                upstreamClosures.add(socketClosed)
                void socketClosed.then(() => upstreamClosures.delete(socketClosed))
              })
              request.once('error', reject)
              request.once('upgrade', (_reply, socket) => {
                socket.destroy()
                reject(Error('Metadata upgrade rejected'))
              })
              facts.metadataForwarded++
              request.end()
            })
            const body = await boundedRead(response, 64 * 1024)
            if (
              response.statusCode !== 200 ||
              response.headers['content-encoding'] !== undefined ||
              !metadataEnabled ||
              abort.signal.aborted
            )
              throw Error('Metadata unavailable')
            json(new TextDecoder('utf-8', { fatal: true }).decode(body))
            outgoing.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
            outgoing.end(body)
          } catch {
            facts.rejectedRequests++
            incoming.socket.destroy()
          } finally {
            facts.active--
          }
          return
        }
        if (
          !accepting ||
          facts.active ||
          incoming.method !== 'POST' ||
          incoming.url !== path ||
          incoming.headers['content-encoding'] !== undefined ||
          incoming.headers.upgrade !== undefined
        ) {
          facts.rejectedRequests++
          incoming.socket.destroy()
          return
        }
        facts.active++
        facts.peakActive = Math.max(facts.peakActive, facts.active)
        try {
          const bytes = await boundedRead(incoming, REQUEST_BYTES)
          const validated = validateRequest(bytes),
            body = validated.body
          facts.inputBytes = validated.inputBytes
          const current = authority
          if (
            !current ||
            body.prompt_cache_key !== current.threadId ||
            incoming.headers['chatgpt-account-id'] !== (current.accountId ?? undefined) ||
            incoming.headers['x-openai-account-routing-override'] !==
              (current.routingOverride === 'NO_CONSTRAINT' ? undefined : current.routingOverride) ||
            incoming.headers.cookie !== undefined ||
            incoming.headers['proxy-authorization'] !== undefined
          )
            throw Error('Native identity changed')
          const input = body.input
          if (!Array.isArray(input)) throw Error('Invalid input')
          if (
            !input.some((raw: unknown) => {
              const item = record(raw)
              return (
                item.type === 'message' &&
                item.role === 'user' &&
                Array.isArray(item.content) &&
                item.content.some(
                  (part: unknown) =>
                    record(part).type === 'input_text' && record(part).text === current.prompt,
                )
              )
            })
          )
            throw Error('Native input changed')
          const bodyHash = requestFingerprint(body)
          const rawHash = createHash('sha256').update(bytes).digest('hex')
          const stableHeaders = Object.entries(incoming.headers)
            .filter(
              ([name]) =>
                !['authorization', 'traceparent', 'tracestate', 'x-client-request-id'].includes(
                  name,
                ),
            )
            .toSorted(([left], [right]) => left.localeCompare(right))
          const headersHash = createHash('sha256')
            .update(JSON.stringify(stableHeaders))
            .digest('hex')
          if (requestDigest && bodyHash !== requestDigest) throw Error('Native body changed')
          if (headerDigest && headersHash !== headerDigest) throw Error('Native headers changed')
          if (wireDigest && rawHash !== wireDigest) facts.reorderedRequest = true
          if (!(await current.current()) || !accepting || abort.signal.aborted)
            throw Error('Obsolete native authority')
          requestDigest ??= bodyHash
          wireDigest ??= rawHash
          headerDigest ??= headersHash
          const authorization = incoming.headers.authorization
          if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
            throw Error('Missing native auth')
          const digest = createHash('sha256').update(authorization).digest('hex')
          if (
            facts.forwarded &&
            mayRecover401 &&
            facts.forwarded === 1 &&
            digest === rejectedAuthDigest &&
            !facts.authReload401
          ) {
            facts.authReload401++
            outgoing.writeHead(401, { 'content-type': 'application/json' })
            outgoing.end(
              '{"error":{"message":"Authentication required","type":"authentication_error"}}',
            )
            return
          }
          if (
            facts.forwarded &&
            !(mayRecover401 && facts.forwarded === 1 && digest !== rejectedAuthDigest)
          )
            throw Error('No inference replay')
          if (facts.forwarded) {
            mayRecover401 = false
            facts.authChanged = true
          }
          if (!destination) throw Error('Unbound upstream')
          const headers = {
            ...incoming.headers,
            host: destination.host,
            connection: 'close',
            'content-length': String(bytes.length),
          }
          delete headers['transfer-encoding']
          delete headers['accept-encoding']
          const target = new URL(
            `${destination.pathname.replace(/\/$/u, '')}/responses`,
            destination,
          )
          const transport = destination.protocol === 'https:' ? httpsRequest : httpRequest
          const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
            if (!facts.forwarded) current.dispatch()
            facts.forwarded++
            const attempt = facts.forwarded
            facts.transportError = undefined
            facts.upstreamStatus = undefined
            facts.upstreamContentType = undefined
            facts.upstreamContentEncoding = undefined
            let responseSeen = false
            const observeResponse = (response: IncomingMessage) => {
              if (facts.forwarded !== attempt) return
              const status = response.statusCode
              facts.upstreamStatus =
                Number.isInteger(status) && status !== undefined && status >= 100 && status <= 599
                  ? status
                  : undefined
              facts.upstreamContentType = contentType(response.headers['content-type'])
              facts.upstreamContentEncoding = contentEncoding(response.headers['content-encoding'])
            }
            const failed = (cause: unknown) => {
              if (facts.forwarded === attempt) facts.transportError ??= transportError(cause)
              reject(cause)
            }
            let request: ReturnType<typeof transport>
            try {
              request = transport(
                target,
                {
                  method: 'POST',
                  headers,
                  signal: abort.signal,
                  agent: false,
                  maxHeaderSize: 16 * 1024,
                },
                (response) => {
                  responseSeen = true
                  observeResponse(response)
                  response.once('error', failed)
                  resolve(response)
                },
              )
            } catch (cause) {
              failed(cause)
              return
            }
            const closed = new Promise<void>((done) =>
              request.once('close', () => {
                if (!responseSeen) {
                  if (facts.forwarded === attempt)
                    facts.transportError ??= 'closed_without_response'
                  reject(Error('Upstream closed without a response'))
                }
                done()
              }),
            )
            upstreamClosures.add(closed)
            void closed.then(() => upstreamClosures.delete(closed))
            request.once('socket', (socket) => {
              const socketClosed = new Promise<void>((done) => socket.once('close', done))
              upstreamClosures.add(socketClosed)
              void socketClosed.then(() => upstreamClosures.delete(socketClosed))
            })
            request.once('upgrade', (response, socket) => {
              observeResponse(response)
              if (facts.forwarded === attempt) facts.transportError = 'protocol_upgrade'
              // An unsolicited 101 transfers the socket out of ClientRequest.
              // Close that physical socket and reject the response wait explicitly.
              socket.destroy()
              request.destroy()
              reject(Error('Upstream protocol upgrade refused'))
            })
            request.once('error', failed)
            request.end(bytes)
          })
          if (upstream.statusCode === 401 && facts.forwarded === 1) {
            await boundedRead(upstream, 4096)
            facts.auth401++
            mayRecover401 = true
            rejectedAuthDigest = digest
            outgoing.writeHead(401, { 'content-type': 'application/json' })
            outgoing.end(
              '{"error":{"message":"Authentication required","type":"authentication_error"}}',
            )
            return
          }
          if (
            upstream.statusCode !== 200 ||
            (upstream.headers['content-type'] !== undefined &&
              !upstream.headers['content-type'].startsWith('text/event-stream')) ||
            upstream.headers['content-encoding'] !== undefined
          ) {
            upstream.destroy()
            throw Error('Invalid upstream response')
          }
          let safe: Buffer
          try {
            safe = validateResponse(await boundedRead(upstream, RESPONSE_BYTES), (value) => {
              usage = value
            })
          } catch {
            facts.rejectedResponses++
            throw Error('Unsafe response')
          }
          if (abort.signal.aborted || !accepting) throw Error('Obsolete response')
          facts.acceptedResponses++
          outgoing.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
          facts.nativeBytes += safe.length
          outgoing.end(safe)
        } catch (error) {
          facts.rejectedRequests++
          const reasons: Record<string, NonNullable<typeof facts.refusal>> = {
            'Native identity changed': 'identity',
            'Native body changed': 'body',
            'Native headers changed': 'headers',
            'Obsolete native authority': 'authority',
            'No inference replay': 'replay',
            'Unsafe response': 'response',
          }
          facts.refusal = error instanceof Error ? reasons[error.message] : undefined
          if (!outgoing.headersSent) outgoing.writeHead(502)
          outgoing.end()
        } finally {
          facts.active--
        }
      })()
      handlers.add(handler)
      void handler.then(
        () => handlers.delete(handler),
        () => handlers.delete(handler),
      )
    },
  )
  server.on('connection', (socket) => {
    sockets.add(socket)
    const closed = new Promise<void>((done) =>
      socket.once('close', () => {
        sockets.delete(socket)
        done()
      }),
    )
    socketClosures.add(closed)
    void closed.then(() => socketClosures.delete(closed))
  })
  server.on('upgrade', (_incoming, socket) => {
    facts.upgrades++
    socket.destroy()
  })
  server.on('dropRequest', (_incoming, socket) => socket.destroy())
  server.on('clientError', (_error, socket) => socket.destroy())
  server.maxConnections = 2
  server.maxRequestsPerSocket = 1
  server.requestTimeout = deadlineMs
  server.headersTimeout = Math.min(5_000, deadlineMs)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    clearTimeout(deadline)
    abort.abort()
    workspace.release()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Owned guard unavailable')
  let closing: Promise<void> | undefined
  const stopForwarding = () => {
    accepting = false
    abort.abort()
    clearTimeout(deadline)
    for (const socket of sockets) socket.destroy()
  }
  const close = () => {
    if (closing) return closing
    stopForwarding()
    closing = (async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      // Listener/socket closure is not handler/decoder release. Only a real join
      // permits a future resource owner to release its reservation.
      await Promise.all(handlers)
      await Promise.all(upstreamClosures)
      await Promise.all(socketClosures)
      if (
        facts.active ||
        sockets.size ||
        handlers.size ||
        upstreamClosures.size ||
        socketClosures.size
      )
        throw Error('Guard physical release unconfirmed')
      authority = undefined
      destination = undefined
      metadataDestination = undefined
      facts.physicalReleased = true
      workspace.release()
    })()
    return closing
  }
  return {
    // Base routes only one exact response path. Caller never supplies a destination in an HTTP request.
    baseUrl: `http://127.0.0.1:${address.port}${path.slice(0, -'/responses'.length)}`,
    facts,
    port: address.port,
    metadataBaseUrl: `http://127.0.0.1:${address.port}${metadataPath}`,
    setMetadataDestination(value: string) {
      if (metadataDestination || authority || facts.forwarded) throw Error('Metadata already bound')
      metadataDestination = parseDestination(value)
    },
    metadataPhase(active: boolean) {
      metadataEnabled = active && accepting
    },
    stopForwarding,
    setDestination(value: string) {
      if (destination || authority || facts.forwarded || !accepting)
        throw Error('Upstream already bound')
      destination = parseDestination(value)
    },
    get usage(): SchedulingUsage | undefined {
      return usage ? { ...usage } : undefined
    },
    bind: (value: DecisionGuardAuthority) => {
      if (authority || facts.forwarded || !accepting)
        throw Error('Native authority is already bound')
      authority = Object.freeze({ ...value })
    },
    close,
  }
}
