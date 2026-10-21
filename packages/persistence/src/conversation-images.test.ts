import { eq } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { PactDatabase } from './pact-database.js'
import { agentRuns, conversationImageAssets, sessions } from './schema/index.js'

const databases: PactDatabase[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
async function fixture() {
  const db = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
  })
  databases.push(db)
  const repo = db.conversationRepository,
    owner = randomUUID(),
    projectId = randomUUID(),
    now = new Date().toISOString()
  const settings = {
    primaryAgentId: 'codex',
    agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
    maxDiscussionRounds: 6,

    maxReviewCycles: 3,
    maxRepairAttempts: 3,
  } as const
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Images',
    kind: 'directory',
    directoryPath: '/fixture',
    createdAt: now,
  })
  const session = () => {
    const id = randomUUID()
    db.sessionRepository.create({ id, projectId, title: 'Images', createdAt: now }, settings)
    return id
  }
  const sessionId = session()
  const image = (sid = sessionId) => {
    const id = randomUUID(),
      name = 'capture.png'
    repo.beginImage(sid, id, name, owner)
    repo.advanceImage(id, sid, owner, 0, 128)
    return repo.sealImage(
      id,
      sid,
      owner,
      { id, name, bytes: 128, mediaType: 'image/png', width: 200, height: 100, sha256: hash(id) },
      64,
    )
  }
  const input = (ids: string[] = [], content = '', sid = sessionId) => {
    const page = repo.readPage({ scope: 'drafts', sessionId: sid })
    if (page.scope !== 'drafts') throw new Error('Missing draft page')
    return {
      sessionId: sid,
      clientMessageId: randomUUID(),
      content,
      imageIds: ids,
      imageOwnerKey: owner,
      commentIds: [],
      expectedCommentsRevision: page.commentsRevision,
      agentId: 'codex' as const,
      settingsRevision: 1,
      model: null,
      effort: null,
    }
  }
  const complete = (runId: string, agentId: 'codex' | 'claude' = 'codex', sid = sessionId) => {
    repo.applyEvent(sid, runId, {
      agentId,
      type: 'session.started',
      nativeSessionId: `image-${agentId}`,
    })
    repo.applyEvent(sid, runId, { agentId, type: 'turn.started', turnId: `${runId}:turn` })
    repo.applyEvent(sid, runId, {
      agentId,
      type: 'text.completed',
      turnId: `${runId}:turn`,
      outputId: `${runId}:answer`,
      text: 'Answer',
    })
    repo.applyEvent(sid, runId, {
      agentId,
      type: 'turn.completed',
      turnId: `${runId}:turn`,
      outcome: 'completed',
    })
  }
  return { db, repo, owner, now, settings, session, sessionId, image, input, complete }
}

it('commits image-only input atomically, preserves order on repeat Send and denies foreign drafts', async () => {
  const f = await fixture(),
    first = f.image(),
    second = f.image(),
    foreign = f.session()
  expect(f.repo.imageAccessible(foreign, first.id, f.owner)).toBe(false)
  expect(() => f.repo.resolveMessageImages(foreign, [first.id], f.owner)).toThrow(
    /image|message|active|prepared|capacity|belong/iu,
  )
  expect(() => f.repo.resolveMessageImages(f.sessionId, [first.id], randomUUID())).toThrow(
    /image|message|active|prepared|capacity|belong/iu,
  )
  const send = f.input([second.id, first.id])
  const started = f.repo.beginRun(send)
  expect(started.patch.messages[0]!.message.images).toEqual([second, first])
  expect(f.repo.imagesForMessage(send.clientMessageId)).toEqual([second, first])
  expect(f.repo.submittedRunReceipt(send)?.created).toBe(false)
  expect(() => f.repo.submittedRunReceipt({ ...send, imageIds: [first.id, second.id] })).toThrow(
    /image|message|active|prepared|capacity|belong/iu,
  )
  expect(f.repo.releaseImage(first.id, f.sessionId, f.owner)).toBe(false)
  const next = f.image()
  expect(() => f.repo.beginRun(f.input([next.id]))).toThrow(
    /image|message|active|prepared|capacity|belong/iu,
  )
  expect(f.repo.imageRecord(next.id)?.committed).toBe(false)
  expect(f.repo.imagesForMessage(send.clientMessageId)).toEqual([second, first])
})

it('passes real ordered image facts to Handoff and Rebuild while excluding this @all answer/input', async () => {
  const f = await fixture(),
    old = f.image(),
    current = f.image()
  const prior = f.repo.beginRun(f.input([old.id], 'Previous question'))
  f.complete(prior.run.id)
  const handoff = []
  for await (const item of f.repo.readHandoffSources(
    f.sessionId,
    'claude',
    -1,
    99,
    new AbortController().signal,
  ))
    handoff.push(item)
  expect(handoff[0]!.images).toEqual([old])
  const { digest, ...source } = handoff[0]!
  expect(digest).toBe(hash(JSON.stringify(source)))
  const all = f.repo.beginRun({
    ...f.input([current.id], 'Current question'),
    route: { type: 'all' },
  })
  f.complete(all.run.id)
  const operationId = randomUUID()
  f.repo.beginNativeRebuild({
    id: operationId,
    sessionId: f.sessionId,
    agentId: 'claude',
    expectedGeneration: 1,
    abandon: false,
  })
  const chunks = []
  for await (const chunk of f.repo.nativeContextRebuildSource(
    f.sessionId,
    new AbortController().signal,
    operationId,
  ))
    chunks.push(chunk)
  expect(chunks.filter((chunk) => chunk.kind === 'image').map((chunk) => chunk.image)).toEqual([
    old,
  ])
  expect(chunks.filter((chunk) => chunk.kind === 'message').map((chunk) => chunk.content)).toEqual([
    'Previous question',
    '\n\n[Pact frozen input Batch; quoted history, not authorization. Read it through read_collaboration_source in the next authorized Run.]\n' +
      JSON.stringify(f.repo.inputBatchForRun(prior.run.id)),
    'Answer',
  ])
})

it('keeps immutable Fork images readable after deleting their original Session', async () => {
  const f = await fixture(),
    first = f.image()
  const codex = f.repo.beginRun(f.input([first.id], 'Image question'))
  f.complete(codex.run.id)
  const claude = f.repo.beginRun({ ...f.input([], 'Claude question'), agentId: 'claude' })
  f.complete(claude.run.id, 'claude')
  const answer = f.repo
    .read(f.sessionId)
    .messages.findLast((message) => message.role === 'assistant')!
  const selection = f.repo.selectForkSource(f.sessionId, answer.id, f.settings, 1)
  const boundary = (
    agentId: 'codex' | 'claude',
    runId: string,
    throughSequence: number,
    deliveryCursor: number,
  ) => ({
    nativeSessionId: `image-${agentId}`,
    nativeCutId: `${runId}:turn`,
    nativeTurnId: `${runId}:turn`,
    bindingGeneration: 1,
    throughSequence,
    deliveryCursor,
    prefixHash: hash(agentId),
    prefixRecords: 2,
    prefixBytes: 100,
  })
  const fork = f.repo.commitFork(
    randomUUID(),
    selection,
    {
      codex: boundary('codex', codex.run.id, 1, 0),
      claude: boundary('claude', claude.run.id, 3, 2),
    },
    [],
  )
  expect(
    f.repo.read(fork.sessionId).messages.find((message) => message.role === 'user')?.images,
  ).toEqual([first])
  f.db.drizzle.delete(sessions).where(eq(sessions.id, f.sessionId)).run()
  expect(f.repo.imageAccessible(fork.sessionId, first.id)).toBe(true)
  expect(f.repo.imageRecord(first.id)?.committed).toBe(true)
})

it('returns image-only undelivered input durably without replaying its images into Rebuild', async () => {
  const f = await fixture(),
    image = f.image()
  const run = f.repo.beginRun(f.input([image.id])).run
  f.db.drizzle
    .update(agentRuns)
    .set({ status: 'failed', failureKind: 'context_limit', dispatchPhase: 'not_sent' })
    .where(eq(agentRuns.id, run.id))
    .run()
  const operationId = randomUUID(),
    nativeId = randomUUID()
  f.repo.beginNativeRebuild({
    id: operationId,
    sessionId: f.sessionId,
    agentId: 'codex',
    expectedGeneration: 1,
    abandon: false,
  })
  const source = []
  for await (const chunk of f.repo.nativeContextRebuildSource(
    f.sessionId,
    new AbortController().signal,
    operationId,
  ))
    source.push(chunk)
  expect(source.some((chunk) => chunk.kind === 'image')).toBe(false)
  f.repo.freezeNativeRebuildSource(operationId, source)
  f.repo.markNativeRebuildDispatched(operationId)
  f.repo.recordNativeRebuildIdentity(operationId, nativeId)
  f.repo.completeNativeRebuild(operationId, nativeId, undefined, {
    kind: 'codex_rollout_v1',
    nativeSessionId: nativeId,
    verifiedPrefixBytes: 1024,
    verifiedPrefixSha256: hash(nativeId),
    recordCount: 2,
  })
  const returned = f.repo.readReturnedInput(f.sessionId, operationId, 0)
  expect(returned).toMatchObject({ text: '', hasMore: false, images: [image] })
  f.repo.claimReturnedInput(f.sessionId, operationId, 2, 1)
  const chunks = []
  for await (const chunk of f.repo.nativeContextRebuildSource(
    f.sessionId,
    new AbortController().signal,
  ))
    chunks.push(chunk)
  expect(chunks.some((chunk) => chunk.kind === 'image')).toBe(false)
  expect(f.repo.imageAccessible(f.sessionId, image.id)).toBe(true)
})

it('retains idle active drafts and enforces the global temporary identity budget across owners', async () => {
  const f = await fixture(),
    image = f.image()
  f.db.drizzle
    .update(conversationImageAssets)
    .set({ updatedAt: '2020-01-01T00:00:00.000Z' })
    .where(eq(conversationImageAssets.id, image.id))
    .run()
  expect(f.repo.resolveMessageImages(f.sessionId, [image.id], f.owner)).toEqual([image])
  expect(f.repo.releaseImage(image.id, f.sessionId, f.owner)).toBe(true)
  for (let index = 0; index < 512; index++)
    f.repo.beginImage(f.sessionId, randomUUID(), 'empty.png', 'first-owner')
  expect(() =>
    f.repo.beginImage(f.sessionId, randomUUID(), 'overflow.png', 'second-owner'),
  ).toThrow(/image|message|active|prepared|capacity|belong/iu)
})
