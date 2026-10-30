import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { FrozenExecutionEnvelope, RunEffectiveExecutionSettings } from '@pact/contracts'

import { PactDatabase } from './pact-database.js'
import { planRevisionFixture } from './plan-revision-guidance.test-support.js'
import { agentRuns, conversationMessages, runReexecutionOperations } from './schema/index.js'

const databases = new Set<PactDatabase>(),
  directories: string[] = []
afterEach(async () => {
  for (const db of databases) db.close()
  databases.clear()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
const settings = {
  primaryAgentId: 'codex' as const,
  agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
  maxDiscussionRounds: 6,
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}
const requested = {
  provider: 'codex' as const,
  model: 'original-model',
  effort: null,
  speed: 'standard' as const,
  permissionMode: 'native' as const,
}
const effective: RunEffectiveExecutionSettings = {
  version: 1,
  provider: 'codex',
  model: 'resolved-original-model',
  effort: { known: true, value: null },
  speed: 'standard',
  permissionMode: 'native',
  configurationSha256: 'a'.repeat(64),
  provenance: 'codex_thread_configuration',
}
async function* bytes(text: string) {
  const encoded = new TextEncoder().encode(text)
  for (let offset = 0; offset < encoded.length; offset += 8191)
    yield encoded.subarray(offset, offset + 8191)
}
function drafts(f: { repo: PactDatabase['conversationRepository']; sessionId: string }) {
  const page = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  if (page.scope !== 'drafts') throw new Error('Expected draft projection')
  return page
}
function draftContents(f: { repo: PactDatabase['conversationRepository']; sessionId: string }) {
  const { observation: _observation, ...contents } = drafts(f)
  return contents
}

async function fixture(options: { proof?: boolean; filePath?: string; route?: 'all' } = {}) {
  const db = await PactDatabase.open({
    filePath: options.filePath ?? ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
  })
  databases.add(db)
  const repo = db.conversationRepository,
    sessionId = randomUUID(),
    projectId = randomUUID(),
    createdAt = new Date().toISOString(),
    epoch = randomUUID(),
    nativeGeneration = randomUUID(),
    nativeSessionId = randomUUID(),
    executorId = randomUUID()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Exact unsent input',
    directoryPath: '/confirmed-unsent-fixture',
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Exact unsent input', createdAt },
    settings,
  )
  repo.saveSchedulingSettings({
    expectedRevision: 0,
    enabled: true,
    selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
  })
  repo.beginSchedulingRecoveryEpoch(epoch)
  const content = 'Complete original line 🧭\n'.repeat(3000) + 'THE ORIGINAL FINAL SENTENCE.',
    clientMessageId = randomUUID()
  const original = repo.beginRun({
    sessionId,
    clientMessageId,
    content,
    commentIds: [],
    expectedCommentsRevision: 0,
    agentId: 'codex',
    settingsRevision: 1,
    model: requested.model,
    effort: null,
    ...(options.route ? { route: { type: 'all' as const } } : {}),
  }).run
  repo.recordExecutor(original.id, executorId)
  repo.applyEvent(sessionId, original.id, {
    agentId: 'codex',
    type: 'session.started',
    nativeSessionId,
  })
  repo.setContinuation(sessionId, 'codex', 'ready')
  const inputBatchRef = repo.inputBatchForRun(original.id)
  const envelope: FrozenExecutionEnvelope = {
    version: 'pact-agent-prompt-v1',
    sessionId,
    message: { id: original.userMessageId, content },
    comments: [],
    ...(inputBatchRef ? { inputBatchRef } : {}),
  }
  const captured = await repo.captureExecutionInput({
    runId: original.id,
    nativeGeneration,
    requested,
    source: bytes(JSON.stringify(envelope)),
    signal: new AbortController().signal,
  })
  if (!captured) throw new Error('The complete immutable original capture was not admitted')
  repo.recordEffectiveExecutionSettings(original.id, nativeGeneration, effective, {
    executorId,
    nativeSessionId,
  })
  repo.recordDispatch(original.id, 'rejected', nativeSessionId, executorId)
  if (options.proof !== false)
    repo.recordConfirmedUnsent(
      original.id,
      nativeGeneration,
      { kind: 'codex_root_frame_not_written', requestId: 7 },
      { executorId, nativeSessionId },
    )
  repo.failRun(
    original.id,
    'transient_transport',
    'Exact original transport failed before root bytes.',
  )
  repo.armSchedulingRecoveryFaults(sessionId)
  const candidate = repo
    .takeSchedulingRecoveryFaults()
    .find((row) => row.fault.runId === original.id)
  if (!candidate) throw new Error('The original fault was not retained')
  return {
    db,
    repo,
    sessionId,
    projectId,
    epoch,
    nativeGeneration,
    nativeSessionId,
    executorId,
    original: repo.findRun(original.id)!,
    content,
    envelope,
    captured,
    candidate,
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function admission(f: Fixture, operationId = randomUUID()) {
  return {
    operationId,
    faultId: f.candidate.fault.id,
    handoff: f.repo.recoveryHandoff({ kind: 'run', id: f.original.id }),
  }
}

async function stoppedWriteReplacement(
  stage: 'implement' | 'repair',
  settled = true,
  filePath?: string,
) {
  const f = await planRevisionFixture(filePath ? { filePath } : {})
  databases.add(f.db)
  f.repo.beginSchedulingRecoveryEpoch(randomUUID())
  const revision = f.repo.beginRun(f.admission()).run
  f.finish(revision.id, { plan: 'Keep the original cancellation scope and owned cleanup.' })
  const accepted = f.repo.beginRun(f.admission()).run
  f.finish(accepted.id, { verdict: 'accepted' })
  const startAction = (action: 'execute' | 'repair' | 'resume') => {
    const task = f.repo.collaboration(f.sessionId)!
    const clientMessageId = randomUUID()
    const prepared = f.repo.prepareCollaborationAction(
      {
        sessionId: f.sessionId,
        taskId: task.id,
        revision: task.revision,
        clientMessageId,
        action,
      },
      settings,
    )
    if (!prepared.next || !prepared.handoff) throw Error('Missing concrete write admission')
    return f.repo.beginRun({
      sessionId: f.sessionId,
      clientMessageId,
      content: 'Continue authorized work.',
      commentIds: [],
      expectedCommentsRevision: drafts(f).commentsRevision,
      agentId: prepared.next.actor,
      settingsRevision: 1,
      model: null,
      effort: null,
      preserveDraftComments: true,
      expectedCollaborationRevision: task.revision,
      collaboration: prepared.next,
      collaborationActionReceiptId: prepared.receipt.id,
      schedulingHandoff: prepared.handoff,
    }).run
  }
  let original = startAction('execute')
  if (stage === 'repair') {
    f.finish(original.id, { answer: 'Implemented the accepted scope.' })
    const review = f.repo.beginRun(f.admission()).run
    f.finish(review.id, {
      verdict: 'changes_requested',
      answer: 'Repair the original cleanup gap.',
    })
    original = startAction('repair')
  }
  const originalTask = f.repo.collaboration(f.sessionId)!
  const auth = f.repo.collaborationTurnAuthorization(original.id)!
  const nativeGeneration = randomUUID(),
    executorId = randomUUID(),
    nativeSessionId = `fixture-${original.agentId}`
  f.repo.recordExecutor(original.id, executorId)
  f.repo.applyEvent(f.sessionId, original.id, {
    type: 'session.started',
    agentId: original.agentId,
    nativeSessionId,
  })
  f.repo.setContinuation(f.sessionId, original.agentId, 'ready')
  const inputBatchRef = f.repo.inputBatchForRun(original.id)!
  const envelope: FrozenExecutionEnvelope = {
    version: 'pact-agent-prompt-v1',
    sessionId: f.sessionId,
    message: { id: original.userMessageId, content: 'Continue authorized work.' },
    comments: [],
    collaboration: f.repo.collaborationPromptState(originalTask),
    collaborationAuthorization: auth,
    inputBatchRef,
  }
  expect(
    await f.repo.captureExecutionInput({
      runId: original.id,
      nativeGeneration,
      requested: {
        ...requested,
        provider: original.agentId,
        model: original.model ?? null,
        effort: original.effort ?? null,
      },
      source: bytes(JSON.stringify(envelope)),
      signal: new AbortController().signal,
    }),
  ).toBeDefined()
  f.repo.recordEffectiveExecutionSettings(original.id, nativeGeneration, effective, {
    executorId,
    nativeSessionId,
  })
  f.repo.recordDispatch(original.id, 'rejected', nativeSessionId, executorId)
  f.repo.recordConfirmedUnsent(
    original.id,
    nativeGeneration,
    { kind: 'codex_root_frame_not_written', requestId: 9 },
    { executorId, nativeSessionId },
  )
  f.repo.failRun(original.id, 'transient_transport', 'Original root was positively not written.')
  f.repo.finishCollaboration(original.id, false, 'Original root was positively not written.')
  f.repo.armSchedulingRecoveryFaults(f.sessionId)
  const fault = f.repo
    .takeSchedulingRecoveryFaults()
    .find((row) => row.fault.runId === original.id)!
  const operationId = randomUUID()
  const replacement = f.repo.beginConfirmedUnsentReexecution({
    operationId,
    faultId: fault.fault.id,
    handoff: f.repo.recoveryHandoff({ kind: 'run', id: original.id }),
  }).run
  f.repo.recordExecutor(replacement.id, executorId)
  f.repo.applyEvent(f.sessionId, replacement.id, {
    type: 'session.started',
    agentId: original.agentId,
    nativeSessionId,
  })
  f.repo.recordDispatch(replacement.id, 'accepted', nativeSessionId, executorId)
  f.repo.applyEvent(f.sessionId, replacement.id, {
    type: 'turn.started',
    agentId: original.agentId,
    turnId: replacement.id,
  })
  f.repo.interruptRun(replacement.id, true)
  if (settled) {
    f.repo.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: 'interrupted',
      identity: {
        sessionId: f.sessionId,
        agentId: original.agentId,
        requestId: replacement.id,
        runId: replacement.id,
        nativeSessionId,
        nativeTurnId: replacement.id,
        bindingGeneration: replacement.bindingGeneration ?? 1,
      },
    })
    f.repo.recordNativeEffects(replacement.id, 'settled')
  }
  f.repo.finishCollaboration(replacement.id, false, 'The replacement was stopped.')
  return {
    ...f,
    original,
    originalTask,
    auth,
    inputBatchRef,
    operationId,
    replacement,
    resume: () => startAction('resume'),
  }
}
function counts(f: Fixture) {
  return {
    runs: f.db.drizzle.select().from(agentRuns).all().length,
    messages: f.db.drizzle.select().from(conversationMessages).all().length,
    operations: f.db.drizzle.select().from(runReexecutionOperations).all().length,
  }
}

function queueNewInput(f: Fixture, anchorRunId: string) {
  const owner = randomUUID(),
    clientMessageId = randomUUID(),
    content = 'A newer accepted request must prevent the old replacement.'
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
  f.repo.receiveCollaborationInput(
    {
      sessionId: f.sessionId,
      clientMessageId,
      content,
      commentIds: [],
      expectedCommentsRevision: drafts(f).commentsRevision,
      route: { type: 'primary' },
    },
    body.inputId,
    'codex',
    'next_round',
    owner,
    true,
    anchorRunId,
  )
  return clientMessageId
}

describe('confirmed-unsent reexecution through the authoritative repository', () => {
  it('retains a stopped write replacement and its original Batch across cold reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-stopped-replacement-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite')
    const f = await stoppedWriteReplacement('repair', true, filePath)
    const before = f.repo.readFrozenInputBatch(f.original.id, f.inputBatchRef.id)
    f.db.close()
    databases.delete(f.db)
    const reopened = await PactDatabase.open({
      filePath,
      migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
    })
    databases.add(reopened)
    const repo = reopened.conversationRepository,
      task = repo.collaboration(f.sessionId)!,
      clientMessageId = randomUUID()
    expect(task.pendingWork?.runId).toBe(f.replacement.id)
    const prepared = repo.prepareCollaborationAction(
      {
        sessionId: f.sessionId,
        taskId: task.id,
        revision: task.revision,
        clientMessageId,
        action: 'resume',
      },
      settings,
    )
    const resumed = repo.beginRun({
      sessionId: f.sessionId,
      clientMessageId,
      content: 'Continue authorized work.',
      commentIds: [],
      expectedCommentsRevision: drafts({ repo, sessionId: f.sessionId }).commentsRevision,
      agentId: prepared.next!.actor,
      settingsRevision: 1,
      model: null,
      effort: null,
      preserveDraftComments: true,
      expectedCollaborationRevision: task.revision,
      collaboration: prepared.next!,
      collaborationActionReceiptId: prepared.receipt.id,
      schedulingHandoff: prepared.handoff!,
    }).run
    expect(repo.readFrozenInputBatch(resumed.id, f.inputBatchRef.id)).toEqual(before)
    expect(repo.collaboration(f.sessionId)?.repairAttempts).toBe(f.originalTask.repairAttempts)
    expect(repo.schedulingBudget(`task:${task.id}`)?.automaticResends).toBe(1)
    expect(repo.collaborationTurnAuthorization(resumed.id)?.userAuthority).toMatchObject({
      purpose: 'write_continuation',
      rootReceiptId: f.auth.userAuthority!.rootReceiptId,
    })
  })
  it.each(['implement', 'repair'] as const)(
    'continues the same %s after its confirmed-unsent replacement is stopped and settled',
    async (stage) => {
      const f = await stoppedWriteReplacement(stage)
      const before = f.repo.readFrozenInputBatch(f.original.id, f.inputBatchRef.id)
      const resumed = f.resume()
      const auth = f.repo.collaborationTurnAuthorization(resumed.id)!
      expect(auth).toMatchObject({
        stage,
        actor: f.auth.actor,
        userAuthority: {
          rootReceiptId: f.auth.userAuthority!.rootReceiptId,
          purpose: 'write_continuation',
        },
      })
      expect(f.repo.collaboration(f.sessionId)?.repairAttempts).toBe(f.originalTask.repairAttempts)
      expect(f.repo.schedulingBudget(`task:${f.originalTask.id}`)?.automaticResends).toBe(1)
      expect(f.repo.readFrozenInputBatch(resumed.id, f.inputBatchRef.id)).toEqual(before)
      expect(
        f.repo
          .readRunSources(resumed.id)
          .items.some((item) => item.inputBatchRef?.id === f.inputBatchRef.id),
      ).toBe(true)
    },
  )
  it.each(['missing_lineage', 'wrong_original', 'native_unknown'] as const)(
    'rejects a stopped replacement continuation with %s',
    async (mutation) => {
      const f = await stoppedWriteReplacement('implement', mutation !== 'native_unknown')
      if (mutation === 'missing_lineage')
        f.db.drizzle
          .delete(runReexecutionOperations)
          .where(eq(runReexecutionOperations.id, f.operationId))
          .run()
      if (mutation === 'wrong_original')
        f.db.drizzle
          .update(runReexecutionOperations)
          .set({ originalRunId: f.first.run.id })
          .where(eq(runReexecutionOperations.id, f.operationId))
          .run()
      const before = f.repo.collaboration(f.sessionId)
      const beforeRuns = f.db.drizzle.select().from(agentRuns).all().length
      const beforeAuth = f.repo.collaborationTurnAuthorization(f.replacement.id)
      const beforeBatch = f.repo.readFrozenInputBatch(f.original.id, f.inputBatchRef.id)
      expect(() => f.resume()).toThrow(
        mutation === 'native_unknown'
          ? 'There is no original unfinished write.'
          : 'The original replacement input lineage is unavailable.',
      )
      expect(f.repo.collaboration(f.sessionId)).toEqual(before)
      expect(f.db.drizzle.select().from(agentRuns).all()).toHaveLength(beforeRuns)
      expect(f.repo.collaborationTurnAuthorization(f.replacement.id)).toEqual(beforeAuth)
      expect(f.repo.readFrozenInputBatch(f.original.id, f.inputBatchRef.id)).toEqual(beforeBatch)
      expect(f.repo.schedulingBudget(`task:${f.originalTask.id}`)?.automaticResends).toBe(1)
    },
  )
  it('reserves no replacement or budget while a newer accepted queue receipt is already waiting', async () => {
    const f = await fixture()
    f.repo.setConversationQueueEnabled({
      sessionId: f.sessionId,
      operationId: randomUUID(),
      expectedRevision: 0,
      enabled: true,
    })
    const id = queueNewInput(f, f.original.id),
      before = counts(f)
    expect(f.repo.receivedCollaborationInput(f.sessionId)).toMatchObject({ id })
    expect(() => f.repo.beginConfirmedUnsentReexecution(admission(f))).toThrow(/eligible/u)
    expect(counts(f)).toEqual(before)
    expect(
      f.repo.schedulingBudget(`input:${f.original.userMessageId}`)?.automaticResends ?? 0,
    ).toBe(0)
  })
  it('withholds the admitted ordinary replacement after a newer input is accepted into the real queue', async () => {
    const f = await fixture()
    f.repo.setConversationQueueEnabled({
      sessionId: f.sessionId,
      operationId: randomUUID(),
      expectedRevision: 0,
      enabled: true,
    })
    const child = f.repo.beginConfirmedUnsentReexecution(admission(f)).run
    expect(f.repo.canDispatchReexecution(child.id)).toBe(true)
    const clientMessageId = queueNewInput(f, child.id)
    expect(f.repo.receivedCollaborationInput(f.sessionId)).toMatchObject({ id: clientMessageId })
    expect(f.repo.canDispatchReexecution(child.id)).toBe(false)
  })
  it('creates one replacement for the exact original input and preserves live draft Comments and complete paged sources', async () => {
    const f = await fixture(),
      commentId = randomUUID()
    f.repo.saveCommentDraft({
      mode: 'create',
      sessionId: f.sessionId,
      commentId,
      expectedCommentsRevision: drafts(f).commentsRevision,
      body: 'Keep my unsent draft. 🧭',
      anchor: {
        type: 'file',
        path: 'src/keep.ts',
        contentHash: 'b'.repeat(64),
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 5,
        quote: 'keep',
      },
    })
    const beforeDrafts = draftContents(f),
      before = counts(f),
      original = f.repo.findRun(f.original.id),
      operation = admission(f),
      replacement = f.repo.beginConfirmedUnsentReexecution(operation)
    expect(replacement.created).toBe(true)
    expect(replacement.run).toMatchObject({
      userMessageId: f.original.userMessageId,
      agentId: 'codex',
      reexecutedFromRunId: f.original.id,
      settingsRevision: f.original.settingsRevision,
      nativeSessionId: f.nativeSessionId,
      status: 'starting',
    })
    expect(replacement.run.id).not.toBe(f.original.id)
    expect(f.db.drizzle.select().from(runReexecutionOperations).get()).toMatchObject({
      id: operation.operationId,
      originalRunId: f.original.id,
      replacementRunId: replacement.run.id,
    })
    expect(f.repo.findRun(f.original.id)).toEqual(original)
    expect(draftContents(f)).toEqual(beforeDrafts)
    expect(counts(f)).toEqual({ ...before, runs: before.runs + 1, operations: 1 })
    expect(f.repo.frozenExecutionEnvelope(f.original.id)).toEqual(f.envelope)
    const sources = f.repo.readRunSources(replacement.run.id),
      document = sources.items.find((source) => source.messageId === f.original.userMessageId)
        ?.documents[0]?.source
    if (!document) throw new Error('The replacement did not retain its original user-source grant')
    expect(f.repo.sourceDocumentAuthorized(replacement.run.id, document)).toBe(true)
    expect(
      f.repo.sourceDocumentAuthorized(replacement.run.id, { ...document, sha256: 'f'.repeat(64) }),
    ).toBe(false)
    expect(f.repo.sourceDocumentAuthorized(replacement.run.id, f.captured.document)).toBe(false)
    const sourceOwner = f.repo.collaborationDocumentRow(f.sessionId, document).sourceRunId
    if (!sourceOwner) throw new Error('The immutable source lost its original owner')
    let offset = 0,
      text = '',
      pages = 0
    for (;;) {
      const page = f.repo.readPage({
        scope: 'collaboration-text',
        sessionId: f.sessionId,
        runId: sourceOwner,
        document,
        offset,
      })
      if (page.scope !== 'collaboration-text') throw new Error('Missing original source page')
      text += page.text
      pages++
      if (page.nextOffset === null) break
      offset = page.nextOffset
    }
    expect(pages).toBeGreaterThan(1)
    expect(text).toBe(f.content)
    expect(text.endsWith('THE ORIGINAL FINAL SENTENCE.')).toBe(true)
    expect(f.repo.canDispatchReexecution(replacement.run.id)).toBe(true)
    expect(f.repo.schedulingBudget(f.candidate.node.budgetSubjectId)?.automaticResends).toBe(1)
  })
  it('returns the same operation receipt without charging again and rejects a second operation for the original fault', async () => {
    const f = await fixture(),
      operation = admission(f),
      first = f.repo.beginConfirmedUnsentReexecution(operation),
      before = counts(f),
      budget = f.repo.schedulingBudget(f.candidate.node.budgetSubjectId)
    const duplicate = f.repo.beginConfirmedUnsentReexecution(operation)
    expect(duplicate.created).toBe(false)
    expect(duplicate.run.id).toBe(first.run.id)
    expect(counts(f)).toEqual(before)
    expect(f.repo.schedulingBudget(f.candidate.node.budgetSubjectId)).toEqual(budget)
    expect(() =>
      f.repo.beginConfirmedUnsentReexecution({ ...operation, operationId: randomUUID() }),
    ).toThrow(/replacement/u)
    expect(counts(f)).toEqual(before)
  })
  it('does not turn a raw rejected phase without exact physical proof into automatic authority', async () => {
    const f = await fixture({ proof: false }),
      before = counts(f)
    expect(f.repo.executionInput(f.original.id)?.proof).toBeUndefined()
    expect(() => f.repo.beginConfirmedUnsentReexecution(admission(f))).toThrow(/eligible/u)
    expect(counts(f)).toEqual(before)
  })
  it.each([
    'accepted',
    'unknown_delivery',
    'unknown_effects',
    'config_aba',
    'stop',
    'native_question',
    'native_rebuild',
    'new_input',
    'epoch',
  ] as const)(
    'rejects %s facts without creating a replacement or changing the original input',
    async (change) => {
      const f = await fixture(),
        input = f.repo.frozenExecutionEnvelope(f.original.id)
      if (change === 'accepted')
        f.repo.recordDispatch(f.original.id, 'accepted', f.nativeSessionId, f.executorId)
      else if (change === 'unknown_delivery')
        f.repo.recordDispatch(f.original.id, 'possibly_sent', f.nativeSessionId, f.executorId)
      else if (change === 'unknown_effects')
        f.repo.recordNativeEffects(
          f.original.id,
          'unknown',
          'Startup work remains physically unconfirmed.',
        )
      else if (change === 'config_aba') {
        f.repo.saveSchedulingSettings({ expectedRevision: 1, enabled: false })
        f.repo.saveSchedulingSettings({ expectedRevision: 2, enabled: true })
      } else if (change === 'stop') f.repo.cancelSchedulingRecoveryFaults(f.sessionId)
      else if (change === 'native_question')
        f.repo.recordContextPermissions(f.sessionId, 'codex', f.original.id, [
          {
            id: randomUUID(),
            kind: 'questions',
            title: 'Original native question',
            detail: 'Waiting for the user.',
            createdAt: new Date().toISOString(),
          },
        ])
      else if (change === 'native_rebuild')
        f.repo.setContinuation(f.sessionId, 'codex', 'rebuilding')
      else if (change === 'new_input')
        f.repo.beginRun({
          sessionId: f.sessionId,
          clientMessageId: randomUUID(),
          content: 'A later real user request.',
          commentIds: [],
          expectedCommentsRevision: drafts(f).commentsRevision,
          agentId: 'codex',
          settingsRevision: 1,
          model: null,
          effort: null,
        })
      else f.repo.beginSchedulingRecoveryEpoch(randomUUID())
      const before = counts(f)
      expect(() => f.repo.beginConfirmedUnsentReexecution(admission(f))).toThrow(
        /eligible|fault|fresh|changed/u,
      )
      expect(counts(f)).toEqual(before)
      expect(f.repo.frozenExecutionEnvelope(f.original.id)).toEqual(input)
    },
  )
  it.each(['stop', 'configuration', 'native_question', 'executor'] as const)(
    'rechecks %s at the final native-write fence',
    async (change) => {
      const f = await fixture(),
        replacement = f.repo.beginConfirmedUnsentReexecution(admission(f))
      expect(f.repo.canDispatchReexecution(replacement.run.id)).toBe(true)
      if (change === 'stop') f.repo.cancelSchedulingRecoveryFaults(f.sessionId)
      else if (change === 'configuration')
        f.repo.saveSchedulingSettings({ expectedRevision: 1, enabled: false })
      else if (change === 'native_question')
        f.repo.recordContextPermissions(f.sessionId, 'codex', replacement.run.id, [
          {
            id: randomUUID(),
            kind: 'questions',
            title: 'Native question',
            detail: 'The original native owner needs an answer.',
            createdAt: new Date().toISOString(),
          },
        ])
      else {
        f.repo.recordExecutor(replacement.run.id, randomUUID())
        f.repo.applyEvent(f.sessionId, replacement.run.id, {
          agentId: 'codex',
          type: 'session.started',
          nativeSessionId: f.nativeSessionId,
        })
        f.repo.setContinuation(f.sessionId, 'codex', 'ready')
      }
      expect(f.repo.canDispatchReexecution(replacement.run.id)).toBe(false)
    },
  )
  it('does not replay a persisted proof after a real SQLite reopen and a fresh Utility epoch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-unsent-restart-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite'),
      f = await fixture({ filePath }),
      operation = admission(f),
      saved = f.repo.executionInput(f.original.id)
    f.db.close()
    databases.delete(f.db)
    const db = await PactDatabase.open({
      filePath,
      migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
    })
    databases.add(db)
    db.conversationRepository.beginSchedulingRecoveryEpoch(randomUUID())
    expect(db.conversationRepository.executionInput(f.original.id)).toEqual(saved)
    expect(() => db.conversationRepository.beginConfirmedUnsentReexecution(operation)).toThrow(
      /eligible/u,
    )
    expect(db.drizzle.select().from(runReexecutionOperations).all()).toEqual([])
  })
  it('does not transfer the old proof across an explicitly completed native binding generation', async () => {
    const f = await fixture(),
      operation = admission(f),
      id = randomUUID(),
      nativeSessionId = randomUUID()
    f.repo.beginNativeRebuild({
      id,
      sessionId: f.sessionId,
      agentId: 'codex',
      expectedGeneration: 1,
      abandon: false,
    })
    const chunks = []
    for await (const chunk of f.repo.nativeContextRebuildSource(
      f.sessionId,
      new AbortController().signal,
      id,
    ))
      chunks.push(chunk)
    f.repo.freezeNativeRebuildSource(id, chunks)
    f.repo.markNativeRebuildDispatched(id)
    f.repo.recordNativeRebuildIdentity(id, nativeSessionId)
    f.repo.completeNativeRebuild(id, nativeSessionId, undefined, {
      kind: 'codex_rollout_v1',
      nativeSessionId,
      verifiedPrefixBytes: 1024,
      verifiedPrefixSha256: 'e'.repeat(64),
      recordCount: 2,
    })
    expect(f.repo.nativeContext(f.sessionId, 'codex')).toMatchObject({
      bindingGeneration: 2,
      nativeSessionId,
    })
    expect(f.repo.executionInput(f.original.id)?.proof?.bindingGeneration).toBe(1)
    expect(() => f.repo.beginConfirmedUnsentReexecution(operation)).toThrow(/eligible/u)
    expect(f.db.drizzle.select().from(runReexecutionOperations).all()).toEqual([])
  })
  it('restores only the failed first @all stage and preserves the second recipient as pending', async () => {
    const f = await fixture({ route: 'all' }),
      replacement = f.repo.beginConfirmedUnsentReexecution(admission(f))
    expect(replacement.run.agentId).toBe('codex')
    expect(
      f.db.drizzle
        .select()
        .from(agentRuns)
        .all()
        .map((run) => run.agentId),
    ).toEqual(['codex', 'codex'])
    const message = f.db.drizzle
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, f.original.userMessageId))
      .get()!
    expect(message.routePendingAgentId).toBe('claude')
    expect(counts(f).messages).toBe(1)
  })
  it('restores the exact failed Plan review duty and reacquires its refunded discussion round exactly once', async () => {
    const f = await planRevisionFixture()
    databases.add(f.db)
    f.repo.beginSchedulingRecoveryEpoch(randomUUID())
    const response = f.repo.beginRun(f.admission()).run
    f.finish(response.id, { plan: 'Complete revised Plan for the original reviewer.' })
    const started = f.repo.beginRun(f.admission()).run,
      task = f.repo.collaboration(f.sessionId)!,
      auth = f.repo.collaborationTurnAuthorization(started.id),
      nativeGeneration = randomUUID(),
      executorId = randomUUID(),
      nativeSessionId = `fixture-${started.agentId}`
    if (!auth) throw new Error('The original Plan duty has no actual authorization')
    expect(task.discussionRounds).toBeGreaterThan(0)
    f.repo.recordExecutor(started.id, executorId)
    f.repo.applyEvent(f.sessionId, started.id, {
      agentId: started.agentId,
      type: 'session.started',
      nativeSessionId,
    })
    f.repo.setContinuation(f.sessionId, started.agentId, 'ready')
    const inputBatchRef = f.repo.inputBatchForRun(started.id),
      envelope: FrozenExecutionEnvelope = {
        version: 'pact-agent-prompt-v1',
        sessionId: f.sessionId,
        message: { id: started.userMessageId, content: 'Continue authorized work.' },
        comments: [],
        collaboration: f.repo.collaborationPromptState(task),
        collaborationAuthorization: auth,
        ...(inputBatchRef ? { inputBatchRef } : {}),
      }
    const captured = await f.repo.captureExecutionInput({
      runId: started.id,
      nativeGeneration,
      requested: {
        ...requested,
        provider: started.agentId,
        model: started.model ?? null,
        effort: started.effort ?? null,
      },
      source: bytes(JSON.stringify(envelope)),
      signal: new AbortController().signal,
    })
    expect(captured).toBeDefined()
    f.repo.recordEffectiveExecutionSettings(
      started.id,
      nativeGeneration,
      {
        ...effective,
        provider: started.agentId,
        provenance:
          started.agentId === 'codex' ? 'codex_thread_configuration' : 'claude_applied_settings',
      },
      {
        executorId,
        nativeSessionId,
      },
    )
    f.repo.recordDispatch(started.id, 'rejected', nativeSessionId, executorId)
    f.repo.recordConfirmedUnsent(
      started.id,
      nativeGeneration,
      started.agentId === 'codex'
        ? { kind: 'codex_root_frame_not_written', requestId: 8 }
        : { kind: 'claude_root_not_yielded' },
      { executorId, nativeSessionId },
    )
    f.repo.failRun(
      started.id,
      'transient_transport',
      'Physical root writer confirmed no input bytes.',
    )
    f.repo.finishCollaboration(started.id, false, 'Physical root writer confirmed no input bytes.')
    const failed = f.repo.collaboration(f.sessionId)!
    expect(failed).toMatchObject({
      id: task.id,
      status: 'failed',
      pauseReason: 'failure',
      actor: task.actor,
      stage: task.stage,
      discussionRounds: task.discussionRounds - 1,
    })
    f.repo.armSchedulingRecoveryFaults(f.sessionId)
    const candidate = f.repo
      .takeSchedulingRecoveryFaults()
      .find((row) => row.fault.runId === started.id)
    if (!candidate) throw new Error('The original Plan response fault was not recorded')
    const operation = {
        operationId: randomUUID(),
        faultId: candidate.fault.id,
        handoff: f.repo.recoveryHandoff({ kind: 'run', id: started.id }),
      },
      replacement = f.repo.beginConfirmedUnsentReexecution(operation),
      resumed = f.repo.collaboration(f.sessionId)!
    expect(resumed).toMatchObject({
      id: task.id,
      status: 'running',
      actor: task.actor,
      stage: task.stage,
      owner: task.owner,
      reviewer: task.reviewer,
      discussionRounds: task.discussionRounds,
      runId: replacement.run.id,
      planReference: task.planReference,
      review: task.review,
    })
    expect(f.repo.collaborationTurnAuthorization(replacement.run.id)).toEqual({
      ...auth,
      runId: replacement.run.id,
      taskRevision: resumed.revision,
    })
    expect(f.repo.canDispatchReexecution(replacement.run.id)).toBe(true)
    expect(f.repo.beginConfirmedUnsentReexecution(operation)).toMatchObject({
      created: false,
      run: { id: replacement.run.id },
    })
    expect(f.repo.collaboration(f.sessionId)?.discussionRounds).toBe(task.discussionRounds)
    expect(f.repo.findRun(started.id)).toMatchObject({
      status: 'failed',
      userMessageId: started.userMessageId,
    })
    f.finish(replacement.run.id, {
      verdict: 'changes_requested',
      answer: 'Original reviewer responsibility addressed completely.',
    })
    expect(f.repo.findRun(replacement.run.id)).toMatchObject({ status: 'completed' })
    expect(f.repo.collaboration(f.sessionId)?.discussionRounds).toBe(task.discussionRounds)
  })
  it('replaces only the failed second @all stage and retains the completed first stage and its full answer', async () => {
    const f = await fixture(),
      messageId = randomUUID(),
      content = 'A new exact two-stage request.',
      first = f.repo.beginRun({
        sessionId: f.sessionId,
        clientMessageId: messageId,
        content,
        commentIds: [],
        expectedCommentsRevision: drafts(f).commentsRevision,
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
        route: { type: 'all' },
      }).run,
      turnId = randomUUID(),
      answer = 'Complete first-stage answer.\nPreserve its final sentence.'
    f.repo.recordExecutor(first.id, f.executorId)
    f.repo.applyEvent(f.sessionId, first.id, {
      agentId: 'codex',
      type: 'session.started',
      nativeSessionId: f.nativeSessionId,
    })
    f.repo.applyEvent(f.sessionId, first.id, { agentId: 'codex', type: 'turn.started', turnId })
    f.repo.applyEvent(f.sessionId, first.id, {
      agentId: 'codex',
      type: 'text.completed',
      turnId,
      outputId: randomUUID(),
      text: answer,
    })
    f.repo.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: 'completed',
      identity: {
        agentId: 'codex',
        sessionId: f.sessionId,
        requestId: first.id,
        runId: first.id,
        bindingGeneration: 1,
        nativeSessionId: f.nativeSessionId,
        nativeTurnId: turnId,
        executorId: f.executorId,
      },
    })
    f.repo.recordNativeEffects(first.id, 'settled')
    f.repo.applyEvent(f.sessionId, first.id, {
      agentId: 'codex',
      type: 'turn.completed',
      turnId,
      outcome: 'completed',
    })
    const completed = f.repo.findRun(first.id)!,
      second = f.repo.beginRoutedContinuation({
        sessionId: f.sessionId,
        userMessageId: first.userMessageId,
        agentId: 'claude',
        settingsRevision: 1,
        model: null,
        effort: null,
      }).run,
      nativeSessionId = randomUUID(),
      executorId = randomUUID(),
      nativeGeneration = randomUUID(),
      inputBatchRef = f.repo.inputBatchForRun(second.id),
      envelope: FrozenExecutionEnvelope = {
        version: 'pact-agent-prompt-v1',
        sessionId: f.sessionId,
        message: { id: second.userMessageId, content },
        comments: [],
        handoffContext: [
          {
            messageId: completed.responseMessageId!,
            speaker: 'codex',
            content: answer,
            comments: [],
          },
        ],
        ...(inputBatchRef ? { inputBatchRef } : {}),
      }
    expect(completed.status).toBe('completed')
    f.repo.recordExecutor(second.id, executorId)
    f.repo.applyEvent(f.sessionId, second.id, {
      agentId: 'claude',
      type: 'session.started',
      nativeSessionId,
    })
    f.repo.setContinuation(f.sessionId, 'claude', 'ready')
    expect(
      await f.repo.captureExecutionInput({
        runId: second.id,
        nativeGeneration,
        requested: { ...requested, provider: 'claude' },
        source: bytes(JSON.stringify(envelope)),
        signal: new AbortController().signal,
      }),
    ).toBeDefined()
    f.repo.recordEffectiveExecutionSettings(
      second.id,
      nativeGeneration,
      { ...effective, provider: 'claude', provenance: 'claude_applied_settings' },
      { executorId, nativeSessionId },
    )
    f.repo.recordDispatch(second.id, 'rejected', nativeSessionId, executorId)
    f.repo.recordConfirmedUnsent(
      second.id,
      nativeGeneration,
      { kind: 'claude_root_not_yielded' },
      { executorId, nativeSessionId },
    )
    f.repo.failRun(
      second.id,
      'transient_transport',
      'This exact second-stage root was never yielded.',
    )
    f.repo.armSchedulingRecoveryFaults(f.sessionId)
    const candidate = f.repo
      .takeSchedulingRecoveryFaults()
      .find((row) => row.fault.runId === second.id)
    if (!candidate) throw new Error('The exact failed second-stage fault is unavailable')
    const replacement = f.repo.beginConfirmedUnsentReexecution({
      operationId: randomUUID(),
      faultId: candidate.fault.id,
      handoff: f.repo.recoveryHandoff({ kind: 'run', id: second.id }),
    })
    expect(replacement.run).toMatchObject({
      agentId: 'claude',
      userMessageId: first.userMessageId,
      reexecutedFromRunId: second.id,
    })
    expect(f.repo.findRun(first.id)).toEqual(completed)
    expect(f.repo.frozenExecutionEnvelope(second.id)).toEqual(envelope)
    expect(
      f.db.drizzle
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.userMessageId, first.userMessageId))
        .all()
        .map((run) => run.agentId),
    ).toEqual(['codex', 'claude', 'claude'])
    const originalUser = f.db.drizzle
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, first.userMessageId))
      .get()!
    expect(originalUser.routePendingAgentId).toBeNull()
  })
})
