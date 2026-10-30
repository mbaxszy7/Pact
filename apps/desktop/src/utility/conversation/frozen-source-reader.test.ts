import { createHash, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  collaborationSourceReadResultSchema,
  collaborationSourceWireResultSchema,
  collaborationSourceNativeReadSchema,
  collaborationSourceNativeProofSchema,
  type CollaborationSourceWireRead,
  type CollaborationSourceReadResult,
  sourceReadCallIdentity,
  sourceReadDiagnosticSchema,
  COLLABORATION_PAGE_BYTES,
} from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import { assembleFrozenBatch } from '../../../../../tests/e2e/frozen-batch-evidence.js'
import * as sourceLog from '../../diagnostics/utility-log'
import { FrozenSourceReader, readFrozenSourceTool } from './frozen-source-reader'
import { PactPeerToolServer } from './pact-peer-tool-server'

const databases: PactDatabase[] = []
const readers: FrozenSourceReader[] = []
afterEach(() => {
  for (const reader of readers.splice(0)) reader.retire()
  for (const db of databases.splice(0)) db.close()
})

async function fixture(
  originalBatch = false,
  userInformation?: import('@pact/contracts').UserInformationDeclaration,
) {
  const db = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
  })
  databases.push(db)
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Source reader',
    directoryPath: '/source-reader-fixture',
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Source reader', createdAt },
    {
      primaryAgentId: 'codex',
      agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  const repo = db.conversationRepository
  const content = 'Complete immutable user text αβ🤝\n'.repeat(900)
  const started = repo.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content,
    ...(userInformation ? { userInformation } : {}),
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
  })
  const batch = repo.inputBatchForRun(started.run.id)!
  const body = repo.readFrozenInputBatch(started.run.id, batch.id).body!
  let active = true
  const signal = new AbortController()
  const reader = new FrozenSourceReader(
    { runId: started.run.id, grant: randomUUID() },
    sessionId,
    repo,
    () => active,
    () => batch.id,
    undefined,
    signal.signal,
    originalBatch ? batch.id : undefined,
  )
  readers.push(reader)
  return {
    db,
    repo,
    started,
    batch,
    body,
    reader,
    signal,
    content,
    sessionId,
    retireOwner: () => {
      active = false
    },
  }
}

describe('FrozenSourceReader', () => {
  it('keeps every frozen Comment across bounded transport pages with readable body navigation', async () => {
    const f = await fixture()
    f.repo.applyEvent(f.sessionId, f.started.run.id, {
      agentId: 'codex',
      type: 'turn.completed',
      turnId: 'first-turn',
      outcome: 'completed',
    })
    f.reader.retire()
    const commentIds: string[] = []
    for (let index = 0; index < 100; index++) {
      const commentId = randomUUID()
      commentIds.push(commentId)
      const drafts = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
      if (drafts.scope !== 'drafts') throw Error('Missing draft metadata')
      f.repo.saveCommentDraft({
        mode: 'create',
        sessionId: f.sessionId,
        commentId,
        expectedCommentsRevision: drafts.commentsRevision,
        body: `Comment ${index} αβ🤝`,
        anchor: {
          type: 'message',
          messageId: f.started.run.userMessageId,
          contentHash: createHash('sha256').update(f.content).digest('hex'),
          textBasis: 'markdown-visible-v2',
          startOffset: 0,
          endOffset: 8,
          quote: 'Complete',
        },
      })
    }
    const drafts = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
    if (drafts.scope !== 'drafts') throw Error('Missing draft metadata')
    const next = f.repo.beginRun({
      sessionId: f.sessionId,
      clientMessageId: randomUUID(),
      content: 'Read every Comment.',
      expectedCommentsRevision: drafts.commentsRevision,
      commentIds,
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    })
    const batch = f.repo.inputBatchForRun(next.run.id)!
    const reader = new FrozenSourceReader(
      { runId: next.run.id, grant: randomUUID() },
      f.sessionId,
      f.repo,
      () => true,
      () => batch.id,
    )
    readers.push(reader)
    const captured: Record<'sourceReference' | 'legacy', CollaborationSourceReadResult[]> = {
      sourceReference: [],
      legacy: [],
    }
    for (const form of ['sourceReference', 'legacy'] as const) {
      let request = reader.navigation({ source: 'batch', batchId: batch.id }, form),
        pages = 0
      const seen: string[] = []
      for (;;) {
        const page = reader.read(request).page
        captured[form].push(page)
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(48 * 1024)
        const index: {
          members: Array<{ commentId: string; bodyRead: CollaborationSourceWireRead }>
        } = JSON.parse(page.text)
        expect(index.members.length).toBeLessThanOrEqual(24)
        for (const member of index.members) {
          seen.push(member.commentId)
          expect(reader.read(member.bodyRead).page.text).toBe(`Comment ${seen.length - 1} αβ🤝`)
        }
        pages++
        if (page.nextOffset === null) break
        if (!page.nextRead) throw Error('Missing index continuation')
        request = page.nextRead
      }
      expect(pages).toBeGreaterThan(1)
      expect(seen).toEqual(commentIds)
    }
    const nativeReader = new FrozenSourceReader(
        reader.identity,
        f.sessionId,
        f.repo,
        () => true,
        () => batch.id,
        undefined,
        undefined,
        batch.id,
      ),
      root = { threadId: randomUUID(), turnId: randomUUID() }
    readers.push(nativeReader)
    let nativeRequest: unknown = { context: 'native-root-v1', source: 'root_batch', offset: 0 }
    const nativeComments: string[] = []
    while (nativeRequest) {
      const page = nativeReader.readNativeRoot(nativeRequest, root).page,
        index = JSON.parse(page.text)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(COLLABORATION_PAGE_BYTES)
      for (const member of index.members) {
        expect(member.bodyRead).toEqual({
          context: 'native-root-v1',
          source: 'root_document',
          part: 'comment',
          ordinal: nativeComments.length,
          offset: 0,
        })
        const comment = nativeReader.readNativeRoot(member.bodyRead, root).page
        expect(comment.text).toBe(`Comment ${nativeComments.length} αβ🤝`)
        nativeComments.push(member.commentId)
      }
      nativeRequest = page.nextRead
    }
    expect(nativeComments).toEqual(commentIds)
    const alternating = captured.sourceReference.map(
      (_page, index) => captured[index % 2 ? 'legacy' : 'sourceReference'][index]!,
    )
    expect(
      assembleFrozenBatch(
        { id: batch.id, revision: batch.revision, memberCount: batch.memberCount },
        alternating,
      ).pages,
    ).toHaveLength(captured.sourceReference.length)
  })
  it('borrows the same reader through actual MCP HTTP and retires only its matching root', async () => {
    const f = await fixture(),
      server = new PactPeerToolServer()
    const url = await server.start()
    const legacy = (raw: unknown) => {
      const { binding: _binding, nextRead: _nextRead, ...page } = f.reader.read(raw).page
      return page
    }
    server.beginTurn('claude', false, undefined, false, legacy, f.reader.identity, f.reader)
    const reference = f.reader.navigation(
      { source: 'document', document: f.body },
      'sourceReference',
    )
    const call = async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'read_collaboration_source', arguments: reference },
        }),
        signal: AbortSignal.timeout(2000),
      })
      const value: unknown = await response.json()
      return value
    }
    try {
      expect(await call()).toMatchObject({ result: { content: [{ type: 'text' }] } })
      server.retireSourceReader({ ...f.reader.identity, grant: randomUUID() })
      expect(await call()).toMatchObject({ result: { content: [{ type: 'text' }] } })
      server.retireSourceReader(f.reader.identity)
      expect(await call()).toMatchObject({ result: { isError: true } })
      expect(() => f.reader.read(reference)).toThrow(/retired/u)
    } finally {
      await server.dispose()
    }
  })
  it('uses the primary Repository authorization and preserves complete Unicode with both forms', async () => {
    const f = await fixture()
    const index = f.reader.read(
      f.reader.navigation({ source: 'batch', batchId: f.batch.id }, 'sourceReference'),
    )
    const parsed: { bodyRead: CollaborationSourceWireRead } = JSON.parse(index.page.text)
    expect(index.submitted).toBe('sourceReference')
    expect(Object.keys(parsed.bodyRead).toSorted()).toEqual(['offset', 'sourceReference'])
    for (const form of ['legacy', 'sourceReference'] as const) {
      let request = f.reader.navigation({ source: 'document', document: f.body }, form),
        text = '',
        pages = 0
      for (;;) {
        const result = readFrozenSourceTool(f.reader.identity, request, f.reader, undefined)
        expect(result).toHaveProperty('binding.submitted', form)
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(48 * 1024)
        expect(result.offset).toBe(text.length)
        text += result.text
        pages++
        if (result.nextOffset === null) break
        if (!('nextRead' in result) || !result.nextRead) throw Error('Missing continuation')
        request = result.nextRead
      }
      expect(pages).toBeGreaterThan(1)
      expect(text).toBe(f.content)
      expect(createHash('sha256').update(text).digest('hex')).toBe(f.body.sha256)
    }
    const legacy = f.reader.read({ ...f.reader.identity, source: 'batch', offset: 0 })
    expect(legacy.submitted).toBe('legacy')
    expect(
      collaborationSourceReadResultSchema.parse({
        source: legacy.page.source,
        offset: legacy.page.offset,
        text: legacy.page.text,
        nextOffset: legacy.page.nextOffset,
      }).source,
    ).toBe('batch')
  })

  it('rejects changed fields, mixed forms, wrong roots and all retired callbacks without normalizing requests', async () => {
    const f = await fixture()
    const reference = f.reader.navigation(
      { source: 'document', document: f.body },
      'sourceReference',
    )
    for (const raw of [
      { ...reference, runId: f.reader.identity.runId },
      { ...reference, unexpected: true },
      { ...reference, offset: -1 },
      { sourceReference: reference.sourceReference },
      { ...reference, sourceReference: `${reference.sourceReference}x` },
      { ...f.reader.identity, runId: randomUUID(), document: f.body, offset: 0 },
      { ...f.reader.identity, grant: randomUUID(), document: f.body, offset: 0 },
      { ...f.reader.identity, document: { ...f.body, bytes: f.body.bytes + 1 }, offset: 0 },
      { ...f.reader.identity, document: { ...f.body, chars: f.body.chars + 1 }, offset: 0 },
      { ...f.reader.identity, document: { ...f.body, id: randomUUID() }, offset: 0 },
      { ...f.reader.identity, document: f.body, offset: 0, unexpected: true },
    ])
      expect(() => f.reader.read(raw)).toThrow(/.+/u)
    expect(() => f.reader.navigation({ source: 'batch' }, 'sourceReference')).toThrow(/.+/u)
    expect(() => f.reader.navigation({ source: 'document' }, 'sourceReference')).toThrow(/.+/u)
    const other = await fixture()
    expect(() => other.reader.read(reference)).toThrow(/.+/u)
    f.signal.abort()
    expect(() => f.reader.read(reference)).toThrow(/retired/u)
    expect(() => f.reader.read({ ...f.reader.identity, document: f.body, offset: 0 })).toThrow(
      /retired/u,
    )
    expect(
      other.reader.read(
        other.reader.navigation({ source: 'document', document: other.body }, 'sourceReference'),
      ).page.offset,
    ).toBe(0)
    f.reader.retire()
    other.retireOwner()
    expect(() =>
      other.reader.read(
        other.reader.navigation({ source: 'document', document: other.body }, 'legacy'),
      ),
    ).toThrow(/retired/u)
  })
})

function isTestObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function testObject(value: unknown): Record<string, unknown> {
  if (!isTestObject(value)) throw Error('Expected object')
  return value
}

async function nativeSourceCall(url: string, args: unknown, meta: unknown) {
  const reply = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_collaboration_source', arguments: args, _meta: meta },
    }),
  })
  return testObject(testObject(await reply.json())['result'])
}

function nativeSourceMeta(root: { threadId: string; turnId: string }) {
  return {
    threadId: root.threadId,
    sessionId: 'fork-original-session',
    'x-codex-turn-metadata': {
      thread_id: root.threadId,
      session_id: 'fork-original-session',
      turn_id: root.turnId,
    },
  }
}

it('authenticated native entry keeps complete navigation, pagination and a bound private proof', async () => {
  const f = await fixture(),
    server = new PactPeerToolServer(),
    root = { threadId: randomUUID(), turnId: randomUUID() }
  try {
    server.beginTurn('claude', false, undefined, false, undefined, f.reader.identity, f.reader)
    server.bindNativeSourceRoot(
      f.reader.identity,
      { ...root, executorId: randomUUID() },
      () => true,
    )
    const url = await server.start(),
      args = f.reader.navigation({ source: 'batch', batchId: f.batch.id }, 'nativeRoot')
    expect(() => f.reader.read(args)).toThrow(/Unrecognized key/u)
    expect(() => readFrozenSourceTool(f.reader.identity, args, f.reader, undefined)).toThrow(
      /Unrecognized key/u,
    )
    const reply = await nativeSourceCall(url, args, nativeSourceMeta(root)),
      content = reply['content']
    expect(reply['isError']).not.toBe(true)
    if (!Array.isArray(content)) throw Error('Missing native source content')
    const page = collaborationSourceWireResultSchema.parse(
        JSON.parse(String(testObject(content[0])['text'])),
      ),
      proof = collaborationSourceNativeProofSchema.parse(
        testObject(reply['_meta'])['pactSourceRoot'],
      )
    expect(proof).toMatchObject({
      root,
      callerRunId: f.reader.identity.runId,
      requestSha256: createHash('sha256')
        .update(JSON.stringify(collaborationSourceNativeReadSchema.parse(args)))
        .digest('hex'),
      pageSha256: createHash('sha256').update(JSON.stringify(page)).digest('hex'),
    })
    expect(Buffer.byteLength(JSON.stringify({ page, proof }))).toBeLessThanOrEqual(48 * 1024)
    let request: unknown = testObject(JSON.parse(page.text))['bodyRead'],
      text = '',
      pages = 0
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- Each page supplies the next authenticated cursor.
      const next = await nativeSourceCall(url, request, nativeSourceMeta(root)),
        parts = next['content']
      if (!Array.isArray(parts)) throw Error('Missing native body content')
      const value = collaborationSourceWireResultSchema.parse(
        JSON.parse(String(testObject(parts[0])['text'])),
      )
      expect(value.binding).toMatchObject({ submitted: 'nativeRoot', nativeRoot: root })
      expect(value.offset).toBe(text.length)
      text += value.text
      pages++
      if (value.nextOffset === null) break
      expect(value.nextRead).toMatchObject({ context: 'native-root-v1', offset: text.length })
      request = value.nextRead
    }
    expect(pages).toBeGreaterThan(1)
    expect(text).toBe(f.content)
    expect(createHash('sha256').update(text).digest('hex')).toBe(f.body.sha256)
    expect(() =>
      server.bindNativeSourceRoot(
        f.reader.identity,
        { ...root, executorId: randomUUID() },
        () => true,
      ),
    ).toThrow(/cannot be bound/u)
  } finally {
    await server.dispose()
  }
})

it.each([
  'missing-meta',
  'wrong-outer',
  'wrong-inner',
  'old-turn',
  'child-thread',
  'string-inner',
  'oversized-id',
  'argument-meta',
  'mixed-grant',
  'mixed-run',
  'mixed-reference',
  'before-ack',
  'cancelled',
  'disconnected',
  'disposed',
] as const)('native source refuses %s before invoking its reader', async (kind) => {
  const f = await fixture(),
    server = new PactPeerToolServer(),
    root = { threadId: randomUUID(), turnId: randomUUID() },
    read = vi.spyOn(f.reader, 'readNativeRoot'),
    meta: Record<string, unknown> = nativeSourceMeta(root),
    args: Record<string, unknown> = {
      context: 'native-root-v1',
      source: 'batch',
      batchId: f.batch.id,
      offset: 0,
    }
  let current = true
  try {
    server.beginTurn('claude', false, undefined, false, undefined, f.reader.identity, f.reader)
    if (kind !== 'before-ack')
      server.bindNativeSourceRoot(
        f.reader.identity,
        { ...root, executorId: randomUUID() },
        () => current,
      )
    const url = await server.start()
    if (kind === 'wrong-outer') meta['threadId'] = randomUUID()
    if (kind === 'wrong-inner')
      testObject(meta['x-codex-turn-metadata'])['thread_id'] = randomUUID()
    if (kind === 'old-turn') testObject(meta['x-codex-turn-metadata'])['turn_id'] = randomUUID()
    if (kind === 'child-thread') {
      meta['threadId'] = randomUUID()
      testObject(meta['x-codex-turn-metadata'])['thread_id'] = meta['threadId']
    }
    if (kind === 'string-inner')
      meta['x-codex-turn-metadata'] = JSON.stringify(meta['x-codex-turn-metadata'])
    if (kind === 'oversized-id') {
      meta['threadId'] = 'x'.repeat(1025)
      testObject(meta['x-codex-turn-metadata'])['thread_id'] = meta['threadId']
    }
    if (kind === 'argument-meta') args['_meta'] = nativeSourceMeta(root)
    if (kind === 'mixed-grant') args['grant'] = f.reader.identity.grant
    if (kind === 'mixed-run') args['runId'] = f.reader.identity.runId
    if (kind === 'mixed-reference')
      args['sourceReference'] = f.reader.navigation(
        { source: 'batch', batchId: f.batch.id },
        'sourceReference',
      ).sourceReference
    if (kind === 'cancelled' || kind === 'disconnected') current = false
    if (kind === 'disposed') server.retireSourceReader(f.reader.identity)
    const reply = await nativeSourceCall(
      url,
      args,
      kind === 'missing-meta' || kind === 'argument-meta' ? undefined : meta,
    )
    expect(reply['isError']).toBe(true)
    expect(read).not.toHaveBeenCalled()
    let lateAckRefused = false
    if (kind === 'before-ack') {
      server.retireSourceReader(f.reader.identity)
      try {
        server.bindNativeSourceRoot(
          f.reader.identity,
          { ...root, executorId: randomUUID() },
          () => true,
        )
      } catch {
        lateAckRefused = true
      }
    }
    expect(lateAckRefused).toBe(kind === 'before-ack')
  } finally {
    await server.dispose()
  }
})

it('native Root retirement cannot adopt or revoke a replacement owner', async () => {
  const old = await fixture(),
    next = await fixture(),
    server = new PactPeerToolServer(),
    root = { threadId: randomUUID(), turnId: randomUUID() }
  const oldRead = vi.spyOn(old.reader, 'readNativeRoot'),
    nextRead = vi.spyOn(next.reader, 'readNativeRoot')
  try {
    server.beginTurn('claude', false, undefined, false, undefined, old.reader.identity, old.reader)
    server.bindNativeSourceRoot(
      old.reader.identity,
      { ...root, executorId: randomUUID() },
      () => true,
    )
    const url = await server.start(),
      oldArgs = old.reader.navigation({ source: 'batch', batchId: old.batch.id }, 'nativeRoot')
    server.retireSourceReader(old.reader.identity)
    const nextRoot = { threadId: root.threadId, turnId: randomUUID() }
    server.beginTurn(
      'claude',
      false,
      undefined,
      false,
      undefined,
      next.reader.identity,
      next.reader,
    )
    server.bindNativeSourceRoot(
      next.reader.identity,
      { ...nextRoot, executorId: randomUUID() },
      () => true,
    )
    server.retireSourceReader(old.reader.identity)
    expect(() =>
      server.bindNativeSourceRoot(
        old.reader.identity,
        { ...root, executorId: randomUUID() },
        () => true,
      ),
    ).toThrow(/cannot be bound/u)
    expect((await nativeSourceCall(url, oldArgs, nativeSourceMeta(root)))['isError']).toBe(true)
    expect(oldRead).not.toHaveBeenCalled()
    expect(nextRead).not.toHaveBeenCalled()
    const args = next.reader.navigation({ source: 'batch', batchId: next.batch.id }, 'nativeRoot')
    expect((await nativeSourceCall(url, args, nativeSourceMeta(nextRoot)))['isError']).not.toBe(
      true,
    )
    expect(nextRead).toHaveBeenCalledOnce()
  } finally {
    await server.dispose()
  }
})

it('native authentication preserves Repository document authorization and refuses old grant forms', async () => {
  const f = await fixture(),
    server = new PactPeerToolServer(),
    root = { threadId: randomUUID(), turnId: randomUUID() },
    bodyRead = vi.spyOn(f.repo, 'readPage')
  try {
    server.beginTurn('claude', false, undefined, false, undefined, f.reader.identity, f.reader)
    server.bindNativeSourceRoot(
      f.reader.identity,
      { ...root, executorId: randomUUID() },
      () => true,
    )
    const url = await server.start(),
      meta = nativeSourceMeta(root)
    const badDoc = { ...f.body, id: randomUUID() }
    const denied = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'read_collaboration_source',
          arguments: { context: 'native-root-v1', source: 'document', document: badDoc, offset: 0 },
          _meta: meta,
        },
      }),
    })
    expect(testObject(await denied.json())).toHaveProperty('error')
    expect(bodyRead).not.toHaveBeenCalled()
    const read = vi.spyOn(f.reader, 'readNativeRoot'),
      legacy = f.reader.navigation({ source: 'batch', batchId: f.batch.id }, 'legacy')
    const refused = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'read_collaboration_source',
          arguments: { ...legacy, grant: randomUUID() },
          _meta: meta,
        },
      }),
    })
    expect(testObject(await refused.json())).toHaveProperty('error')
    expect(read).not.toHaveBeenCalled()
  } finally {
    await server.dispose()
  }
})

it.each(['replacement', 'dispose'] as const)(
  'an HTTP request admitted before %s cannot borrow its successor source reader',
  async (action) => {
    const old = await fixture(),
      next = await fixture(),
      server = new PactPeerToolServer(),
      root = { threadId: randomUUID(), turnId: randomUUID() },
      nextRoot = { threadId: randomUUID(), turnId: randomUUID() },
      oldRead = vi.spyOn(old.reader, 'readNativeRoot'),
      nextRead = vi.spyOn(next.reader, 'readNativeRoot')
    let closing: Promise<void> | undefined
    try {
      server.beginTurn(
        'claude',
        false,
        undefined,
        false,
        undefined,
        old.reader.identity,
        old.reader,
      )
      server.bindNativeSourceRoot(
        old.reader.identity,
        { ...root, executorId: randomUUID() },
        () => true,
      )
      const url = await server.start(),
        body = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'read_collaboration_source',
            arguments: {
              context: 'native-root-v1',
              source: 'batch',
              batchId: next.batch.id,
              offset: 0,
            },
            _meta: nativeSourceMeta(nextRoot),
          },
        })
      const { promise: response, resolve: finish, reject: fail } = Promise.withResolvers<unknown>()
      const request = httpRequest(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (reply) => {
          const chunks: Buffer[] = []
          reply.on('data', (chunk: Buffer) => chunks.push(chunk))
          reply.once('end', () => {
            try {
              finish(JSON.parse(Buffer.concat(chunks).toString()))
            } catch (error) {
              fail(error instanceof Error ? error : Error('Invalid response'))
            }
          })
        },
      )
      request.once('error', fail)
      request.write(body.slice(0, 10))
      await vi.waitFor(() => expect(Reflect.get(server, 'activeRequests')).toBe(1))
      if (action === 'dispose') closing = server.dispose()
      else {
        server.retireSourceReader(old.reader.identity)
        server.beginTurn(
          'claude',
          false,
          undefined,
          false,
          undefined,
          next.reader.identity,
          next.reader,
        )
        server.bindNativeSourceRoot(
          next.reader.identity,
          { ...nextRoot, executorId: randomUUID() },
          () => true,
        )
      }
      request.end(body.slice(10))
      expect(testObject(testObject(await response)['result'])['isError']).toBe(true)
      expect(oldRead).not.toHaveBeenCalled()
      expect(nextRead).not.toHaveBeenCalled()
      await closing
    } finally {
      await server.dispose()
    }
  },
)

it('root_batch freezes the original selection independently from the legacy default', async () => {
  const f = await fixture(),
    root = { threadId: randomUUID(), turnId: randomUUID() },
    later = randomUUID(),
    reader = new FrozenSourceReader(
      f.reader.identity,
      f.sessionId,
      f.repo,
      () => true,
      () => later,
      undefined,
      undefined,
      f.batch.id,
    )
  readers.push(reader)
  const request = { context: 'native-root-v1', source: 'root_batch', offset: 0 }
  expect(reader.navigation({ source: 'batch', batchId: f.batch.id }, 'nativeRoot')).toEqual(request)
  expect(JSON.parse(reader.readNativeRoot(request, root).page.text).batch.id).toBe(f.batch.id)
  expect(
    reader.readNativeRoot(
      { context: 'native-root-v1', source: 'root_document', part: 'body', offset: 0 },
      root,
    ).page.document,
  ).toEqual(f.body)
  expect(() => reader.read({ ...reader.identity, source: 'batch', offset: 0 })).toThrow(
    /Batch|Run|Unrecognized|Supply only|Invalid/u,
  )
  expect(() =>
    reader.readNativeRoot({ ...request, source: 'batch', batchId: later }, root),
  ).toThrow(/Batch|Run|Unrecognized|Supply only|Invalid/u)
  expect(() => reader.read(request)).toThrow(/Batch|Run|Unrecognized|Supply only|Invalid/u)
  const read = vi.spyOn(f.repo, 'readFrozenInputBatch')
  read.mockClear()
  for (const extra of [
    { batchId: f.batch.id },
    { document: f.body },
    { runId: f.started.run.id },
    { grant: f.reader.identity.grant },
    { sourceReference: 'p1.invalid' },
  ])
    expect(() => reader.readNativeRoot({ ...request, ...extra }, root)).toThrow(
      /Batch|Run|Unrecognized|Supply only|Invalid/u,
    )
  expect(read).not.toHaveBeenCalled()
})

it('missing original capture refuses root_batch despite a valid mutable default', async () => {
  const f = await fixture(),
    root = { threadId: randomUUID(), turnId: randomUUID() }
  expect(() =>
    f.reader.readNativeRoot({ context: 'native-root-v1', source: 'root_batch', offset: 0 }, root),
  ).toThrow(/original Run input Batch/u)
  expect(() =>
    f.reader.readNativeRoot(
      { context: 'native-root-v1', source: 'root_document', part: 'body', offset: 0 },
      root,
    ),
  ).toThrow(/original Run input Batch/u)
  expect(f.reader.navigation({ source: 'batch', batchId: f.batch.id }, 'nativeRoot')).toEqual({
    context: 'native-root-v1',
    source: 'batch',
    batchId: f.batch.id,
    offset: 0,
  })
})

it.each(['valid', 'before-ack', 'wrong-root', 'mixed-correct-batch', 'retired'])(
  'root_batch uses the existing exact Native caller boundary: %s',
  async (mode) => {
    const f = await fixture(true),
      server = new PactPeerToolServer(),
      root = { threadId: randomUUID(), turnId: randomUUID() },
      read = vi.spyOn(f.reader, 'readNativeRoot'),
      args: Record<string, unknown> = { context: 'native-root-v1', source: 'root_batch', offset: 0 }
    try {
      server.beginTurn('claude', false, undefined, false, undefined, f.reader.identity, f.reader)
      if (mode !== 'before-ack')
        server.bindNativeSourceRoot(
          f.reader.identity,
          { ...root, executorId: randomUUID() },
          () => true,
        )
      if (mode === 'mixed-correct-batch') args['batchId'] = f.batch.id
      if (mode === 'retired') server.retireSourceReader(f.reader.identity)
      const url = await server.start(),
        meta = nativeSourceMeta(mode === 'wrong-root' ? { ...root, turnId: randomUUID() } : root),
        reply = await nativeSourceCall(url, args, meta)
      expect(reply['isError'] === true).toBe(mode !== 'valid')
      expect(read.mock.calls.length).toBe(mode === 'valid' ? 1 : 0)
      let checked: { batchId: string; requestSha256: string } | undefined
      if (mode === 'valid') {
        const content = reply['content']
        if (!Array.isArray(content)) throw Error('Missing page')
        const page = collaborationSourceWireResultSchema.parse(
            JSON.parse(String(testObject(content[0])['text'])),
          ),
          proof = collaborationSourceNativeProofSchema.parse(
            testObject(reply['_meta'])['pactSourceRoot'],
          )
        checked = { batchId: JSON.parse(page.text).batch.id, requestSha256: proof.requestSha256 }
      }
      expect(checked).toEqual(
        mode === 'valid'
          ? {
              batchId: f.batch.id,
              requestSha256: createHash('sha256')
                .update(JSON.stringify(collaborationSourceNativeReadSchema.parse(args)))
                .digest('hex'),
            }
          : undefined,
      )
    } finally {
      await server.dispose()
    }
  },
)

it.each([
  ['inputs', 'repository_scope', true],
  ['missing_capture', 'original_capture', true],
  ['wrong_batch', 'repository_scope', true],
  ['wrong_root', 'native_root', false],
  ['native_current', 'native_current', false],
  ['expires_before_read', 'native_current', false],
  ['reader_retired', 'reader_current', true],
  ['page_error', 'page_read', true],
  ['navigation_scope', 'repository_scope', true],
  ['cursor', 'cursor', true],
  ['page_validation', 'page_validation', true],
  ['page_budget', 'page_budget', true],
  ['no_owner', 'entry_owner', false],
  ['schema', 'request_parse', false],
] as const)(
  'native failure facts follow the actual %s boundary without exposing private data',
  async (mode, stage, entered) => {
    const f = await fixture(mode !== 'missing_capture'),
      server = new PactPeerToolServer()
    const root = { threadId: randomUUID(), turnId: randomUUID() },
      callId = randomUUID()
    const privateError = 'PRIVATE_SOURCE_ERROR_CREDENTIAL_' + randomUUID()
    const events: unknown[] = []
    const log = vi.spyOn(sourceLog, 'recordDiagnostic').mockImplementation((event) => {
      events.push(structuredClone(event))
    })
    let current = true,
      currentChecks = 0
    const args: Record<string, unknown> = {
      context: 'native-root-v1',
      source: 'root_batch',
      offset: 0,
    }
    const meta = { ...nativeSourceMeta(root), callId }
    try {
      if (mode === 'inputs') args['source'] = 'inputs'
      if (mode === 'wrong_batch') {
        args['source'] = 'batch'
        args['batchId'] = randomUUID()
      }
      if (mode === 'schema') {
        args['source'] = privateError
        args['offset'] = null
      }
      if (mode === 'wrong_root') meta.threadId = randomUUID()
      if (mode === 'reader_retired') f.retireOwner()
      if (mode === 'page_error' || mode === 'page_validation') {
        args['source'] = 'document'
        args['document'] = f.body
        const original = f.repo.readPage.bind(f.repo)
        vi.spyOn(f.repo, 'readPage').mockImplementation((input) => {
          if (mode === 'page_error') throw Error(privateError)
          const page = original(input)
          return page.scope === 'collaboration-text' ? { ...page, offset: page.offset + 1 } : page
        })
      }
      if (mode === 'navigation_scope')
        vi.spyOn(f.repo, 'sourceDocumentAuthorized').mockReturnValue(false)
      if (mode === 'cursor') {
        const original = f.repo.readFrozenInputBatch.bind(f.repo)
        vi.spyOn(f.repo, 'readFrozenInputBatch').mockImplementation((...input) => {
          const index = original(...input)
          return input[3] ? { ...index, hasMore: true, nextOrdinal: -1 } : index
        })
      }
      if (mode === 'page_budget') {
        const value = f.reader.readNativeRoot(args, root)
        const index = testObject(JSON.parse(value.page.text))
        index['budgetPadding'] = ''
        value.page.text = JSON.stringify(index)
        index['budgetPadding'] = 'x'.repeat(
          COLLABORATION_PAGE_BYTES - Buffer.byteLength(JSON.stringify(value.page)) - 1,
        )
        value.page.text = JSON.stringify(index)
        vi.spyOn(f.reader, 'readNativeRoot').mockReturnValue(value)
      }
      if (mode === 'no_owner') server.beginTurn('claude', false)
      else {
        server.beginTurn('claude', false, undefined, false, undefined, f.reader.identity, f.reader)
        server.bindNativeSourceRoot(
          f.reader.identity,
          { ...root, executorId: randomUUID() },
          () => {
            currentChecks += 1
            return mode === 'expires_before_read' ? currentChecks < 3 : current
          },
        )
      }
      if (mode === 'native_current') current = false
      const target = await server.start()
      const response = await fetch(target, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'read_collaboration_source', arguments: args, _meta: meta },
        }),
      })
      const wire: unknown = await response.json()
      const error = testObject(wire)['error'],
        result = testObject(wire)['result']
      expect(error ? testObject(error)['code'] : testObject(result)['isError']).toBe(
        error ? -32603 : true,
      )
      const failures = events.flatMap((event) =>
        isTestObject(event) && event['sourceRead']
          ? [sourceReadDiagnosticSchema.parse(event['sourceRead'])]
          : [],
      )
      expect(failures).toHaveLength(1)
      const failure = failures[0]!
      expect(failure).toMatchObject({ stage, readerEntered: entered, form: 'nativeRoot' })
      expect(failure.requestSha256).toBe(
        mode === 'schema'
          ? null
          : createHash('sha256')
              .update(JSON.stringify(collaborationSourceNativeReadSchema.parse(args)))
              .digest('hex'),
      )
      expect(failure.nativeCallSha256).toBe(
        createHash('sha256')
          .update(sourceReadCallIdentity(meta.threadId, root.turnId, callId)!)
          .digest('hex'),
      )
      const encoded = JSON.stringify({ failures, wire })
      for (const value of [
        privateError,
        f.reader.identity.grant,
        root.threadId,
        root.turnId,
        callId,
      ])
        expect(encoded).not.toContain(value)
      expect(currentChecks).toBe(
        mode === 'no_owner'
          ? 0
          : mode === 'wrong_root'
            ? 1
            : mode === 'schema' || mode === 'native_current'
              ? 2
              : 3,
      )
    } finally {
      log.mockRestore()
      vi.restoreAllMocks()
      await server.dispose()
    }
  },
)

it('a failing diagnostic writer cannot change the source refusal response', async () => {
  const f = await fixture(true),
    server = new PactPeerToolServer(),
    root = { threadId: randomUUID(), turnId: randomUUID() }
  const log = vi.spyOn(sourceLog, 'recordDiagnostic').mockImplementation(() => {
    throw Error('PRIVATE_WRITER_FAILURE')
  })
  try {
    server.beginTurn('claude', false, undefined, false, undefined, f.reader.identity, f.reader)
    server.bindNativeSourceRoot(
      f.reader.identity,
      { ...root, executorId: randomUUID() },
      () => true,
    )
    const target = await server.start(),
      response = await fetch(target, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'read_collaboration_source',
            arguments: { context: 'native-root-v1', source: 'inputs', offset: 0 },
            _meta: nativeSourceMeta(root),
          },
        }),
      })
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'The peer Tool request failed.' },
    })
  } finally {
    log.mockRestore()
    await server.dispose()
  }
})

it('Native closed failures do not alter legacy and P1 exception identity', async () => {
  const f = await fixture(true),
    root = { threadId: randomUUID(), turnId: randomUUID() }
  const legacy = { ...f.reader.identity, source: 'batch', batchId: f.batch.id, offset: 0 }
  const reference = f.reader.navigation({ source: 'batch', batchId: f.batch.id }, 'sourceReference')
  const original = Error('PRIVATE_REPOSITORY_ERROR')
  const read = vi.spyOn(f.repo, 'readFrozenInputBatch').mockImplementation(() => {
    throw original
  })
  try {
    for (const args of [legacy, reference]) {
      let caught: unknown
      try {
        f.reader.read(args)
      } catch (error) {
        caught = error
      }
      expect(caught).toBe(original)
    }
    let caught: unknown
    try {
      f.reader.readNativeRoot({ context: 'native-root-v1', source: 'root_batch', offset: 0 }, root)
    } catch (error) {
      caught = error
    }
    expect(caught).not.toBe(original)
    expect(String(caught)).not.toContain(original.message)
    expect(caught).toMatchObject({ stage: 'repository_scope', readerEntered: true })
  } finally {
    read.mockRestore()
  }
})

it('current document selectors retain complete Unicode pages, canonical authorization and selector continuations', async () => {
  const f = await fixture(true),
    root = { threadId: randomUUID(), turnId: randomUUID() },
    server = new PactPeerToolServer(),
    authorized = vi.spyOn(f.repo, 'sourceDocumentAuthorized')
  try {
    server.beginTurn('codex', false, undefined, false, undefined, f.reader.identity, f.reader)
    server.bindNativeSourceRoot(
      f.reader.identity,
      { ...root, executorId: randomUUID() },
      () => true,
    )
    const url = await server.start(),
      index = f.reader.readNativeRoot(
        { context: 'native-root-v1', source: 'root_batch', offset: 0 },
        root,
      ).page
    let request: unknown = index.bodyRead,
      text = ''
    expect(request).toEqual({
      context: 'native-root-v1',
      source: 'root_document',
      part: 'body',
      offset: 0,
    })
    while (request) {
      // oxlint-disable-next-line no-await-in-loop -- Each nextRead is issued by the preceding authenticated page.
      const reply = await nativeSourceCall(url, request, nativeSourceMeta(root)),
        content = reply['content']
      if (!Array.isArray(content)) throw Error('Missing document page')
      const page = collaborationSourceWireResultSchema.parse(
          JSON.parse(String(testObject(content[0])['text'])),
        ),
        proof = collaborationSourceNativeProofSchema.parse(
          testObject(reply['_meta'])['pactSourceRoot'],
        )
      expect(page.document).toEqual(f.body)
      expect(page.text.length).toBeLessThanOrEqual(4096)
      expect(Buffer.byteLength(JSON.stringify({ page, proof }))).toBeLessThanOrEqual(
        COLLABORATION_PAGE_BYTES,
      )
      expect(proof.requestSha256).toBe(
        createHash('sha256')
          .update(JSON.stringify(collaborationSourceNativeReadSchema.parse(request)))
          .digest('hex'),
      )
      expect(page.nextRead).toEqual(
        page.nextOffset === null
          ? undefined
          : {
              context: 'native-root-v1',
              source: 'root_document',
              part: 'body',
              offset: page.nextOffset,
            },
      )
      text += page.text
      request = page.nextRead
    }
    expect(text).toBe(f.content)
    expect(createHash('sha256').update(text).digest('hex')).toBe(f.body.sha256)
    expect(authorized).toHaveBeenCalledWith(f.started.run.id, f.body)
    const denied = async (extra: Record<string, unknown>) => {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'read_collaboration_source',
            arguments: { context: 'native-root-v1', source: 'root_document', offset: 0, ...extra },
            _meta: nativeSourceMeta(root),
          },
        }),
      })
      const reply = testObject(await response.json())
      expect(
        reply['error'] !== undefined ||
          (isTestObject(reply['result']) && reply['result']['isError'] === true),
      ).toBe(true)
    }
    for (const extra of [
      { part: undefined },
      { part: 'user_information' },
      { part: 'clarification_answer' },
      { part: 'comment', ordinal: 0 },
      { part: 'comment', ordinal: 1000 },
      { part: 'body', document: f.body },
      { part: 'body', ordinal: 0 },
    ]) {
      expect(() =>
        f.reader.readNativeRoot(
          { context: 'native-root-v1', source: 'root_document', offset: 0, ...extra },
          root,
        ),
      ).toThrow(/Invalid/u)
      // oxlint-disable-next-line no-await-in-loop -- Each denial settles before the next bounded HTTP request.
      await denied(extra)
    }
    const read = vi.spyOn(f.reader, 'readNativeRoot'),
      wrong = await nativeSourceCall(
        url,
        { context: 'native-root-v1', source: 'root_document', part: 'body', offset: 0 },
        nativeSourceMeta({ ...root, turnId: randomUUID() }),
      )
    expect(wrong['isError']).toBe(true)
    expect(read).not.toHaveBeenCalled()
  } finally {
    await server.dispose()
  }
})

it('current declaration selector derives its immutable metadata from the original Repository Batch', async () => {
  const declaration = {
      version: 'user-information-v1' as const,
      id: randomUUID(),
      kind: 'user_supplied_value' as const,
      question: 'What launch date should be used? αβ🤝',
      input: 'text' as const,
      options: [],
      state: { status: 'unanswered' as const },
    },
    f = await fixture(true, declaration),
    root = { threadId: randomUUID(), turnId: randomUUID() },
    index = f.reader.readNativeRoot(
      { context: 'native-root-v1', source: 'root_batch', offset: 0 },
      root,
    ).page,
    request = index.userInformationRead
  expect(request).toEqual({
    context: 'native-root-v1',
    source: 'root_document',
    part: 'user_information',
    offset: 0,
  })
  const page = f.reader.readNativeRoot(request, root).page
  expect(page.document).toEqual(
    f.repo.readFrozenInputBatch(f.started.run.id, f.batch.id).userInformation,
  )
  expect(createHash('sha256').update(page.text).digest('hex')).toBe(page.document!.sha256)
  expect(page.text).toContain(declaration.question)
  expect(page.nextOffset).toBeNull()
  const authorized = vi.spyOn(f.repo, 'sourceDocumentAuthorized').mockReturnValue(false)
  expect(() => f.reader.readNativeRoot(request, root)).toThrow(/repository_scope/u)
  expect(authorized).toHaveBeenCalledWith(f.started.run.id, page.document)
})
