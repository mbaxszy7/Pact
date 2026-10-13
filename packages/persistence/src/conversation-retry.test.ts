import { eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { DefaultSessionSettings } from '@pact/contracts'

import { PactDatabase, conversationMessages, agentRuns, nativeAgentContexts } from './index.js'
import { copyLegacyDatabase, seedHistoricalAnswerAttempt } from './legacy-database.test-support.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
  maxDiscussionRounds: 6,
  runningMessagePolicy: 'immediate_safe_point',
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}
async function pendingFixture(filePath = ':memory:') {
  const db = await PactDatabase.open({ filePath, migrationsFolder })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Fixture',
    kind: 'git',
    directoryPath: '/fixture',
    createdAt,
  })
  db.sessionRepository.create({ id: sessionId, projectId, title: 'Fixture', createdAt }, settings)
  const repo = db.conversationRepository
  const started = repo.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'Original request',
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
  })
  return { db, repo, sessionId, runId: started.run.id, userId: started.run.userMessageId }
}
async function fixture(filePath = ':memory:') {
  const { db, repo, sessionId, runId, userId } = await pendingFixture(filePath)
  repo.applyEvent(sessionId, runId, {
    agentId: 'codex',
    type: 'text.completed',
    turnId: 'old',
    outputId: 'old-output',
    text: 'Original response',
  })
  repo.failRun(runId, 'unknown_delivery', 'Interrupted', true)
  const original = repo.readPage({ scope: 'messages', sessionId })
  if (original.scope !== 'messages') throw Error('Wrong fixture page')
  const oldItem = original.messages.find((item) => item.message.role === 'assistant')
  if (!oldItem || oldItem.kind !== 'complete') throw Error('Expected a complete fixture body')
  const oldMessage = oldItem.message
  return {
    db,
    repo,
    sessionId,
    runId: runId,
    userId: userId,
    oldMessage,
    commentsRevision: original.header.commentsRevision,
  }
}
describe('Read-only answer regeneration', () => {
  it('publishes reliable readback after a complete hidden archive with no prior visible answer', async () => {
    const f = await pendingFixture()
    try {
      f.repo.applyArchivedEvent(f.sessionId, f.runId, {
        agentId: 'codex',
        type: 'text.completed',
        turnId: 'old',
        outputId: 'actual-output',
        text: 'Complete actual result',
      })
      f.repo.applyArchivedEvent(f.sessionId, f.runId, {
        agentId: 'codex',
        type: 'turn.completed',
        turnId: 'old',
        outcome: 'completed',
      })
      const before = f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })
      expect(before).toMatchObject({ messages: [{ message: { role: 'user' } }] })
      const archived = f.db.drizzle
        .select()
        .from(conversationMessages)
        .where(sql`run_id=${f.runId} AND role='assistant'`)
        .get()!
      expect(archived).toMatchObject({
        isVisible: false,
        state: 'complete',
        content: 'Complete actual result',
      })
      const patch = f.repo.recordNativeOutput(f.runId, {
        outputId: 'actual-output',
        completeness: 'complete',
        text: 'Complete actual result',
      })
      expect(patch.messages).toEqual([
        expect.objectContaining({
          mode: 'replace',
          text: 'Complete actual result',
          message: expect.objectContaining({ state: 'complete' }),
        }),
      ])
      const visible = f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })
      expect(visible).toMatchObject({
        messages: [
          { message: { role: 'user' } },
          { message: { role: 'assistant', content: 'Complete actual result', state: 'complete' } },
        ],
      })
      const again = f.repo.recordNativeOutput(f.runId, {
        outputId: 'actual-output',
        completeness: 'complete',
        text: 'Complete actual result',
      })
      expect(again.messages).toEqual([])
      const repeated = f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })
      if (repeated.scope !== 'messages' || visible.scope !== 'messages')
        throw new Error('Wrong Message window')
      expect(repeated.messages).toEqual(visible.messages)
      expect(f.repo.message(archived.id, f.sessionId)?.content).toBe(archived.content)
      const plan = f.db.drizzle.all(
        sql`EXPLAIN QUERY PLAN SELECT id FROM conversation_messages WHERE run_id=${f.runId} AND role='assistant' AND is_visible=1 AND state='complete' AND length(content)>0 LIMIT 1`,
      )
      expect(JSON.stringify(plan)).toContain('SEARCH conversation_messages USING INDEX')
      expect(JSON.stringify(plan)).not.toContain('SCAN conversation_messages')
    } finally {
      f.db.close()
    }
  })
  it('keeps an earlier visible complete answer and Comment source when the latest archive is hidden complete', async () => {
    const f = await pendingFixture()
    try {
      f.repo.applyEvent(f.sessionId, f.runId, {
        agentId: 'codex',
        type: 'text.completed',
        turnId: 'old',
        outputId: 'old-output',
        text: 'Accepted complete answer',
      })
      f.repo.applyEvent(f.sessionId, f.runId, {
        agentId: 'codex',
        type: 'turn.completed',
        turnId: 'old',
        outcome: 'completed',
      })
      const page = f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })
      if (page.scope !== 'messages') throw new Error('Wrong Message window')
      const acceptedItem = page.messages.find((row) => row.message.role === 'assistant')
      if (!acceptedItem || acceptedItem.kind !== 'complete')
        throw new Error('Accepted complete answer unavailable')
      const accepted = acceptedItem.message
      const id = randomUUID()
      f.repo.saveCommentDraft({
        mode: 'create',
        sessionId: f.sessionId,
        commentId: id,
        expectedCommentsRevision: page.header.commentsRevision,
        body: 'Preserve source',
        anchor: {
          type: 'message',
          messageId: accepted.id,
          contentHash: createHash('sha256').update(accepted.content).digest('hex'),
          textBasis: 'markdown-visible-v2',
          startOffset: 0,
          endOffset: accepted.content.length,
          quote: accepted.content,
        },
      })
      f.repo.applyArchivedEvent(f.sessionId, f.runId, {
        agentId: 'codex',
        type: 'text.completed',
        turnId: 'old',
        outputId: 'late-hidden',
        text: 'Different archived completion',
      })
      f.db.drizzle
        .update(conversationMessages)
        .set({ state: 'complete' })
        .where(sql`run_id=${f.runId} AND is_visible=0 AND content='Different archived completion'`)
        .run()
      const recovered = f.repo.recordNativeOutput(f.runId, {
        outputId: 'late-hidden',
        text: 'Different archived completion',
        completeness: 'complete',
      })
      expect(recovered.messages).toEqual([])
      const after = f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })
      expect(after).toMatchObject({
        messages: [{ message: { role: 'user' } }, { message: accepted }],
      })
      expect(f.repo.message(accepted.id, f.sessionId)).toEqual(accepted)
      expect(f.repo.comment(id)?.anchor).toMatchObject({
        messageId: accepted.id,
        quote: accepted.content,
      })
    } finally {
      f.db.close()
    }
  })
  it.each(['abandoned', 'generation', 'pending-rebuild', 'newer-run'] as const)(
    'does not publish complete hidden history through a %s gate',
    async (gate) => {
      const f = await pendingFixture()
      try {
        f.repo.applyEvent(f.sessionId, f.runId, {
          agentId: 'codex',
          type: 'session.started',
          nativeSessionId: 'native-old',
        })
        f.repo.applyArchivedEvent(f.sessionId, f.runId, {
          agentId: 'codex',
          type: 'text.completed',
          turnId: 'old',
          outputId: 'actual-output',
          text: 'Retained archive',
        })
        f.repo.applyArchivedEvent(f.sessionId, f.runId, {
          agentId: 'codex',
          type: 'turn.completed',
          turnId: 'old',
          outcome: 'completed',
        })
        if (gate === 'abandoned')
          f.db.drizzle
            .update(agentRuns)
            .set({ controlDisposition: 'abandoned' })
            .where(eq(agentRuns.id, f.runId))
            .run()
        if (gate === 'generation')
          f.db.drizzle
            .update(nativeAgentContexts)
            .set({ bindingGeneration: 2 })
            .where(eq(nativeAgentContexts.sessionId, f.sessionId))
            .run()
        if (gate === 'pending-rebuild')
          f.repo.beginNativeRebuild({
            id: randomUUID(),
            sessionId: f.sessionId,
            agentId: 'codex',
            expectedGeneration: 1,
            abandon: false,
          })
        if (gate === 'newer-run')
          f.repo.beginRun({
            sessionId: f.sessionId,
            clientMessageId: randomUUID(),
            content: 'New explicit request',
            expectedCommentsRevision: f.repo.read(f.sessionId).commentsRevision,
            commentIds: [],
            agentId: 'codex',
            settingsRevision: 1,
            model: null,
            effort: null,
          })
        const archiveBefore = f.db.drizzle
          .select()
          .from(conversationMessages)
          .where(sql`run_id=${f.runId} AND role='assistant'`)
          .all()
        const recovered = f.repo.recordNativeOutput(f.runId, {
          outputId: 'actual-output',
          completeness: 'complete',
          text: 'Retained archive',
        })
        expect(recovered.messages).toEqual([])
        f.repo.recordNativeOutput(f.runId, {
          outputId: 'actual-output',
          completeness: 'complete',
          text: 'Retained archive',
        })
        expect(
          f.db.drizzle
            .select()
            .from(conversationMessages)
            .where(sql`run_id=${f.runId} AND role='assistant'`)
            .all(),
        ).toEqual(archiveBefore)
        const visible = f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })
        if (visible.scope !== 'messages') throw new Error('Wrong Message window')
        expect(visible.messages.filter((row) => row.message.role === 'assistant')).toEqual([])
        expect(
          f.db.drizzle
            .select()
            .from(conversationMessages)
            .where(sql`run_id=${f.runId} AND role='assistant'`)
            .all()
            .some((row) => row.content === 'Retained archive'),
        ).toBe(true)
      } finally {
        f.db.close()
      }
    },
  )
  it('records changed hidden readback facts once while preserving archived sources and completeness', async () => {
    const f = await pendingFixture()
    try {
      f.repo.applyArchivedEvent(f.sessionId, f.runId, {
        agentId: 'codex',
        type: 'text.completed',
        turnId: 'old',
        outputId: 'actual-output',
        text: 'Original archive',
      })
      f.repo.applyArchivedEvent(f.sessionId, f.runId, {
        agentId: 'codex',
        type: 'turn.completed',
        turnId: 'old',
        outcome: 'completed',
      })
      f.db.drizzle
        .update(agentRuns)
        .set({ controlDisposition: 'abandoned' })
        .where(eq(agentRuns.id, f.runId))
        .run()
      const original = f.db.drizzle
        .select()
        .from(conversationMessages)
        .where(sql`run_id=${f.runId} AND role='assistant'`)
        .get()!
      const count = () =>
        f.db.drizzle
          .select()
          .from(conversationMessages)
          .where(sql`run_id=${f.runId} AND role='assistant'`)
          .all()
      f.repo.recordNativeOutput(f.runId, {
        outputId: 'actual-output',
        completeness: 'complete',
        text: 'Changed reliable archive',
      })
      expect(count()).toHaveLength(2)
      f.repo.recordNativeOutput(f.runId, {
        outputId: 'actual-output',
        completeness: 'complete',
        text: 'Changed reliable archive',
      })
      expect(count()).toHaveLength(2)
      f.repo.recordNativeOutput(f.runId, {
        outputId: 'actual-output',
        completeness: 'partial',
        text: 'Changed reliable archive plus',
      })
      expect(count()).toHaveLength(3)
      f.repo.recordNativeOutput(f.runId, {
        outputId: 'actual-output',
        completeness: 'partial',
        text: 'Changed reliable archive plus',
      })
      expect(count()).toHaveLength(3)
      f.repo.recordNativeOutput(f.runId, {
        outputId: 'actual-output',
        completeness: 'complete',
        text: 'Changed reliable archive plus',
      })
      expect(count()).toHaveLength(4)
      f.repo.recordNativeOutput(f.runId, {
        outputId: 'actual-output',
        completeness: 'complete',
        text: 'Changed reliable archive plus',
      })
      expect(count()).toHaveLength(4)
      expect(count().every((row) => !row.isVisible)).toBe(true)
      expect(
        f.db.drizzle
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.id, original.id))
          .get(),
      ).toEqual(original)
      const plan = f.db.drizzle.all(
        sql`EXPLAIN QUERY PLAN SELECT content,state,is_visible FROM conversation_messages WHERE run_id=${f.runId} AND role='assistant' ORDER BY sequence DESC LIMIT 1`,
      )
      expect(JSON.stringify(plan)).toContain('SEARCH conversation_messages USING INDEX')
      expect(JSON.stringify(plan)).not.toContain('SCAN conversation_messages')
    } finally {
      f.db.close()
    }
  })
  it('preserves anchored sources while a retained background answer continues to its real terminal', async () => {
    const f = await fixture()
    const anchor = (messageId: string, text: string, revision: number) => {
      const id = randomUUID()
      f.repo.saveCommentDraft({
        mode: 'create',
        sessionId: f.sessionId,
        commentId: id,
        expectedCommentsRevision: revision,
        body: 'Keep this exact source',
        anchor: {
          type: 'message',
          messageId,
          contentHash: createHash('sha256').update(text).digest('hex'),
          textBasis: 'markdown-visible-v2',
          startOffset: 0,
          endOffset: text.length,
          quote: text,
        },
      })
      return id
    }
    const latest = () =>
      f.db.drizzle
        .select()
        .from(conversationMessages)
        .where(sql`run_id=${f.runId} AND role='assistant'`)
        .orderBy(conversationMessages.sequence)
        .all()
        .at(-1)!
    const sourceUnchanged = () =>
      expect(f.repo.message(f.oldMessage.id, f.sessionId)).toEqual(f.oldMessage)
    try {
      const first = anchor(f.oldMessage.id, f.oldMessage.content, f.commentsRevision)
      f.repo.applyArchivedBatch(f.sessionId, f.runId, [
        { agentId: 'codex', type: 'text.delta', turnId: 'old', outputId: 'old-output', text: ' B' },
      ])
      const middle = latest()
      expect(middle).toMatchObject({
        content: 'Original response B',
        state: 'streaming',
        isVisible: false,
      })
      sourceUnchanged()
      const second = anchor(middle.id, middle.content, f.commentsRevision + 1)
      const sealed = f.repo.message(middle.id, f.sessionId)
      f.repo.applyArchivedBatch(f.sessionId, f.runId, [
        { agentId: 'codex', type: 'text.delta', turnId: 'old', outputId: 'old-output', text: ' C' },
      ])
      expect(latest().content).toBe('Original response B C')
      expect(f.repo.message(middle.id, f.sessionId)).toEqual(sealed)
      f.repo.applyArchivedEvent(f.sessionId, f.runId, {
        agentId: 'codex',
        type: 'text.completed',
        turnId: 'old',
        outputId: 'old-output',
        text: 'Original response B C',
      })
      sourceUnchanged()
      expect(f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })).toMatchObject({
        messages: [
          { message: { role: 'user' } },
          { message: { id: f.oldMessage.id, content: 'Original response' } },
        ],
      })
      const complete = f.repo.applyArchivedEvent(f.sessionId, f.runId, {
        agentId: 'codex',
        type: 'turn.completed',
        turnId: 'old',
        outcome: 'completed',
      })
      expect(complete.removedMessageIds).toEqual([f.oldMessage.id])
      expect(f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })).toMatchObject({
        messages: [
          { message: { role: 'user' } },
          { message: { content: 'Original response B C', state: 'complete' } },
        ],
      })
      sourceUnchanged()
      expect(f.repo.message(middle.id, f.sessionId)).toEqual(sealed)
      expect(f.repo.comment(first)?.anchor).toMatchObject({
        messageId: f.oldMessage.id,
        quote: 'Original response',
      })
      expect(f.repo.comment(second)?.anchor).toMatchObject({
        messageId: middle.id,
        quote: 'Original response B',
      })
    } finally {
      f.db.close()
    }
  })
  it.each(['complete', 'new-run'] as const)(
    'archives late text without replacing an accepted %s answer',
    async (scenario) => {
      const f = await fixture()
      try {
        if (scenario === 'complete')
          f.repo.applyArchivedEvent(f.sessionId, f.runId, {
            agentId: 'codex',
            type: 'turn.completed',
            turnId: 'old',
            outcome: 'completed',
          })
        else {
          const retry = seedHistoricalAnswerAttempt(f.db, f.runId)
          f.repo.applyEvent(f.sessionId, retry.run.id, {
            agentId: 'codex',
            type: 'text.completed',
            turnId: 'new',
            outputId: 'new-output',
            text: 'New accepted answer',
          })
          f.repo.applyEvent(f.sessionId, retry.run.id, {
            agentId: 'codex',
            type: 'turn.completed',
            turnId: 'new',
            outcome: 'completed',
          })
        }
        const source = f.repo.message(f.oldMessage.id, f.sessionId)
        f.repo.applyArchivedBatch(f.sessionId, f.runId, [
          {
            agentId: 'codex',
            type: 'text.delta',
            turnId: 'old',
            outputId: 'old-output',
            text: ' late',
          },
        ])
        f.repo.applyArchivedEvent(f.sessionId, f.runId, {
          agentId: 'codex',
          type: 'turn.completed',
          turnId: 'old',
          outcome: 'completed',
        })
        expect(f.repo.message(f.oldMessage.id, f.sessionId)).toEqual(source)
        expect(f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })).toMatchObject({
          messages: [
            { message: { role: 'user' } },
            {
              message: {
                content: scenario === 'complete' ? 'Original response' : 'New accepted answer',
              },
            },
          ],
        })
      } finally {
        f.db.close()
      }
    },
  )
  it.each(['Original response extended', 'Original response extended completely'])(
    'publishes a complete recovery after a hidden partial without mutating its old source: %s',
    async (text) => {
      const f = await fixture()
      try {
        f.repo.recordNativeOutput(f.runId, {
          outputId: 'partial',
          text: 'Original response extended',
          completeness: 'partial',
        })
        expect(f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })).toMatchObject({
          messages: [
            { message: { role: 'user' } },
            { message: { id: f.oldMessage.id, content: 'Original response' } },
          ],
        })
        const complete = f.repo.recordNativeOutput(f.runId, {
          outputId: 'complete',
          text,
          completeness: 'complete',
        })
        expect(complete.removedMessageIds).toEqual([f.oldMessage.id])
        expect(f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })).toMatchObject({
          messages: [
            { message: { role: 'user' } },
            { message: { content: text, state: 'complete' } },
          ],
        })
        expect(f.repo.message(f.oldMessage.id, f.sessionId)?.content).toBe('Original response')
      } finally {
        f.db.close()
      }
    },
  )
  it('preserves the exact Comment source when reliable recovery extends interrupted text', async () => {
    const f = await fixture()
    try {
      const contentHash = createHash('sha256').update(f.oldMessage.content).digest('hex')
      const commentId = randomUUID()
      f.repo.saveCommentDraft({
        mode: 'create',
        sessionId: f.sessionId,
        commentId,
        expectedCommentsRevision: f.commentsRevision,
        body: 'Verify this response',
        anchor: {
          type: 'message',
          messageId: f.oldMessage.id,
          contentHash,
          textBasis: 'markdown-visible-v2',
          startOffset: 0,
          endOffset: f.oldMessage.content.length,
          quote: f.oldMessage.content,
        },
      })
      const recovered = f.repo.recordNativeOutput(f.runId, {
        outputId: 'completed-output',
        text: 'Original response with reliable completion',
        completeness: 'complete',
      })
      expect(recovered.removedMessageIds).toEqual([f.oldMessage.id])
      // Complete readback publishes a new version, leaving the Comment source unchanged.
      expect(f.repo.message(f.oldMessage.id, f.sessionId)?.content).toBe(f.oldMessage.content)
      expect(f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })).toMatchObject({
        messages: [
          { message: { role: 'user' } },
          { message: { content: 'Original response with reliable completion', state: 'complete' } },
        ],
      })
      expect(f.repo.comment(commentId)?.anchor).toMatchObject({
        messageId: f.oldMessage.id,
        contentHash,
        quote: f.oldMessage.content,
      })
    } finally {
      f.db.close()
    }
  })
  it('binds a new permitted attempt and rejects the previous native Turn afterwards', async () => {
    const f = await fixture()
    try {
      const retry = seedHistoricalAnswerAttempt(f.db, f.runId)
      f.repo.updateAttempt(retry.run.id, 1, false)
      f.repo.applyEvent(f.sessionId, retry.run.id, {
        agentId: 'codex',
        type: 'turn.started',
        turnId: 'T1',
      })
      f.repo.updateAttempt(retry.run.id, 2, true)
      f.repo.applyEvent(f.sessionId, retry.run.id, {
        agentId: 'codex',
        type: 'turn.started',
        turnId: 'T2',
      })
      expect(() =>
        f.repo.applyEvent(f.sessionId, retry.run.id, {
          agentId: 'codex',
          type: 'text.delta',
          turnId: 'T1',
          outputId: 'late',
          text: 'Late output',
        }),
      ).toThrow(/earlier native Turn/)
      f.repo.applyEvent(f.sessionId, retry.run.id, {
        agentId: 'codex',
        type: 'text.completed',
        turnId: 'T2',
        outputId: 'new',
        text: 'Successful next attempt',
      })
      f.repo.applyEvent(f.sessionId, retry.run.id, {
        agentId: 'codex',
        type: 'turn.completed',
        turnId: 'T2',
        outcome: 'completed',
      })
      expect(f.repo.findRun(retry.run.id)?.status).toBe('completed')
    } finally {
      f.db.close()
    }
  })
  it('preserves visible incomplete text on partial readback and prevents historical completion from replacing a newer answer', async () => {
    const f = await fixture()
    try {
      const partial = f.repo.recordNativeOutput(f.runId, {
        outputId: 'partial-readback',
        text: 'Original response with a fragment',
        completeness: 'partial',
      })
      expect(partial.removedMessageIds ?? []).toEqual([])
      expect(f.repo.message(f.oldMessage.id, f.sessionId)?.content).toBe('Original response')
      expect(f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })).toMatchObject({
        messages: [
          { message: { role: 'user' } },
          { message: { id: f.oldMessage.id, content: 'Original response' } },
        ],
      })
      const retry = seedHistoricalAnswerAttempt(f.db, f.runId)
      f.repo.applyEvent(f.sessionId, retry.run.id, {
        agentId: 'codex',
        type: 'text.completed',
        turnId: 'replacement',
        outputId: 'replacement-output',
        text: 'New accepted answer',
      })
      f.repo.applyEvent(f.sessionId, retry.run.id, {
        agentId: 'codex',
        type: 'turn.completed',
        turnId: 'replacement',
        outcome: 'completed',
      })
      const oldComplete = f.repo.recordNativeOutput(f.runId, {
        outputId: 'historical-readback',
        text: 'Original response with historical completion',
        completeness: 'complete',
      })
      expect(oldComplete.removedMessageIds ?? []).toEqual([])
      expect(f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })).toMatchObject({
        messages: [{ message: { role: 'user' } }, { message: { content: 'New accepted answer' } }],
      })
      expect(f.repo.message(f.oldMessage.id, f.sessionId)?.content).toBe('Original response')
    } finally {
      f.db.close()
    }
  })
  it('upgrades legacy reply versions without deleting original bodies or trusting failed output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-retry-upgrade-'))
    const filePath = join(directory, 'pact.sqlite')
    let database: PactDatabase | undefined
    try {
      const f = await fixture(filePath)
      database = f.db
      const retry = seedHistoricalAnswerAttempt(f.db, f.runId)
      f.repo.applyEvent(f.sessionId, retry.run.id, {
        agentId: 'codex',
        type: 'text.completed',
        turnId: 'fresh',
        outputId: 'fresh-output',
        text: 'Trusted completed response',
      })
      f.repo.applyEvent(f.sessionId, retry.run.id, {
        agentId: 'codex',
        type: 'turn.completed',
        turnId: 'fresh',
        outcome: 'completed',
      })
      // Recreate pre-0019 projection states: item completion was not reliable Run completion.
      database.drizzle.run(sql`UPDATE conversation_messages SET state = CASE
        WHEN run_id = ${f.runId} THEN 'complete' ELSE 'streaming' END WHERE role = 'assistant'`)
      const legacyPath = join(directory, 'legacy.sqlite')
      copyLegacyDatabase(database, legacyPath, migrationsFolder, 18)
      database.close()
      database = await PactDatabase.open({ filePath: legacyPath, migrationsFolder })
      const replies = database.drizzle
        .select()
        .from(conversationMessages)
        .where(sql`role = 'assistant'`)
        .all()
      expect(replies).toHaveLength(2)
      expect(replies.find((reply) => reply.id === f.oldMessage.id)).toMatchObject({
        content: 'Original response',
        state: 'incomplete',
        isVisible: false,
        replyToMessageId: f.userId,
      })
      expect(replies.filter((reply) => reply.isVisible)).toMatchObject([
        { content: 'Trusted completed response', state: 'complete', replyToMessageId: f.userId },
      ])
    } finally {
      database?.close()
      await rm(directory, { recursive: true })
    }
  })
  it('keeps candidate output hidden and atomically replaces one answer only after trusted completion', async () => {
    const f = await fixture()
    try {
      const retry = seedHistoricalAnswerAttempt(f.db, f.runId)
      const before = f.repo.diagnostics().eventTransactions
      const duplicate = {
        agentId: 'codex' as const,
        type: 'text.delta' as const,
        turnId: 'fresh',
        outputId: 'fresh-output',
        text: 'Not coalesced',
      }
      expect(() =>
        f.repo.applyStreamBatch(f.sessionId, retry.run.id, [duplicate, duplicate]),
      ).toThrow(/coalesced keys/)
      expect(f.repo.diagnostics().eventTransactions).toBe(before)
      const partial = f.repo.applyStreamBatch(f.sessionId, retry.run.id, [
        {
          agentId: 'codex',
          type: 'text.delta',
          turnId: 'fresh',
          outputId: 'fresh-output',
          text: 'New response',
        },
      ])
      expect(f.repo.diagnostics().eventTransactions - before).toBe(1)
      expect(partial.messages).toEqual([])
      const visible = () =>
        f.db.drizzle
          .select()
          .from(conversationMessages)
          .where(sql`role='assistant' AND is_visible=1`)
          .all()
      expect(visible().map((row) => row.content)).toEqual(['Original response'])
      expect(await f.repo.readRunHandoff(retry.run.id, new AbortController().signal)).toEqual([])
      const completed = f.repo.applyEvent(f.sessionId, retry.run.id, {
        agentId: 'codex',
        type: 'turn.completed',
        turnId: 'fresh',
        outcome: 'completed',
      })
      expect(completed.removedMessageIds).toEqual([f.oldMessage.id])
      expect(completed.messages[0]).toMatchObject({
        mode: 'replace',
        text: 'New response',
        message: { replyToMessageId: f.userId, state: 'complete' },
      })
      expect(visible().map((row) => row.content)).toEqual(['New response'])
      expect(f.repo.message(f.oldMessage.id, f.sessionId)?.content).toBe('Original response')
      expect(f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })).toMatchObject({
        messages: [{ message: { role: 'user' } }, { message: { content: 'New response' } }],
      })
      const source = f.repo.readPage({
        scope: 'messages',
        sessionId: f.sessionId,
        aroundMessageId: f.oldMessage.id,
        includeHistoricalSource: true,
      })
      expect(source).toMatchObject({
        sourceMessageId: f.oldMessage.id,
        messages: [{ message: { id: f.oldMessage.id, content: 'Original response' } }],
      })
      expect(() =>
        f.repo.applyEvent(f.sessionId, f.runId, {
          agentId: 'codex',
          type: 'turn.completed',
          turnId: 'old',
          outcome: 'completed',
        }),
      ).toThrow(/no longer owns/)
      expect(f.repo.findRun(retry.run.id)?.status).toBe('completed')
      expect(f.repo.diagnostics().completeReads).toBe(0)
    } finally {
      f.db.close()
    }
  })
  it('preserves the original response after a failed replacement and rejects duplicate or stale Retry', async () => {
    const f = await fixture()
    try {
      const retry = seedHistoricalAnswerAttempt(f.db, f.runId)
      expect(() => seedHistoricalAnswerAttempt(f.db, f.runId)).toThrow(/UNIQUE|active/)
      f.repo.applyEvent(f.sessionId, retry.run.id, {
        agentId: 'codex',
        type: 'text.completed',
        turnId: 'fresh',
        outputId: 'new-output',
        text: 'Failed candidate',
      })
      f.repo.failRun(retry.run.id, 'agent_process_crash', 'Failed')
      const page = f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })
      expect(page).toMatchObject({
        messages: [{ message: { role: 'user' } }, { message: { content: 'Original response' } }],
        header: { latestRun: { status: 'failed' } },
      })
      expect(
        f.db.drizzle
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.role, 'assistant'))
          .all(),
      ).toHaveLength(2)
      expect(f.repo.diagnostics().completeReads).toBe(0)
    } finally {
      f.db.close()
    }
  })
  it('keeps large completed replacements bounded and requests resynchronization instead of clearing text', async () => {
    const f = await fixture()
    try {
      const retry = seedHistoricalAnswerAttempt(f.db, f.runId)
      f.repo.applyEvent(f.sessionId, retry.run.id, {
        agentId: 'codex',
        type: 'text.completed',
        turnId: 'fresh',
        outputId: 'new-output',
        text: 'x'.repeat(32_000),
      })
      const terminal = f.repo.applyEvent(f.sessionId, retry.run.id, {
        agentId: 'codex',
        type: 'turn.completed',
        turnId: 'fresh',
        outcome: 'completed',
      })
      expect(terminal.messages[0]).toMatchObject({ mode: 'invalidate', contentBytes: 32_000 })
      expect(Buffer.byteLength(JSON.stringify(terminal))).toBeLessThan(64 * 1024)
      expect(f.repo.message(f.oldMessage.id, f.sessionId)?.content).toBe('Original response')
    } finally {
      f.db.close()
    }
  })
})
