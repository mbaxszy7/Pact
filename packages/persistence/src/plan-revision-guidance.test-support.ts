import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import {
  advanceCollaboration,
  collaborationTaskSchema,
  type CollaborationDocument,
  type PlanRevisionGuidanceProposal,
} from '@pact/contracts'

import { PactDatabase } from './pact-database.js'

const settings = {
  primaryAgentId: 'codex',
  agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
  maxDiscussionRounds: 6,
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
} as const

/** Uses normal publication, review and terminal settlement, never synthetic workflow rows. */
export async function planRevisionFixture(
  options: {
    filePath?: string
    task?: string
    plan?: string
    replyPlan?: string
    review?: string
    commentCount?: number
    fileComments?: boolean
    planComments?: boolean
    inputs?: string[]
  } = {},
) {
  const db = await PactDatabase.open({
    filePath: options.filePath ?? ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
  })
  const repo = db.conversationRepository,
    sessionId = randomUUID(),
    projectId = randomUUID(),
    messageId = randomUUID(),
    now = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Plan revision',
    directoryPath: '/fixture',
    kind: 'directory',
    createdAt: now,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Plan revision', createdAt: now },
    settings,
  )
  const initial = collaborationTaskSchema.parse({
    id: randomUUID(),
    sessionId,
    kind: 'plan',
    revision: 0,
    protocol: 'native-workflow-v1',
    owner: 'codex',
    reviewer: 'claude',
    automation: 'active',
    inputSequence: 0,
    handledInputSequence: 0,
    task: options.task ?? 'Review cancellation.',
    taskMessageId: messageId,
    stage: 'plan',
    actor: 'codex',
    status: 'running',
    runId: messageId,
    planVersion: 0,
    discussionRounds: 0,
    reviewCycles: 0,
    repairAttempts: 0,
  })
  const first = repo.beginRun({
    sessionId,
    clientMessageId: messageId,
    content: `/plan ${initial.task}`,
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
    collaboration: initial,
  })
  const finish = (
    runId: string,
    result: { plan?: string; verdict?: 'changes_requested' | 'accepted'; answer?: string } = {},
  ) => {
    const run = repo.findRun(runId)!
    repo.applyEvent(sessionId, runId, {
      type: 'session.started',
      agentId: run.agentId,
      nativeSessionId: `fixture-${run.agentId}`,
    })
    repo.applyEvent(sessionId, runId, {
      type: 'turn.started',
      agentId: run.agentId,
      turnId: `turn-${runId}`,
    })
    if (result.plan)
      repo.recordWorkflowPlan(runId, { nativeId: `plan-${runId}`, text: result.plan })
    if (result.verdict) repo.recordWorkflowReview(runId, { verdict: result.verdict })
    repo.applyEvent(sessionId, runId, {
      type: 'text.completed',
      agentId: run.agentId,
      turnId: `turn-${runId}`,
      outputId: `answer-${runId}`,
      text: result.answer ?? 'Checked current scope.',
    })
    repo.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: 'completed',
      identity: {
        sessionId,
        agentId: run.agentId,
        requestId: runId,
        runId,
        nativeSessionId: `fixture-${run.agentId}`,
        nativeTurnId: `turn-${runId}`,
        bindingGeneration: run.bindingGeneration ?? 1,
      },
    })
    repo.recordNativeEffects(runId, 'settled')
    repo.applyEvent(sessionId, runId, {
      type: 'turn.completed',
      agentId: run.agentId,
      turnId: `turn-${runId}`,
      outcome: 'completed',
    })
    repo.recordNativeEffects(runId, 'settled')
  }
  const admission = (proposal?: PlanRevisionGuidanceProposal, clientMessageId = randomUUID()) => {
    const task = repo.collaboration(sessionId)!,
      next = advanceCollaboration(task, 'continue', settings)
    const drafts = repo.readPage({ scope: 'drafts', sessionId })
    if (drafts.scope !== 'drafts') throw Error('Missing drafts')
    return {
      sessionId,
      clientMessageId,
      content: 'Continue authorized work.',
      commentIds: [],
      expectedCommentsRevision: drafts.commentsRevision,
      agentId: next.actor,
      settingsRevision: 1,
      model: null,
      effort: null,
      preserveDraftComments: true,
      expectedCollaborationRevision: task.revision,
      collaboration: next,
      schedulingHandoff: repo.workflowHandoff(task, next.actor),
      ...(proposal ? { planRevisionGuidance: proposal } : {}),
    }
  }
  finish(first.run.id, { plan: options.plan ?? 'Scope and acceptance.' })
  const originalPlan = repo.collaboration(sessionId)!.planReference!
  const commentIds: string[] = []
  for (let index = 0; index < (options.commentCount ?? 0); index++) {
    const id = randomUUID()
    const drafts = repo.readPage({ scope: 'drafts', sessionId })
    if (drafts.scope !== 'drafts') throw Error('Missing drafts')
    repo.saveCommentDraft({
      mode: 'create',
      sessionId,
      commentId: id,
      expectedCommentsRevision: drafts.commentsRevision,
      body: `Required Comment ${index}.`,
      anchor: options.fileComments
        ? {
            type: 'file',
            path: `source-${index}.ts`,
            contentHash: 'a'.repeat(64),
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 2,
            quote: 'x',
          }
        : options.planComments
          ? {
              type: 'message',
              messageId: originalPlan.sourceMessageId,
              plan: { runId: originalPlan.sourceRunId, version: originalPlan.version },
              contentHash: originalPlan.document.sha256,
              textBasis: 'markdown-visible-v2',
              startOffset: 0,
              endOffset: Math.min(6, (options.plan ?? 'Scope and acceptance.').length),
              quote: (options.plan ?? 'Scope and acceptance.').slice(0, 6),
            }
          : {
              type: 'message',
              messageId: first.run.userMessageId,
              contentHash: createHash('sha256').update(`/plan ${initial.task}`).digest('hex'),
              textBasis: 'plain-visible-v1',
              startOffset: 0,
              endOffset: 5,
              quote: '/plan',
            },
    })
    commentIds.push(id)
  }
  const inputs = [
    ...(commentIds.length ? ['Address the saved Comments.'] : []),
    ...(options.inputs ?? []),
  ]
  for (const [index, content] of inputs.entries()) {
    const owner = randomUUID(),
      clientMessageId = randomUUID()
    const body = repo.writeConversationInput({ type: 'begin', sessionId, clientMessageId }, owner)
    for (let offset = 0; offset < content.length; offset += 8192)
      repo.writeConversationInput(
        {
          type: 'append',
          sessionId,
          inputId: body.inputId,
          offset,
          text: content.slice(offset, offset + 8192),
        },
        owner,
      )
    repo.writeConversationInput({ type: 'seal', sessionId, inputId: body.inputId }, owner)
    const drafts = repo.readPage({ scope: 'drafts', sessionId })
    if (drafts.scope !== 'drafts') throw Error('Missing drafts')
    const send = {
      sessionId,
      clientMessageId,
      content,
      commentIds: index === 0 ? commentIds : [],
      expectedCommentsRevision: drafts.commentsRevision,
      route: { type: 'primary' as const },
    }
    repo.receiveCollaborationInput(send, body.inputId, 'codex', 'immediate_safe_point', owner)
    const received = repo.readReceivedInput(sessionId)!,
      task = repo.collaboration(sessionId)!
    const next = repo.workflowReply(task, received.actor)
    next.latestUserMessageId = received.id
    const reply = repo.beginRun({
      sessionId,
      clientMessageId: received.id,
      content: received.content,
      commentIds: received.metadata.commentIds,
      imageIds: received.metadata.imageIds,
      expectedCommentsRevision: drafts.commentsRevision,
      agentId: received.actor,
      settingsRevision: 1,
      model: null,
      effort: null,
      preserveDraftComments: true,
      receivedInputId: received.id,
      expectedCollaborationRevision: task.revision,
      collaboration: next,
    })
    finish(reply.run.id, { plan: options.replyPlan ?? options.plan ?? 'Scope and acceptance.' })
    repo.setCollaborationState(
      advanceCollaboration(repo.collaboration(sessionId)!, 'resume', settings),
    )
  }
  const reviewRun = repo.beginRun(admission()).run
  finish(reviewRun.id, {
    verdict: 'changes_requested',
    answer: options.review ?? 'Handle cancellation before completing the Plan.',
  })
  repo.saveSchedulingSettings({
    expectedRevision: 0,
    enabled: true,
    selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
  })
  const task = repo.collaboration(sessionId)!,
    handoff = repo.workflowHandoff(task, task.owner)
  const readDocument = (document: CollaborationDocument, requestedSession: string = sessionId) => {
    const row = repo.collaborationDocumentRow(requestedSession, document)
    let text = '',
      offset = 0
    for (;;) {
      const page = repo.readPage({
        scope: 'collaboration-text',
        sessionId: requestedSession,
        runId: row.sourceRunId!,
        document,
        offset,
      })
      if (page.scope !== 'collaboration-text') throw Error('Missing source')
      text += page.text
      if (page.nextOffset === null) return text
      offset = page.nextOffset
    }
  }
  return {
    db,
    repo,
    sessionId,
    projectId,
    first,
    originalPlan,
    reviewRun,
    task,
    handoff,
    finish,
    admission,
    readDocument,
  }
}
