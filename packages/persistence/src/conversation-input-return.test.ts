import { and, eq, isNull, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CONVERSATION_PATCH_BYTES, conversationPatchSchema } from '@pact/contracts'

import {
  createInputReturnFixture,
  inputReturnTimestamp,
  type InputReturnFixture,
} from './conversation-input-return.test-helper.js'
import { PactDatabase } from './pact-database.js'
import {
  agentEventJournal,
  agentRuns,
  anchoredComments,
  conversationMessages,
} from './schema/index.js'

const fixtures: InputReturnFixture[] = []
const reopenedDatabases: PactDatabase[] = []
const temporaryDirectories: string[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) fixture.db.close()
  for (const db of reopenedDatabases.splice(0)) db.close()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
const fixture = async (options?: Parameters<typeof createInputReturnFixture>[0]) => {
  const value = await createInputReturnFixture(options)
  fixtures.push(value)
  return value
}
const events = (value: InputReturnFixture, name: string) =>
  value.db.drizzle
    .select()
    .from(agentEventJournal)
    .where(eq(agentEventJournal.eventType, name))
    .all()

describe('Rebuild input return through the Conversation Repository', () => {
  it.each(['not_sent', 'rejected'] as const)(
    'returns only proven %s input without including it in the native seed',
    async (phase) => {
      const value = await fixture({
        comments: ['First comment', 'Second comment'],
        run: { dispatchPhase: phase },
      })
      const beforeMessage = value.sourceMessage(),
        beforeRun = value.sourceRun()
      const { operationId, chunks, patch } = await value.rebuild()
      expect(chunks.some((chunk) => chunk.messageId === value.messageId)).toBe(false)
      expect(patch.removedMessageIds).toContain(value.messageId)
      expect(patch.rebuildInputRecovery).toMatchObject({
        operationId,
        messageId: value.messageId,
        state: 'pending',
        route: value.route,
      })
      const page = value.repo.readPage({ scope: 'messages', sessionId: value.sessionId })
      expect(
        page.scope === 'messages' &&
          page.messages.some((item) => item.message.id === value.messageId),
      ).toBe(false)
      expect(value.sourceMessage()).toEqual({ ...beforeMessage, isVisible: false })
      expect(value.sourceRun()).toEqual(beforeRun)
      expect(
        value.db.drizzle
          .select()
          .from(anchoredComments)
          .where(eq(anchoredComments.sentWithMessageId, value.messageId))
          .all(),
      ).toEqual(value.sourceComments)

      const beforeClaimRevision = value.revision()
      const claim = value.repo.claimReturnedInput(
        value.sessionId,
        operationId,
        2,
        beforeClaimRevision,
      )
      expect(claim.comments?.revision).toBe(beforeClaimRevision + 1)
      expect(claim.resync?.drafts).toBe(true)
      expect(claim.rebuildInputRecovery?.state).toBe('installed')
      expect(
        value.drafts().map((comment) => ({ body: comment.body, anchor: comment.anchor })),
      ).toEqual(
        value.sourceComments.map((comment) => ({
          body: comment.body,
          anchor: JSON.parse(comment.anchorJson),
        })),
      )
      expect(value.drafts().map((comment) => comment.id)).not.toEqual(
        value.sourceComments.map((comment) => comment.id),
      )
      const clones = value.drafts(),
        revision = value.revision()
      const retry = value.repo.claimReturnedInput(value.sessionId, operationId, 2, revision)
      expect(value.drafts()).toEqual(clones)
      expect(value.revision()).toBe(revision)
      expect(retry.resync?.drafts).toBe(false)
      expect(events(value, 'native.input_returned')).toHaveLength(1)
    },
  )

  it('pages the complete body and preserves the original ordered @all route', async () => {
    const content = '@all ' + 'x'.repeat(19_000)
    const route = {
      type: 'all' as const,
      firstAgentId: 'codex' as const,
      secondAgentId: 'claude' as const,
    }
    const value = await fixture({ content, route })
    const { operationId } = await value.rebuild()
    let restored = '',
      offset = 0,
      count = 0
    for (;;) {
      const part = value.repo.readPage({
        scope: 'rebuild-input',
        sessionId: value.sessionId,
        operationId,
        offset,
      })
      expect(part.scope).toBe('rebuild-input')
      if (part.scope !== 'rebuild-input') throw new Error('Wrong page scope')
      expect(part.text.length).toBeLessThanOrEqual(8192)
      expect(part.route).toEqual(route)
      restored += part.text
      offset = part.nextOffset
      count += 1
      if (!part.hasMore) break
      expect(count).toBeLessThan(13)
    }
    expect(restored).toBe(content)
    expect(count).toBe(Math.ceil(content.length / 4096))
    expect(value.repo.returnedInputRoute(value.sessionId, operationId)).toEqual(route)
  })

  it.each([
    ['possibly sent', { dispatchPhase: 'possibly_sent' }],
    ['accepted', { dispatchPhase: 'accepted' }],
    ['native turn', { nativeTurnId: randomUUID() }],
    ['native outcome', { nativeOutcome: 'failed' }],
    ['unknown delivery', { failureKind: 'unknown_delivery' }],
    ['non-failed Run', { status: 'completed', dispatchPhase: 'ended', nativeOutcome: 'completed' }],
  ] as const)('does not return input with %s evidence', async (_name, run) => {
    const value = await fixture({ run })
    const { chunks, patch } = await value.rebuild({ abandon: true })
    expect(patch.rebuildInputRecovery).toBeNull()
    expect(value.sourceMessage().isVisible).toBe(true)
    expect(chunks.some((chunk) => chunk.messageId === value.messageId)).toBe(true)
  })

  it('does not return a shared User message when another @all Run was accepted', async () => {
    const value = await fixture({
      route: { type: 'all', firstAgentId: 'codex', secondAgentId: 'claude' },
    })
    value.db.drizzle
      .insert(agentRuns)
      .values({
        ...value.sourceRun(),
        id: randomUUID(),
        agentId: 'claude',
        dispatchPhase: 'ended',
        status: 'completed',
        nativeTurnId: randomUUID(),
        nativeOutcome: 'completed',
      })
      .run()
    const { patch, chunks } = await value.rebuild()
    expect(patch.rebuildInputRecovery).toBeNull()
    expect(chunks.some((chunk) => chunk.messageId === value.messageId)).toBe(true)
  })

  it.each(['user', 'assistant'] as const)(
    'does not return an earlier input after a later %s message',
    async (role) => {
      const value = await fixture()
      value.db.drizzle
        .insert(conversationMessages)
        .values({
          id: randomUUID(),
          sessionId: value.sessionId,
          runId: value.runId,
          role,
          agentId: role === 'assistant' ? 'codex' : null,
          content: 'Later message',
          state: 'complete',
          sequence: 1,
          createdAt: inputReturnTimestamp,
          updatedAt: inputReturnTimestamp,
        })
        .run()
      const { patch } = await value.rebuild()
      expect(patch.rebuildInputRecovery).toBeNull()
    },
  )

  it('keeps a pending input available across repeated Rebuilds without seeding it or changing its receipt', async () => {
    const value = await fixture({ comments: ['Keep sent comment'] })
    const first = await value.rebuild()
    const second = await value.rebuild()
    expect(second.patch.rebuildInputRecovery).toMatchObject({
      operationId: first.operationId,
      bindingGeneration: 3,
      state: 'pending',
    })
    expect(second.chunks.some((chunk) => chunk.messageId === value.messageId)).toBe(false)
    expect(value.repo.readReturnedInput(value.sessionId, first.operationId, 0).text).toBe(
      value.content,
    )
    expect(() =>
      value.repo.claimReturnedInput(value.sessionId, first.operationId, 2, value.revision()),
    ).toThrow(/generation/)
    value.repo.claimReturnedInput(value.sessionId, first.operationId, 3, value.revision())
    expect(value.drafts()).toHaveLength(1)
  })

  it('consumes the restored receipt with its new Send, and acknowledges duplicate Send without cloning or dispatching again', async () => {
    const value = await fixture({ comments: ['Sent comment'] })
    const { operationId } = await value.rebuild()
    value.repo.claimReturnedInput(value.sessionId, operationId, 2, value.revision())
    const input = {
      returnedInputOperationId: operationId,
      clientMessageId: randomUUID(),
      expectedCommentsRevision: value.revision(),
      commentIds: value.drafts().map((comment) => comment.id),
    }
    const first = value.send(input)
    const second = value.send(input)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.run.id).toBe(first.run.id)
    expect(value.repo.rebuildInputRecovery(value.sessionId)).toBeNull()
    expect(value.drafts()).toHaveLength(0)
    expect(events(value, 'native.input_consumed')).toHaveLength(1)
    expect(value.sourceMessage().content).toBe(value.content)
  })

  it('does not consume a restored receipt when the Send transaction fails after the receipt update', async () => {
    const value = await fixture({ comments: ['Keep clone'] })
    const { operationId } = await value.rebuild()
    value.repo.claimReturnedInput(value.sessionId, operationId, 2, value.revision())
    const comments = value.drafts()
    // Inject a write failure after receipt consumption to exercise the real SQLite transaction.
    value.db.drizzle.run(
      sql`CREATE TEMP TRIGGER fail_return_send BEFORE INSERT ON conversation_messages BEGIN SELECT RAISE(ABORT, 'owned send failure'); END`,
    )
    expect(() => value.send({ returnedInputOperationId: operationId })).toThrow(
      'owned send failure',
    )
    expect(value.repo.rebuildInputRecovery(value.sessionId)?.state).toBe('installed')
    expect(value.drafts()).toEqual(comments)
    expect(events(value, 'native.input_consumed')).toHaveLength(0)
  })

  it.each(['pending', 'installed'] as const)(
    'an ordinary new Composer Send supersedes %s recovery instead of replaying it later',
    async (state) => {
      const value = await fixture()
      const { operationId } = await value.rebuild()
      if (state === 'installed')
        value.repo.claimReturnedInput(value.sessionId, operationId, 2, value.revision())
      value.send({ content: 'A different user request' })
      expect(value.repo.rebuildInputRecovery(value.sessionId)).toBeNull()
      expect(events(value, 'native.input_consumed')[0]?.payload).toContain('new_input_sent')
    },
  )

  it('a peer action preserves pending input recovery', async () => {
    const value = await fixture()
    const { operationId } = await value.rebuild()
    value.send({ content: 'Peer action', preserveDraftComments: true })
    expect(value.repo.rebuildInputRecovery(value.sessionId)?.operationId).toBe(operationId)
    expect(events(value, 'native.input_consumed')).toHaveLength(0)
  })

  it('refuses to overwrite an existing Comment draft and checks the observed revision', async () => {
    const value = await fixture({ comments: ['Old sent comment'] })
    const { operationId } = await value.rebuild()
    const revision = value.revision()
    const draft = {
      ...value.sourceComments[0]!,
      id: randomUUID(),
      body: 'New draft',
      sentWithMessageId: null,
      position: 1,
    }
    value.db.drizzle.insert(anchoredComments).values(draft).run()
    expect(() => value.repo.claimReturnedInput(value.sessionId, operationId, 2, revision)).toThrow(
      /Comment drafts/,
    )
    expect(value.drafts().map((item) => item.body)).toEqual(['New draft'])
    expect(value.repo.rebuildInputRecovery(value.sessionId)?.state).toBe('pending')
    expect(() =>
      value.repo.claimReturnedInput(value.sessionId, operationId, 2, revision + 1),
    ).toThrow(/changed/)
  })

  it('keeps original sent Comments immutable when an installed clone is edited and reloaded', async () => {
    const value = await fixture({ comments: ['Original comment'] })
    const { operationId } = await value.rebuild()
    value.repo.claimReturnedInput(value.sessionId, operationId, 2, value.revision())
    const cloneId = value.drafts()[0]!.id
    value.db.drizzle
      .update(anchoredComments)
      .set({ body: 'Edited restored draft' })
      .where(eq(anchoredComments.id, cloneId))
      .run()
    value.repo.claimReturnedInput(value.sessionId, operationId, 2, value.revision())
    expect(value.drafts().map((comment) => comment.body)).toEqual(['Edited restored draft'])
    expect(
      value.db.drizzle
        .select()
        .from(anchoredComments)
        .where(eq(anchoredComments.id, value.sourceComments[0]!.id))
        .get(),
    ).toEqual(value.sourceComments[0])
  })

  it('rejects changed original proof and can dismiss pending recovery without deleting its evidence', async () => {
    const value = await fixture()
    const { operationId } = await value.rebuild()
    value.db.drizzle
      .update(agentRuns)
      .set({ dispatchPhase: 'accepted' })
      .where(eq(agentRuns.id, value.runId))
      .run()
    expect(() => value.repo.readReturnedInput(value.sessionId, operationId, 0)).toThrow(
      /non-dispatch proof/,
    )
    value.db.drizzle
      .update(agentRuns)
      .set({ dispatchPhase: 'rejected' })
      .where(eq(agentRuns.id, value.runId))
      .run()
    value.repo.discardReturnedInput(value.sessionId, operationId)
    expect(value.repo.rebuildInputRecovery(value.sessionId)).toBeNull()
    expect(value.sourceMessage().content).toBe(value.content)
    expect(value.sourceRun().dispatchPhase).toBe('rejected')
    expect(events(value, 'native.input_dismissed')).toHaveLength(1)
  })

  it('does not seed the old returned input or the latest rejected Composer input after another Send and Rebuild', async () => {
    const value = await fixture()
    const first = await value.rebuild()
    const latest = value.send({ content: 'Latest rejected request' }).run
    value.repo.recordDispatch(latest.id, 'rejected')
    value.repo.recordNativeEffects(latest.id, 'not_dispatched')
    value.repo.failRun(latest.id, 'native_session_occupied', 'Owned writer conflict')
    const second = await value.rebuild()
    expect(second.patch.rebuildInputRecovery?.operationId).not.toBe(first.operationId)
    expect(second.patch.rebuildInputRecovery?.messageId).toBe(latest.userMessageId)
    expect(second.chunks.some((chunk) => chunk.messageId === value.messageId)).toBe(false)
    expect(second.chunks.some((chunk) => chunk.messageId === latest.userMessageId)).toBe(false)
  })
})

const activeDraftRows = (db: PactDatabase, sessionId: string) =>
  db.drizzle
    .select()
    .from(anchoredComments)
    .where(
      and(
        eq(anchoredComments.sessionId, sessionId),
        isNull(anchoredComments.sentWithMessageId),
        isNull(anchoredComments.pendingReceiptId),
      ),
    )
    .orderBy(anchoredComments.position)
    .all()

async function installedInputFixture(count = 100, filePath?: string) {
  const value = await fixture({
    comments: Array.from({ length: count }, (_, index) => `Original requested check ${index}`),
    ...(filePath ? { filePath } : {}),
  })
  const { operationId } = await value.rebuild()
  value.repo.claimReturnedInput(value.sessionId, operationId, 2, value.revision())
  return { value, operationId }
}

it.each(['append', 'same-count-replace'] as const)(
  'checks installed clone provenance beyond the Renderer window for %s foreign drafts',
  async (mutation) => {
    const { value, operationId } = await installedInputFixture()
    const clones = activeDraftRows(value.db, value.sessionId)
    expect(clones).toHaveLength(100)
    expect(clones.every((clone) => clone.returnOperationId === operationId)).toBe(true)
    const proof = value.repo.rebuildInputRecovery(value.sessionId)!.draftEligibility!
    expect(proof).toEqual({ commentsRevision: value.revision(), canRestore: true })
    const outsideWindow = clones[99]!
    expect(clones.slice(0, 75).some((clone) => clone.id === outsideWindow.id)).toBe(false)
    if (mutation === 'same-count-replace')
      value.repo.removeCommentDraft({
        sessionId: value.sessionId,
        commentId: outsideWindow.id,
        expectedCommentsRevision: value.revision(),
      })
    const foreignId = randomUUID()
    const draftAnchor = value.drafts()[0]!.anchor
    if (draftAnchor.type === 'unavailable') throw new Error('Fixture requires a live anchor')
    value.repo.saveCommentDraft({
      mode: 'create',
      sessionId: value.sessionId,
      commentId: foreignId,
      expectedCommentsRevision: value.revision(),
      body: 'A new independent user draft.',
      anchor: draftAnchor,
    })
    const before = activeDraftRows(value.db, value.sessionId),
      revision = value.revision()
    expect(before).toHaveLength(mutation === 'append' ? 101 : 100)
    expect(before[99 + Number(mutation === 'append')]?.id).toBe(foreignId)
    expect(before.slice(0, 75).some((clone) => clone.id === foreignId)).toBe(false)
    expect(before.at(-1)?.returnOperationId).toBeNull()
    const recovery = value.repo.rebuildInputRecovery(value.sessionId)!
    expect(recovery).toMatchObject({
      state: 'installed',
      commentIds: [],
      draftEligibility: { commentsRevision: revision, canRestore: false },
    })
    expect(() =>
      value.repo.claimReturnedInput(value.sessionId, operationId, 2, proof.commentsRevision),
    ).toThrow(/drafts changed/)
    expect(() => value.repo.claimReturnedInput(value.sessionId, operationId, 2, revision)).toThrow(
      /current Comment drafts/,
    )
    expect(activeDraftRows(value.db, value.sessionId)).toEqual(before)
    expect(value.revision()).toBe(revision)
    expect(value.repo.rebuildInputRecovery(value.sessionId)).toEqual(recovery)
    expect(events(value, 'native.input_returned')).toHaveLength(1)
  },
)

it('a constant installed eligibility proof preserves edited clone provenance and survives an actual cold database reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-return-provenance-cold-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'pact.sqlite')
  const { value, operationId } = await installedInputFixture(100, filePath)
  const { value: one } = await installedInputFixture(1)
  const initial = value.repo.rebuildInputRecovery(value.sessionId)!
  const small = one.repo.rebuildInputRecovery(one.sessionId)!
  const clones = activeDraftRows(value.db, value.sessionId)
  expect(clones).toHaveLength(100)
  expect(initial.commentIds).toEqual([])
  expect(Buffer.byteLength(JSON.stringify(initial.draftEligibility))).toBe(
    Buffer.byteLength(JSON.stringify(small.draftEligibility)),
  )
  expect(Buffer.byteLength(JSON.stringify(initial))).toBeLessThanOrEqual(
    Buffer.byteLength(JSON.stringify(small)) + 2,
  )
  expect(clones.every((clone) => !JSON.stringify(initial).includes(clone.id))).toBe(true)
  const edited = clones[99]!
  value.repo.saveCommentDraft({
    mode: 'edit',
    sessionId: value.sessionId,
    commentId: edited.id,
    expectedCommentsRevision: value.revision(),
    body: 'Edited outside the Renderer draft window.',
  })
  const before = activeDraftRows(value.db, value.sessionId),
    revision = value.revision()
  expect(before[99]).toMatchObject({
    id: edited.id,
    returnOperationId: operationId,
    body: 'Edited outside the Renderer draft window.',
    draftRevision: 2,
  })
  const recovery = value.repo.rebuildInputRecovery(value.sessionId)!
  expect(recovery.draftEligibility).toEqual({ commentsRevision: revision, canRestore: true })
  value.db.close()
  fixtures.splice(fixtures.indexOf(value), 1)
  const db = await PactDatabase.open({
    filePath,
    migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
  })
  reopenedDatabases.push(db)
  const repo = db.conversationRepository
  expect(repo.rebuildInputRecovery(value.sessionId)).toEqual(recovery)
  expect(activeDraftRows(db, value.sessionId)).toEqual(before)
  const repeated = repo.claimReturnedInput(value.sessionId, operationId, 2, revision)
  expect(repeated.resync?.drafts).toBe(false)
  expect(repeated.comments?.revision).toBe(revision)
  expect(activeDraftRows(db, value.sessionId)).toEqual(before)
  expect(repo.rebuildInputRecovery(value.sessionId)?.draftEligibility).toEqual(
    recovery.draftEligibility,
  )
  expect(
    db.drizzle
      .select()
      .from(anchoredComments)
      .where(eq(anchoredComments.sentWithMessageId, value.messageId))
      .all(),
  ).toEqual(value.sourceComments)
  expect(
    db.drizzle
      .select()
      .from(agentEventJournal)
      .where(eq(agentEventJournal.eventType, 'native.input_returned'))
      .all(),
  ).toHaveLength(1)
})

it('an installed proof does not bypass stale CAS after a genuine owned-clone edit and repeated fresh claims do not clone again', async () => {
  const { value, operationId } = await installedInputFixture()
  const proof = value.repo.rebuildInputRecovery(value.sessionId)!.draftEligibility!
  const clone = activeDraftRows(value.db, value.sessionId)[99]!
  value.repo.saveCommentDraft({
    mode: 'edit',
    sessionId: value.sessionId,
    commentId: clone.id,
    expectedCommentsRevision: proof.commentsRevision,
    body: 'Actual user edit of an owned returned draft.',
  })
  const before = activeDraftRows(value.db, value.sessionId),
    revision = value.revision()
  expect(value.repo.rebuildInputRecovery(value.sessionId)?.draftEligibility).toEqual({
    commentsRevision: revision,
    canRestore: true,
  })
  expect(() =>
    value.repo.claimReturnedInput(value.sessionId, operationId, 2, proof.commentsRevision),
  ).toThrow(/drafts changed/)
  expect(activeDraftRows(value.db, value.sessionId)).toEqual(before)
  expect(value.revision()).toBe(revision)
  const first = value.repo.claimReturnedInput(value.sessionId, operationId, 2, revision)
  const second = value.repo.claimReturnedInput(value.sessionId, operationId, 2, revision)
  expect(first.resync?.drafts).toBe(false)
  expect(second.resync?.drafts).toBe(false)
  expect(activeDraftRows(value.db, value.sessionId)).toEqual(before)
  expect(value.revision()).toBe(revision)
  expect(events(value, 'native.input_returned')).toHaveLength(1)
})

it('acknowledges an explicit legacy list of one hundred drafts with a complete Batch and a bounded idempotent Patch', async () => {
  const { value } = await installedInputFixture()
  const before = activeDraftRows(value.db, value.sessionId)
  const ids = before.map((comment) => comment.id)
  expect(ids).toHaveLength(100)
  const input = {
    clientMessageId: randomUUID(),
    content: 'Submit every explicitly listed restored draft.',
    expectedCommentsRevision: value.revision(),
    commentIds: ids,
  }
  const started = value.send(input)
  expect(started.created).toBe(true)
  expect(conversationPatchSchema.parse(started.patch)).toEqual(started.patch)
  expect(Buffer.byteLength(JSON.stringify(started.patch))).toBeLessThanOrEqual(
    CONVERSATION_PATCH_BYTES,
  )
  expect(started.patch.resync?.drafts).toBe(true)
  expect(started.patch.comments?.sent).toBeUndefined()
  const batch = value.repo.inputBatchForRun(started.run.id)!
  expect(batch.memberCount).toBe(100)
  const readIds: string[] = []
  let cursor = -1
  for (;;) {
    const page = value.repo.readFrozenInputBatch(started.run.id, batch.id, cursor)
    expect(page.members.length).toBeLessThanOrEqual(24)
    readIds.push(...page.members.map((member) => member.commentId))
    if (!page.hasMore) break
    cursor = page.nextOrdinal
  }
  expect(readIds).toEqual(ids)
  expect(
    value.db.drizzle
      .select({ id: anchoredComments.id })
      .from(anchoredComments)
      .where(eq(anchoredComments.sentWithMessageId, input.clientMessageId))
      .orderBy(anchoredComments.position)
      .all()
      .map((row) => row.id),
  ).toEqual(ids)
  expect(activeDraftRows(value.db, value.sessionId)).toHaveLength(0)
  const revision = value.revision()
  const repeated = value.send(input)
  expect(repeated.created).toBe(false)
  expect(repeated.run.id).toBe(started.run.id)
  expect(conversationPatchSchema.parse(repeated.patch)).toEqual(repeated.patch)
  expect(value.revision()).toBe(revision)
  expect(value.repo.inputBatchForRun(repeated.run.id)).toEqual(batch)
  expect(
    value.db.drizzle
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.userMessageId, input.clientMessageId))
      .all(),
  ).toHaveLength(1)
})
