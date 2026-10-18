import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  skillArguments,
  collaborationEnvelopeSchema,
  type CollaborationResult,
  type ConversationPageMessage,
  type FrozenSkillInvocation,
} from '@pact/contracts'

import {
  createQueueFixture,
  queueBodyHash,
  type QueueFixture,
} from './conversation-queue.test-helper.js'
import {
  anchoredComments,
  collaborationInputs,
  conversationBodyInputs,
  conversationInputBatches,
  conversationInputBatchMembers,
  conversationQueueOperations,
} from './schema/index.js'

const fixtures: QueueFixture[] = [],
  directories: string[] = []
afterEach(async () => {
  fixtures.splice(0).forEach((value) => value.close())
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture(persistent = false) {
  let filePath: string | undefined
  if (persistent) {
    const directory = await mkdtemp(join(tmpdir(), 'pact-queue-regression-'))
    directories.push(directory)
    filePath = join(directory, 'pact.sqlite')
  }
  const value = await createQueueFixture(filePath)
  fixtures.push(value)
  return value
}
function operation(value: QueueFixture, id: string) {
  return value.db.drizzle
    .select()
    .from(conversationQueueOperations)
    .where(eq(conversationQueueOperations.id, id))
    .get()!
}
function frozenComments(value: QueueFixture) {
  const members = value.db.drizzle.select().from(conversationInputBatchMembers).all()
  return {
    members,
    comments: value.db.drizzle
      .select()
      .from(anchoredComments)
      .all()
      .filter((comment) => members.some((member) => member.commentId === comment.id)),
  }
}
function completeMessage(item: ConversationPageMessage | undefined) {
  if (item?.kind !== 'complete') throw new Error('Expected a complete, small fixture message')
  return item.message
}

describe('queued workflow classification through the sealed body', () => {
  it.each([
    '/review inspect',
    '@codex /review inspect',
    '@claude /build implement',
    ' '.repeat(32) + '@codex /plan inspect',
  ])('keeps %j independent from the existing collaboration Task', async (content) => {
    const value = await fixture(),
      root = value.root(true),
      task = value.repo.collaboration(value.sessionId)!,
      request = value.queue(root, content),
      received = value.repo.readReceivedInput(value.sessionId)!
    expect(received.content).toBe(content)
    expect(received.metadata.workflowCommand).toBe(true)
    expect(received.taskId).toBeNull()
    expect(value.repo.queueState(value.sessionId).input?.workflowCommand).toBe(true)
    expect(() => value.prepare(root, request)).toThrow(/cannot be steered/)
    expect(value.repo.collaboration(value.sessionId)).toEqual(task)
    expect(value.repo.queueState(value.sessionId).input?.state).toBe('queued')
  })

  it('freezes ordinary feedback to the current Task and preserves a native chip named review', async () => {
    const value = await fixture(),
      root = value.root(true),
      content = '@codex /review check the implementation',
      selection = {
        id: 'a'.repeat(64),
        agentId: 'codex' as const,
        name: 'review',
        start: 7,
        end: 14,
      }
    const request = value.queue(root, content, { skills: [selection] })
    const received = value.repo.readReceivedInput(value.sessionId)!
    expect(received.metadata.workflowCommand).toBe(false)
    expect(received.metadata.skills).toEqual([selection])
    expect(received.taskId).toBe(root.collaboration?.taskId)
    expect(value.prepare(root, request).created).toBe(true)
  })

  it('rejects malformed mixed commands before reserving the queue or freezing Comments', async () => {
    const value = await fixture(),
      root = value.root(true)
    value.comment(root, 'Keep this draft')
    const before = value.drafts()
    expect(() => value.queue(root, '@codex /review /format inspect')).toThrow(
      /Pact Skill or native Skills/,
    )
    expect(value.repo.queueState(value.sessionId).input).toBeNull()
    expect(value.drafts()).toEqual(before)
    expect(value.db.drizzle.select().from(conversationInputBatchMembers).all()).toEqual([])
  })
})

describe('queued Return claims and durable Comment ownership', () => {
  it('rejects a stale queue removal after another action changes its revision', async () => {
    const value = await fixture(),
      root = value.root(),
      request = value.queue(root, 'Keep this queued input')
    value.repo.pauseConversationQueue(value.sessionId, 'Paused by another action')
    const paused = value.repo.queueState(value.sessionId)
    expect(() => value.repo.removeQueuedConversationMessage(request)).toThrow(/queue changed/)
    expect(value.repo.queueState(value.sessionId)).toEqual(paused)
    expect(value.repo.readReceivedInput(value.sessionId)?.content).toBe('Keep this queued input')
  })

  it('replays a lost claim ACK after cold reopen without cloning Comments again', async () => {
    const value = await fixture(true),
      root = value.root()
    value.comment(root, 'Frozen first observation')
    value.comment(root, 'Frozen second observation')
    const request = value.queue(root, 'Return the complete input')
    value.repo.returnQueuedConversationMessage({ ...request, phase: 'return' })
    const source = frozenComments(value),
      capturedRevision = value.drafts().commentsRevision
    value.repo.returnQueuedConversationMessage({
      ...request,
      phase: 'claim',
      claimId: request.operationId,
      expectedCommentsRevision: capturedRevision,
    })
    const installed = value.drafts(),
      receipt = value.repo.queueState(value.sessionId).returnedInput
    expect(installed.comments.map((comment) => comment.body)).toEqual([
      'Frozen first observation',
      'Frozen second observation',
    ])
    expect(receipt?.claimId).toBe(request.operationId)
    await value.reopen()
    value.repo.returnQueuedConversationMessage({
      ...request,
      phase: 'claim',
      claimId: receipt!.claimId!,
      expectedCommentsRevision: capturedRevision,
    })
    expect(value.drafts().comments).toEqual(installed.comments)
    expect(value.drafts().commentsRevision).toBe(installed.commentsRevision)
    expect(value.repo.queueState(value.sessionId).returnedInput).toEqual(receipt)
    expect(frozenComments(value)).toEqual(source)
  })

  it('rejects a click-start revision after another Comment edit and allows a new explicit overwrite', async () => {
    const value = await fixture(),
      root = value.root()
    value.comment(root, 'Frozen queued observation')
    const request = value.queue(root, 'Return input')
    value.repo.returnQueuedConversationMessage({ ...request, phase: 'return' })
    const capturedRevision = value.drafts().commentsRevision,
      source = frozenComments(value)
    value.comment(root, 'Added while the body was being read')
    const concurrent = value.drafts()
    expect(() =>
      value.repo.returnQueuedConversationMessage({
        ...request,
        phase: 'claim',
        claimId: request.operationId,
        expectedCommentsRevision: capturedRevision,
      }),
    ).toThrow(/drafts changed/)
    expect(value.drafts()).toEqual(concurrent)
    expect(value.repo.queueState(value.sessionId).returnedInput?.state).toBe('pending')
    value.repo.returnQueuedConversationMessage({
      ...request,
      phase: 'claim',
      claimId: randomUUID(),
      expectedCommentsRevision: concurrent.commentsRevision,
    })
    expect(value.drafts().comments.map((comment) => comment.body)).toEqual([
      'Frozen queued observation',
    ])
    expect(frozenComments(value).members).toEqual(source.members)
    expect(value.db.drizzle.select().from(anchoredComments).all()).toEqual(
      expect.arrayContaining(source.comments),
    )
  })

  it('does not let an installed claim retry overwrite a subsequent Comment edit', async () => {
    const value = await fixture(),
      root = value.root()
    value.comment(root, 'Queued observation')
    const request = value.queue(root, 'Return input')
    value.repo.returnQueuedConversationMessage({ ...request, phase: 'return' })
    value.repo.returnQueuedConversationMessage({
      ...request,
      phase: 'claim',
      claimId: request.operationId,
      expectedCommentsRevision: value.drafts().commentsRevision,
    })
    value.comment(root, 'New draft after installation')
    const edited = value.drafts()
    expect(() =>
      value.repo.returnQueuedConversationMessage({
        ...request,
        phase: 'claim',
        claimId: request.operationId,
        expectedCommentsRevision: edited.commentsRevision,
      }),
    ).toThrow(/changed after this input was restored/)
    expect(value.drafts()).toEqual(edited)
  })
})

describe('Steer receipts against the original native execution', () => {
  it.each([
    { phase: 'possibly_sent', legacyAlias: false },
    { phase: 'unknown', legacyAlias: false },
    { phase: 'unknown', legacyAlias: true },
  ] as const)(
    'accepts independent final nonce proof for $phase delivery (legacy root UUID alias: $legacyAlias)',
    async ({ phase, legacyAlias }) => {
      const value = await fixture(),
        root = value.root(true)
      value.comment(root, 'Preserve this frozen observation')
      let request = value.queue(root, 'Apply this supplemental requirement')
      const grant = value.prepare(root, request)
      value.repo.markQueuedSteerPossiblySent(request.operationId)
      if (phase === 'unknown') value.repo.markQueuedSteerUnknown(request.operationId)
      const received = value.repo.readReceivedInput(value.sessionId)!,
        bodyBefore = value.db.drizzle
          .select()
          .from(conversationBodyInputs)
          .where(eq(conversationBodyInputs.id, received.inputId))
          .get()!,
        frozen = frozenComments(value)
      if (legacyAlias) {
        // Reproduce only the durable identity mapping of a pre-guard legacy intent.
        // Its sealed bytes, digest, Batch/member identities, nonce and Run stay intact.
        value.db.drizzle.transaction((transaction) => {
          transaction.run(sql`PRAGMA defer_foreign_keys = ON`)
          transaction
            .update(collaborationInputs)
            .set({ id: root.id })
            .where(eq(collaborationInputs.id, request.inputId))
            .run()
          transaction
            .update(conversationQueueOperations)
            .set({ inputId: root.id })
            .where(eq(conversationQueueOperations.id, request.operationId))
            .run()
          transaction
            .update(conversationInputBatches)
            .set({ clientMessageId: root.id })
            .where(eq(conversationInputBatches.clientMessageId, request.inputId))
            .run()
          transaction
            .update(conversationBodyInputs)
            .set({ clientMessageId: root.id, pendingReceiptId: root.id })
            .where(eq(conversationBodyInputs.id, received.inputId))
            .run()
          transaction
            .update(anchoredComments)
            .set({ pendingReceiptId: root.id })
            .where(eq(anchoredComments.pendingReceiptId, request.inputId))
            .run()
        })
        request = { ...request, inputId: root.id }
        value.repo.recordQueuedSteerConsumption(value.proof(root), request.inputId)
      }
      const auth = value.repo.collaborationTurnAuthorization(root.id)!,
        inputResponses: CollaborationResult['inputResponses'] = []
      let offset = 0
      for (;;) {
        const page = value.repo.readRequiredInputMembers(root.id, offset, grant.inputRevision)
        inputResponses.push(
          ...page.items.map((item) => ({
            batchId: item.batchId,
            memberId: item.memberId,
            disposition: 'resolved' as const,
            reason: 'Applied the complete frozen requirement to the submitted plan.',
            todoId: null,
          })),
        )
        if (page.nextOffset === null) break
        offset = page.nextOffset
      }
      const result: CollaborationResult = {
        submission: auth.duty,
        outcome: 'complete',
        summary: 'The plan includes the supplemental requirement and frozen observation.',
        plan: 'Scope and acceptance include the complete supplemental requirement.',
        todoDeltas: [],
        inputRevision: grant.inputRevision,
        resultNonce: grant.resultNonce,
        inputResponses,
      }
      const carrier = collaborationEnvelopeSchema.parse({
        version: 'pact-collaboration-envelope-v5',
        answer: 'Full final response.',
        result,
      })
      expect(inputResponses).toHaveLength(3)
      expect(operation(value, request.operationId).state).toBe(phase)
      value.repo.recordCollaborationCarrierText(root.id, JSON.stringify(carrier))
      const proofPatch = value.repo.recordCollaborationCarrier(root.id, carrier)
      expect(proofPatch?.resync).toMatchObject({ messages: true, drafts: true })
      expect(operation(value, request.operationId).state).toBe('consumed')
      value.repo.recordCollaborationResult(root.id, carrier.result)
      value.finish(root)
      value.repo.recordNativeEffects(root.id, 'settled')
      expect(value.repo.queueState(value.sessionId).input).toBeNull()
      expect(value.repo.unresolvedSteerInputs(root.id)).toEqual([])
      expect(value.repo.collaboration(value.sessionId)).toMatchObject({
        id: root.collaboration!.taskId,
        runId: root.id,
        status: 'waiting',
        planVersion: 1,
      })
      expect(value.repo.collaborationReportSource(value.sessionId, root.id)).toMatchObject(result)
      expect(
        value.repo
          .readRequiredInputMembers(root.id, 0, grant.inputRevision)
          .items.every((member) => member.state === 'resolved'),
      ).toBe(true)
      expect(value.repo.message(request.inputId, value.sessionId)?.content).toBe(received.content)
      expect(
        value.db.drizzle
          .select()
          .from(conversationBodyInputs)
          .where(eq(conversationBodyInputs.id, received.inputId))
          .get(),
      ).toMatchObject({
        hash: bodyBefore.hash,
        chars: bodyBefore.chars,
        bytes: bodyBefore.bytes,
        sealed: true,
      })
      expect(
        frozenComments(value).members.map(({ bodySha256, anchorJson }) => ({
          bodySha256,
          anchorJson,
        })),
      ).toEqual(frozen.members.map(({ bodySha256, anchorJson }) => ({ bodySha256, anchorJson })))
      expect(value.repo.findRun(root.id)?.outputSnapshots?.settled).toBe(true)
    },
  )

  it('recovers an undispatched reservation as paused without materializing or retrying it', async () => {
    const value = await fixture(true),
      root = value.root(),
      request = value.queue(root, 'Never dispatched')
    value.prepare(root, request)
    await value.reopen()
    expect(operation(value, request.operationId).state).toBe('refused')
    expect(value.repo.queueState(value.sessionId).input?.state).toBe('paused')
    expect(value.repo.unresolvedSteerInputs(root.id)).toEqual([])
    expect(value.page().messages.some(({ message }) => message.id === request.inputId)).toBe(false)
    expect(() =>
      value.repo.recordQueuedSteerConsumption(value.proof(root), request.inputId),
    ).toThrow(/original execution/)
    expect(value.repo.readReceivedInput(value.sessionId)?.content).toBe('Never dispatched')
  })

  it.each([
    'runId',
    'sessionId',
    'nativeSessionId',
    'nativeTurnId',
    'bindingGeneration',
    'executorId',
  ] as const)('rejects mismatched %s without mutating the intent', async (field) => {
    const value = await fixture(),
      root = value.root(),
      request = value.queue(root, 'Keep the source')
    value.prepare(root, request)
    value.repo.markQueuedSteerPossiblySent(request.operationId)
    const proof = value.proof(root),
      before = operation(value, request.operationId)
    const mismatched = {
      ...proof,
      [field]: field === 'bindingGeneration' ? proof.bindingGeneration + 1 : randomUUID(),
    }
    expect(() => value.repo.recordQueuedSteerConsumption(mismatched, request.inputId)).toThrow(
      /original execution/,
    )
    expect(operation(value, request.operationId)).toEqual(before)
    expect(value.repo.queueState(value.sessionId).input?.state).toBe('dispatching')
    expect(value.page().messages.some(({ message }) => message.id === request.inputId)).toBe(false)
  })

  it('keeps ACK distinct from consumption and settles only after an exact native receipt', async () => {
    const value = await fixture(),
      root = value.root(),
      request = value.queue(root, 'Accepted supplement')
    value.prepare(root, request)
    value.repo.markQueuedSteerPossiblySent(request.operationId)
    value.repo.markQueuedSteerAccepted(request.operationId)
    value.finish(root)
    value.repo.recordNativeEffects(root.id, 'settled')
    expect(operation(value, request.operationId).state).toBe('accepted')
    expect(value.repo.findRun(root.id)?.outputSnapshots?.settled).toBe(false)
    expect(value.repo.unresolvedSteerInputs(root.id).map((item) => item.inputId)).toEqual([
      request.inputId,
    ])
    expect(() => value.repo.recordQueuedSteerConsumption(value.proof(root), randomUUID())).toThrow(
      /original execution/,
    )
    value.repo.recordQueuedSteerConsumption(value.proof(root), request.inputId)
    expect(operation(value, request.operationId).state).toBe('consumed')
    expect(value.repo.unresolvedSteerInputs(root.id)).toEqual([])
    expect(value.repo.findRun(root.id)?.outputSnapshots?.settled).toBe(true)
  })

  it('makes event-before-ACK consumption and duplicate recovery idempotent', async () => {
    const value = await fixture(),
      root = value.root(),
      request = value.consume(root)
    const before = {
      queue: value.repo.queueState(value.sessionId),
      messages: value.page().messages,
      operation: operation(value, request.operationId),
    }
    value.repo.recordQueuedSteerConsumption(value.proof(root), request.inputId)
    value.repo.markQueuedSteerAccepted(request.operationId)
    expect(value.repo.queueState(value.sessionId)).toEqual(before.queue)
    expect(value.page().messages).toEqual(before.messages)
    expect(operation(value, request.operationId)).toEqual(before.operation)
    expect(before.queue.input).toBeNull()
    expect(before.messages.filter(({ message }) => message.id === request.inputId)).toHaveLength(1)
  })

  it.each(['possibly_sent', 'accepted'] as const)(
    'recovers a %s intent after restart with the original receipt even after a newer Run starts',
    async (phase) => {
      const value = await fixture(true),
        root = value.root(),
        request = value.queue(root, 'Delivered before restart')
      value.prepare(root, request)
      value.repo.markQueuedSteerPossiblySent(request.operationId)
      if (phase === 'accepted') value.repo.markQueuedSteerAccepted(request.operationId)
      value.finish(root)
      value.repo.recordNativeEffects(root.id, 'settled')
      const before = value.repo.findRun(root.id)!
      await value.reopen()
      expect(operation(value, request.operationId).state).toBe(
        phase === 'accepted' ? 'accepted' : 'unknown',
      )
      expect(value.repo.findRun(root.id)?.outputSnapshots?.settled ?? false).toBe(false)
      const newer = value.root(),
        newerBefore = value.repo.findRun(newer.id)
      expect(() =>
        value.repo.recordQueuedSteerConsumption(value.proof(newer), request.inputId),
      ).toThrow(/original execution/)
      value.repo.recordQueuedSteerConsumption(value.proof(root), request.inputId)
      expect(operation(value, request.operationId).state).toBe('consumed')
      expect(value.repo.findRun(newer.id)).toEqual(newerBefore)
      expect(value.repo.findRun(root.id)).toMatchObject({
        status: before.status,
        nativeOutcome: before.nativeOutcome,
        dispatchPhase: before.dispatchPhase,
        nativeEffectsState: before.nativeEffectsState,
      })
      expect(
        value.page().messages.filter(({ message }) => message.id === request.inputId),
      ).toHaveLength(1)
    },
  )

  it.each([false, true])(
    'restores frozen native Skill metadata after restart (opaque selection: %s)',
    async (opaque) => {
      const value = await fixture(true),
        root = value.root(),
        content = '@codex /format Use exact output',
        selections = opaque
          ? [{ id: 'a'.repeat(64), agentId: 'codex' as const, name: 'format', start: 7, end: 14 }]
          : [],
        request = value.queue(root, content, { skills: selections })
      const invocation: FrozenSkillInvocation = {
        version: 'pact-skills-v1',
        arguments: skillArguments(content, selections),
        selections,
        bindings: [
          {
            id: 'a'.repeat(64),
            agentId: 'codex',
            name: 'format',
            description: 'Frozen description',
            argumentHint: 'Original hint',
            source: 'native',
            path: '/frozen/format/SKILL.md',
          },
        ],
      }
      value.prepare(root, request, invocation)
      value.repo.markQueuedSteerPossiblySent(request.operationId)
      await value.reopen()
      value.repo.recordQueuedSteerConsumption(value.proof(root), request.inputId)
      expect(value.repo.skillInvocation(request.inputId)).toEqual(invocation)
      expect(
        completeMessage(value.page().messages.find(({ message }) => message.id === request.inputId))
          .content,
      ).toBe(content)
    },
  )

  it('preserves an uncertain legacy native Skill when its frozen invocation is unavailable', async () => {
    const value = await fixture(true),
      root = value.root(),
      request = value.queue(root, '/format Keep the original native selection')
    value.prepare(root, request)
    value.repo.markQueuedSteerPossiblySent(request.operationId)
    await value.reopen()
    const before = operation(value, request.operationId),
      queue = value.repo.queueState(value.sessionId)
    expect(() =>
      value.repo.recordQueuedSteerConsumption(value.proof(root), request.inputId),
    ).toThrow(/frozen native Skill invocation is unavailable/)
    expect(operation(value, request.operationId)).toEqual(before)
    expect(value.repo.queueState(value.sessionId)).toEqual(queue)
    expect(value.repo.readReceivedInput(value.sessionId)?.content).toBe(
      '/format Keep the original native selection',
    )
    expect(value.page().messages.some(({ message }) => message.id === request.inputId)).toBe(false)
  })
})

describe('settled snapshot projection and independent live preservation', () => {
  it('reopens frozen sources when a late native effects observation becomes unknown', async () => {
    const value = await fixture(),
      root = value.root()
    value.consume(root)
    value.finish(root)
    expect(value.repo.findRun(root.id)?.outputSnapshots?.settled).toBe(false)
    value.repo.recordNativeEffects(root.id, 'settled')
    expect(value.repo.findRun(root.id)?.outputSnapshots?.settled).toBe(true)
    const expanded = value.page({ snapshotView: { runId: root.id, mode: 'expanded' } }),
      source = completeMessage(
        expanded.messages.find(({ message }) => message.outputSnapshot?.canonical === false),
      ),
      hash = queueBodyHash(source.content)
    expect(value.page().messages.some(({ message }) => message.id === source.id)).toBe(false)
    const reversal = value.repo.recordNativeEffects(root.id, 'unknown')
    expect(reversal.runs?.find((run) => run.id === root.id)?.outputSnapshots?.settled).toBe(false)
    const recovered = completeMessage(
      value.page().messages.find(({ message }) => message.id === source.id),
    )
    expect(queueBodyHash(recovered.content)).toBe(hash)
    expect(recovered.outputSnapshot?.canonical).toBe(false)
    value.repo.recordNativeEffects(root.id, 'settled')
    expect(value.page().messages.some(({ message }) => message.id === source.id)).toBe(false)
  })

  it('keeps historical Run A expanded independently of live preserved Run B', async () => {
    const value = await fixture(),
      a = value.root()
    value.consume(a, 'A supplement')
    value.finish(a)
    value.repo.recordNativeEffects(a.id, 'settled')
    const aSource = completeMessage(
      value
        .page({ snapshotView: { runId: a.id, mode: 'expanded' } })
        .messages.find(({ message }) => message.outputSnapshot?.canonical === false),
    )
    const b = value.root()
    value.consume(b, 'B supplement')
    value.finish(b)
    value.repo.recordNativeEffects(b.id, 'settled')
    const both = value.page({
      snapshotView: { runId: a.id, mode: 'expanded' },
      preserveRunId: b.id,
    })
    expect(both.messages.some(({ message }) => message.id === aSource.id)).toBe(true)
    expect(
      both.messages.some(
        ({ message }) => message.runId === b.id && message.outputSnapshot?.canonical === false,
      ),
    ).toBe(true)
    expect(both.preserveRunId).toBe(b.id)
    const foldedB = value.page({ snapshotView: { runId: a.id, mode: 'expanded' } })
    expect(foldedB.messages.some(({ message }) => message.id === aSource.id)).toBe(true)
    expect(
      foldedB.messages.some(
        ({ message }) => message.runId === b.id && message.outputSnapshot?.canonical === false,
      ),
    ).toBe(false)
    expect(
      queueBodyHash(
        completeMessage(foldedB.messages.find(({ message }) => message.id === aSource.id)).content,
      ),
    ).toBe(queueBodyHash(aSource.content))
    expect(
      value.page().messages.some(({ message }) => message.outputSnapshot?.canonical === false),
    ).toBe(false)
  })

  it('does not allow a preserved Run to expose a source owned by another Session', async () => {
    const owner = await fixture(),
      root = owner.root()
    owner.consume(root)
    const sessionId = randomUUID()
    owner.db.sessionRepository.create(
      {
        id: sessionId,
        projectId: owner.db.sessionRepository.find(owner.sessionId)!.projectId,
        title: 'Another Session in the same database',
        createdAt: new Date().toISOString(),
      },
      owner.db.sessionRepository.findSettingsRevision(owner.sessionId, 1)!,
    )
    expect(() =>
      owner.repo.readPage({ scope: 'messages', sessionId, preserveRunId: root.id }),
    ).toThrow(/unavailable in this Session/)
    expect(() =>
      owner.repo.readPage({
        scope: 'messages',
        sessionId,
        snapshotView: { runId: root.id, mode: 'expanded' },
      }),
    ).toThrow(/unavailable/)
  })
})
