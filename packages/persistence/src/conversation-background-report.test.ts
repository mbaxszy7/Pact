import { eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import {
  isConversationBackgroundReport,
  type AgentRun,
  type AgentNativeForkBoundary,
  type AgentNativeForkWitness,
  type NativeBackgroundReport,
  type NativeContextRebuildChunk,
} from '@pact/contracts'

import { outputTimelineSql } from './conversation-output-snapshots.js'
import { copyLegacyDatabase } from './legacy-database.test-support.js'
import { nativeSessionIssueMetadata } from './native-presence-metadata.js'
import { PactDatabase } from './pact-database.js'
import {
  agentRuns,
  conversationBodyInputs,
  conversationMessages,
  conversationRunSourceRefs,
  nativeAgentContexts,
  nativeRebuildOperations,
  conversationRebuildSourceRefs,
  sessions,
} from './schema/index.js'
import { projectSessionIssues } from './session-issues.js'

const databases: PactDatabase[] = []
const directories: string[] = []
const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(persistent = false, measurePerformance = false) {
  let filePath = ':memory:'
  if (persistent) {
    const directory = await mkdtemp(join(tmpdir(), 'pact-background-report-'))
    directories.push(directory)
    filePath = join(directory, 'pact.sqlite')
  }
  let db = await PactDatabase.open({ filePath, migrationsFolder, measurePerformance })
  databases.push(db)
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    now = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Reports',
    directoryPath: '/fixture/reports',
    kind: 'directory',
    createdAt: now,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Reports', createdAt: now },
    {
      primaryAgentId: 'claude',
      agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
      maxDiscussionRounds: 3,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  const revision = () => {
    const drafts = db.conversationRepository.readPage({ scope: 'drafts', sessionId })
    if (drafts.scope !== 'drafts') throw new Error('Wrong fixture page')
    return drafts.commentsRevision
  }
  const start = (agentId: 'claude' | 'codex' = 'claude', content = 'Original request') =>
    db.conversationRepository.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content,
      expectedCommentsRevision: revision(),
      commentIds: [],
      agentId,
      settingsRevision: 1,
      model: null,
      effort: null,
    }).run
  const finish = (run: AgentRun) => {
    const repo = db.conversationRepository,
      agentId = run.agentId
    const executorId = randomUUID(),
      nativeSessionId = repo.nativeContext(sessionId, agentId)?.nativeSessionId ?? randomUUID(),
      nativeTurnId = randomUUID()
    repo.recordExecutor(run.id, executorId)
    repo.recordDispatch(run.id, 'accepted', nativeSessionId, executorId)
    repo.applyEvent(sessionId, run.id, { type: 'session.started', agentId, nativeSessionId })
    repo.applyEvent(sessionId, run.id, { type: 'turn.started', agentId, turnId: nativeTurnId })
    repo.applyEvent(sessionId, run.id, {
      type: 'text.completed',
      agentId,
      turnId: nativeTurnId,
      outputId: 'root-answer',
      text: 'Original complete reply.',
    })
    repo.applyEvent(sessionId, run.id, {
      type: 'turn.completed',
      agentId,
      turnId: nativeTurnId,
      outcome: 'completed',
    })
    repo.recordNativeEffects(run.id, 'settled')
    return { executorId, nativeSessionId, nativeTurnId }
  }
  const root = start(),
    { executorId, nativeSessionId, nativeTurnId } = finish(root)
  db.conversationRepository.recordNativeEffects(root.id, 'pending')
  const report = (text = 'A complete provider background update.'): NativeBackgroundReport => ({
    agentId: 'claude',
    runId: root.id,
    nativeSessionId,
    nativeTurnId,
    bindingGeneration: 1,
    executorId,
    frameId: randomUUID(),
    nativeMessageId: randomUUID(),
    text,
  })
  return {
    get db() {
      return db
    },
    get repo() {
      return db.conversationRepository
    },
    sessionId,
    root,
    report,
    start,
    finish,
    revision,
    async reopen() {
      db.close()
      databases.splice(databases.indexOf(db), 1)
      db = await PactDatabase.open({ filePath, migrationsFolder, measurePerformance })
      databases.push(db)
    },
  }
}

const parts = (text: string) =>
  async function* (signal: AbortSignal) {
    for (let offset = 0; offset < text.length; offset += 8192) {
      signal.throwIfAborted()
      yield text.slice(offset, offset + 8192)
    }
  }

function refusedInput(f: Awaited<ReturnType<typeof fixture>>) {
  const run = f.start('claude', 'A separate request never delivered to native')
  f.repo.recordDispatch(run.id, 'rejected')
  f.repo.recordNativeEffects(run.id, 'not_dispatched')
  f.repo.failRun(run.id, 'native_session_occupied', 'No input was sent')
  return f.repo.findRun(run.id)!
}

async function freezeRebuild(f: Awaited<ReturnType<typeof fixture>>, operationId: string) {
  const sourceRevisions = new Map<string, number>()
  const chunks: NativeContextRebuildChunk[] = []
  for await (const chunk of f.repo.nativeContextRebuildSource(
    f.sessionId,
    new AbortController().signal,
    operationId,
    sourceRevisions,
  ))
    chunks.push(chunk)
  f.repo.freezeNativeRebuildSource(operationId, chunks, sourceRevisions)
  return chunks
}

it.each(['complete', 'unavailable'] as const)(
  'keeps the yielded version of an incomplete background source when it becomes %s before freeze',
  async (completion) => {
    const f = await fixture(),
      report = f.report(),
      operationId = randomUUID()
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const sealing = f.repo
      .recordBackgroundReport(
        report,
        async function* () {
          entered.resolve()
          await release.promise
          if (completion === 'unavailable') throw new Error('Controlled report seal failure')
          yield report.text
        },
        new AbortController().signal,
      )
      .catch((error: unknown) => {
        f.repo.recordBackgroundReportUnavailable(report)
        return error
      })
    await entered.promise
    try {
      const update = f.repo.read(f.sessionId).messages.find(isConversationBackgroundReport)!
      const capturedRevision = update.contentRevision
      // A Codex candidate leaves the original Claude report's visibility/owner intact.
      f.repo.beginNativeRebuild({
        id: operationId,
        sessionId: f.sessionId,
        agentId: 'codex',
        expectedGeneration: 1,
        expectedRunId: null,
        abandon: false,
      })
      const sourceRevisions = new Map<string, number>()
      const chunks: NativeContextRebuildChunk[] = []
      for await (const chunk of f.repo.nativeContextRebuildSource(
        f.sessionId,
        new AbortController().signal,
        operationId,
        sourceRevisions,
      ))
        chunks.push(chunk)
      expect(chunks.filter((chunk) => chunk.messageId === update.id)).toMatchObject([
        { kind: 'message', state: 'incomplete', content: '' },
      ])
      expect(sourceRevisions.get(update.id)).toBe(capturedRevision)
      release.resolve()
      expect((await sealing) instanceof Error).toBe(completion === 'unavailable')
      const current = f.db.drizzle
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, update.id))
        .get()!
      expect(current).toMatchObject({
        state: completion === 'complete' ? 'complete' : 'incomplete',
        isVisible: true,
      })
      expect(current.contentRevision).toBe(capturedRevision + 1)
      expect(() => f.repo.freezeNativeRebuildSource(operationId, chunks, sourceRevisions)).toThrow(
        /changed/,
      )
      expect(f.repo.nativeRebuildOperation(operationId)?.sourceHash).toBeUndefined()
      expect(
        f.db.drizzle
          .select()
          .from(conversationRebuildSourceRefs)
          .all()
          .filter((row) => row.operationId === operationId),
      ).toEqual([])
      expect(f.repo.internalMessage(update.id, f.sessionId)?.contentRevision).toBe(
        current.contentRevision,
      )
    } finally {
      release.resolve()
      await sealing
    }
  },
)

it('keeps an already frozen incomplete version when its same-hash receipt is replayed after completion', async () => {
  const f = await fixture(),
    report = f.report(),
    operationId = randomUUID()
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const sealing = f.repo.recordBackgroundReport(
    report,
    async function* () {
      entered.resolve()
      await release.promise
      yield report.text
    },
    new AbortController().signal,
  )
  await entered.promise
  try {
    const update = f.repo.read(f.sessionId).messages.find(isConversationBackgroundReport)!
    f.repo.beginNativeRebuild({
      id: operationId,
      sessionId: f.sessionId,
      agentId: 'codex',
      expectedGeneration: 1,
      expectedRunId: null,
      abandon: false,
    })
    const sourceRevisions = new Map<string, number>(),
      chunks: NativeContextRebuildChunk[] = []
    for await (const chunk of f.repo.nativeContextRebuildSource(
      f.sessionId,
      new AbortController().signal,
      operationId,
      sourceRevisions,
    ))
      chunks.push(chunk)
    const hash = f.repo.freezeNativeRebuildSource(operationId, chunks, sourceRevisions)
    const before = f.db.drizzle.select().from(conversationRebuildSourceRefs).all()
    sourceRevisions.clear()
    release.resolve()
    await sealing
    expect(f.repo.internalMessage(update.id, f.sessionId)?.contentRevision).toBe(
      update.contentRevision + 1,
    )
    expect(f.repo.freezeNativeRebuildSource(operationId, chunks, sourceRevisions)).toBe(hash)
    expect(f.db.drizzle.select().from(conversationRebuildSourceRefs).all()).toEqual(before)
    expect(before.find((row) => row.sourceMessageId === update.id)).toMatchObject({
      sourceRevision: update.contentRevision,
      documentsJson: '[]',
    })
  } finally {
    release.resolve()
    await sealing
  }
})

it('refuses a missing source revision without partially freezing the other Message references', async () => {
  const f = await fixture(),
    operationId = randomUUID()
  f.repo.beginNativeRebuild({
    id: operationId,
    sessionId: f.sessionId,
    agentId: 'codex',
    expectedGeneration: 1,
    expectedRunId: null,
    abandon: false,
  })
  const sourceRevisions = new Map<string, number>(),
    chunks: NativeContextRebuildChunk[] = []
  for await (const chunk of f.repo.nativeContextRebuildSource(
    f.sessionId,
    new AbortController().signal,
    operationId,
    sourceRevisions,
  ))
    chunks.push(chunk)
  sourceRevisions.delete(chunks.at(-1)!.messageId)
  expect(() => f.repo.freezeNativeRebuildSource(operationId, chunks, sourceRevisions)).toThrow(
    /revision.*missing/,
  )
  expect(f.repo.nativeRebuildOperation(operationId)?.sourceHash).toBeUndefined()
  expect(
    f.db.drizzle
      .select()
      .from(conversationRebuildSourceRefs)
      .all()
      .filter((row) => row.operationId === operationId),
  ).toEqual([])
})

it('retains the existing 4096-entry bound for revision collection and first freeze', async () => {
  const f = await fixture(),
    operationId = randomUUID()
  f.repo.beginNativeRebuild({
    id: operationId,
    sessionId: f.sessionId,
    agentId: 'codex',
    expectedGeneration: 1,
    expectedRunId: null,
    abandon: false,
  })
  const full = new Map(Array.from({ length: 4096 }, () => [randomUUID(), 0] as const))
  const source = f.repo.nativeContextRebuildSource(
    f.sessionId,
    new AbortController().signal,
    operationId,
    full,
  )
  await expect(source[Symbol.asyncIterator]().next()).rejects.toThrow(/revision map exceeds/)
  expect(full.size).toBe(4096)
  full.set(randomUUID(), 0)
  expect(() => f.repo.freezeNativeRebuildSource(operationId, [], full)).toThrow(
    /revision map exceeds/,
  )
  expect(f.repo.nativeRebuildOperation(operationId)?.sourceHash).toBeUndefined()
})

it.each(['', 'Retained incomplete provider text'])(
  'freezes incomplete report %j without inventing a sealed document',
  async (content) => {
    const f = await fixture(),
      report = f.report(),
      operationId = randomUUID()
    f.repo.recordBackgroundReportUnavailable(report)
    const update = f.repo.read(f.sessionId).messages.find(isConversationBackgroundReport)!
    // Exercise an existing incomplete record as well as a newly admitted empty placeholder.
    if (content)
      f.db.drizzle
        .update(conversationMessages)
        .set({ content })
        .where(eq(conversationMessages.id, update.id))
        .run()
    f.repo.beginNativeRebuild({
      id: operationId,
      sessionId: f.sessionId,
      agentId: 'claude',
      expectedGeneration: 1,
      expectedRunId: f.root.id,
      abandon: true,
    })
    const chunks = await freezeRebuild(f, operationId)
    expect(chunks.find((chunk) => chunk.messageId === update.id)).toMatchObject({
      kind: 'message',
      content,
      state: 'incomplete',
    })
    const ref = f.db.drizzle
      .select()
      .from(conversationRebuildSourceRefs)
      .all()
      .find((row) => row.operationId === operationId && row.sourceMessageId === update.id)!
    expect(JSON.parse(ref.documentsJson)).toEqual([])
    expect(
      f.db.drizzle
        .select()
        .from(conversationBodyInputs)
        .where(eq(conversationBodyInputs.id, update.id))
        .get(),
    ).toBeUndefined()
    expect(f.repo.internalMessage(update.id, f.sessionId)).toMatchObject({
      content,
      state: 'incomplete',
    })
  },
)

it.each([false, true])(
  'returns the latest unsent input across reopen; independent late report=%s',
  async (lateReport) => {
    const f = await fixture(true),
      operationId = randomUUID()
    const refused = refusedInput(f)
    const report = lateReport
      ? f.report('A completed background update after B was refused')
      : undefined
    if (report)
      await f.repo.recordBackgroundReport(report, parts(report.text), new AbortController().signal)
    const updates = f.repo.read(f.sessionId).messages.filter(isConversationBackgroundReport)
    const update = updates[0]
    expect(updates).toMatchObject(
      report
        ? [
            {
              state: 'complete',
              content: report.text,
              sourceMessageId: f.root.userMessageId,
            },
          ]
        : [],
    )
    expect(
      updates.every(
        (message) =>
          message.sequence > f.repo.internalMessage(refused.userMessageId, f.sessionId)!.sequence,
      ),
    ).toBe(true)
    expect(
      f.db.drizzle
        .select()
        .from(conversationMessages)
        .all()
        .filter(isConversationBackgroundReport)
        .map((message) => message.isVisible),
    ).toEqual(report ? [true] : [])
    f.repo.recordNativeEffects(f.root.id, 'unknown')
    const beforeRefused = f.repo.findRun(refused.id)
    const input = {
      id: operationId,
      sessionId: f.sessionId,
      agentId: 'claude' as const,
      expectedGeneration: 1,
      expectedRunId: f.root.id,
      abandon: true,
    }
    f.repo.beginNativeRebuild(input)
    const receipt = f.db.drizzle
      .select()
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, operationId))
      .get()!
    expect(receipt.oldRunId).toBe(f.root.id)
    expect(f.repo.nativeRecoveryRun(f.sessionId, 'claude')?.id).toBe(f.root.id)
    expect(JSON.parse(receipt.returnedInputJson!)).toMatchObject({
      runId: refused.id,
      messageId: refused.userMessageId,
      state: 'prepared',
    })
    const chunks = await freezeRebuild(f, operationId)
    expect(chunks.some((chunk) => chunk.messageId === refused.userMessageId)).toBe(false)
    expect(chunks.some((chunk) => chunk.messageId === f.root.userMessageId)).toBe(true)
    expect(chunks.filter((chunk) => chunk.messageId === update?.id)).toMatchObject(
      report
        ? [
            {
              kind: 'message',
              state: 'complete',
              content: report.text,
            },
          ]
        : [],
    )
    f.repo.markNativeRebuildDispatched(operationId)
    f.repo.recordNativeRebuildIdentity(operationId, 'replacement-native-session')
    f.repo.completeNativeRebuild(operationId, 'replacement-native-session', randomUUID())
    expect(f.repo.findRun(f.root.id)).toMatchObject({
      controlDisposition: 'abandoned',
      nativeEffectsState: 'unknown',
    })
    expect(f.repo.findRun(refused.id)).toEqual(beforeRefused)
    expect(f.repo.rebuildInputRecovery(f.sessionId)).toMatchObject({
      operationId,
      messageId: refused.userMessageId,
      state: 'pending',
    })
    await f.reopen()
    expect(f.repo.read(f.sessionId).messages.filter(isConversationBackgroundReport)).toMatchObject(
      report
        ? [
            {
              id: update!.id,
              state: 'complete',
              content: report.text,
            },
          ]
        : [],
    )
    expect(f.repo.rebuildInputRecovery(f.sessionId)).toMatchObject({
      operationId,
      messageId: refused.userMessageId,
      state: 'pending',
    })
    expect(f.repo.readReturnedInput(f.sessionId, operationId, 0).text).toBe(
      'A separate request never delivered to native',
    )
    expect(() => f.repo.verifyRebuildReceipt(operationId, f.sessionId, 'claude')).not.toThrow()
    expect(() =>
      f.repo.verifyRebuildReceipt(operationId, f.sessionId, 'claude', f.root.id),
    ).not.toThrow()
    expect(() =>
      f.repo.verifyRebuildReceipt(operationId, f.sessionId, 'claude', refused.id),
    ).toThrow(/recovery target/)
    expect(() => f.repo.verifyRebuildReceipt(operationId, f.sessionId, 'claude', null)).toThrow(
      /recovery target/,
    )
    f.repo.beginNativeRebuild(input)
    expect(f.db.drizzle.select().from(nativeRebuildOperations).all()).toHaveLength(1)
    expect(() => f.repo.beginNativeRebuild({ ...input, expectedRunId: refused.id })).toThrow(
      /confirmation belongs|recovery target/i,
    )
    expect(() => f.repo.beginNativeRebuild({ ...input, expectedRunId: null })).toThrow(
      /confirmation belongs|recovery target/i,
    )
  },
)

it.each(['user', 'assistant'] as const)(
  'preserves the later transcript %s guard when freezing a returnable input',
  async (role) => {
    const f = await fixture(),
      refused = refusedInput(f),
      operationId = randomUUID()
    const source = f.repo.internalMessage(refused.userMessageId, f.sessionId)!
    // An existing later input or ordinary reply remains a history boundary.
    // It has a Run and is not an independent background-report Message.
    f.db.drizzle
      .insert(conversationMessages)
      .values({
        id: randomUUID(),
        sessionId: f.sessionId,
        runId: f.root.id,
        role,
        agentId: role === 'assistant' ? 'claude' : null,
        sourceMessageId: null,
        isVisible: true,
        state: 'complete',
        content: 'Later ordinary transcript entry',
        sequence: source.sequence + 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run()
    f.repo.recordNativeEffects(f.root.id, 'unknown')
    f.repo.beginNativeRebuild({
      id: operationId,
      sessionId: f.sessionId,
      agentId: 'claude',
      expectedGeneration: 1,
      expectedRunId: f.root.id,
      abandon: true,
    })
    const receipt = f.db.drizzle
      .select()
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, operationId))
      .get()!
    expect(receipt.returnedInputJson).toBeNull()
    expect(
      f.db.drizzle
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, refused.userMessageId))
        .get()?.isVisible,
    ).toBe(true)
  },
)

it.each(['content', 'dispatch'] as const)(
  'does not return a different or newly uncertain B after its frozen %s facts change',
  async (change) => {
    const f = await fixture(),
      operationId = randomUUID()
    f.repo.recordNativeEffects(f.root.id, 'unknown')
    const refused = refusedInput(f)
    f.repo.beginNativeRebuild({
      id: operationId,
      sessionId: f.sessionId,
      agentId: 'claude',
      expectedGeneration: 1,
      expectedRunId: f.root.id,
      abandon: true,
    })
    await freezeRebuild(f, operationId)
    f.repo.markNativeRebuildDispatched(operationId)
    f.repo.recordNativeRebuildIdentity(operationId, 'replacement-native-session')
    if (change === 'content')
      f.db.drizzle
        .update(conversationMessages)
        .set({ content: 'Changed after freezing', contentRevision: 99 })
        .where(eq(conversationMessages.id, refused.userMessageId))
        .run()
    else
      f.db.drizzle
        .update(agentRuns)
        .set({ dispatchPhase: 'possibly_sent', nativeEffectsState: 'unknown' })
        .where(eq(agentRuns.id, refused.id))
        .run()
    f.repo.completeNativeRebuild(operationId, 'replacement-native-session', randomUUID())
    expect(f.repo.rebuildInputRecovery(f.sessionId)).toBeNull()
    expect(
      f.db.drizzle
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, refused.userMessageId))
        .get()?.isVisible,
    ).toBe(true)
    expect(f.repo.findRun(refused.id)?.controlDisposition).toBe('retained')
    expect(f.repo.findRun(f.root.id)).toMatchObject({
      controlDisposition: 'abandoned',
      nativeEffectsState: 'unknown',
    })
  },
)

it('rolls back Rebuild completion when the saved seed no longer matches its frozen hash', async () => {
  const f = await fixture(),
    operationId = randomUUID()
  f.repo.recordNativeEffects(f.root.id, 'unknown')
  const refused = refusedInput(f)
  f.repo.beginNativeRebuild({
    id: operationId,
    sessionId: f.sessionId,
    agentId: 'claude',
    expectedGeneration: 1,
    expectedRunId: f.root.id,
    abandon: true,
  })
  const chunks = await freezeRebuild(f, operationId)
  f.repo.markNativeRebuildDispatched(operationId)
  f.repo.recordNativeRebuildIdentity(operationId, 'replacement-native-session')
  f.db.drizzle
    .update(nativeRebuildOperations)
    .set({ sourceChunksJson: JSON.stringify(chunks.slice(1)) })
    .where(eq(nativeRebuildOperations.id, operationId))
    .run()
  expect(() =>
    f.repo.completeNativeRebuild(operationId, 'replacement-native-session', randomUUID()),
  ).toThrow(/initialization source cannot be verified/)
  expect(f.repo.findRun(f.root.id)).toMatchObject({
    controlDisposition: 'retained',
    nativeEffectsState: 'unknown',
  })
  expect(f.repo.nativeContext(f.sessionId, 'claude')?.bindingGeneration).toBe(1)
  expect(f.repo.rebuildInputRecovery(f.sessionId)).toBeNull()
  expect(
    f.db.drizzle
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, refused.userMessageId))
      .get()?.isVisible,
  ).toBe(true)
})

it('rejects a stale recovery owner after a newer accepted root and retains the operation nonce scope', async () => {
  const f = await fixture(),
    operationId = randomUUID()
  f.repo.recordNativeEffects(f.root.id, 'settled')
  const next = f.start()
  f.finish(next)
  const input = {
    id: operationId,
    sessionId: f.sessionId,
    agentId: 'claude' as const,
    expectedGeneration: 1,
    expectedRunId: f.root.id,
    abandon: true,
  }
  expect(() => f.repo.beginNativeRebuild(input)).toThrow(/recovery target/i)
  expect(f.repo.nativeRecoveryRun(f.sessionId, 'claude')?.id).toBe(next.id)
  expect(f.db.drizzle.select().from(nativeRebuildOperations).all()).toHaveLength(0)
  expect(f.repo.findRun(f.root.id)?.controlDisposition).toBe('retained')
  f.repo.beginNativeRebuild({ ...input, expectedRunId: next.id })
  f.repo.beginNativeRebuild({ ...input, expectedRunId: next.id })
  expect(() => f.repo.beginNativeRebuild(input)).toThrow(/confirmation belongs|recovery target/i)
  expect(f.db.drizzle.select().from(nativeRebuildOperations).all()).toHaveLength(1)
})

it('keeps the durable recovery cursor when replacing an unconfirmed candidate', async () => {
  const f = await fixture(true),
    first = randomUUID(),
    second = randomUUID()
  f.repo.recordNativeEffects(f.root.id, 'unknown')
  const refused = refusedInput(f)
  const input = {
    sessionId: f.sessionId,
    agentId: 'claude' as const,
    expectedGeneration: 1,
    expectedRunId: f.root.id,
    abandon: true,
  }
  f.repo.beginNativeRebuild({ ...input, id: first })
  await freezeRebuild(f, first)
  f.repo.markNativeRebuildDispatched(first)
  f.repo.recordNativeRebuildIdentity(first, 'unconfirmed-candidate')
  f.repo.failNativeRebuild(first, 'Candidate initialization was not confirmed')
  await f.reopen()
  expect(f.repo.isCurrentBackgroundCursor(f.root.id)).toBe(false)
  expect(f.repo.ownsBackgroundControl(f.root.id)).toBe(false)
  expect(f.repo.nativeRecoveryRun(f.sessionId, 'claude')?.id).toBe(f.root.id)
  f.repo.beginNativeRebuild({ ...input, id: second })
  const rows = f.db.drizzle.select().from(nativeRebuildOperations).all()
  expect(rows.find((row) => row.id === first)?.stage).toBe('superseded')
  expect(rows.find((row) => row.id === second)?.oldRunId).toBe(f.root.id)
  expect(JSON.parse(rows.find((row) => row.id === second)!.returnedInputJson!)).toMatchObject({
    runId: refused.id,
  })
})

it('does not reuse an older recovery cursor across an intervening uncertain native dispatch', async () => {
  const f = await fixture(),
    first = refusedInput(f),
    latest = refusedInput(f)
  f.db.drizzle
    .update(agentRuns)
    .set({ dispatchPhase: 'possibly_sent', nativeEffectsState: 'unknown' })
    .where(eq(agentRuns.id, first.id))
    .run()
  expect(() =>
    f.repo.beginNativeRebuild({
      id: randomUUID(),
      sessionId: f.sessionId,
      agentId: 'claude',
      expectedGeneration: 1,
      expectedRunId: f.root.id,
      abandon: true,
    }),
  ).toThrow(/recovery target/i)
  expect(f.db.drizzle.select().from(nativeRebuildOperations).all()).toHaveLength(0)
  expect(f.repo.nativeRecoveryRun(f.sessionId, 'claude')?.id).toBe(latest.id)
})

it('includes the complete visible background source in ordinary cross-agent Handoff', async () => {
  const f = await fixture(),
    report = f.report()
  await f.repo.recordBackgroundReport(report, parts(report.text), new AbortController().signal)
  const update = f.repo.read(f.sessionId).messages.find(isConversationBackgroundReport)!
  expect(update).toMatchObject({
    state: 'complete',
    content: report.text,
    sourceMessageId: f.root.userMessageId,
  })
  const page = f.repo.readHandoffPage(f.sessionId, 'codex', -1, update.sequence)
  expect(page.messages.map((message) => message.messageId)).toContain(update.id)
  const sources = []
  for await (const source of f.repo.readHandoffSources(
    f.sessionId,
    'codex',
    -1,
    update.sequence,
    new AbortController().signal,
  ))
    sources.push(source)
  expect(sources.find((source) => source.messageId === update.id)).toMatchObject({
    content: report.text,
    speaker: 'claude',
    handledBy: 'claude',
  })
  const received = f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: randomUUID(),
    content: 'Use the update',
    expectedCommentsRevision: f.revision(),
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
    handoffSourceRefs: sources.map(({ messageId, contentRevision, digest }) => ({
      id: messageId,
      revision: contentRevision,
      digest,
    })),
  })
  expect(received.run.handoffMessageCount).toBe(sources.length)
  const frozen = f.db.drizzle
    .select()
    .from(conversationRunSourceRefs)
    .all()
    .find((row) => row.runId === received.run.id && row.sourceMessageId === update.id)!
  const documents: unknown = JSON.parse(frozen.documentsJson)
  expect(documents).toEqual([
    {
      key: 'message',
      source: {
        id: update.id,
        sha256: createHash('sha256').update(report.text).digest('hex'),
        bytes: Buffer.byteLength(report.text),
        chars: report.text.length,
      },
    },
  ])
  expect(await f.repo.readRunHandoff(received.run.id, new AbortController().signal)).toEqual(
    sources,
  )
})

it('preserves an admitted incomplete report through interrupted sealing and cold reopen', async () => {
  const f = await fixture(true),
    report = f.report('Background text '.repeat(1500))
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    controller = new AbortController()
  const pending = f.repo.recordBackgroundReport(
    report,
    async function* (signal) {
      entered.resolve()
      await release.promise
      signal.throwIfAborted()
      yield report.text
    },
    controller.signal,
  )
  const result = pending.catch((error: unknown) => error)
  await entered.promise
  const update = f.repo.read(f.sessionId).messages.find(isConversationBackgroundReport)
  controller.abort()
  release.resolve()
  expect(await result).toBeInstanceOf(Error)
  expect(update).toMatchObject({ state: 'incomplete', sourceMessageId: f.root.userMessageId })
  await f.reopen()
  expect(f.repo.read(f.sessionId).messages.find(isConversationBackgroundReport)).toMatchObject({
    id: update!.id,
    state: 'incomplete',
  })
  expect(f.repo.findRun(f.root.id)?.nativeEffectsState).toBe('pending')
  const before = f.db.drizzle.select().from(conversationBodyInputs).all().length
  await f.repo.recordBackgroundReport(
    { ...report, text: 'Changed replay' },
    parts('Changed replay'),
    new AbortController().signal,
  )
  expect(f.repo.internalMessage(update!.id, f.sessionId)?.state).toBe('incomplete')
  expect(f.db.drizzle.select().from(conversationBodyInputs).all()).toHaveLength(before)
})

it('refuses a required visible report with a missing immutable carrier instead of omitting it', async () => {
  const f = await fixture(),
    report = f.report()
  await f.repo.recordBackgroundReport(report, parts(report.text), new AbortController().signal)
  const update = f.repo.read(f.sessionId).messages.find(isConversationBackgroundReport)!
  f.db.drizzle.delete(conversationBodyInputs).where(eq(conversationBodyInputs.id, update.id)).run()
  expect(() => f.repo.readHandoffPage(f.sessionId, 'codex', -1, update.sequence)).toThrow(
    /immutable background update/,
  )
  const operationId = randomUUID()
  f.repo.beginNativeRebuild({
    id: operationId,
    sessionId: f.sessionId,
    agentId: 'claude',
    expectedGeneration: 1,
    expectedRunId: f.root.id,
    abandon: true,
  })
  const sourceRevisions = new Map<string, number>()
  const chunks: NativeContextRebuildChunk[] = []
  for await (const chunk of f.repo.nativeContextRebuildSource(
    f.sessionId,
    new AbortController().signal,
    operationId,
    sourceRevisions,
  ))
    chunks.push(chunk)
  expect(() => f.repo.freezeNativeRebuildSource(operationId, chunks, sourceRevisions)).toThrow(
    /immutable background update/,
  )
  expect(f.repo.nativeRebuildOperation(operationId)?.sourceHash).toBeUndefined()
})

it('fences visibility and Session activity when a report is superseded during sealing', async () => {
  const f = await fixture(),
    report = f.report(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const pending = f.repo.recordBackgroundReport(
    report,
    async function* () {
      entered.resolve()
      await release.promise
      yield report.text
    },
    new AbortController().signal,
  )
  await entered.promise
  f.start()
  const activity = f.db.drizzle
    .select({ updatedAt: sessions.updatedAt })
    .from(sessions)
    .where(eq(sessions.id, f.sessionId))
    .get()!.updatedAt
  release.resolve()
  expect(await pending).toBeUndefined()
  const update = f.db.drizzle
    .select()
    .from(conversationMessages)
    .all()
    .find(isConversationBackgroundReport)!
  expect(update).toMatchObject({ state: 'complete', isVisible: false, content: report.text })
  expect(
    f.db.drizzle
      .select({ updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(eq(sessions.id, f.sessionId))
      .get()!.updatedAt,
  ).toBe(activity)
  expect(
    f.repo
      .readHandoffPage(f.sessionId, 'codex', -1, update.sequence)
      .messages.map((message) => message.messageId),
  ).not.toContain(update.id)
})

it('keeps a current background cursor visible after a definitely-unsent local refusal', async () => {
  const f = await fixture(),
    refused = f.start()
  f.db.drizzle
    .update(agentRuns)
    .set({ status: 'failed', dispatchPhase: 'not_sent', nativeEffectsState: 'not_dispatched' })
    .where(eq(agentRuns.id, refused.id))
    .run()
  expect(f.repo.ownsNativeControl(f.root.id)).toBe(false)
  expect(f.repo.ownsBackgroundControl(f.root.id)).toBe(true)
  const cursor = f.repo.findRun(f.root.id)!
  const context = f.repo.nativeContext(f.sessionId, 'claude')!
  const projected = projectSessionIssues(
    f.sessionId,
    [context],
    [f.repo.findRun(refused.id)],
    [cursor],
  )
  expect(projected.agents.find((issue) => issue.agentId === 'claude')).toMatchObject({
    runId: f.root.id,
    inputDisposition: 'submitted',
  })
  expect(
    nativeSessionIssueMetadata(f.db.drizzle, f.sessionId).issues.agents.find(
      (issue) => issue.agentId === 'claude',
    ),
  ).toMatchObject({ runId: f.root.id })
  f.db.drizzle
    .update(agentRuns)
    .set({ dispatchPhase: 'possibly_sent' })
    .where(eq(agentRuns.id, refused.id))
    .run()
  expect(f.repo.ownsBackgroundControl(f.root.id)).toBe(false)
})

it.each([
  { field: 'executor', change: { executorId: 'replacement-executor' } },
  { field: 'native session', change: { nativeSessionId: 'replacement-native-session' } },
  { field: 'generation', change: { bindingGeneration: 2 } },
])('does not grant background control after the binding $field changes', async ({ change }) => {
  const f = await fixture()
  expect(f.repo.ownsBackgroundControl(f.root.id)).toBe(true)
  f.db.drizzle
    .update(nativeAgentContexts)
    .set(change)
    .where(eq(nativeAgentContexts.sessionId, f.sessionId))
    .run()
  expect(f.repo.ownsBackgroundControl(f.root.id)).toBe(false)
})

it('does not treat an older cursor as current across an intervening uncertain dispatch', async () => {
  const f = await fixture(),
    first = f.start()
  f.db.drizzle
    .update(agentRuns)
    .set({ status: 'failed', dispatchPhase: 'not_sent', nativeEffectsState: 'not_dispatched' })
    .where(eq(agentRuns.id, first.id))
    .run()
  const latest = f.start()
  f.db.drizzle
    .update(agentRuns)
    .set({ status: 'failed', dispatchPhase: 'not_sent', nativeEffectsState: 'not_dispatched' })
    .where(eq(agentRuns.id, latest.id))
    .run()
  // A retained older receipt can make that earlier attempt uncertain even when
  // the latest local admission never reached a native process.
  f.db.drizzle
    .update(agentRuns)
    .set({ dispatchPhase: 'possibly_sent', nativeEffectsState: 'unknown' })
    .where(eq(agentRuns.id, first.id))
    .run()
  expect(f.repo.ownsBackgroundControl(f.root.id)).toBe(false)
  expect(
    nativeSessionIssueMetadata(f.db.drizzle, f.sessionId).issues.agents.some(
      (issue) => issue.runId === f.root.id,
    ),
  ).toBe(false)
})

it('retains an unclassified legacy cursor for recovery without granting executor control', async () => {
  const f = await fixture(),
    refused = f.start()
  f.db.drizzle
    .update(agentRuns)
    .set({ status: 'failed', dispatchPhase: 'not_sent', nativeEffectsState: 'not_dispatched' })
    .where(eq(agentRuns.id, refused.id))
    .run()
  f.db.drizzle.update(agentRuns).set({ executorId: null }).where(eq(agentRuns.id, f.root.id)).run()
  f.db.drizzle
    .update(nativeAgentContexts)
    .set({ executorId: null })
    .where(eq(nativeAgentContexts.sessionId, f.sessionId))
    .run()
  expect(f.repo.nativeRecoveryBlocksInput(f.sessionId)).toBe(false)
  expect(f.repo.isCurrentBackgroundCursor(f.root.id)).toBe(true)
  expect(f.repo.ownsBackgroundControl(f.root.id)).toBe(false)
  const issue = nativeSessionIssueMetadata(f.db.drizzle, f.sessionId).issues.agents[0]!
  expect(issue).toMatchObject({ runId: f.root.id, phase: 'background_check' })
  expect(issue.backgroundStop).toBeUndefined()
})

it('keeps immutable report bytes and Comment sources through two successive Forks', async () => {
  const f = await fixture(),
    text = JSON.stringify({
      runId: f.root.id,
      messageId: f.root.userMessageId,
      value: '原始 ✨ background text',
    })
  const report = f.report(text)
  await f.repo.recordBackgroundReport(report, parts(text), new AbortController().signal)
  f.repo.recordNativeEffects(f.root.id, 'settled')
  const original = f.repo.read(f.sessionId).messages.find(isConversationBackgroundReport)!
  f.repo.saveCommentDraft({
    mode: 'create',
    sessionId: f.sessionId,
    commentId: randomUUID(),
    expectedCommentsRevision: f.revision(),
    body: 'Keep the exact background source',
    anchor: {
      type: 'message',
      messageId: original.id,
      contentHash: createHash('sha256').update(text).digest('hex'),
      textBasis: 'markdown-visible-v2',
      startOffset: 0,
      endOffset: text.length,
      quote: text,
    },
  })
  const next = f.start('codex')
  f.finish(next)
  const copy = (sourceId: string, generation: number) => {
    const session = f.db.sessionRepository.find(sourceId)!
    const cut = f.repo
      .read(sourceId)
      .messages.findLast((message) => message.role === 'assistant' && message.runId)!
    const selection = f.repo.selectForkSource(
      sourceId,
      cut.id,
      session.settings,
      session.settingsRevision,
    )
    const boundary = (agentId: 'claude' | 'codex'): AgentNativeForkBoundary => {
      const run = selection.runs[agentId],
        response = f.repo.forkResponse(run.id, selection.prepared.sequence)
      return {
        nativeSessionId: run.nativeSessionId!,
        nativeTurnId: run.nativeTurnId!,
        nativeCutId: run.nativeTurnId!,
        bindingGeneration: run.bindingGeneration,
        throughSequence: response.sequence,
        deliveryCursor: response.deliveryCursor,
        prefixHash: createHash('sha256').update(`${agentId}:${generation}`).digest('hex'),
        prefixRecords: 2,
        prefixBytes: 100,
      }
    }
    const boundaries = { claude: boundary('claude'), codex: boundary('codex') }
    const operation = f.repo.commitFork(randomUUID(), selection, boundaries, [])
    for (const agentId of ['claude', 'codex'] as const) {
      const source = boundaries[agentId]
      const nativeSessionId = `child-${generation}-${agentId}`
      const witness: AgentNativeForkWitness = {
        version: 'pact-native-fork-v1',
        sourceNativeSessionId: source.nativeSessionId,
        nativeSessionId,
        sourceCutId: source.nativeCutId,
        sourcePrefixHash: source.prefixHash,
        candidatePrefixHash: source.prefixHash,
        idMap: [[source.nativeTurnId, source.nativeTurnId]],
        model: null,
        effort: null,
        permissionMode: agentId === 'claude' ? 'ask' : 'native',
        initializedAt: new Date().toISOString(),
        initializedPrefixHash: source.prefixHash,
        initializedPrefixBytes: 100,
        initializedPrefixRecords: 2,
      }
      f.repo.updateForkIntent(operation.sessionId, operation.id, agentId, {
        nativeSessionId,
        witnessJson: JSON.stringify(witness),
        nativeWorkState: 'settled',
      })
      f.repo.completeForkSide(operation.sessionId, operation.id, agentId, nativeSessionId, witness)
    }
    const copied = f.repo.read(operation.sessionId).messages.find(isConversationBackgroundReport)!
    expect(copied).toMatchObject({ content: text, state: 'complete' })
    expect(copied.id).not.toBe(original.id)
    const body = f.db.drizzle
      .select()
      .from(conversationBodyInputs)
      .where(eq(conversationBodyInputs.id, copied.id))
      .get()!
    expect(body).toMatchObject({
      committedMessageId: copied.id,
      hash: createHash('sha256').update(text).digest('hex'),
      sealed: true,
    })
    const comment = f.repo
      .read(operation.sessionId)
      .comments.find((item) => item.body === 'Keep the exact background source')!
    expect(comment.anchor).toMatchObject({
      messageId: copied.id,
      quote: text,
      contentHash: body.hash,
    })
    expect(() =>
      f.repo.selectForkSource(operation.sessionId, copied.id, session.settings, 1),
    ).toThrow(/completed Agent message/)
    return operation.sessionId
  }
  const child = copy(f.sessionId, 1)
  copy(child, 2)
})

it('preserves existing report records and installs the 0101 index on a real 0100 upgrade', async () => {
  const f = await fixture(),
    report = f.report()
  await f.repo.recordBackgroundReport(report, parts(report.text), new AbortController().signal)
  const before = f.db.drizzle.select().from(conversationMessages).all()
  const directory = await mkdtemp(join(tmpdir(), 'pact-report-upgrade-'))
  directories.push(directory)
  const path = join(directory, 'legacy.sqlite')
  copyLegacyDatabase(f.db, path, migrationsFolder, 100)
  const upgraded = await PactDatabase.open({ filePath: path, migrationsFolder })
  databases.push(upgraded)
  expect(upgraded.drizzle.select().from(conversationMessages).all()).toEqual(before)
  expect(
    upgraded.drizzle.get(
      sql`SELECT name FROM sqlite_master WHERE type='index' AND name='conversation_messages_archived_background_idx'`,
    ),
  ).toBeDefined()
})

it('uses bounded indexed latest, older and around branches with representative archived report history', async () => {
  const measurements: Array<Array<{ operations: number; rows: number; items: number }>> = []
  for (const history of [1000, 10_000]) {
    // oxlint-disable-next-line no-await-in-loop -- Separate real databases compare the same page read against two history sizes.
    const f = await fixture(false, true),
      now = new Date().toISOString()
    let aroundId = ''
    // Historical metadata load, not provider/protocol evidence: one report among
    // ten archived rows proves the dedicated partial index excludes unrelated text.
    f.db.drizzle.transaction((tx) => {
      for (let start = 0; start < history; start += 500)
        tx.insert(conversationMessages)
          .values(
            Array.from({ length: 500 }, (_, offset) => {
              const index = start + offset,
                report = index % 10 === 0,
                id = randomUUID()
              if (index === history / 2) aroundId = id
              return {
                id,
                sessionId: f.sessionId,
                role: 'assistant' as const,
                agentId: 'claude' as const,
                runId: report ? null : f.root.id,
                sourceMessageId: report ? f.root.userMessageId : null,
                isVisible: false,
                state: 'incomplete' as const,
                content: 'Archived fixture body',
                sequence: index + 2,
                createdAt: now,
                updatedAt: now,
              }
            }),
          )
          .run()
    })
    for (const [filter, newer] of [
      [sql`1=1`, false],
      [sql`sequence < ${history * 0.4}`, false],
      [sql`sequence <= ${history / 2}`, false],
      [sql`sequence > ${history / 2}`, true],
    ] as const) {
      const timeline = outputTimelineSql(f.sessionId, undefined, {
        filter,
        newer,
        legacy: false,
        archivedBackground: true,
      })
      const read = sql`${timeline} SELECT * FROM timeline ORDER BY sequence ${newer ? sql`ASC` : sql`DESC`}, rank, id LIMIT 26`
      const plan = f.db.drizzle
        .all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${read}`)
        .map((row) => row.detail)
        .join('\n')
      expect(plan).toContain('conversation_messages_archived_background_idx')
      expect(plan).not.toMatch(/SCAN (?:conversation_messages|m\b)/)
      expect(f.db.drizzle.all(read)).toHaveLength(26)
    }
    const before = f.repo.diagnostics()
    const sample = []
    for (const input of [
      { scope: 'messages' as const, sessionId: f.sessionId },
      { scope: 'messages' as const, sessionId: f.sessionId, beforeSequence: history * 0.4 },
      { scope: 'messages' as const, sessionId: f.sessionId, aroundMessageId: aroundId },
    ]) {
      const begin = f.db.performanceDiagnostics()!.sqlite
      const page = f.repo.readPage(input)
      const end = f.db.performanceDiagnostics()!.sqlite
      expect(page.scope).toBe('messages')
      if (page.scope !== 'messages') throw Error('Wrong fixture page')
      expect(page.messages.length).toBeLessThanOrEqual(25)
      sample.push({
        operations: end.operations - begin.operations,
        rows: end.rowsReturned - begin.rowsReturned,
        items: page.messages.length,
      })
    }
    expect(f.repo.diagnostics().completeReads).toBe(before.completeReads)
    expect(f.repo.diagnostics().pageReads - before.pageReads).toBe(3)
    measurements.push(sample)
  }
  expect(measurements[1]).toEqual(measurements[0])
  console.info(
    '[background-report-page-lookups]',
    JSON.stringify({ histories: [1000, 10_000], latestOlderAround: measurements }),
  )
})
