import { eq } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type {
  ConversationMessageRoute,
  ConversationPatch,
  NativeContextRebuildChunk,
} from '@pact/contracts'

import { PactDatabase } from './pact-database.js'
import {
  agentRuns,
  anchoredComments,
  conversationMessages,
  nativeAgentContexts,
} from './schema/index.js'

export const inputReturnTimestamp = '2026-10-05T00:00:00.000Z'

export async function createInputReturnFixture(
  options: {
    content?: string
    comments?: string[]
    route?: ConversationMessageRoute
    filePath?: string
    run?: Partial<typeof agentRuns.$inferInsert>
  } = {},
) {
  const db = await PactDatabase.open({
    filePath: options.filePath ?? ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
  })
  try {
    const repo = db.conversationRepository
    const sessionId = randomUUID(),
      projectId = randomUUID()
    const messageId = randomUUID(),
      nativeId = randomUUID()
    const route = options.route ?? { type: 'agent' as const, agentId: 'codex' as const }
    const agentId = route.type === 'all' ? route.firstAgentId : route.agentId
    const content = options.content ?? '@codex original request'
    const quotedContent = content || 'An earlier message that the Comment quotes.'
    const quotedMessageId = content ? messageId : randomUUID()
    const now = inputReturnTimestamp
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Owned input return fixture',
      directoryPath: '/owned/input-return',
      kind: 'directory',
      createdAt: now,
    })
    const settings = {
      primaryAgentId: 'codex' as const,
      agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
      maxDiscussionRounds: 3,

      maxReviewCycles: 2,
      maxRepairAttempts: 2,
    }
    db.sessionRepository.create(
      { id: sessionId, projectId, title: 'Recovery', createdAt: now },
      settings,
    )
    if (!content) {
      const earlier = repo.beginRun({
        sessionId,
        clientMessageId: quotedMessageId,
        content: quotedContent,
        expectedCommentsRevision: 0,
        commentIds: [],
        agentId,
        settingsRevision: 1,
        model: null,
        effort: null,
        route,
      })
      db.drizzle
        .update(agentRuns)
        .set({
          status: 'completed',
          nativeOutcome: 'completed',
          nativeEffectsState: 'settled',
          dispatchPhase: 'ended',
        })
        .where(eq(agentRuns.id, earlier.run.id))
        .run()
    }
    ;(options.comments ?? []).forEach((body, position) => {
      const id = randomUUID()
      db.drizzle
        .insert(anchoredComments)
        .values({
          id,
          sessionId,
          body,
          anchorJson: JSON.stringify({
            type: 'message',
            messageId: quotedMessageId,
            contentHash: createHash('sha256').update(quotedContent).digest('hex'),
            textBasis: 'markdown-visible-v2',
            startOffset: 0,
            endOffset: Math.min(5, quotedContent.length),
            quote: quotedContent.slice(0, 5),
          }),
          position,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    })
    const started = repo.beginRun({
      sessionId,
      clientMessageId: messageId,
      content,
      expectedCommentsRevision: repo.read(sessionId).commentsRevision,
      commentIds: [],
      agentId,
      settingsRevision: 1,
      model: null,
      effort: null,
      route,
    })
    const runId = started.run.id
    db.drizzle
      .update(agentRuns)
      .set({
        status: 'failed',
        failureKind: 'native_session_occupied',
        failureMessage: 'Owned writer conflict',
        dispatchPhase: 'rejected',
        nativeEffectsState: 'settled',
        nativeSessionId: nativeId,
        ...options.run,
      })
      .where(eq(agentRuns.id, runId))
      .run()
    db.drizzle
      .insert(nativeAgentContexts)
      .values({
        sessionId,
        agentId,
        nativeSessionId: nativeId,
        bindingGeneration: 1,
        lastRunId: runId,
        state: 'active',
        continuationState: 'recovery_required',
        recoveryFailureKind: 'native_session_occupied',
        recoveryAction: 'rebuild',
        updatedAt: now,
      })
      .run()
    const sourceComments = db.drizzle
      .select()
      .from(anchoredComments)
      .where(eq(anchoredComments.sentWithMessageId, messageId))
      .all()

    const rebuild = async (
      rebuildOptions: {
        generation?: number
        abandon?: boolean
        onPatch?: (patch: ConversationPatch) => void
      } = {},
    ) => {
      const operationId = randomUUID(),
        candidateId = randomUUID()
      const beginning = repo.beginNativeRebuild({
        id: operationId,
        sessionId,
        agentId,
        expectedGeneration:
          rebuildOptions.generation ??
          repo.nativeContext(sessionId, agentId)?.bindingGeneration ??
          1,
        abandon: rebuildOptions.abandon ?? false,
      })
      rebuildOptions.onPatch?.(beginning)
      const chunks: NativeContextRebuildChunk[] = []
      for await (const chunk of repo.nativeContextRebuildSource(
        sessionId,
        new AbortController().signal,
        operationId,
      ))
        chunks.push(chunk)
      repo.freezeNativeRebuildSource(operationId, chunks)
      repo.markNativeRebuildDispatched(operationId)
      repo.recordNativeRebuildIdentity(operationId, candidateId)
      const patch = repo.completeNativeRebuild(
        operationId,
        candidateId,
        undefined,
        agentId === 'codex'
          ? {
              kind: 'codex_rollout_v1',
              nativeSessionId: candidateId,
              verifiedPrefixBytes: 1024,
              verifiedPrefixSha256: 'a'.repeat(64),
              recordCount: 2,
            }
          : undefined,
      )
      return { operationId, candidateId, chunks, patch }
    }
    const revision = () => repo.read(sessionId).commentsRevision
    const drafts = () => {
      const page = repo.readPage({ scope: 'drafts', sessionId })
      if (page.scope !== 'drafts') throw new Error('Unexpected draft page')
      return page.comments
    }
    const send = (extra: Partial<Parameters<typeof repo.beginRun>[0]> = {}) =>
      repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content,
        expectedCommentsRevision: revision(),
        commentIds: drafts().map((item) => item.id),
        agentId,
        settingsRevision: 1,
        model: null,
        effort: null,
        route,
        ...extra,
      })
    const sourceMessage = () =>
      db.drizzle
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, messageId))
        .get()!
    const sourceRun = () =>
      db.drizzle.select().from(agentRuns).where(eq(agentRuns.id, runId)).get()!
    return {
      db,
      repo,
      sessionId,
      projectId,
      messageId,
      runId,
      nativeId,
      agentId,
      route,
      content,
      sourceComments,
      settings,
      rebuild,
      revision,
      drafts,
      send,
      sourceMessage,
      sourceRun,
    }
  } catch (error) {
    db.close()
    throw error
  }
}

export type InputReturnFixture = Awaited<ReturnType<typeof createInputReturnFixture>>
