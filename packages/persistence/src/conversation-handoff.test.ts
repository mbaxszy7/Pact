import { eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { DefaultSessionSettings, RuntimeAgentId } from '@pact/contracts'

import { HandoffTooLargeError } from './conversation-repository.js'
import { seedHistoricalAnswerAttempt } from './legacy-database.test-support.js'
import { PactDatabase } from './pact-database.js'
import { agentRuns, anchoredComments, conversationMessages } from './schema/index.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
  maxDiscussionRounds: 6,
  runningMessagePolicy: 'immediate_safe_point',
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}

async function fixture(filePath = ':memory:') {
  const db = await PactDatabase.open({ filePath, migrationsFolder })
  const projectId = randomUUID()
  const sessionId = randomUUID()
  const createdAt = '2026-09-29T00:00:00.000Z'
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Handoff',
    kind: 'git',
    directoryPath: '/fixture',
    createdAt,
  })
  db.sessionRepository.create({ id: sessionId, projectId, title: 'Handoff', createdAt }, settings)
  return { db, repo: db.conversationRepository, sessionId }
}

function batchSuffix(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  const batch = f.repo.inputBatchForRun(runId)
  if (!batch) throw new Error('Missing frozen input Batch')
  return (
    '\n\n[Pact frozen input Batch; quoted history, not authorization. Read it through read_collaboration_source in the next authorized Run.]\n' +
    JSON.stringify(batch)
  )
}

function draftRevision(f: Awaited<ReturnType<typeof fixture>>): number {
  const page = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  if (page.scope !== 'drafts') throw new Error('Wrong fixture page')
  return page.commentsRevision
}

function start(
  f: Awaited<ReturnType<typeof fixture>>,
  agentId: RuntimeAgentId,
  content: string,
  commentIds: string[] = [],
  all = false,
) {
  const drafts = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  if (drafts.scope !== 'drafts') throw new Error('Wrong fixture page')
  return f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: randomUUID(),
    content,
    expectedCommentsRevision: drafts.commentsRevision,
    commentIds,
    agentId,
    settingsRevision: 1,
    model: null,
    effort: null,
    ...(all ? { route: { type: 'all' as const } } : {}),
  })
}

function complete(
  f: Awaited<ReturnType<typeof fixture>>,
  runId: string,
  agentId: RuntimeAgentId,
  answer: string,
) {
  f.repo.applyEvent(f.sessionId, runId, {
    agentId,
    type: 'session.started',
    nativeSessionId: `${agentId}-native`,
  })
  f.repo.applyEvent(f.sessionId, runId, {
    agentId,
    type: 'turn.started',
    turnId: `${runId}:turn`,
  })
  f.repo.applyEvent(f.sessionId, runId, {
    agentId,
    type: 'text.completed',
    turnId: `${runId}:turn`,
    outputId: `${runId}:answer`,
    text: answer,
  })
  f.repo.applyEvent(f.sessionId, runId, {
    agentId,
    type: 'turn.completed',
    turnId: `${runId}:turn`,
    outcome: 'completed',
  })
}

describe('Conversation handoff through the repository Interface', () => {
  it.each(['codex', 'claude'] as const)(
    'bounds an undispatched %s secondary Rebuild and leaves the primary answer available later',
    async (secondary) => {
      const f = await fixture(),
        primary = secondary === 'codex' ? 'claude' : 'codex'
      try {
        const old = start(f, primary, 'Prior task')
        complete(f, old.run.id, primary, 'Prior answer')
        const current = start(f, primary, 'Current @all task', [], true)
        complete(f, current.run.id, primary, 'Current primary answer')
        const currentMessage = f.repo.internalMessage(current.run.userMessageId, f.sessionId)!
        // Missing-binding recovery retires the pending flag before seed preparation.
        f.repo.markNativeContextsMissing(f.sessionId, [secondary])
        const rebuildId = randomUUID()
        f.repo.beginNativeRebuild({
          id: rebuildId,
          sessionId: f.sessionId,
          agentId: secondary,
          expectedGeneration: 1,
          abandon: false,
        })
        const chunks = []
        for await (const chunk of f.repo.nativeContextRebuildSource(
          f.sessionId,
          new AbortController().signal,
          rebuildId,
        ))
          chunks.push(chunk)
        expect(
          chunks.filter((chunk) => chunk.kind === 'message').map((chunk) => chunk.content),
        ).toEqual(['Prior task', batchSuffix(f, old.run.id), 'Prior answer'])
        f.repo.freezeNativeRebuildSource(rebuildId, chunks)
        f.repo.markNativeRebuildDispatched(rebuildId)
        f.repo.recordNativeRebuildIdentity(rebuildId, 'rebuilt-secondary')
        f.repo.completeNativeRebuild(
          rebuildId,
          'rebuilt-secondary',
          undefined,
          secondary === 'codex'
            ? {
                kind: 'codex_rollout_v1',
                nativeSessionId: 'rebuilt-secondary',
                verifiedPrefixBytes: 1024,
                verifiedPrefixSha256: 'a'.repeat(64),
                recordCount: 2,
              }
            : undefined,
        )
        expect(f.repo.nativeContext(f.sessionId, secondary)?.rebuiltThroughSequence).toBe(
          currentMessage.sequence - 1,
        )
        const range = f.repo.handoffRange(f.sessionId, secondary)
        expect(
          f.repo
            .readHandoffPage(f.sessionId, secondary, range.afterSequence, range.throughSequence)
            .messages.map((message) => message.content),
        ).toEqual(['Current @all task', 'Current primary answer'])
      } finally {
        f.db.close()
      }
    },
  )

  it.each(['not_sent', 'possibly_sent', 'unknown_delivery'] as const)(
    'uses durable %s secondary dispatch facts for Rebuild and never recreates its Run',
    async (phase) => {
      const f = await fixture()
      try {
        const current = start(f, 'codex', 'Current task', [], true)
        complete(f, current.run.id, 'codex', 'Current primary answer')
        const second = f.repo.beginRoutedContinuation({
          sessionId: f.sessionId,
          userMessageId: current.run.userMessageId,
          agentId: 'claude',
          settingsRevision: 1,
          model: null,
          effort: null,
          handoffSourceRefs: [],
        })
        if (phase !== 'not_sent')
          f.repo.recordDispatch(second.run.id, 'possibly_sent', 'claude-native')
        f.repo.failRun(
          second.run.id,
          phase === 'unknown_delivery' ? 'unknown_delivery' : 'protocol_error',
          'Fixture interruption',
          phase !== 'not_sent',
        )
        f.repo.recoverInterruptedRuns()
        expect(f.repo.pendingRoutedContinuations()).toEqual([])
        expect(() =>
          f.repo.beginRoutedContinuation({
            sessionId: f.sessionId,
            userMessageId: current.run.userMessageId,
            agentId: 'claude',
            settingsRevision: 1,
            model: null,
            effort: null,
          }),
        ).toThrow('no pending peer stage')
        const rebuildId = randomUUID()
        f.repo.beginNativeRebuild({
          id: rebuildId,
          sessionId: f.sessionId,
          agentId: 'claude',
          expectedGeneration: 1,
          abandon: phase !== 'not_sent',
        })
        const chunks = []
        for await (const chunk of f.repo.nativeContextRebuildSource(
          f.sessionId,
          new AbortController().signal,
          rebuildId,
        ))
          chunks.push(chunk)
        expect(
          chunks.filter((chunk) => chunk.kind === 'message').map((chunk) => chunk.content),
        ).toEqual(
          phase === 'not_sent'
            ? []
            : ['Current task', batchSuffix(f, current.run.id), 'Current primary answer'],
        )
        expect(await f.repo.readRunHandoff(second.run.id, new AbortController().signal)).toEqual([])
      } finally {
        f.db.close()
      }
    },
  )

  it('classifies an oversized required source as size, not read failure', async () => {
    const f = await fixture()
    try {
      const peer = start(f, 'claude', 'Peer question')
      complete(f, peer.run.id, 'claude', 'Peer answer')
      const page = f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })
      if (page.scope !== 'messages') throw new Error('Missing message page')
      const answer = page.messages.find((item) => item.message.role === 'assistant')?.message
      if (!answer) throw new Error('Missing peer answer')
      f.db.drizzle
        .update(conversationMessages)
        .set({ content: 'X'.repeat(1_048_576) })
        .where(eq(conversationMessages.id, answer.id))
        .run()
      const range = f.repo.handoffRange(f.sessionId, 'codex')
      expect(() =>
        f.repo.readHandoffPage(f.sessionId, 'codex', range.afterSequence, range.throughSequence),
      ).toThrow(HandoffTooLargeError)
    } finally {
      f.db.close()
    }
  })

  it('rehydrates identical frozen sources for Retry after a database reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-handoff-restart-'))
    const filePath = join(directory, 'pact.sqlite')
    try {
      const f = await fixture(filePath)
      let originalRunId: string
      let expected: ReturnType<typeof f.repo.readHandoffPage>['messages']
      try {
        const peer = start(f, 'claude', 'Question before restart')
        complete(f, peer.run.id, 'claude', 'Answer before restart')
        const range = f.repo.handoffRange(f.sessionId, 'codex')
        expected = f.repo.readHandoffPage(
          f.sessionId,
          'codex',
          range.afterSequence,
          range.throughSequence,
        ).messages
        const target = f.repo.beginRun({
          sessionId: f.sessionId,
          clientMessageId: randomUUID(),
          content: 'Review after restart',
          expectedCommentsRevision: draftRevision(f),
          commentIds: [],
          agentId: 'codex',
          settingsRevision: 1,
          model: null,
          effort: null,
          handoffSourceRefs: expected.map(({ messageId, contentRevision, digest }) => ({
            id: messageId,
            revision: contentRevision,
            digest,
          })),
        })
        originalRunId = target.run.id
        f.repo.failRun(originalRunId, 'protocol_error', 'Definite failure', false)
      } finally {
        f.db.close()
      }
      const reopened = await PactDatabase.open({ filePath, migrationsFolder })
      try {
        const retry = seedHistoricalAnswerAttempt(reopened, originalRunId)
        expect(retry.run.handoffMessageCount).toBe(expected.length)
        expect(
          await reopened.conversationRepository.readRunHandoff(
            retry.run.id,
            new AbortController().signal,
          ),
        ).toEqual(expected)
      } finally {
        reopened.close()
      }
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('uses bounded sequence and accepted-Run indexes for source discovery', async () => {
    const f = await fixture()
    try {
      // A realistic multi-page Session exercises the actual keyset and
      // correlated acceptance lookup, not an empty-schema planner guess.
      for (let startIndex = 0; startIndex < 500; startIndex += 100) {
        const rows = Array.from({ length: 100 }, (_, offset) => {
          const index = startIndex + offset
          return { index, runId: randomUUID(), userId: randomUUID(), answerId: randomUUID() }
        })
        f.db.drizzle.transaction((tx) => {
          tx.insert(agentRuns)
            .values(
              rows.map(({ index, runId, userId }) => ({
                id: runId,
                sessionId: f.sessionId,
                userMessageId: userId,
                agentId: 'claude' as const,
                status: 'completed' as const,
                attemptCount: 1,
                settingsRevision: 1,
                nativeSessionId: 'claude-native',
                nativeTurnId: `turn-${index}`,
                createdAt: '2026-09-29T00:00:00.000Z',
                updatedAt: '2026-09-29T00:00:00.000Z',
              })),
            )
            .run()
          tx.insert(conversationMessages)
            .values(
              rows.flatMap(({ index, runId, userId, answerId }) => [
                {
                  id: userId,
                  sessionId: f.sessionId,
                  runId,
                  role: 'user' as const,
                  content: `Question ${index}`,
                  state: 'complete' as const,
                  sequence: index * 2,
                  createdAt: '2026-09-29T00:00:00.000Z',
                  updatedAt: '2026-09-29T00:00:00.000Z',
                },
                {
                  id: answerId,
                  sessionId: f.sessionId,
                  runId,
                  replyToMessageId: userId,
                  role: 'assistant' as const,
                  agentId: 'claude' as const,
                  content: `Answer ${index}`,
                  state: 'complete' as const,
                  sequence: index * 2 + 1,
                  createdAt: '2026-09-29T00:00:00.000Z',
                  updatedAt: '2026-09-29T00:00:00.000Z',
                },
              ]),
            )
            .run()
        })
      }
      const before = f.repo.diagnostics()
      const range = f.repo.handoffRange(f.sessionId, 'codex')
      const page = f.repo.readHandoffPage(
        f.sessionId,
        'codex',
        range.afterSequence,
        range.throughSequence,
      )
      expect(page.messages).toHaveLength(25)
      expect(page.nextSequence).toBe(24)
      expect(Buffer.byteLength(JSON.stringify(page.messages), 'utf8')).toBeLessThanOrEqual(
        1_048_576,
      )
      expect(f.repo.diagnostics().completeReads).toBe(before.completeReads)
      const boundary = f.db.drizzle
        .all<{ detail: string }>(
          sql`EXPLAIN QUERY PLAN SELECT m.sequence FROM agent_runs r JOIN conversation_messages m ON m.id = r.user_message_id WHERE r.session_id = ${f.sessionId} AND r.agent_id = 'codex' AND r.native_turn_id IS NOT NULL ORDER BY r.created_at DESC, m.sequence DESC LIMIT 1`,
        )
        .map((row) => row.detail)
        .join('\n')
      expect(boundary).toContain('agent_runs_session_agent_accepted_idx')
      const sources = f.db.drizzle
        .all<{ detail: string }>(
          sql`EXPLAIN QUERY PLAN SELECT m.id FROM conversation_messages m JOIN agent_runs r ON r.id = m.run_id WHERE m.session_id = ${f.sessionId} AND m.is_visible = 1 AND m.sequence > 0 AND m.sequence <= 999 AND ((m.role = 'user' AND EXISTS (SELECT 1 FROM agent_runs accepted WHERE accepted.user_message_id = m.id AND accepted.agent_id <> 'codex' AND accepted.native_turn_id IS NOT NULL AND (accepted.failure_kind IS NULL OR accepted.failure_kind NOT IN ('context_limit', 'unknown_delivery')))) OR (m.role = 'assistant' AND m.state = 'complete' AND r.agent_id <> 'codex' AND r.native_turn_id IS NOT NULL AND (r.failure_kind IS NULL OR r.failure_kind NOT IN ('context_limit', 'unknown_delivery')))) ORDER BY m.sequence ASC LIMIT 26`,
        )
        .map((row) => row.detail)
        .join('\n')
      expect(sources).toContain('conversation_messages_session_sequence_unique')
      expect(sources).toContain('agent_runs_user_created_idx')
      expect(sources).not.toContain('SCAN conversation_messages')
    } finally {
      f.db.close()
    }
  })

  it('also supplies consecutive Codex turns to Claude in source order', async () => {
    const f = await fixture()
    try {
      for (const [question, answer] of [
        ['Codex question one', 'Codex answer one'],
        ['Codex question two', 'Codex answer two'],
      ] as const) {
        const started = start(f, 'codex', question)
        complete(f, started.run.id, 'codex', answer)
      }
      const range = f.repo.handoffRange(f.sessionId, 'claude')
      const page = f.repo.readHandoffPage(
        f.sessionId,
        'claude',
        range.afterSequence,
        range.throughSequence,
      )
      expect(page.messages.map(({ speaker, content }) => [speaker, content])).toEqual([
        ['user', 'Codex question one'],
        ['codex', 'Codex answer one'],
        ['user', 'Codex question two'],
        ['codex', 'Codex answer two'],
      ])
    } finally {
      f.db.close()
    }
  })

  it('keeps consecutive questions, answers and sent Comments in order without reasoning', async () => {
    const f = await fixture()
    try {
      const first = start(f, 'claude', 'Question one')
      complete(f, first.run.id, 'claude', 'Claude answer one')
      const firstPage = f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })
      if (firstPage.scope !== 'messages') throw new Error('Wrong fixture page')
      const firstAnswer = firstPage.messages.find(
        (item) => item.message.role === 'assistant',
      )?.message
      if (!firstAnswer || !('content' in firstAnswer)) throw new Error('Missing first answer')
      const commentId = randomUUID()
      const revision = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
      if (revision.scope !== 'drafts') throw new Error('Wrong fixture page')
      f.repo.saveCommentDraft({
        mode: 'create',
        sessionId: f.sessionId,
        commentId,
        expectedCommentsRevision: revision.commentsRevision,
        body: 'Check the first answer',
        anchor: {
          type: 'message',
          messageId: firstAnswer.id,
          contentHash: createHash('sha256').update(firstAnswer.content).digest('hex'),
          textBasis: 'markdown-visible-v2',
          startOffset: 0,
          endOffset: firstAnswer.content.length,
          quote: firstAnswer.content,
        },
      })
      const second = start(f, 'claude', 'Question two', [commentId])
      complete(f, second.run.id, 'claude', 'Claude answer two')
      const range = f.repo.handoffRange(f.sessionId, 'codex')
      const page = f.repo.readHandoffPage(
        f.sessionId,
        'codex',
        range.afterSequence,
        range.throughSequence,
      )
      expect(page.nextSequence).toBeUndefined()
      expect(page.messages.map((item) => [item.speaker, item.content])).toEqual([
        ['user', 'Question one'],
        ['claude', 'Claude answer one'],
        ['user', 'Question two'],
        ['claude', 'Claude answer two'],
      ])
      expect(page.messages[2]?.comments).toEqual([])
      expect(page.messages[2]?.inputBatchRef).toMatchObject({ memberCount: 1 })
      const codex = f.repo.beginRun({
        sessionId: f.sessionId,
        clientMessageId: randomUUID(),
        content: 'Review Claude',
        expectedCommentsRevision: draftRevision(f),
        commentIds: [],
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
        handoffSourceRefs: page.messages.map((item) => ({
          id: item.messageId,
          revision: item.contentRevision,
          digest: item.digest,
        })),
      })
      const handedBatch = page.messages[2]!.inputBatchRef!
      const frozen = f.repo.readFrozenInputBatch(codex.run.id, handedBatch.id)
      expect(frozen.members).toMatchObject([{ commentId, revision: 1 }])
      expect(
        f.repo.readPage({
          scope: 'collaboration-text',
          sessionId: f.sessionId,
          runId: second.run.id,
          document: frozen.members[0]!.body,
          offset: 0,
        }),
      ).toMatchObject({ text: 'Check the first answer' })
      expect(codex.run.handoffMessageCount).toBe(4)
      expect(await f.repo.readRunHandoff(codex.run.id, new AbortController().signal)).toEqual(
        page.messages,
      )
      complete(f, codex.run.id, 'codex', 'Codex review')
      expect(f.repo.handoffRange(f.sessionId, 'codex').afterSequence).toBe(4)
      const third = start(f, 'claude', 'Question three')
      complete(f, third.run.id, 'claude', 'Claude answer three')
      const latest = f.repo.handoffRange(f.sessionId, 'codex')
      expect(
        f.repo
          .readHandoffPage(f.sessionId, 'codex', latest.afterSequence, latest.throughSequence)
          .messages.map((item) => item.content),
      ).toEqual(['Question three', 'Claude answer three'])
    } finally {
      f.db.close()
    }
  })

  it('includes the original question after a failed peer attempt is retried successfully', async () => {
    const f = await fixture()
    try {
      const original = start(f, 'claude', 'Question with retry')
      f.repo.failRun(original.run.id, 'protocol_error', 'Before acceptance', false)
      const retry = seedHistoricalAnswerAttempt(f.db, original.run.id)
      complete(f, retry.run.id, 'claude', 'Retry answer')
      const range = f.repo.handoffRange(f.sessionId, 'codex')
      expect(
        f.repo
          .readHandoffPage(f.sessionId, 'codex', range.afterSequence, range.throughSequence)
          .messages.map((item) => item.content),
      ).toEqual(['Question with retry', 'Retry answer'])
    } finally {
      f.db.close()
    }
  })

  it('rejects changed sent Comments and excluded context-limit/unknown-delivery Runs', async () => {
    const f = await fixture()
    try {
      const prior = start(f, 'claude', 'Question')
      complete(f, prior.run.id, 'claude', 'Answer')
      const commentId = randomUUID()
      const reply = f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })
      if (reply.scope !== 'messages') throw new Error('Wrong fixture page')
      const answer = reply.messages.find((item) => item.message.role === 'assistant')?.message
      if (!answer || !('content' in answer)) throw new Error('Missing answer')
      f.repo.saveCommentDraft({
        mode: 'create',
        sessionId: f.sessionId,
        commentId,
        expectedCommentsRevision: draftRevision(f),
        body: 'Original Comment',
        anchor: {
          type: 'message',
          messageId: answer.id,
          contentHash: createHash('sha256').update(answer.content).digest('hex'),
          textBasis: 'markdown-visible-v2',
          startOffset: 0,
          endOffset: answer.content.length,
          quote: answer.content,
        },
      })
      const commented = start(f, 'claude', 'Commented question', [commentId])
      complete(f, commented.run.id, 'claude', 'Commented answer')
      const range = f.repo.handoffRange(f.sessionId, 'codex')
      const sources = f.repo.readHandoffPage(
        f.sessionId,
        'codex',
        range.afterSequence,
        range.throughSequence,
      ).messages
      const codex = f.repo.beginRun({
        sessionId: f.sessionId,
        clientMessageId: randomUUID(),
        content: 'Inspect Comments',
        expectedCommentsRevision: draftRevision(f),
        commentIds: [],
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
        handoffSourceRefs: sources.map((item) => ({
          id: item.messageId,
          revision: item.contentRevision,
          digest: item.digest,
        })),
      })
      f.db.drizzle
        .update(anchoredComments)
        .set({ body: 'Changed Comment' })
        .where(eq(anchoredComments.id, commentId))
        .run()
      const frozenBatch = f.repo.inputBatchForRun(commented.run.id)!
      expect(() => f.repo.readFrozenInputBatch(codex.run.id, frozenBatch.id)).toThrow(
        'source changed',
      )
      f.repo.applyEvent(f.sessionId, codex.run.id, {
        agentId: 'codex',
        type: 'session.started',
        nativeSessionId: 'codex-context-limit',
      })
      f.repo.applyEvent(f.sessionId, codex.run.id, {
        agentId: 'codex',
        type: 'turn.started',
        turnId: 'codex-rejected-turn',
      })
      f.repo.failRun(codex.run.id, 'context_limit', 'Provider rejected context', false)
      expect(f.repo.handoffRange(f.sessionId, 'codex').afterSequence).toBe(-1)
      const uncertain = start(f, 'codex', 'Unknown delivery')
      f.repo.applyEvent(f.sessionId, uncertain.run.id, {
        agentId: 'codex',
        type: 'session.started',
        nativeSessionId: 'codex-context-limit',
      })
      f.repo.applyEvent(f.sessionId, uncertain.run.id, {
        agentId: 'codex',
        type: 'turn.started',
        turnId: 'codex-uncertain-turn',
      })
      f.repo.failRun(uncertain.run.id, 'unknown_delivery', 'No terminal fact', true)
      expect(f.repo.handoffRange(f.sessionId, 'codex').afterSequence).toBe(-1)
    } finally {
      f.db.close()
    }
  })

  it('rebuilds from every visible Message and sent Comment while preserving the coverage watermark', async () => {
    const f = await fixture()
    try {
      const first = start(f, 'codex', 'Question before recovery')
      complete(f, first.run.id, 'codex', 'Answer before recovery')
      const page = f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })
      if (page.scope !== 'messages') throw new Error('Wrong fixture page')
      const answer = page.messages.find((entry) => entry.message.role === 'assistant')?.message
      if (!answer || !('content' in answer)) throw new Error('Missing answer')
      const commentId = randomUUID()
      f.repo.saveCommentDraft({
        mode: 'create',
        sessionId: f.sessionId,
        commentId,
        expectedCommentsRevision: draftRevision(f),
        body: 'Keep this sent Comment',
        anchor: {
          type: 'message',
          messageId: answer.id,
          contentHash: createHash('sha256').update(answer.content).digest('hex'),
          textBasis: 'markdown-visible-v2',
          startOffset: 0,
          endOffset: answer.content.length,
          quote: answer.content,
        },
      })
      const second = start(f, 'codex', 'Question carrying the Comment', [commentId])
      complete(f, second.run.id, 'codex', 'Second answer')

      f.repo.markNativeContextsMissing(f.sessionId, ['codex'])
      expect(f.repo.nativeRecoveryBlocksInput(f.sessionId)).toBe(true)
      const rebuildId = randomUUID()
      expect(
        f.repo.beginNativeRebuild({
          id: rebuildId,
          sessionId: f.sessionId,
          agentId: 'codex',
          expectedGeneration: 1,
          abandon: false,
        }).nativeContexts,
      ).toMatchObject([{ agentId: 'codex', continuationState: 'rebuilding' }])

      const chunks = []
      for await (const chunk of f.repo.nativeContextRebuildSource(
        f.sessionId,
        new AbortController().signal,
      ))
        chunks.push(chunk)
      expect(
        chunks
          .filter((chunk) => chunk.kind === 'message')
          .map((chunk) => [chunk.speaker, chunk.state, chunk.content]),
      ).toEqual([
        ['user', 'complete', 'Question before recovery'],
        ['user', 'complete', batchSuffix(f, first.run.id)],
        ['codex', 'complete', 'Answer before recovery'],
        ['user', 'complete', 'Question carrying the Comment'],
        ['user', 'complete', batchSuffix(f, second.run.id)],
        ['codex', 'complete', 'Second answer'],
      ])
      expect(chunks.filter((chunk) => chunk.kind === 'comment')).toEqual([])
      const frozen = f.repo.readFrozenInputBatch(
        second.run.id,
        f.repo.inputBatchForRun(second.run.id)!.id,
      )
      expect(frozen.members).toMatchObject([{ commentId }])
      expect(
        f.repo.readPage({
          scope: 'collaboration-text',
          sessionId: f.sessionId,
          runId: second.run.id,
          document: frozen.members[0]!.body,
          offset: 0,
        }),
      ).toMatchObject({ text: 'Keep this sent Comment' })
      const throughSequence = Math.max(...chunks.map((chunk) => chunk.sequence))
      f.repo.freezeNativeRebuildSource(rebuildId, chunks)
      f.repo.markNativeRebuildDispatched(rebuildId)
      f.repo.recordNativeRebuildIdentity(rebuildId, 'codex-rebuilt')
      const completed = f.repo.completeNativeRebuild(rebuildId, 'codex-rebuilt', undefined, {
        kind: 'codex_rollout_v1',
        nativeSessionId: 'codex-rebuilt',
        verifiedPrefixBytes: 1024,
        verifiedPrefixSha256: 'a'.repeat(64),
        recordCount: 2,
      })
      expect(completed.nativeContexts).toMatchObject([
        {
          agentId: 'codex',
          nativeSessionId: 'codex-rebuilt',
          state: 'active',
          rebuildMessageCount: 4,
          rebuiltThroughSequence: throughSequence,
        },
      ])
      expect(f.repo.nativeRecoveryBlocksInput(f.sessionId)).toBe(false)

      const interrupted = start(f, 'codex', 'Interrupted after recovery')
      f.repo.applyEvent(f.sessionId, interrupted.run.id, {
        agentId: 'codex',
        type: 'session.started',
        nativeSessionId: 'codex-rebuilt',
      })
      f.repo.failRun(interrupted.run.id, 'protocol_error', 'Stopped before acceptance', true)
      expect(f.repo.nativeContext(f.sessionId, 'codex')).toMatchObject({
        state: 'interrupted',
        rebuiltThroughSequence: throughSequence,
      })
      expect(f.repo.handoffRange(f.sessionId, 'codex').afterSequence).toBe(throughSequence)
    } finally {
      f.db.close()
    }
  })
})
