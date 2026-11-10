import { and, asc, eq, gt, lte, ne, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import {
  advanceCollaboration,
  collaborationDocumentSchema,
  collaborationTaskSchema,
  collaborationTurnAuthorizationSchema,
  commentAnchorSchema,
  handoffGuidanceSchema,
  planRevisionGuidanceSchema,
  type CollaborationDocument,
  type HandoffGuidance,
  type PlanRevisionGuidance,
  type PlanRevisionGuidanceSource,
  type SchedulingHandoff,
  type TaskStageRoles,
} from '@pact/contracts'

import { PactDatabase } from './pact-database.js'
import {
  collaborationTasks,
  conversationBodyInputs,
  conversationInputBatchMembers,
  conversationInputBatches,
  conversationRunSourceRefs,
  schedulingBudgetCounters,
  schedulingEvaluations,
  workflowTurns,
} from './schema/index.js'

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
    owner?: 'codex' | 'claude'
    nativeSessionId?: string
    task?: string
    plan?: string
    replyPlan?: string
    review?: string
    commentCount?: number
    fileComments?: boolean
    planComments?: boolean
    inputs?: string[]
    rolePolicy?: 'split-stages-v1'
    stageRoles?: TaskStageRoles
  } = {},
) {
  const planOwner = options.owner ?? 'codex'
  const selectedSettings = { ...settings, primaryAgentId: planOwner }
  const nativeSessionId = (agent: 'codex' | 'claude') =>
    agent === planOwner && options.nativeSessionId ? options.nativeSessionId : `fixture-${agent}`
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
    selectedSettings,
  )
  const initial = collaborationTaskSchema.parse({
    id: randomUUID(),
    sessionId,
    kind: 'plan',
    revision: 0,
    protocol: 'native-workflow-v1',
    owner: planOwner,
    reviewer: planOwner === 'codex' ? 'claude' : 'codex',
    automation: 'active',
    inputSequence: 0,
    handledInputSequence: 0,
    task: options.task ?? 'Review cancellation.',
    taskMessageId: messageId,
    stage: 'plan',
    actor: planOwner,
    status: 'running',
    runId: messageId,
    planVersion: 0,
    discussionRounds: 0,
    reviewCycles: 0,
    repairAttempts: 0,
    ...(options.rolePolicy ? { rolePolicy: options.rolePolicy } : {}),
    ...(options.stageRoles ? { stageRoles: options.stageRoles } : {}),
  })
  const first = repo.beginRun({
    sessionId,
    clientMessageId: messageId,
    content: `/plan ${initial.task}`,
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: planOwner,
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
      nativeSessionId: nativeSessionId(run.agentId),
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
        nativeSessionId: nativeSessionId(run.agentId),
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
  const admission = (clientMessageId = randomUUID()) => {
    const task = repo.collaboration(sessionId)!,
      next = advanceCollaboration(task, 'continue', selectedSettings)
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
    repo.receiveCollaborationInput(send, body.inputId, planOwner, 'immediate_safe_point', owner)
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
    if (repo.collaboration(sessionId)?.automation !== 'active')
      throw new Error('Confirmed input did not retain automatic collaboration.')
  }
  const reviewRun = repo.beginRun(admission()).run
  finish(reviewRun.id, {
    verdict: 'changes_requested',
    answer: options.review ?? 'Handle cancellation before completing the Plan.',
  })
  repo.saveSchedulingSettings({
    expectedRevision: 0,
    enabled: true,
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

type Fixture = Awaited<ReturnType<typeof planRevisionFixture>>
type HistoricalGrant = {
  document: CollaborationDocument
  messageId: string
  sourceRunId: string
  revision: number
}

/** Seed an already-frozen pre-cutover record; never invoke the retired adoption path. */
export function seedHistoricalGuidance(
  f: Pick<Fixture, 'db' | 'repo' | 'sessionId' | 'readDocument'>,
  runId: string,
  handoff: SchedulingHandoff,
  value: HandoffGuidance,
  grants: readonly HistoricalGrant[] = [],
): CollaborationDocument {
  const guidance = handoffGuidanceSchema.parse(value)
  const run = f.repo.findRun(runId)
  const auth = f.repo.collaborationTurnAuthorization(runId)
  if (
    !run ||
    !auth ||
    auth.sourceManifestRef ||
    f.repo.handoffReceipt(handoff.id)?.runId !== runId ||
    guidance.handoffId !== handoff.id
  )
    throw Error('Historical guidance requires the exact receiving Run and handoff')
  const text = JSON.stringify(guidance)
  const owner = randomUUID()
  const { inputId } = f.repo.writeConversationInput(
    { type: 'begin', sessionId: f.sessionId, clientMessageId: randomUUID() },
    owner,
  )
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 2048)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    f.repo.writeConversationInput(
      { type: 'append', sessionId: f.sessionId, inputId, offset, text: text.slice(offset, end) },
      owner,
    )
    offset = end
  }
  f.repo.writeConversationInput({ type: 'seal', sessionId: f.sessionId, inputId }, owner)
  const row = f.db.drizzle
    .select()
    .from(conversationBodyInputs)
    .where(eq(conversationBodyInputs.id, inputId))
    .get()
  if (
    !row?.sealed ||
    row.hash !== createHash('sha256').update(text).digest('hex') ||
    row.bytes !== Buffer.byteLength(text) ||
    row.chars !== text.length
  )
    throw Error('The complete historical manifest was not sealed')
  const document = collaborationDocumentSchema.parse({
    id: inputId,
    sha256: row.hash,
    bytes: row.bytes,
    chars: row.chars,
  })
  const authorization = collaborationTurnAuthorizationSchema.parse({
    ...auth,
    sourceManifestRef: document,
  })
  const authorizationJson = JSON.stringify(authorization)
  const createdAt = run.createdAt
  f.db.drizzle.transaction((tx) => {
    tx.update(conversationBodyInputs)
      .set({
        purpose: 'collaboration',
        sourceRunId: runId,
        projectionBasis: null,
        projectionPages: null,
      })
      .where(eq(conversationBodyInputs.id, inputId))
      .run()
    tx.update(workflowTurns)
      .set({
        authorizationJson,
        stateJson: sql`json_set(${workflowTurns.stateJson}, '$.authorization', json(${authorizationJson}))`,
      })
      .where(eq(workflowTurns.runId, runId))
      .run()
    tx.update(collaborationTasks)
      .set({
        stateJson: sql`json_set(${collaborationTasks.stateJson}, '$.authorization', json(${authorizationJson}))`,
      })
      .where(
        and(
          eq(collaborationTasks.id, auth.taskId),
          sql`json_extract(${collaborationTasks.stateJson}, '$.runId') = ${runId}`,
        ),
      )
      .run()
    // The historical evaluation is already closed. There is no active native runtime owner,
    // physical absence assertion, dispatch call, or new model response in this fixture.
    tx.insert(schedulingEvaluations)
      .values({
        id: guidance.evaluationId,
        sessionId: f.sessionId,
        handoffId: handoff.id,
        budgetSubjectId: handoff.budgetSubjectId,
        factFingerprint: handoff.factFingerprint,
        provider: 'codex',
        model: 'gpt-6-luna',
        configurationFingerprint: 'a'.repeat(64),
        inputSha256: guidance.inputSha256,
        selectedCandidateId: guidance.candidateId,
        handoffJson: JSON.stringify(handoff),
        active: false,
        called: true,
        outcome: 'completed',
        createdAt,
        deadline: new Date(Date.parse(createdAt) + 15000).toISOString(),
        settledAt: createdAt,
      })
      .run()
    tx.insert(schedulingBudgetCounters)
      .values({
        subjectId: handoff.budgetSubjectId,
        sessionId: f.sessionId,
        evaluationCalls: 1,
      })
      .onConflictDoUpdate({
        target: schedulingBudgetCounters.subjectId,
        set: { evaluationCalls: sql`${schedulingBudgetCounters.evaluationCalls} + 1` },
      })
      .run()
    // Grants come ONLY from the previously verified host snapshot, not the manifest contents.
    // This intentionally allows negative fixtures with an ungranted source in a corrupt manifest.
    for (const grant of grants) {
      const previous = tx
        .select()
        .from(conversationRunSourceRefs)
        .where(
          and(
            eq(conversationRunSourceRefs.runId, runId),
            eq(conversationRunSourceRefs.sourceMessageId, grant.messageId),
          ),
        )
        .get()
      if (previous && previous.sourceRevision !== grant.revision)
        throw Error('Historical grant revisions disagree')
      const documents: Array<{ key: string; source: CollaborationDocument }> = previous
        ? JSON.parse(previous.documentsJson)
        : []
      const same = documents.find((entry) => entry.source.id === grant.document.id)
      if (same && JSON.stringify(same.source) !== JSON.stringify(grant.document))
        throw Error('Historical grant documents disagree')
      if (!same) documents.push({ key: `relay_${grant.document.id}`, source: grant.document })
      const documentsJson = JSON.stringify(documents)
      // Match the existing private HANDOFF_SOURCE_IDS_BYTES budget; do not export a new API.
      if (Buffer.byteLength(documentsJson) > 512 * 1024)
        throw Error('Historical source grant exceeds its metadata budget')
      tx.insert(conversationRunSourceRefs)
        .values({
          runId,
          sourceMessageId: grant.messageId,
          sourceRevision: grant.revision,
          batchId: previous?.batchId ?? null,
          documentsJson,
        })
        .onConflictDoUpdate({
          target: [conversationRunSourceRefs.runId, conversationRunSourceRefs.sourceMessageId],
          set: { documentsJson },
        })
        .run()
    }
  })
  return document
}

/** V1 history fixture for the existing original-message Comment scenarios. */
export function historicalPlanGuidance(f: Fixture): PlanRevisionGuidance {
  const task = f.repo.collaboration(f.sessionId)!
  if (!task.taskDocument || !task.planReference || !task.review?.document)
    throw Error('Missing the complete historical Plan/review')
  const sources: PlanRevisionGuidanceSource[] = []
  const add = (
    document: CollaborationDocument,
    role: PlanRevisionGuidanceSource['roles'][number],
    provenance: Pick<
      PlanRevisionGuidanceSource,
      'messageId' | 'memberId' | 'inputBatchRef' | 'inputSequence' | 'planVersion'
    > = {},
  ) => {
    const prior = sources.find(
      (entry) =>
        entry.document.id === document.id &&
        (!provenance.memberId || entry.memberId === provenance.memberId) &&
        (!provenance.messageId || entry.messageId === provenance.messageId),
    )
    if (prior) {
      if (JSON.stringify(prior.document) !== JSON.stringify(document))
        throw Error('Historical source identity changed')
      if (!prior.roles.includes(role)) prior.roles.push(role)
      return
    }
    const carrier = f.repo.collaborationDocumentRow(f.sessionId, document)
    sources.push({
      id: `s${sources.length}`,
      roles: [role],
      document,
      evaluatedSha256: document.sha256,
      ...(carrier.sourceRunId ? { sourceRunId: carrier.sourceRunId } : {}),
      ...provenance,
    })
  }
  add(task.taskDocument, 'task', { messageId: task.taskMessageId })
  const batches = f.db.drizzle
    .select()
    .from(conversationInputBatches)
    .where(
      and(
        eq(conversationInputBatches.taskId, task.id),
        gt(conversationInputBatches.sequence, 0),
        lte(conversationInputBatches.sequence, task.inputSequence),
        ne(conversationInputBatches.bodyState, 'withdrawn'),
      ),
    )
    .orderBy(asc(conversationInputBatches.sequence))
    .all()
  for (const batch of batches) {
    if (!batch.messageId || !batch.bodyDocumentJson) throw Error('Incomplete historical input')
    const provenance = {
      messageId: batch.messageId,
      inputSequence: batch.sequence,
      inputBatchRef: {
        id: batch.id,
        revision: batch.commentsRevision,
        memberCount: batch.memberCount,
      },
    }
    add(collaborationDocumentSchema.parse(JSON.parse(batch.bodyDocumentJson)), 'input', provenance)
    const members = f.db.drizzle
      .select()
      .from(conversationInputBatchMembers)
      .where(eq(conversationInputBatchMembers.batchId, batch.id))
      .orderBy(asc(conversationInputBatchMembers.ordinal))
      .all()
    if (members.length !== batch.memberCount) throw Error('Incomplete historical Comments')
    for (const [ordinal, member] of members.entries()) {
      if (member.ordinal !== ordinal || !member.bodyDocumentJson || !member.anchorDocumentJson)
        throw Error('Incomplete historical Comment bodies')
      const body = collaborationDocumentSchema.parse(JSON.parse(member.bodyDocumentJson))
      const anchorDocument = collaborationDocumentSchema.parse(
        JSON.parse(member.anchorDocumentJson),
      )
      if (body.sha256 !== member.bodySha256) throw Error('Historical Comment digest changed')
      const anchor = commentAnchorSchema.parse(JSON.parse(f.readDocument(anchorDocument)))
      if (
        anchor.type !== 'message' ||
        anchor.messageId !== task.taskMessageId ||
        anchor.contentHash !== task.taskDocument.sha256 ||
        anchor.plan
      )
        throw Error('This fixture supports only the original immutable message anchor')
      const memberProvenance = { ...provenance, memberId: member.memberId }
      add(body, 'comment', memberProvenance)
      add(anchorDocument, 'anchor', memberProvenance)
      add(task.taskDocument, 'anchor_target', { ...memberProvenance, messageId: anchor.messageId })
    }
  }
  add(task.planReference.document, 'plan', {
    messageId: task.planReference.sourceMessageId,
    planVersion: task.planReference.version,
  })
  add(task.review.document, 'review', {
    messageId: f.repo.findRun(task.review.runId)!.responseMessageId!,
    planVersion: task.planReference.version,
  })
  const review = sources.find((source) => source.roles.includes('review'))!
  return planRevisionGuidanceSchema.parse({
    version: 'plan-revision-guidance-v1',
    evaluationId: randomUUID(),
    handoffId: f.handoff.id,
    // Opaque historical receipt identities, never presented as a new model invocation hash.
    inputSha256: 'b'.repeat(64),
    sourceFingerprint: 'c'.repeat(64),
    taskId: task.id,
    inputSequence: task.inputSequence,
    planVersion: task.planReference.version,
    candidateId: 'continue_plan_revision',
    sources,
    highlights: [{ text: 'Keep the cancellation boundary explicit.', sourceIds: [review.id] }],
  })
}
