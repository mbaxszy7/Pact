import { desc, eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'

import type { RuntimeAgentId } from '@pact/contracts'

import { collaborationDocumentSchema } from '@pact/contracts'

import { RunOperationConflictError } from './conversation-errors.js'
import { PactDatabase } from './pact-database.js'
import {
  conversationMessages,
  conversationRebuildSourceRefs,
  nativeAgentContexts,
  nativeRebuildOperations,
} from './schema/index.js'

async function rebuiltSourceFixture(agentId: RuntimeAgentId) {
  const db = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
  })
  try {
    const repo = db.conversationRepository,
      projectId = randomUUID(),
      sessionId = randomUUID(),
      createdAt = new Date().toISOString()
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Rebuild source inheritance',
      directoryPath: '/rebuild-source-fixture',
      kind: 'directory',
      createdAt,
    })
    db.sessionRepository.create(
      { id: sessionId, projectId, title: 'Rebuild sources', createdAt },
      {
        primaryAgentId: agentId,
        agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    )
    const start = (content: string) => {
      const drafts = repo.readPage({ scope: 'drafts', sessionId })
      if (drafts.scope !== 'drafts') throw new Error('Missing draft revision')
      return repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content,
        commentIds: [],
        expectedCommentsRevision: drafts.commentsRevision,
        agentId,
        model: null,
        effort: null,
        settingsRevision: 1,
      }).run
    }
    const prior = start('Preserve this original request.'),
      answer = 'The complete saved answer retains its original source. 🚀',
      turnId = randomUUID()
    repo.applyEvent(sessionId, prior.id, {
      type: 'session.started',
      agentId,
      nativeSessionId: randomUUID(),
    })
    repo.applyEvent(sessionId, prior.id, { type: 'turn.started', agentId, turnId })
    repo.applyEvent(sessionId, prior.id, {
      type: 'text.completed',
      agentId,
      turnId,
      outputId: randomUUID(),
      text: answer,
    })
    repo.applyEvent(sessionId, prior.id, {
      type: 'turn.completed',
      agentId,
      turnId,
      outcome: 'completed',
    })
    repo.recordNativeEffects(prior.id, 'settled')
    const responseMessageId = repo.findRun(prior.id)!.responseMessageId!
    repo.markNativeContextsMissing(sessionId, [agentId])
    const operationId = randomUUID(),
      executorId = randomUUID(),
      nativeSessionId = randomUUID()
    repo.beginNativeRebuild({
      id: operationId,
      sessionId,
      agentId,
      expectedGeneration: 1,
      abandon: false,
    })
    const chunks = []
    for await (const chunk of repo.nativeContextRebuildSource(
      sessionId,
      new AbortController().signal,
      operationId,
    ))
      chunks.push(chunk)
    repo.freezeNativeRebuildSource(operationId, chunks)
    const saved = db.drizzle
      .select()
      .from(conversationRebuildSourceRefs)
      .where(eq(conversationRebuildSourceRefs.operationId, operationId))
      .all()
    const response = saved.find((row) => row.sourceMessageId === responseMessageId)!
    expect(response).toBeDefined()
    const rawDocuments: unknown = JSON.parse(response.documentsJson)
    if (!Array.isArray(rawDocuments)) throw new Error('Invalid source references')
    const documents = rawDocuments.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object') throw new Error('Invalid source reference')
      const key: unknown = Reflect.get(entry, 'key')
      if (typeof key !== 'string') throw new Error('Invalid source key')
      return { key, source: collaborationDocumentSchema.parse(Reflect.get(entry, 'source')) }
    })
    const document = documents.find((entry) => entry.key === 'message')!.source
    expect(document.sha256).toBe(createHash('sha256').update(answer).digest('hex'))
    repo.markNativeRebuildDispatched(operationId, executorId)
    repo.recordNativeRebuildIdentity(operationId, nativeSessionId)
    repo.completeNativeRebuild(
      operationId,
      nativeSessionId,
      undefined,
      agentId === 'codex'
        ? {
            kind: 'codex_rollout_v1',
            nativeSessionId,
            verifiedPrefixBytes: 1024,
            verifiedPrefixSha256: 'a'.repeat(64),
            recordCount: 2,
          }
        : undefined,
    )
    repo.recordNativeRebuildWork(operationId, executorId, nativeSessionId, 'settled')
    return {
      db,
      repo,
      projectId,
      sessionId,
      agentId,
      prior,
      start,
      answer,
      document,
      responseMessageId,
      operationId,
      executorId,
      nativeSessionId,
      saved,
    }
  } catch (error) {
    db.close()
    throw error
  }
}

it.each(['codex', 'claude'] as const)(
  'inherits the completed %s Rebuild sources through the next Run reader',
  async (agentId) => {
    const f = await rebuiltSourceFixture(agentId)
    const { db, repo, start, sessionId, prior, answer, document, responseMessageId } = f
    try {
      const next = start('Read the exact original source after Rebuild.')
      expect(next.bindingGeneration).toBe(2)
      const page = repo.readRunSources(next.id)
      expect(page.items.some((entry) => entry.messageId === responseMessageId)).toBe(true)
      expect(repo.sourceDocumentAuthorized(next.id, document)).toBe(true)
      expect(
        repo.readPage({
          scope: 'collaboration-text',
          sessionId,
          runId: prior.id,
          document,
          offset: 0,
        }),
      ).toMatchObject({ text: answer, nextOffset: null })
    } finally {
      db.close()
    }
  },
)

const rejectedScopes = [
  'unconfirmed',
  'failed',
  'pending_work',
  'unknown_work',
  'missing_hash',
  'missing_manifest',
  'wrong_generation',
  'wrong_candidate',
  'wrong_agent',
  'wrong_session',
  'wrong_cut',
] as const

it.each(
  (['codex', 'claude'] as const).flatMap((agentId) =>
    rejectedScopes.map((scope) => ({ agentId, scope })),
  ),
)('refuses $agentId Rebuild sources for $scope', async ({ agentId, scope }) => {
  const f = await rebuiltSourceFixture(agentId)
  try {
    const { db, repo, operationId, sessionId } = f
    if (scope === 'wrong_generation' || scope === 'wrong_candidate') {
      db.drizzle
        .update(nativeAgentContexts)
        .set(
          scope === 'wrong_generation'
            ? { bindingGeneration: 3 }
            : { nativeSessionId: randomUUID() },
        )
        .where(eq(nativeAgentContexts.sessionId, sessionId))
        .run()
    } else {
      const patch: Partial<typeof nativeRebuildOperations.$inferInsert> =
        scope === 'unconfirmed' || scope === 'failed'
          ? { stage: scope }
          : scope === 'pending_work'
            ? { nativeWorkState: 'pending' }
            : scope === 'unknown_work'
              ? { nativeWorkState: 'unknown' }
              : scope === 'missing_hash'
                ? { sourceHash: null }
                : scope === 'missing_manifest'
                  ? { sourceChunksJson: null }
                  : scope === 'wrong_agent'
                    ? { agentId: agentId === 'claude' ? 'codex' : 'claude' }
                    : scope === 'wrong_cut'
                      ? { throughSequence: 10000 }
                      : { sessionId: randomUUID() }
      if (scope === 'wrong_session') {
        const original = db.sessionRepository.find(sessionId)!
        db.sessionRepository.create(
          {
            id: patch.sessionId!,
            projectId: f.projectId,
            title: 'Other Session',
            createdAt: new Date().toISOString(),
          },
          original.settings,
        )
      }
      db.drizzle
        .update(nativeRebuildOperations)
        .set(patch)
        .where(eq(nativeRebuildOperations.id, operationId))
        .run()
    }
    let next
    try {
      next = f.start('A mismatched Rebuild must grant no source access.')
    } catch (error) {
      if (!(error instanceof RunOperationConflictError)) throw error
      return
    } // Admission may reject an unsettled or inconsistent binding earlier.
    expect(repo.readRunSources(next.id).items).toEqual([])
    expect(repo.sourceDocumentAuthorized(next.id, f.document)).toBe(false)
  } finally {
    f.db.close()
  }
})

it.each(['codex', 'claude'] as const)(
  'keeps the %s provider completion evidence specific',
  async (agentId) => {
    const f = await rebuiltSourceFixture(agentId)
    try {
      f.db.drizzle
        .update(nativeRebuildOperations)
        .set({
          initializationWitnessJson:
            agentId === 'codex' ? null : JSON.stringify({ kind: 'codex_rollout_v1' }),
        })
        .where(eq(nativeRebuildOperations.id, f.operationId))
        .run()
      const next = f.start('Do not borrow the other provider completion contract.')
      expect(f.repo.readRunSources(next.id).items).toEqual([])
      expect(f.repo.sourceDocumentAuthorized(next.id, f.document)).toBe(false)
    } finally {
      f.db.close()
    }
  },
)

it.each(['codex', 'claude'] as const)(
  'freezes the %s source cut and keeps admitted refs immutable',
  async (agentId) => {
    const f = await rebuiltSourceFixture(agentId)
    try {
      f.repo.recordSystemMessage(
        f.sessionId,
        f.prior.id,
        'This later Message is outside the rebuilt cut.',
      )
      const later = f.db.drizzle
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.sessionId, f.sessionId))
        .orderBy(desc(conversationMessages.sequence))
        .limit(1)
        .get()!
      f.db.drizzle
        .insert(conversationRebuildSourceRefs)
        .values({
          operationId: f.operationId,
          sourceMessageId: later.id,
          sourceRevision: later.contentRevision,
          batchId: null,
          documentsJson: JSON.stringify([{ key: 'message', source: f.document }]),
        })
        .run()
      const next = f.start('Use only the completed cut.')
      const frozen = f.repo.readRunSources(next.id)
      expect(frozen.items.some((entry) => entry.messageId === f.responseMessageId)).toBe(true)
      expect(frozen.items.some((entry) => entry.messageId === later.id)).toBe(false)
      f.db.drizzle
        .update(conversationRebuildSourceRefs)
        .set({ documentsJson: '[]' })
        .where(eq(conversationRebuildSourceRefs.operationId, f.operationId))
        .run()
      f.db.drizzle
        .update(nativeAgentContexts)
        .set({ bindingGeneration: 3, nativeSessionId: randomUUID() })
        .where(eq(nativeAgentContexts.sessionId, f.sessionId))
        .run()
      expect(f.repo.readRunSources(next.id)).toEqual(frozen)
      expect(f.repo.sourceDocumentAuthorized(next.id, f.document)).toBe(true)
    } finally {
      f.db.close()
    }
  },
)

it('uses indexed lookups for the actual inheritance query with unrelated retained history', async () => {
  const f = await rebuiltSourceFixture('claude')
  try {
    let inherited: Parameters<typeof f.db.drizzle.run>[0] | undefined
    const original = f.db.drizzle.run.bind(f.db.drizzle)
    const spy = vi.spyOn(f.db.drizzle, 'run').mockImplementation((query) => {
      const chunks: unknown =
        query && typeof query === 'object' ? Reflect.get(query, 'queryChunks') : undefined
      const text = Array.isArray(chunks)
        ? chunks
            .flatMap((chunk: unknown) => {
              if (!chunk || typeof chunk !== 'object') return []
              const values: unknown = Reflect.get(chunk, 'value')
              return Array.isArray(values)
                ? values.filter((value: unknown) => typeof value === 'string')
                : []
            })
            .join('')
        : undefined
      if (text?.includes('FROM conversation_rebuild_source_refs')) inherited = query
      return original(query)
    })
    f.start('Capture the actual production SQL.')
    spy.mockRestore()
    expect(inherited).toBeDefined()
    const before = f.db.drizzle.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${inherited}`)
    const originalOperation = f.db.drizzle
      .select()
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, f.operationId))
      .get()!
    const other = randomUUID(),
      session = f.db.sessionRepository.find(f.sessionId)!
    f.db.sessionRepository.create(
      {
        id: other,
        projectId: f.projectId,
        title: 'Unrelated history',
        createdAt: new Date().toISOString(),
      },
      session.settings,
    )
    f.db.drizzle.transaction((tx) => {
      for (let index = 0; index < 1000; index++)
        tx.insert(nativeRebuildOperations)
          .values({
            ...originalOperation,
            id: randomUUID(),
            sessionId: other,
            oldRunId: null,
            oldGeneration: index + 1,
          })
          .run()
    })
    const after = f.db.drizzle.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${inherited}`)
    expect(after).toEqual(before)
    expect(
      after.some((row) =>
        /SEARCH n USING INDEX native_rebuild_operations_binding_idx/u.test(row.detail),
      ),
    ).toBe(true)
    expect(after.some((row) => /SEARCH s USING (?:COVERING )?INDEX/u.test(row.detail))).toBe(true)
    expect(after.some((row) => /SEARCH m USING INDEX/u.test(row.detail))).toBe(true)
    expect(after.some((row) => /SCAN (?:n|s|m)\b/u.test(row.detail))).toBe(false)
  } finally {
    f.db.close()
  }
})
