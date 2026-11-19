import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { collaborationTaskSchema } from '@pact/contracts'

import { PactDatabase } from './pact-database.js'
import { agentRuns, workflowTurns, collaborationTasks } from './schema/index.js'
import historical from './unfinished-write-0074.test-fixture.json' with { type: 'json' }

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const databases: PactDatabase[] = []
const directories: string[] = []
const settings = {
  primaryAgentId: 'codex',
  secondaryAgentId: 'claude',
  agents: {
    codex: { model: null, effort: null },
    claude: { model: null, effort: null },
    agy: { model: null, effort: null },
  },
  maxDiscussionRounds: 6,
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
} as const

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** Actual b054d036 producer facts, rather than a current record with its new fields removed. */
function historical074(filePath: string, stage: 'implement' | 'repair') {
  expect(historical.provenance).toMatchObject({
    commit: 'b054d036f77e9b1be8114a3104392efcd23414c3',
    lastMigration: 74,
    repositorySha256: '22220d650199bfa30fea6fb14b07cab9e0dd4bfd89d248d7a5ebf73f64f0025a',
  })
  const fixture = historical.cases.find((value) => value.stage === stage)!
  const database = new Database(filePath)
  database.pragma('foreign_keys = OFF')
  try {
    database.exec(
      'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY NOT NULL, hash TEXT NOT NULL, created_at NUMERIC)',
    )
    database.transaction(() => {
      for (const migration of readMigrationFiles({ migrationsFolder }).slice(0, 75)) {
        for (const statement of migration.sql) database.exec(statement)
        database
          .prepare('INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)')
          .run(migration.hash, migration.folderMillis)
      }
      for (const { table, rows } of fixture.facts) {
        const columns = database
          .prepare<[], { name: string }>(`PRAGMA table_info(${quote(table)})`)
          .all()
          .map((column) => column.name)
        database.prepare(`DELETE FROM ${quote(table)}`).run()
        const insert = database.prepare(
          `INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        )
        for (const row of rows) insert.run(...columns.map((column) => Reflect.get(row, column)))
      }
    })()
    expect(database.pragma('foreign_key_check')).toEqual([])
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE name='collaboration_action_receipts'",
        )
        .get(),
    ).toEqual({ count: 0 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM workflow_turns WHERE json_extract(authorization_json,'$.userAuthority') IS NOT NULL",
        )
        .get(),
    ).toEqual({ count: 0 })
  } finally {
    database.close()
  }
  return fixture
}

function finish(
  db: PactDatabase,
  runId: string,
  outcome: 'completed' | 'interrupted' = 'completed',
  verdict?: 'changes_requested' | 'accepted',
  processed = false,
  plan?: string,
) {
  const repo = db.conversationRepository,
    run = repo.findRun(runId)!,
    executorId = randomUUID(),
    nativeSessionId =
      run.nativeSessionId ??
      repo.nativeContext(run.sessionId, run.agentId)?.nativeSessionId ??
      `${run.sessionId}-${run.agentId}`,
    turnId = `turn-${runId}`
  repo.recordExecutor(runId, executorId)
  repo.recordDispatch(runId, 'accepted', nativeSessionId, executorId)
  repo.applyEvent(run.sessionId, runId, {
    type: 'session.started',
    agentId: run.agentId,
    nativeSessionId,
  })
  repo.applyEvent(run.sessionId, runId, { type: 'turn.started', agentId: run.agentId, turnId })
  if (plan) repo.recordWorkflowPlan(runId, { nativeId: `plan-${runId}`, text: plan })
  if (verdict) repo.recordWorkflowReview(runId, { verdict })
  if (processed) repo.recordWorkflowInputResult(runId, { outcome: 'processed' })
  repo.applyEvent(run.sessionId, runId, {
    type: 'text.completed',
    agentId: run.agentId,
    turnId,
    outputId: `answer-${runId}`,
    text: 'Complete report within the unchanged original write scope.',
  })
  repo.recordNativeEvidence({
    kind: 'ended',
    source: 'stored_terminal',
    outcome,
    identity: {
      sessionId: run.sessionId,
      agentId: run.agentId,
      requestId: runId,
      runId,
      nativeSessionId,
      nativeTurnId: turnId,
      bindingGeneration: run.bindingGeneration ?? 1,
      executorId,
    },
  })
  repo.recordNativeEffects(runId, 'settled')
  repo.applyEvent(run.sessionId, runId, {
    type: 'turn.completed',
    agentId: run.agentId,
    turnId,
    outcome,
  })
  repo.recordNativeEffects(runId, 'settled')
  repo.reconcileCompletedCollaboration(runId)
}

async function freshLegacyPlanImplement(filePath = ':memory:') {
  const db = await PactDatabase.open({ filePath, migrationsFolder })
  databases.push(db)
  const repo = db.conversationRepository,
    projectId = randomUUID(),
    sessionId = randomUUID(),
    planMsgId = randomUUID(),
    now = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Legacy plan implement authority',
    directoryPath: '/fixture/legacy-plan-implement',
    kind: 'directory',
    createdAt: now,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Legacy plan implement authority', createdAt: now },
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
    task: 'Implement the bounded original cancellation cleanup only.',
    taskMessageId: planMsgId,
    stage: 'plan',
    actor: 'codex',
    status: 'running',
    runId: planMsgId,
    planVersion: 0,
    discussionRounds: 0,
    reviewCycles: 0,
    repairAttempts: 0,
  })
  const first = repo.beginRun({
    sessionId,
    clientMessageId: planMsgId,
    content: '/plan Implement the bounded original cancellation cleanup only.',
    commentIds: [],
    expectedCommentsRevision: 0,
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
    collaboration: initial,
  }).run
  finish(db, first.id, 'completed', undefined, false, 'Bounded original cancellation cleanup.')
  const reviewTask = repo.collaboration(sessionId)!,
    reviewClientId = randomUUID(),
    nextReview = {
      ...reviewTask,
      stage: 'plan_review' as const,
      actor: reviewTask.reviewer,
      status: 'running' as const,
      discussionRounds: reviewTask.discussionRounds + 1,
      nextStage: undefined,
      revision: reviewTask.revision + 1,
    }
  const reviewDrafts = repo.readPage({ scope: 'drafts', sessionId })
  const review = repo.beginRun({
    sessionId,
    clientMessageId: reviewClientId,
    content: 'Review the Plan.',
    commentIds: [],
    expectedCommentsRevision: reviewDrafts.scope === 'drafts' ? reviewDrafts.commentsRevision : 0,
    agentId: nextReview.actor,
    settingsRevision: 1,
    model: null,
    effort: null,
    preserveDraftComments: true,
    collaboration: nextReview,
    expectedCollaborationRevision: reviewTask.revision,
    schedulingHandoff: repo.workflowHandoff(reviewTask, nextReview.actor),
  }).run
  finish(db, review.id, 'completed', 'accepted')
  const acceptedTask = repo.collaboration(sessionId)!,
    writeDrafts = repo.readPage({ scope: 'drafts', sessionId })
  const clientMessageId = randomUUID(),
    prepared = repo.prepareCollaborationAction(
      {
        sessionId,
        taskId: acceptedTask.id,
        revision: acceptedTask.revision,
        clientMessageId,
        action: 'execute',
      },
      settings,
    )
  const write = repo.beginRun({
    sessionId,
    clientMessageId,
    content: 'Implement the bounded original cancellation cleanup only.',
    commentIds: [],
    expectedCommentsRevision: writeDrafts.scope === 'drafts' ? writeDrafts.commentsRevision : 0,
    agentId: prepared.next!.actor,
    settingsRevision: 1,
    model: null,
    effort: null,
    preserveDraftComments: true,
    collaboration: prepared.next!,
    expectedCollaborationRevision: acceptedTask.revision,
    schedulingHandoff: prepared.handoff,
    collaborationActionReceiptId: prepared.receipt.id,
  }).run
  // Simulate pre-open-mode implement state before interruption so Phase 1 reply & pendingWork semantics apply.
  const preOpen = collaborationTaskSchema.parse({
    ...repo.collaboration(sessionId)!,
    openMode: undefined,
    pendingWork: { stage: 'implement', runId: write.id, inputSequence: 0 },
  })
  delete preOpen.openMode
  const preOpenJson = JSON.stringify(preOpen)
  db.drizzle
    .update(collaborationTasks)
    .set({ stateJson: preOpenJson })
    .where(eq(collaborationTasks.id, preOpen.id))
    .run()
  db.drizzle
    .update(workflowTurns)
    .set({ stateJson: preOpenJson })
    .where(eq(workflowTurns.runId, write.id))
    .run()
  finish(db, write.id, 'interrupted')
  expect(repo.collaboration(sessionId)).toMatchObject({
    automation: 'paused',
    pendingWork: { stage: 'implement', runId: write.id },
  })
  return { db, repo, sessionId, write }
}

async function legacyRepairFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pact-legacy-repair-'))
  directories.push(directory)
  const filePath = join(directory, 'pact.sqlite'),
    legacy = historical074(filePath, 'repair'),
    db = await PactDatabase.open({ filePath, migrationsFolder })
  databases.push(db)
  return {
    db,
    repo: db.conversationRepository,
    sessionId: legacy.sessionId,
    writeId: legacy.originalRunId,
  }
}

type Fixture = Awaited<ReturnType<typeof freshLegacyPlanImplement>>
function resume(
  f: { db: PactDatabase; repo: Fixture['repo']; sessionId: string },
  clientMessageId = randomUUID(),
) {
  const task = f.repo.collaboration(f.sessionId)!
  const input = {
    sessionId: f.sessionId,
    taskId: task.id,
    revision: task.revision,
    clientMessageId,
    action: 'retry' as const,
  }
  const prepared = f.repo.prepareCollaborationAction(input, settings)
  if (!prepared.task || !prepared.next || !prepared.handoff)
    throw Error('Missing original continuation')
  const admission = {
    sessionId: f.sessionId,
    clientMessageId,
    content: 'Continue the exact unfinished original write.',
    commentIds: [],
    expectedCommentsRevision: 0,
    agentId: prepared.next.actor,
    settingsRevision: 1,
    model: null,
    effort: null,
    preserveDraftComments: true,
    expectedCollaborationRevision: prepared.task.revision,
    collaboration: prepared.next,
    schedulingHandoff: prepared.handoff,
    collaborationActionReceiptId: prepared.receipt.id,
  }
  return { input, admission, result: f.repo.beginRun(admission) }
}

function processedStatus(f: Fixture, processed = true) {
  const content =
      'Status only: where did the unfinished work stop? Do not change code, scope, accepted plan, owner or permissions.',
    clientMessageId = randomUUID(),
    owner = randomUUID()
  const body = f.repo.writeConversationInput(
    { type: 'begin', sessionId: f.sessionId, clientMessageId },
    owner,
  )
  f.repo.writeConversationInput(
    { type: 'append', sessionId: f.sessionId, inputId: body.inputId, offset: 0, text: content },
    owner,
  )
  f.repo.writeConversationInput(
    { type: 'seal', sessionId: f.sessionId, inputId: body.inputId },
    owner,
  )
  const drafts = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  if (drafts.scope !== 'drafts') throw Error('Missing draft revision')
  f.repo.receiveCollaborationInput(
    {
      sessionId: f.sessionId,
      clientMessageId,
      content,
      commentIds: [],
      expectedCommentsRevision: drafts.commentsRevision,
      route: { type: 'primary' },
    },
    body.inputId,
    'codex',
    'immediate_safe_point',
    owner,
  )
  const received = f.repo.readReceivedInput(f.sessionId)!,
    task = f.repo.collaboration(f.sessionId)!,
    next = f.repo.workflowReply(task, received.actor)
  next.latestUserMessageId = received.id
  const reply = f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: received.id,
    content: received.content,
    commentIds: [],
    expectedCommentsRevision: drafts.commentsRevision,
    agentId: received.actor,
    settingsRevision: 1,
    model: null,
    effort: null,
    preserveDraftComments: true,
    receivedInputId: received.id,
    expectedCollaborationRevision: task.revision,
    collaboration: next,
  }).run
  finish(f.db, reply.id, 'completed', undefined, processed)
  expect(f.repo.collaboration(f.sessionId)?.inputProcessing).toMatchObject(
    processed
      ? {
          settled: {
            runId: reply.id,
            inputSequence: f.repo.collaboration(f.sessionId)!.inputSequence,
          },
        }
      : {
          pending: {
            inputId: received.id,
            inputSequence: f.repo.collaboration(f.sessionId)!.inputSequence,
          },
        },
  )
}

function sourceHashes(f: { repo: Fixture['repo']; sessionId: string }, runId: string) {
  return f.repo.readRunSources(runId).items.flatMap((source) =>
    source.documents.map(({ source: document }) => {
      const row = f.repo.collaborationDocumentRow(f.sessionId, document)
      let text = '',
        offset = 0
      for (;;) {
        const page = f.repo.readPage({
          scope: 'collaboration-text',
          sessionId: f.sessionId,
          runId: row.sourceRunId!,
          document,
          offset,
        })
        if (page.scope !== 'collaboration-text') throw Error('Missing complete source')
        text += page.text
        if (page.nextOffset === null) break
        offset = page.nextOffset
      }
      expect(createHash('sha256').update(text).digest('hex')).toBe(document.sha256)
      return { id: document.id, sha256: document.sha256, chars: text.length }
    }),
  )
}

describe('the original explicit unfinished write authority', () => {
  it.each(['implement', 'repair'] as const)(
    'migrates genuine 0074 %s authority and continues without a new write grant',
    async (stage) => {
      const directory = await mkdtemp(join(tmpdir(), 'pact-authority-074-'))
      directories.push(directory)
      const filePath = join(directory, 'pact.sqlite'),
        legacy = historical074(filePath, stage),
        db = await PactDatabase.open({ filePath, migrationsFolder })
      databases.push(db)
      const f = { db, repo: db.conversationRepository, sessionId: legacy.sessionId },
        before = f.repo.collaboration(f.sessionId)!,
        sources = sourceHashes(f, legacy.originalRunId)
      expect(before.pendingWork?.runId).toBe(legacy.originalRunId)
      const continued = resume(f),
        auth = f.repo.collaborationTurnAuthorization(continued.result.run.id)!
      expect(continued.result.created).toBe(true)
      expect(auth).toMatchObject({
        taskId: before.id,
        actor: before.owner,
        stage,
        userAuthority: { purpose: 'write_continuation' },
      })
      expect(f.repo.collaboration(f.sessionId)?.repairAttempts).toBe(before.repairAttempts)
      expect(sourceHashes(f, legacy.originalRunId)).toEqual(sources)
      const originalAuth = f.repo.collaborationTurnAuthorization(legacy.originalRunId)!,
        batch = f.repo.readFrozenInputBatch(continued.result.run.id, originalAuth.inputBatchRef!.id)
      expect(batch.batch).toMatchObject(originalAuth.inputBatchRef!)
      expect(batch.body).toBeDefined()
      expect(f.repo.sourceDocumentAuthorized(continued.result.run.id, batch.body!)).toBe(true)
      const discoverable = [
        ...f.repo.readWorkflowInputs(continued.result.run.id).items.map((item) => item.batch.id),
        ...f.repo
          .readRunSources(continued.result.run.id)
          .items.flatMap((item) => (item.inputBatchRef ? [item.inputBatchRef.id] : [])),
      ]
      expect(discoverable).toContain(originalAuth.inputBatchRef!.id)
      expect(f.repo.beginRun(continued.admission)).toMatchObject({
        created: false,
        run: { id: continued.result.run.id },
      })
      const derivedRoot = auth.userAuthority!.rootReceiptId
      finish(db, continued.result.run.id, 'interrupted')
      db.close()
      databases.splice(databases.indexOf(db), 1)
      const reopened = await PactDatabase.open({ filePath, migrationsFolder })
      databases.push(reopened)
      reopened.conversationRepository.recoverCollaborationTasks()
      const cold = {
          db: reopened,
          repo: reopened.conversationRepository,
          sessionId: legacy.sessionId,
        },
        again = resume(cold)
      expect(
        cold.repo.collaborationTurnAuthorization(again.result.run.id)?.userAuthority,
      ).toMatchObject({ rootReceiptId: derivedRoot, purpose: 'write_continuation' })
      expect(cold.repo.collaboration(cold.sessionId)?.repairAttempts).toBe(before.repairAttempts)
      expect(
        cold.repo.readFrozenInputBatch(again.result.run.id, originalAuth.inputBatchRef!.id).body,
      ).toEqual(batch.body)
    },
  )

  it('continues receipt-backed implement after a fully processed read-only status reply', async () => {
    const f = await freshLegacyPlanImplement(),
      before = f.repo.collaboration(f.sessionId)!,
      original = f.repo.collaborationTurnAuthorization(f.write.id)!,
      sources = sourceHashes(f, f.write.id)
    processedStatus(f)
    const current = f.repo.collaboration(f.sessionId)!
    expect(current.inputSequence).toBeGreaterThan(before.inputSequence)
    expect(current.pendingWork).toEqual(before.pendingWork)
    expect(current.planReference).toEqual(before.planReference)
    expect(current.reviewScopeRef).toEqual(before.reviewScopeRef)
    const continued = resume(f),
      auth = f.repo.collaborationTurnAuthorization(continued.result.run.id)!
    expect(auth).toMatchObject({
      stage: 'implement',
      actor: before.owner,
      userAuthority: {
        purpose: 'write_continuation',
        rootReceiptId: original.userAuthority!.rootReceiptId,
      },
    })
    expect(f.repo.collaboration(f.sessionId)?.repairAttempts).toBe(before.repairAttempts)
    expect(sourceHashes(f, f.write.id)).toEqual(sources)
  })

  it('keeps the implement root across a second interruption, cold restart and nonce readback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-authority-restart-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite'),
      f = await freshLegacyPlanImplement(filePath),
      before = f.repo.collaboration(f.sessionId)!,
      root = f.repo.collaborationTurnAuthorization(f.write.id)!.userAuthority!.rootReceiptId
    const first = resume(f)
    expect(f.repo.beginRun(first.admission)).toMatchObject({ created: false })
    finish(f.db, first.result.run.id, 'interrupted')
    f.db.close()
    databases.splice(databases.indexOf(f.db), 1)
    const db = await PactDatabase.open({ filePath, migrationsFolder })
    databases.push(db)
    db.conversationRepository.recoverCollaborationTasks()
    const resumed = resume({ db, repo: db.conversationRepository, sessionId: f.sessionId }),
      auth = db.conversationRepository.collaborationTurnAuthorization(resumed.result.run.id)!
    expect(auth.userAuthority).toMatchObject({
      rootReceiptId: root,
      purpose: 'write_continuation',
    })
    expect(db.conversationRepository.collaboration(f.sessionId)?.repairAttempts).toBe(
      before.repairAttempts,
    )
    expect(db.conversationRepository.beginRun(resumed.admission)).toMatchObject({
      created: false,
    })
  })

  it('refuses public role or policy changes while preserving an unfinished write', async () => {
    const f = await legacyRepairFixture(),
      task = f.repo.collaboration(f.sessionId)!
    expect(() =>
      f.repo.setCollaborationState({
        ...task,
        revision: task.revision + 1,
        owner: task.reviewer,
        reviewer: task.owner,
      }),
    ).toThrow(/collaboration changed/u)
    expect(() =>
      f.repo.setCollaborationState({
        ...task,
        revision: task.revision + 1,
        rolePolicy: 'split-stages-v1',
      }),
    ).toThrow(/collaboration changed/u)
    expect(f.repo.collaboration(f.sessionId)).toEqual(task)
  })

  it.each(['scope', 'owner', 'unsettled'] as const)(
    'rejects the %s negative control without granting a broader continuation',
    async (change) => {
      const f = await legacyRepairFixture(),
        task = f.repo.collaboration(f.sessionId)!
      if (change === 'scope')
        f.repo.setCollaborationState({
          ...task,
          revision: task.revision + 1,
          reviewScopeRef: task.taskDocument!,
        })
      if (change === 'owner')
        // Persisted-authority corruption must still be rejected even though the public state setter now refuses role changes.
        f.db.drizzle
          .update(collaborationTasks)
          .set({
            stateJson: JSON.stringify({
              ...task,
              revision: task.revision + 1,
              owner: task.reviewer,
              reviewer: task.owner,
            }),
          })
          .where(eq(collaborationTasks.id, task.id))
          .run()
      if (change === 'unsettled') f.repo.recordNativeEffects(f.writeId, 'unknown')
      expect(() => resume(f)).toThrow(/original write authorization|native recovery/u)
      expect(f.repo.findRun(f.writeId)?.dispatchPhase).toBe('ended')
    },
  )

  it.each(['missing_batch', 'revision', 'member_count'] as const)(
    'rejects a persisted %s input-Batch authority mismatch',
    async (change) => {
      const f = await freshLegacyPlanImplement(),
        auth = f.repo.collaborationTurnAuthorization(f.write.id)!
      const original = auth.inputBatchRef!
      const changed = {
        ...original,
        ...(change === 'missing_batch'
          ? { id: randomUUID() }
          : change === 'revision'
            ? { revision: original.revision + 1 }
            : { memberCount: original.memberCount + 1 }),
      }
      // Stored authority is a trust seam: corruption must fail closed even when native effects settled.
      f.db.drizzle
        .update(workflowTurns)
        .set({ authorizationJson: JSON.stringify({ ...auth, inputBatchRef: changed }) })
        .where(eq(workflowTurns.runId, f.write.id))
        .run()
      expect(() => resume(f)).toThrow(/input|authorization/u)
    },
  )

  it('rejects newer input without a completed processed-input result', async () => {
    const f = await freshLegacyPlanImplement()
    processedStatus(f, false)
    expect(() => resume(f)).toThrow(/input|processed/u)
  })

  it('rejects Fork provenance even when the projected write otherwise looks settled', async () => {
    const f = await legacyRepairFixture(),
      source = f.repo.collaboration(f.sessionId)!.codeRunId!
    // Imported Fork provenance cannot promote a projected historical Turn into native authority.
    f.db.drizzle
      .update(agentRuns)
      .set({ forkSourceRunId: source })
      .where(eq(agentRuns.id, f.writeId))
      .run()
    expect(() => resume(f)).toThrow(/authorization|input/u)
  })

  it('settles interrupted Open Mode work without pendingWork and retries with a fresh action receipt', async () => {
    const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    databases.push(db)
    const repo = db.conversationRepository,
      projectId = randomUUID(),
      sessionId = randomUUID(),
      taskMessageId = randomUUID(),
      now = new Date().toISOString()
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Open mode retry',
      directoryPath: '/fixture/open-retry',
      kind: 'directory',
      createdAt: now,
    })
    db.sessionRepository.create(
      { id: sessionId, projectId, title: 'Open mode retry', createdAt: now },
      settings,
    )
    const initial = collaborationTaskSchema.parse({
      id: randomUUID(),
      sessionId,
      kind: 'build',
      openMode: true,
      revision: 0,
      protocol: 'native-workflow-v1',
      owner: 'codex',
      reviewer: 'claude',
      automation: 'active',
      inputSequence: 0,
      handledInputSequence: 0,
      task: 'Implement Open Mode cleanup.',
      taskMessageId,
      stage: 'implement',
      actor: 'codex',
      status: 'running',
      runId: taskMessageId,
      planVersion: 0,
      discussionRounds: 0,
      reviewCycles: 0,
      repairAttempts: 0,
    })
    const first = repo.beginRun({
      sessionId,
      clientMessageId: taskMessageId,
      content: '/build Implement Open Mode cleanup.',
      commentIds: [],
      expectedCommentsRevision: 0,
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
      collaboration: initial,
    }).run
    finish(db, first.id, 'interrupted')
    const afterInterrupt = repo.collaboration(sessionId)!
    expect(afterInterrupt).toMatchObject({
      openMode: true,
      status: 'failed',
      automation: 'paused',
      stage: 'implement',
    })
    expect(afterInterrupt.pendingWork).toBeUndefined()
    const retried = resume({ db, repo, sessionId })
    expect(retried.result.created).toBe(true)
    expect(repo.collaborationTurnAuthorization(retried.result.run.id)?.userAuthority).toMatchObject(
      {
        purpose: 'action',
      },
    )
  })
})
