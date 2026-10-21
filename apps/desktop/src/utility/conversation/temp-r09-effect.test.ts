// TEMPORARY R09 effect probe — not part of the delivery; delete before the formal gate.
// Run: pnpm exec vitest run apps/desktop/src/utility/conversation/temp-r09-effect.test.ts
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { DefaultSessionSettings } from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { AgentAnswerAssembler } from './agent-answer-assembler'
import { NATIVE_OWNER_WORKING_BYTES } from './native-working-memory'
import { PactPeerToolServer } from './pact-peer-tool-server'
import { PeerAssistanceTurn } from './peer-assistance-policy'

const migrationsFolder = resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle')
const REQUEST_BYTES = 64 * 1024
const requests = new Set<ClientRequest>()
const temporaryDirectories: string[] = []

function trackRequest(request: ClientRequest): ClientRequest {
  requests.add(request)
  request.once('close', () => requests.delete(request))
  return request
}

interface RpcReply {
  status: number
  body: Record<string, unknown> | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const proposalEvent = (kind: 'review' | 'fact_check') => ({
  agentId: 'codex' as const,
  type: 'peer.assistance.requested' as const,
  turnId: `turn-${kind}`,
  proposalId: randomUUID(),
  targetAgentId: 'claude' as const,
  kind,
})

function postJson(url: string, message: unknown): Promise<RpcReply> {
  return postPayload(url, JSON.stringify(message))
}

function postPayload(url: string, payload: string, chunked = false): Promise<RpcReply> {
  return new Promise((resolveReply, reject) => {
    let settled = false
    const finish = (error?: Error, reply?: RpcReply): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error) reject(error)
      else resolveReply(reply!)
    }
    const request = trackRequest(
      httpRequest(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(chunked ? {} : { 'content-length': Buffer.byteLength(payload) }),
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('error', (error) => finish(error))
          response.on('aborted', () => finish(new Error('The HTTP response was aborted.')))
          response.on('end', () => {
            let body: Record<string, unknown> | undefined
            try {
              const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              body = isRecord(parsed) ? parsed : undefined
            } catch {
              body = undefined
            }
            finish(undefined, { status: response.statusCode ?? 0, body })
          })
        },
      ),
    )
    // A client deadline fails the probe; it must never masquerade as server rejection.
    const deadline = setTimeout(
      () => request.destroy(new Error('HTTP probe deadline exceeded.')),
      5_000,
    )
    request.on('error', (error) => finish(error))
    if (chunked) request.write(payload.slice(0, Math.floor(payload.length / 2)))
    const remaining = chunked ? payload.slice(Math.floor(payload.length / 2)) : payload
    request.end(remaining)
  })
}

let callId = 0

function callTool(url: string, args: unknown, name = 'request_peer_assistance'): Promise<RpcReply> {
  callId += 1
  return postJson(url, {
    jsonrpc: '2.0',
    id: `call-${callId}`,
    method: 'tools/call',
    params: { name, arguments: args },
  })
}

function resultOf(reply: RpcReply): Record<string, unknown> {
  const result = reply.body?.result
  return isRecord(result) ? result : {}
}

function resultText(reply: RpcReply): string | undefined {
  const content = resultOf(reply).content
  if (!Array.isArray(content)) return undefined
  const first: unknown = content[0]
  if (!first || typeof first !== 'object') return undefined
  const text = Reflect.get(first, 'text')
  return typeof text === 'string' ? text : undefined
}

function proposalReceipt(reply: RpcReply): { accepted?: boolean; receipt?: string } | undefined {
  const structured = resultOf(reply).structuredContent
  if (!structured || typeof structured !== 'object') return undefined
  const proposal = Reflect.get(structured, 'pactPeerProposal')
  if (!isRecord(proposal)) return undefined
  const { accepted, receipt } = proposal
  if (typeof accepted !== 'boolean' || typeof receipt !== 'string') return undefined
  return { accepted, receipt }
}

const started: PactPeerToolServer[] = []

async function startServer(
  allowed = true,
): Promise<{ server: PactPeerToolServer; url: string; receipt: string }> {
  const server = new PactPeerToolServer()
  started.push(server)
  const url = await server.start()
  const receipt = server.beginTurn('claude', allowed)
  return { server, url, receipt }
}

function holdConnection(url: string): ClientRequest {
  const request = trackRequest(
    httpRequest(url, { method: 'POST', headers: { 'content-length': '1000' } }),
  )
  request.on('error', () => undefined)
  request.write('{"jsonrpc":"2.0"')
  return request
}

function paddedListRequest(bytes: number): string {
  const empty = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', padding: '' })
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    padding: 'x'.repeat(bytes - Buffer.byteLength(empty)),
  })
  expect(Buffer.byteLength(payload)).toBe(bytes)
  return payload
}

async function expectHttpStatus(url: string, status: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const reply = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
        return reply.status
      },
      { interval: 20, timeout: 2_000 },
    )
    .toBe(status)
}

afterEach(async () => {
  for (const request of requests) request.destroy()
  try {
    await Promise.all(started.splice(0).map((server) => server.dispose()))
  } finally {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    )
  }
})

describe('R09 peer tool server — temporary effect probe', () => {
  it('exposes the tool and validates arguments without consuming root Turn admission', async () => {
    const { server, url, receipt } = await startServer()
    const listed = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = resultOf(listed).tools
    expect(Array.isArray(tools)).toBe(true)
    if (!Array.isArray(tools)) throw new Error('Expected a tools array.')
    const tool: unknown = tools.find(
      (entry: unknown) => isRecord(entry) && entry.name === 'request_peer_assistance',
    )
    if (!isRecord(tool)) throw new Error('Peer Tool was not listed.')
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    })

    const accepted = await callTool(url, { target: 'claude', kind: 'review', reason: 'probe' })
    expect(accepted.status).toBe(200)
    expect(resultOf(accepted).isError).toBe(false)
    expect(resultText(accepted)).toContain('Arguments validated')
    expect(proposalReceipt(accepted)).toEqual({ accepted: true, receipt: server.capabilityReceipt })
    expect(
      server.acceptCompleted({ target: 'claude', kind: 'review', reason: 'probe' }, receipt),
    ).toBe(true)
  })

  it('rejects duplicate root completion, not validated HTTP requests', async () => {
    const { server, url, receipt } = await startServer()
    const first = await callTool(url, { target: 'claude', kind: 'review' })
    expect(proposalReceipt(first)).toEqual({ accepted: true, receipt: server.capabilityReceipt })
    const second = await callTool(url, { target: 'claude', kind: 'review' })
    expect(resultOf(second).isError).toBe(false)
    expect(server.acceptCompleted({ target: 'claude', kind: 'review' }, receipt)).toBe(true)
    expect(server.acceptCompleted({ target: 'claude', kind: 'review' }, receipt)).toBe(false)
  })

  it('mints a fresh receipt for each new Turn', async () => {
    const { server, url, receipt: first } = await startServer()
    await callTool(url, { target: 'claude', kind: 'fact_check' })
    const second = server.beginTurn('claude', true)
    expect(second).not.toBe(first)
    const call = await callTool(url, { target: 'claude', kind: 'review' })
    expect(proposalReceipt(call)).toEqual({ accepted: true, receipt: server.capabilityReceipt })
    expect(server.acceptCompleted({ target: 'claude', kind: 'review' }, first)).toBe(false)
    expect(server.acceptCompleted({ target: 'claude', kind: 'review' }, second)).toBe(true)
  })

  it('rejects wrong targets, disallowed Turns, unknown tools and missing Turns', async () => {
    const { server, url } = await startServer()
    const wrongTarget = await callTool(url, { target: 'codex', kind: 'review' })
    expect(resultText(wrongTarget)).toContain('only request the other Pact Agent')
    server.beginTurn('claude', false)
    const disallowed = await callTool(url, { target: 'claude', kind: 'review' })
    expect(resultText(disallowed)).toContain('unavailable for this routed request')
    const unknown = await callTool(url, { target: 'claude', kind: 'review' }, 'other_tool')
    expect(resultText(unknown)).toContain('Unsupported Pact Tool')
    const bare = new PactPeerToolServer()
    started.push(bare)
    const bareUrl = await bare.start()
    const none = await callTool(bareUrl, { target: 'claude', kind: 'review' })
    expect(resultText(none)).toContain('No active Agent Turn')
  })

  it('recovers concurrency slots when held connections close', async () => {
    const { url } = await startServer()
    const held = [
      holdConnection(url),
      holdConnection(url),
      holdConnection(url),
      holdConnection(url),
    ]
    await expectHttpStatus(url, 429)
    for (const request of held) request.destroy()
    await expectHttpStatus(url, 200)
    const accepted = await callTool(url, { target: 'claude', kind: 'review' })
    expect(accepted.status).toBe(200)
    expect(proposalReceipt(accepted)?.accepted).toBe(true)
  })

  it('accepts exactly 64 KiB and refuses a declared body one byte larger', async () => {
    const { url } = await startServer()
    for (const chunked of [false, true]) {
      // oxlint-disable-next-line no-await-in-loop -- Verify each encoding independently against the same byte budget.
      const accepted = await postPayload(url, paddedListRequest(REQUEST_BYTES), chunked)
      expect(accepted.status).toBe(200)
      expect(Array.isArray(resultOf(accepted).tools)).toBe(true)
    }
    const refused = await postPayload(url, paddedListRequest(REQUEST_BYTES + 1))
    expect(refused.status).toBe(413)
  })

  it('rejects chunked bodies one byte over 64 KiB without leaking slots', async () => {
    const { url } = await startServer()
    for (let index = 0; index < 5; index += 1)
      // oxlint-disable-next-line no-await-in-loop -- Sequential refusals expose leaked slots after more than four requests.
      await expect(
        postPayload(url, paddedListRequest(REQUEST_BYTES + 1), true),
      ).rejects.toMatchObject({ code: 'ECONNRESET' })
    await expectHttpStatus(url, 200)
    const accepted = await callTool(url, { target: 'claude', kind: 'review' })
    expect(accepted.status).toBe(200)
    expect(proposalReceipt(accepted)?.accepted).toBe(true)
  })

  it('reclaims all four slots after the real server timeout', async () => {
    const { url } = await startServer()
    const began = Date.now()
    const held = Array.from({ length: 4 }, () => holdConnection(url))
    const closed = held.map(
      (request) =>
        new Promise<void>((resolveClosed) => {
          request.once('close', resolveClosed)
        }),
    )
    await expectHttpStatus(url, 429)
    // No client destroy or fake clock: closure must come from the server's 10s deadline.
    await Promise.all(closed)
    expect(Date.now() - began).toBeGreaterThanOrEqual(9_500)
    await expectHttpStatus(url, 200)
    const accepted = await callTool(url, { target: 'claude', kind: 'review' })
    expect(proposalReceipt(accepted)?.accepted).toBe(true)
  }, 15_000)

  it('closes the endpoint with dispose', async () => {
    const server = new PactPeerToolServer()
    started.push(server)
    const url = await server.start()
    expect(server.beginTurn('claude', true)).toBeTruthy()
    await server.dispose()
    await expect(callTool(url, { target: 'claude', kind: 'review' })).rejects.toThrow(
      /ECONNREFUSED/u,
    )
  })
})

describe('R09 peer assistance turn — temporary effect probe', () => {
  it('enforces one target and one proposal per Turn', () => {
    const turn = new PeerAssistanceTurn('claude', true)
    expect(turn.accept({ target: 'codex', kind: 'review' })).toMatchObject({ ok: false })
    expect(turn.accept({ target: 'claude', kind: 'review', reason: 'probe' })).toMatchObject({
      ok: true,
    })
    expect(turn.accept({ target: 'claude', kind: 'review' })).toMatchObject({
      ok: false,
      error: 'This answer already has a peer request.',
    })
    expect(turn.receipt).toBeTruthy()
    expect(
      new PeerAssistanceTurn('claude', false).accept({ target: 'claude', kind: 'review' }),
    ).toMatchObject({
      ok: false,
      error: 'Peer assistance is unavailable for this routed request.',
    })
  })
})

describe('R09 proposal durability — temporary effect probe', () => {
  const settings: DefaultSessionSettings = {
    primaryAgentId: 'codex',
    agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
    maxDiscussionRounds: 6,

    maxReviewCycles: 3,
    maxRepairAttempts: 3,
  }

  async function fixture(filePath = ':memory:') {
    const db = await PactDatabase.open({ filePath, migrationsFolder })
    const projectId = randomUUID()
    const sessionId = randomUUID()
    const createdAt = new Date().toISOString()
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Probe',
      kind: 'git',
      directoryPath: '/probe',
      createdAt,
    })
    db.sessionRepository.create({ id: sessionId, projectId, title: 'Probe', createdAt }, settings)
    const repo = db.conversationRepository
    const runStart = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Probe',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    })
    return { db, repo, sessionId, runId: runStart.run.id }
  }

  it('supersedes the pending proposal on retry and replaces it on the next Turn', async () => {
    const f = await fixture()
    try {
      f.repo.applyEvent(f.sessionId, f.runId, proposalEvent('review'))
      const first = f.repo.findRun(f.runId)!.peerProposal
      expect(first).toMatchObject({ state: 'pending', kind: 'review' })
      f.repo.updateAttempt(f.runId, 2, true)
      expect(f.repo.findRun(f.runId)!.peerProposal).toMatchObject({
        id: first!.id,
        state: 'superseded',
      })
      const second = proposalEvent('fact_check')
      f.repo.applyEvent(f.sessionId, f.runId, second)
      expect(f.repo.findRun(f.runId)!.peerProposal).toMatchObject({
        id: second.proposalId,
        state: 'pending',
        kind: 'fact_check',
      })
    } finally {
      f.db.close()
    }
  })

  it('persists pending, superseded and replacement proposals across database reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-r09-probe-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'pact.sqlite')
    const f = await fixture(filePath)
    let db = f.db
    try {
      const first = proposalEvent('review')
      db.conversationRepository.applyEvent(f.sessionId, f.runId, first)
      db.close()
      db = await PactDatabase.open({ filePath, migrationsFolder })
      expect(db.conversationRepository.findRun(f.runId)?.peerProposal).toMatchObject({
        id: first.proposalId,
        state: 'pending',
        kind: 'review',
      })
      db.conversationRepository.updateAttempt(f.runId, 2, true)
      db.close()
      db = await PactDatabase.open({ filePath, migrationsFolder })
      expect(db.conversationRepository.findRun(f.runId)?.peerProposal).toMatchObject({
        id: first.proposalId,
        state: 'superseded',
      })
      const second = proposalEvent('fact_check')
      db.conversationRepository.applyEvent(f.sessionId, f.runId, second)
      db.close()
      db = await PactDatabase.open({ filePath, migrationsFolder })
      expect(db.conversationRepository.findRun(f.runId)?.peerProposal).toMatchObject({
        id: second.proposalId,
        state: 'pending',
        kind: 'fact_check',
        targetAgentId: 'claude',
      })
    } finally {
      if (db.isHealthy()) db.close()
    }
  })
})

describe('R09 answer assembler — temporary effect probe', () => {
  it('merges provider items into one logical answer with separators', () => {
    using answer = new AgentAnswerAssembler('run-probe')
    expect(answer.append('a', 'Hello')).toBe('Hello')
    expect(answer.append('b', 'World')).toBe('\n\nWorld')
    expect(answer.append('b', '!')).toBe('!')
    expect(answer.complete('b', 'World!')).toBe('Hello\n\nWorld!')
    expect(answer.complete('b', 'World!')).toBeUndefined()
    expect(answer.finalize()).toBeUndefined()
  })

  it('accepts an answer above the old content ceiling and refuses working-capacity overflow', () => {
    using answer = new AgentAnswerAssembler('run-probe-2')
    const text = 'x'.repeat(1_100_000)
    expect(answer.append('a', text)).toBe(text)
    expect(answer.text).toBe(text)
    expect(() => answer.append('b', 'x'.repeat(NATIVE_OWNER_WORKING_BYTES / 12))).toThrow(
      /working capacity/,
    )
    expect(answer.text).toBe(text)
  })
})
