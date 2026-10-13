import { eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  AgentNativeForkWitness,
  DefaultSessionSettings,
  RuntimeAgentId,
  CollaborationResult,
  CollaborationTodoDelta,
} from '@pact/contracts'

import { collaborationTaskSchema, prepareCollaborationSupplement } from '@pact/contracts'

import { PactDatabase } from './pact-database.js'
import {
  agentRuns,
  collaborationInputs,
  anchoredComments,
  conversationMessages,
  nativeAgentContexts,
  nativeForkCandidateReceipts,
  sessionForkOperations,
  sessions,
  workspaceChangeSets,
} from './schema/index.js'

const ownedDatabases: PactDatabase[] = []
const ownedDirectories: string[] = []
afterEach(async () => {
  for (const db of ownedDatabases.splice(0)) db.close()
  await Promise.all(
    ownedDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const timestamp = '2026-10-04T00:00:00.000Z'
const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const agents = ['claude', 'codex'] as const
const settings: DefaultSessionSettings = {
  primaryAgentId: 'claude',
  agents: {
    claude: { model: 'fixture-claude', effort: 'high' },
    codex: { model: 'fixture-codex', effort: 'high' },
  },
  maxDiscussionRounds: 3,
  runningMessagePolicy: 'next_round',
  maxReviewCycles: 2,
  maxRepairAttempts: 2,
}

async function fixture(filePath = ':memory:', withCollaboration = false) {
  const db = await PactDatabase.open({ filePath, migrationsFolder })
  ownedDatabases.push(db)
  const projectId = randomUUID(),
    sourceId = randomUUID()
  const messageIds: string[] = Array.from({ length: 4 }, () => randomUUID())
  const runIds: string[] = agents.map(() => randomUUID())
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Fork',
    directoryPath: '/owned/fork',
    kind: 'directory',
    createdAt: timestamp,
  })
  db.sessionRepository.create(
    { id: sourceId, projectId, title: 'Source', createdAt: timestamp },
    settings,
  )
  db.sessionRepository.saveSettings(sourceId, {
    ...settings,
    permissionModes: { claude: 'full', codex: 'ask' },
  })
  if (!withCollaboration) {
    for (const [index, agentId] of agents.entries()) {
      db.drizzle
        .insert(agentRuns)
        .values({
          id: runIds[index]!,
          sessionId: sourceId,
          userMessageId: messageIds[index * 2]!,
          agentId,
          status: 'completed',
          attemptCount: 1,
          settingsRevision: 1,
          model: settings.agents[agentId].model,
          effort: 'high',
          nativeSessionId: `source-${agentId}`,
          nativeTurnId: runIds[index]!,
          nativeOutcome: 'completed',
          nativeEffectsState: 'settled',
          dispatchPhase: 'ended',
          ...(index === 0
            ? {
                peerProposalId: randomUUID(),
                peerProposalTargetAgentId: 'codex' as const,
                peerProposalKind: 'review' as const,
                peerProposalState: 'dismissed' as const,
              }
            : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run()
    }
    for (const [index, id] of messageIds.entries())
      db.drizzle
        .insert(conversationMessages)
        .values({
          id,
          sessionId: sourceId,
          runId: runIds[Math.floor(index / 2)]!,
          role: index % 2 ? 'assistant' : 'user',
          agentId: index % 2 ? agents[Math.floor(index / 2)]! : null,
          replyToMessageId: index % 2 ? messageIds[index - 1]! : null,
          content: `message-${index}`,
          state: 'complete',
          sequence: index,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run()
    const anchor = {
      type: 'message' as const,
      messageId: messageIds[1]!,
      contentHash: hash('message-1'),
      textBasis: 'markdown-visible-v2' as const,
      startOffset: 0,
      endOffset: 9,
      quote: 'message-1',
    }
    db.drizzle
      .insert(anchoredComments)
      .values([
        {
          id: randomUUID(),
          sessionId: sourceId,
          body: 'Sent',
          anchorJson: JSON.stringify(anchor),
          position: 0,
          sentWithMessageId: messageIds[2]!,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: randomUUID(),
          sessionId: sourceId,
          body: 'Draft',
          anchorJson: JSON.stringify(anchor),
          position: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ])
      .run()
  } else {
    const repo = db.conversationRepository
    const revision = () => {
      const page = repo.readPage({ scope: 'drafts', sessionId: sourceId })
      if (page.scope !== 'drafts') throw Error('Missing draft fixture')
      return page.commentsRevision
    }
    const taskMessageId = messageIds[0]!
    const initial = collaborationTaskSchema.parse({
      id: randomUUID(),
      sessionId: sourceId,
      kind: 'plan',
      revision: 0,
      primary: 'codex',
      drafter: 'claude',
      implementer: 'claude',
      reviewer: 'codex',
      task: 'Implement cancellation.',
      taskMessageId: taskMessageId,
      stage: 'draft',
      actor: 'claude',
      status: 'running',
      runId: taskMessageId,
      planVersion: 0,
      discussionRounds: 0,
      discussionHalf: false,
      reviewCycles: 0,
      repairAttempts: 0,
      rereview: false,
      nextCycle: false,
    })
    const finish = (runId: string, report: CollaborationResult) => {
      const run = repo.findRun(runId)!
      const auth = repo.collaborationTurnAuthorization(runId)!
      const required = repo.readRequiredInputMembers(runId).items
      const normalized = {
        ...report,
        submission: auth.duty,
        inputResponses: required.map((item) => ({
          batchId: item.batchId,
          memberId: item.memberId,
          disposition: 'resolved' as const,
          reason: 'Handled the original request and its exact source.',
          todoId: null,
        })),
      }
      const answer = run.agentId === 'claude' ? 'message-1' : 'message-3'
      repo.applyEvent(sourceId, runId, {
        type: 'session.started',
        agentId: run.agentId,
        nativeSessionId: `source-${run.agentId}`,
      })
      repo.applyEvent(sourceId, runId, {
        type: 'turn.started',
        agentId: run.agentId,
        turnId: runId,
      })
      repo.recordCollaborationCarrier(runId, {
        version: 'pact-collaboration-envelope-v5',
        answer,
        result: normalized,
      })
      repo.recordCollaborationResult(runId, normalized)
      repo.applyEvent(sourceId, runId, {
        type: 'text.completed',
        agentId: run.agentId,
        turnId: runId,
        outputId: runId,
        text: answer,
      })
      repo.recordNativeEvidence({
        kind: 'ended',
        source: 'stored_terminal',
        outcome: 'completed',
        identity: {
          sessionId: sourceId,
          agentId: run.agentId,
          requestId: runId,
          runId,
          nativeSessionId: `source-${run.agentId}`,
          nativeTurnId: runId,
          bindingGeneration: 1,
          answerFormat: 'collaboration_envelope_v5',
        },
      })
      repo.applyEvent(sourceId, runId, {
        type: 'turn.completed',
        agentId: run.agentId,
        turnId: runId,
        outcome: 'completed',
      })
      db.drizzle
        .update(agentRuns)
        .set({ nativeEffectsState: 'settled' })
        .where(eq(agentRuns.id, runId))
        .run()
      if (repo.collaboration(sourceId)?.reportFailure)
        throw Error(repo.collaboration(sourceId)?.notice)
      return repo.findRun(runId)!.responseMessageId!
    }
    const opinion: CollaborationTodoDelta = {
      todoId: 'ownership',
      expectedRevision: 0,
      operation: 'create',
      kind: 'opinion',
      title: 'Keep ownership together',
      detail: 'Dispose with the request owner.',
      recommendation: 'Use the existing lifecycle.',
      evidence: null,
      question: null,
      resolutionKind: null,
      reason: '',
      mergeTargetId: null,
      userSourceIds: [],
      evidenceRefs: [],
    }
    const first = repo.beginRun({
      sessionId: sourceId,
      clientMessageId: taskMessageId,
      content: 'message-0',
      expectedCommentsRevision: revision(),
      commentIds: [],
      agentId: 'claude',
      settingsRevision: 2,
      model: settings.agents.claude.model,
      effort: 'high',
      collaboration: initial,
    })
    runIds[0] = first.run.id
    messageIds[1] = finish(first.run.id, {
      submission: 'plan_submission',
      outcome: 'complete',
      summary: 'Draft ready for review.',
      plan: 'Draft plan',
      todoDeltas: [opinion],
      inputResponses: [],
    })
    const draft = repo.collaboration(sourceId)!
    repo.saveCommentDraft({
      mode: 'create',
      sessionId: sourceId,
      commentId: randomUUID(),
      expectedCommentsRevision: revision(),
      body: 'Sent',
      anchor: {
        type: 'message',
        messageId: messageIds[1],
        contentHash: hash('message-1'),
        textBasis: 'markdown-visible-v2',
        startOffset: 0,
        endOffset: 9,
        quote: 'message-1',
      },
    })
    repo.saveCommentDraft({
      mode: 'create',
      sessionId: sourceId,
      commentId: randomUUID(),
      expectedCommentsRevision: revision(),
      body: 'Plan reference',
      anchor: {
        type: 'message',
        messageId: taskMessageId,
        plan: { runId: runIds[0], version: 1 },
        contentHash: hash('Draft plan'),
        textBasis: 'markdown-visible-v2',
        startOffset: 0,
        endOffset: 5,
        quote: 'Draft',
      },
    })
    const next = prepareCollaborationSupplement(draft, 'codex', settings, 'maintain_plan')
    const second = repo.beginRun({
      sessionId: sourceId,
      clientMessageId: messageIds[2]!,
      content: 'message-2',
      expectedCommentsRevision: revision(),
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 2,
      model: settings.agents.codex.model,
      effort: 'high',
      collaboration: next,
    })
    runIds[1] = second.run.id
    messageIds[3] = finish(second.run.id, {
      submission: 'plan_adoption',
      outcome: 'complete',
      summary: 'One opinion needs confirmation.',
      plan: 'Confirmed plan',
      todoDeltas: [
        {
          ...opinion,
          operation: 'propose_resolution',
          expectedRevision: 1,
          resolutionKind: 'not_adopted',
          reason: 'The request already belongs to its lifecycle owner.',
        },
      ],
      inputResponses: [],
    })
    repo.saveCommentDraft({
      mode: 'create',
      sessionId: sourceId,
      commentId: randomUUID(),
      expectedCommentsRevision: revision(),
      body: 'Draft',
      anchor: {
        type: 'message',
        messageId: messageIds[1],
        contentHash: hash('message-1'),
        textBasis: 'markdown-visible-v2',
        startOffset: 0,
        endOffset: 9,
        quote: 'message-1',
      },
    })
  }
  const source = db.sessionRepository.find(sourceId)!
  const select = (messageId = messageIds[3]!) =>
    db.conversationRepository.selectForkSource(
      sourceId,
      messageId,
      source.settings,
      source.settingsRevision,
    )
  const boundary = (agentId: RuntimeAgentId, index: number) => ({
    nativeSessionId: `source-${agentId}`,
    nativeCutId: runIds[index]!,
    nativeTurnId: runIds[index]!,
    bindingGeneration: 1,
    throughSequence: index * 2 + 1,
    deliveryCursor: index * 2,
    prefixHash: hash(agentId),
    prefixRecords: 2,
    prefixBytes: 100,
  })
  const boundaries = { claude: boundary('claude', 0), codex: boundary('codex', 1) }
  const commit = (operationId = randomUUID()) =>
    db.conversationRepository.commitFork(operationId, select(), boundaries, ['claude'])
  return {
    db,
    repo: db.conversationRepository,
    sourceId,
    messageIds,
    runIds,
    select,
    commit,
    boundaries,
  }
}
function witness(
  f: Awaited<ReturnType<typeof fixture>>,
  agentId: RuntimeAgentId,
  nativeSessionId = `child-${agentId}`,
): AgentNativeForkWitness {
  return {
    version: 'pact-native-fork-v1',
    sourceNativeSessionId: f.boundaries[agentId].nativeSessionId,
    nativeSessionId,
    sourceCutId: f.boundaries[agentId].nativeCutId,
    sourcePrefixHash: f.boundaries[agentId].prefixHash,
    candidatePrefixHash: f.boundaries[agentId].prefixHash,
    idMap: [[f.boundaries[agentId].nativeTurnId, f.boundaries[agentId].nativeTurnId]],
    model: settings.agents[agentId].model,
    effort: 'high',
    permissionMode: agentId === 'claude' ? 'full' : 'ask',
    initializedAt: timestamp,
    initializedPrefixHash: hash(`initialized-${agentId}`),
    initializedPrefixBytes: 100,
    initializedPrefixRecords: 2,
  }
}

describe('Frozen Fork through ConversationRepository', () => {
  it('copies exact Todo revisions, plan sources and Batch members as readonly history without dispatch authority', async () => {
    const f = await fixture(':memory:', true)
    const sourceTask = f.repo.collaboration(f.sourceId)!
    expect(sourceTask).toMatchObject({ planVersion: 2, ledgerAwaitingCount: 1 })
    const sourceTodo = f.repo.readTodoRevision(sourceTask.id, 'ownership', 2)
    expect(sourceTodo).toMatchObject({ status: 'awaiting_review', resolutionKind: 'not_adopted' })
    const child = f.commit(),
      page = f.repo.read(child.sessionId)
    const inheritedTask = page.runs.find((run) => run.agentId === 'codex')!
    const inherited = f.repo.readPage({
      scope: 'collaboration',
      sessionId: child.sessionId,
      runId: inheritedTask.id,
      projection: 'todos',
      todoId: 'ownership',
      todoRevision: 1,
      todoStatus: 'source',
    })
    if (inherited.scope !== 'collaboration') throw Error('Missing collaboration history')
    expect(inherited.view).toMatchObject({
      actionable: false,
      task: { sessionId: child.sessionId, runId: inheritedTask.id, planVersion: 2 },
      todo: { id: 'ownership', revision: 1, status: 'open' },
      todoCurrent: { revision: 2, status: 'awaiting_review' },
      todos: { group: 'active', activeCount: 1 },
    })
    expect(inherited.view.task?.approvedPlanVersion).toBeUndefined()
    expect(inherited.view.task?.authorization).toBeUndefined()
    expect(f.repo.collaboration(child.sessionId)).toBeUndefined()
    expect(
      f.db.drizzle
        .select()
        .from(collaborationInputs)
        .where(eq(collaborationInputs.sessionId, child.sessionId))
        .all(),
    ).toHaveLength(0)
    expect(page.runs).toHaveLength(2)
    const sentWith = page.messages.find((message) => message.sequence === 2)!
    const comment = f.repo
      .commentsForMessage(sentWith.id)
      .find((value) => value.body === 'Plan reference')!
    if (comment.anchor.type !== 'message' || !comment.anchor.plan)
      throw Error('Missing inherited plan Comment')
    expect(comment.anchor.messageId).not.toBe(f.messageIds[0])
    expect(comment.anchor.plan.runId).not.toBe(f.runIds[0])
    expect(comment.anchor.contentHash).toBe(hash('Draft plan'))
    expect(f.repo.findRun(comment.anchor.plan.runId)).toMatchObject({
      sessionId: child.sessionId,
      userMessageId: comment.anchor.messageId,
    })
    expect(f.repo.collaboration(child.sessionId, comment.anchor.plan.runId, true)).toMatchObject({
      plan: 'Draft plan',
      planVersion: 1,
    })
    expect(
      f.repo.collaboration(child.sessionId, comment.anchor.plan.runId)?.approvedPlanVersion,
    ).toBeUndefined()
    const sourceBatch = f.repo.inputBatchForRun(f.runIds[1]!)!
    const inheritedBatch = f.repo.inputBatchForRun(inheritedTask.id)!
    expect(inheritedBatch.id).not.toBe(sourceBatch.id)
    expect(inheritedBatch.memberCount).toBe(2)
    const frozen = f.repo.readFrozenInputBatch(inheritedTask.id, inheritedBatch.id)
    expect(frozen.members).toHaveLength(2)
    expect(frozen.members.map((item) => item.commentId)).toContain(comment.id)
  })
  it('refuses a plan Comment whose source Run lies outside the frozen prefix', async () => {
    const f = await fixture()
    f.db.drizzle
      .insert(anchoredComments)
      .values({
        id: randomUUID(),
        sessionId: f.sourceId,
        body: 'Future plan source',
        anchorJson: JSON.stringify({
          type: 'message',
          messageId: f.messageIds[0],
          plan: { runId: randomUUID(), version: 1 },
          contentHash: hash('Plan'),
          textBasis: 'markdown-visible-v2',
          startOffset: 0,
          endOffset: 4,
          quote: 'Plan',
        }),
        position: 2,
        sentWithMessageId: f.messageIds[0]!,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run()
    const source = f.select()
    expect(() => f.repo.commitFork(randomUUID(), source, f.boundaries, ['claude'])).toThrow(
      /required Fork run source is outside the frozen history/,
    )
  })
  it('keeps the frozen local Fork title while ordinary local titles still accept Native generation', async () => {
    const f = await fixture()
    const child = f.commit()
    for (const agentId of agents) {
      const evidence = witness(f, agentId)
      f.repo.updateForkIntent(child.sessionId, child.id, agentId, {
        nativeSessionId: evidence.nativeSessionId,
        witnessJson: JSON.stringify(evidence),
        nativeWorkState: 'settled',
      })
      f.repo.completeForkSide(
        child.sessionId,
        child.id,
        agentId,
        evidence.nativeSessionId,
        evidence,
      )
    }
    const inheritedTitle = f.db.sessionRepository.find(child.sessionId)!.title
    for (const sessionId of [child.sessionId, f.sourceId]) {
      const draft = f.repo.readPage({ scope: 'drafts', sessionId })
      if (draft.scope !== 'drafts') throw new Error('Missing draft page')
      const session = f.db.sessionRepository.find(sessionId)!
      const started = f.repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'New question',
        expectedCommentsRevision: draft.commentsRevision,
        commentIds: draft.comments.map((comment) => comment.id),
        agentId: 'codex',
        settingsRevision: session.settingsRevision,
        model: session.settings.agents.codex.model,
        effort: 'high',
        ...(sessionId === f.sourceId ? { suggestedTitle: 'Local question fallback' } : {}),
      })
      f.repo.applyEvent(sessionId, started.run.id, {
        agentId: 'codex',
        type: 'session.started',
        nativeSessionId: sessionId === child.sessionId ? 'child-codex' : 'ordinary-codex',
      })
      f.repo.applyEvent(sessionId, started.run.id, {
        agentId: 'codex',
        type: 'session.title.updated',
        title: 'Native generated title',
      })
      expect(f.db.sessionRepository.find(sessionId)!.title).toBe(
        sessionId === child.sessionId ? inheritedTitle : 'Native generated title',
      )
    }
    expect(inheritedTitle).toContain('(fork)')
  })

  it('rejects User targets and a peer first seen after the cutoff before creating a Session', async () => {
    const f = await fixture()
    expect(() => f.select(f.messageIds[2])).toThrow(/Agent/u)
    expect(() => f.select(f.messageIds[1])).toThrow(/codex/iu)
    f.db.drizzle
      .update(agentRuns)
      .set({ nativeSessionId: null })
      .where(eq(agentRuns.id, f.runIds[1]!))
      .run()
    expect(() => f.select()).toThrow(/codex/iu)
    expect(f.db.drizzle.select().from(sessions).all()).toHaveLength(1)
    expect(f.db.drizzle.select().from(sessionForkOperations).all()).toHaveLength(0)
  })

  it('retains independent messages, sent anchors, historical settings and inert controls without copying drafts', async () => {
    const f = await fixture()
    f.db.drizzle
      .insert(workspaceChangeSets)
      .values({
        id: f.runIds[0]!,
        runId: f.runIds[0]!,
        sessionId: f.sourceId,
        projectId: f.db.sessionRepository.find(f.sourceId)!.projectId,
        agentId: 'claude',
        root: '/owned/fork',
        rootDevice: '1',
        rootInode: '1',
        stagingRoot: '/owned/staging',
        state: 'recovery_required',
        fileCount: 0,
        projectionPending: false,
        createdAt: timestamp,
      })
      .run()
    const operation = f.commit(),
      child = f.repo.read(operation.sessionId),
      original = f.repo.read(f.sourceId)
    expect(child.messages.map((message) => message.content)).toEqual(
      original.messages.map((message) => message.content),
    )
    expect(child.messages.every((message) => !f.messageIds.includes(message.id))).toBe(true)
    expect(child.comments).toHaveLength(1)
    expect(original.comments).toHaveLength(2)
    expect(child.comments[0]!.sentWithMessageId).toBe(child.messages[2]!.id)
    expect(child.comments[0]!.anchor).toMatchObject({
      messageId: child.messages[1]!.id,
      contentHash: hash('message-1'),
    })
    expect(f.db.sessionRepository.find(operation.sessionId)!.settings).toEqual(
      f.db.sessionRepository.find(f.sourceId)!.settings,
    )
    expect(child.runs.map((run) => run.settingsRevision)).toEqual([1, 1])
    const inherited = child.runs.find((run) => run.agentId === 'claude')!
    expect(inherited.forkSourceRunId).toBe(f.runIds[0])
    expect(inherited.peerProposal).toMatchObject({ state: 'superseded' })
    expect(inherited.peerProposal!.id).not.toBe(
      original.runs.find((run) => run.agentId === 'claude')!.peerProposal!.id,
    )
    expect(f.repo.ownsNativeControl(inherited.id)).toBe(false)
    expect(f.repo.latestAgentRun(operation.sessionId, 'claude')).toBeUndefined()
    f.db.drizzle
      .update(workspaceChangeSets)
      .set({ state: 'ready', finalizedAt: timestamp })
      .where(eq(workspaceChangeSets.id, f.runIds[0]!))
      .run()
    expect(f.db.workspaceChangesRepository.hasRecoveryForRoot('/owned/fork')).toBe(false)
    f.db.sessionRepository.archive(f.sourceId)
    expect(f.repo.read(operation.sessionId).messages).toHaveLength(4)
    expect(f.repo.read(operation.sessionId).comments).toHaveLength(1)
  })

  it('checks current settings and explicit target Full consent atomically and replays the same commit', async () => {
    const f = await fixture(),
      selection = f.select()
    expect(() => f.repo.commitFork(randomUUID(), selection, f.boundaries, [])).toThrow(
      /Full access/u,
    )
    expect(f.db.drizzle.select().from(sessions).all()).toHaveLength(1)
    f.db.sessionRepository.saveSettings(f.sourceId, {
      ...settings,
      permissionModes: { claude: 'full', codex: 'ask' },
      maxDiscussionRounds: 4,
    })
    expect(() => f.repo.commitFork(randomUUID(), selection, f.boundaries, ['claude'])).toThrow(
      /settings changed/iu,
    )
    const source = f.db.sessionRepository.find(f.sourceId)!,
      current = f.repo.selectForkSource(
        f.sourceId,
        f.messageIds[3]!,
        source.settings,
        source.settingsRevision,
      ),
      id = randomUUID()
    const first = f.repo.commitFork(id, current, f.boundaries, ['claude'])
    expect(f.repo.commitFork(id, current, f.boundaries, ['claude']).sessionId).toBe(first.sessionId)
    expect(f.db.drizzle.select().from(sessions).all()).toHaveLength(2)
  })

  it('keeps committed history discoverable and gated across a real cold database reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-fork-restart-'))
    ownedDirectories.push(directory)
    const f = await fixture(join(directory, 'pact.sqlite')),
      operation = f.commit()
    f.db.close()
    ownedDatabases.splice(ownedDatabases.indexOf(f.db), 1)
    const db = await PactDatabase.open({
      filePath: join(directory, 'pact.sqlite'),
      migrationsFolder,
    })
    ownedDatabases.push(db)
    db.conversationRepository.recoverForkIntents()
    expect(db.sessionRepository.find(operation.sessionId)!.activity.state).toBe('error')
    expect(db.conversationRepository.read(operation.sessionId).messages).toHaveLength(4)
    expect(db.conversationRepository.nativeRecoveryBlocksInput(operation.sessionId)).toBe(true)
    expect(
      db.conversationRepository
        .forkOperation(operation.sessionId)!
        .sides.every((side) => side.state === 'error' && side.canContinue),
    ).toBe(true)
    for (const agentId of agents) {
      const evidence = witness(f, agentId)
      db.conversationRepository.updateForkIntent(operation.sessionId, operation.id, agentId, {
        nativeSessionId: evidence.nativeSessionId,
        witnessJson: JSON.stringify(evidence),
        nativeWorkState: 'settled',
      })
      db.conversationRepository.completeForkSide(
        operation.sessionId,
        operation.id,
        agentId,
        evidence.nativeSessionId,
        evidence,
      )
    }
    expect(db.conversationRepository.forkOperation(operation.sessionId)!.ready).toBe(true)
    expect(db.conversationRepository.nativeRecoveryBlocksInput(operation.sessionId)).toBe(false)
    db.drizzle.delete(nativeAgentContexts).where(eq(nativeAgentContexts.agentId, 'claude')).run()
    expect(db.conversationRepository.forkOperation(operation.sessionId)!.ready).toBe(false)
    expect(db.conversationRepository.nativeRecoveryBlocksInput(operation.sessionId)).toBe(true)
    expect(db.sessionRepository.find(operation.sessionId)!.activity.state).toBe('error')
  })

  it('archives old candidate evidence before a replacement dispatch and cannot retry a lost new acknowledgement', async () => {
    const f = await fixture(),
      operation = f.commit(),
      evidence = witness(f, 'claude', 'old-candidate')
    f.repo.updateForkIntent(operation.sessionId, operation.id, 'claude', {
      nativeSessionId: evidence.nativeSessionId,
      witnessJson: JSON.stringify(evidence),
      candidateMissing: true,
      nativeWorkState: 'settled',
    })
    expect(() =>
      f.repo.updateForkIntent(operation.sessionId, operation.id, 'claude', {
        nativeSessionId: 'wrong-candidate',
        witnessJson: JSON.stringify(evidence),
      }),
    ).toThrow(/witness|identity|candidate/iu)
    expect(f.db.drizzle.select().from(nativeForkCandidateReceipts).all()).toHaveLength(0)
    f.repo.updateForkIntent(operation.sessionId, operation.id, 'claude', {
      phase: 'fork',
      dispatched: true,
      executorId: randomUUID(),
      state: 'forking',
      nativeWorkState: 'pending',
    })
    const current = f.repo.forkIntent(operation.sessionId, operation.id, 'claude')
    expect(current.nativeSessionId).toBeNull()
    expect(current.witness).toBeUndefined()
    expect(current.candidateMissing).toBe(false)
    expect(f.db.drizzle.select().from(nativeForkCandidateReceipts).get()!.witnessJson).toBe(
      JSON.stringify(evidence),
    )
    f.repo.recoverForkIntents()
    expect(
      f.repo.forkOperation(operation.sessionId)!.sides.find((side) => side.agentId === 'claude')!
        .canContinue,
    ).toBe(false)
  })

  it('rejects exhausted receipt capacity before changing the candidate or dispatch evidence', async () => {
    const f = await fixture(),
      operation = f.commit(),
      evidence = witness(f, 'claude', 'current-candidate')
    f.repo.updateForkIntent(operation.sessionId, operation.id, 'claude', {
      nativeSessionId: evidence.nativeSessionId,
      witnessJson: JSON.stringify(evidence),
      candidateMissing: true,
      nativeWorkState: 'settled',
    })
    for (let index = 0; index < 8; index++)
      f.db.drizzle
        .insert(nativeForkCandidateReceipts)
        .values({
          operationId: operation.id,
          agentId: 'claude',
          nativeSessionId: `previous-${index}`,
          witnessJson: JSON.stringify({ ...evidence, nativeSessionId: `previous-${index}` }),
          createdAt: timestamp,
        })
        .run()
    expect(() =>
      f.repo.updateForkIntent(operation.sessionId, operation.id, 'claude', {
        phase: 'fork',
        dispatched: true,
        executorId: randomUUID(),
        state: 'forking',
        nativeWorkState: 'pending',
      }),
    ).toThrow(/evidence limit/u)
    expect(f.repo.forkIntent(operation.sessionId, operation.id, 'claude')).toMatchObject({
      nativeSessionId: 'current-candidate',
      candidateMissing: true,
      nativeWorkState: 'settled',
    })
  })

  it('refuses oversized complete history without a shortened or partially committed branch', async () => {
    const f = await fixture()
    f.db.drizzle
      .update(conversationMessages)
      .set({ content: 'x'.repeat(8 * 1024 * 1024) })
      .where(eq(conversationMessages.id, f.messageIds[0]!))
      .run()
    expect(() => f.commit()).toThrow(/bound|8 MiB|history exceeds/iu)
    expect(f.db.drizzle.select().from(sessions).all()).toHaveLength(1)
    expect(f.db.drizzle.select().from(sessionForkOperations).all()).toHaveLength(0)
    expect(
      f.db.drizzle
        .all<{ detail: string }>(
          sql`EXPLAIN QUERY PLAN SELECT 1 FROM session_fork_operations o WHERE o.session_id=${f.sourceId} AND (o.ready=0 OR (SELECT count(*) FROM native_agent_contexts c WHERE c.session_id=o.session_id)<>2) LIMIT 1`,
        )
        .map((row) => row.detail)
        .join('\n'),
    ).toMatch(/USING (?:COVERING )?INDEX/u)
  })
})

it('admits a 9000-message frozen prefix when its actual complete material is below 8 MiB', async () => {
  const f = await fixture(),
    extra = 8996
  f.db.drizzle
    .update(conversationMessages)
    .set({ sequence: sql`${conversationMessages.sequence}+${extra}` })
    .run()
  for (let start = 0; start < extra; start += 200)
    f.db.drizzle
      .insert(conversationMessages)
      .values(
        Array.from({ length: Math.min(200, extra - start) }, (_, index) => ({
          id: randomUUID(),
          sessionId: f.sourceId,
          role: 'user' as const,
          // Retain the original serialized workload after adding nullable Skill metadata.
          content: 'x'.repeat(478),
          state: 'complete' as const,
          sequence: start + index,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      )
      .run()
  const messages = f.db.drizzle.select().from(conversationMessages).all()
  expect(Buffer.byteLength(JSON.stringify(messages))).toBeGreaterThan(7.5 * 1024 * 1024)
  expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(8 * 1024 * 1024)
  const boundaries = {
    claude: { ...f.boundaries.claude, throughSequence: extra + 1, deliveryCursor: extra },
    codex: { ...f.boundaries.codex, throughSequence: extra + 3, deliveryCursor: extra + 2 },
  }
  const start = performance.now()
  const operation = f.repo.commitFork(randomUUID(), f.select(), boundaries, ['claude'])
  expect(
    f.db.drizzle
      .select({ count: sql<number>`count(*)` })
      .from(conversationMessages)
      .where(eq(conversationMessages.sessionId, operation.sessionId))
      .get()!.count,
  ).toBe(9000)
  expect(performance.now() - start).toBeLessThan(10_000)
})
