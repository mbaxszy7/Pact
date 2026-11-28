import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  ne,
  sql,
} from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  CONVERSATION_PAGE_BYTES,
  CONVERSATION_PAGE_ITEMS,
  frozenSkillInvocationSchema,
  parseComposerCommandPrefix,
  resolveActiveAgentPair,
  skillArguments,
  type AgentRun,
  type AnchoredComment,
  type CollaborationTask,
  type ConversationGetInput,
  type ConversationMessageRoute,
  type ConversationPage,
  type ConversationPatch,
  type ConversationQueueActionInput,
  type ConversationQueueEnabledInput,
  type ConversationQueueReturnInput,
  type ConversationQueueState,
  type FrozenSkillInvocation,
  type OriginSideChat,
  type RuntimeAgentId,
} from '@pact/contracts'

import type { ConversationRepositoryHost } from './context.js'

import { freezeOutputAtSteer, outputRunContext } from '../conversation-output-snapshots.js'
import {
  agentRuns,
  anchoredComments,
  collaborationInputs,
  conversationBodyInputs,
  conversationBodyParts,
  conversationImageAssets,
  conversationInputBatches,
  conversationInputBatchMembers,
  conversationMessageImages,
  conversationMessages,
  conversationQueueOperations,
  conversationRunSourceRefs,
  nativeRebuildOperations,
  sessions,
  sessionSettingsRevisions,
} from '../schema/index.js'
import { allocateSessionMessageSequence } from '../side-chat-persistence.js'
import { assertSessionAvailable } from '../workspace-archive-repository.js'
import { fitsPage, storedReceivedMetadata, toComment } from './helpers.js'
import {
  COLLABORATION_INDEX_ITEMS,
  OversizedConversationEntityError,
  RunOperationConflictError,
} from './types.js'

export function activePairForSession(
  repo: ConversationRepositoryHost,
  sessionId: string,
  revision?: number,
): [RuntimeAgentId, RuntimeAgentId] | undefined {
  const rev =
    revision ??
    repo.database
      .select({ settingsRevision: sessions.settingsRevision })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get()?.settingsRevision
  if (rev === undefined) return undefined
  const row = repo.database
    .select({
      primaryAgentId: sessionSettingsRevisions.primaryAgentId,
      secondaryAgentId: sessionSettingsRevisions.secondaryAgentId,
    })
    .from(sessionSettingsRevisions)
    .where(
      and(
        eq(sessionSettingsRevisions.sessionId, sessionId),
        eq(sessionSettingsRevisions.revision, rev),
      ),
    )
    .get()
  return row ? resolveActiveAgentPair(row) : undefined
}

function queueRoute(
  repo: ConversationRepositoryHost,
  row: typeof collaborationInputs.$inferSelect,
): ConversationMessageRoute {
  const metadata = storedReceivedMetadata(row.metadataJson)
  if (metadata.route?.type === 'all') {
    if ('firstAgentId' in metadata.route) {
      return metadata.route
    }
    const firstAgentId = row.actor === 'claude' ? 'claude' : 'codex'
    const secondAgentId = firstAgentId === 'claude' ? 'codex' : 'claude'
    return {
      type: 'all',
      firstAgentId,
      secondAgentId,
    }
  }
  return { type: metadata.route?.type === 'agent' ? 'agent' : 'primary', agentId: row.actor }
}

/** Original delivery scope, independent of the Session's current native binding. */
export function queuedSteerDelivery(
  repo: ConversationRepositoryHost,
  row: typeof collaborationInputs.$inferSelect,
): { run: AgentRun; operationId: string; rebuildId: string | undefined } | undefined {
  const op = repo.database
    .select()
    .from(conversationQueueOperations)
    .where(
      and(
        eq(conversationQueueOperations.inputId, row.id),
        eq(conversationQueueOperations.kind, 'steer'),
      ),
    )
    .orderBy(desc(conversationQueueOperations.createdAt))
    .limit(1)
    .get()
  const run = op?.targetRunId ? repo.findRun(op.targetRunId) : undefined
  if (
    !op ||
    !run ||
    !['prepared', 'possibly_sent', 'unknown', 'accepted', 'consumed', 'refused'].includes(
      op.state,
    ) ||
    op.sessionId !== row.sessionId ||
    run.sessionId !== row.sessionId ||
    run.agentId !== row.actor ||
    run.bindingGeneration !== op.bindingGeneration ||
    run.nativeTurnId !== op.nativeTurnId ||
    (op.executorId && run.executorId !== op.executorId)
  )
    return undefined
  const context = repo.nativeContext(row.sessionId, row.actor)
  const rebuild =
    run.controlDisposition === 'abandoned' &&
    run.nativeSessionId &&
    context?.nativeSessionId &&
    context.nativeSessionId !== run.nativeSessionId &&
    (context.bindingGeneration ?? 1) > (run.bindingGeneration ?? 1)
      ? repo.database
          .select({ id: nativeRebuildOperations.id })
          .from(nativeRebuildOperations)
          .where(
            and(
              eq(nativeRebuildOperations.sessionId, row.sessionId),
              eq(nativeRebuildOperations.agentId, row.actor),
              eq(nativeRebuildOperations.oldRunId, run.id),
              eq(nativeRebuildOperations.oldGeneration, run.bindingGeneration ?? 1),
              eq(nativeRebuildOperations.oldNativeSessionId, run.nativeSessionId),
              eq(nativeRebuildOperations.abandon, true),
              eq(nativeRebuildOperations.stage, 'completed'),
              isNotNull(nativeRebuildOperations.provisionalNativeSessionId),
              ne(nativeRebuildOperations.provisionalNativeSessionId, run.nativeSessionId),
            ),
          )
          .limit(1)
          .get()
      : undefined
  return { run, operationId: op.id, rebuildId: rebuild?.id }
}

export function queueState(
  repo: ConversationRepositoryHost,
  sessionId: string,
): ConversationQueueState {
  const stored = repo.sourceQueries.session().get({ sessionId })
  const session = stored
    ? {
        enabled: stored.queueEnabled,
        revision: stored.queueRevision,
        reason: stored.queuePauseReason,
      }
    : undefined
  if (!session) throw new RunOperationConflictError('The Session is unavailable.')
  const row = repo.receivedCollaborationInput(sessionId)
  const returned = repo.database
    .select({
      inputId: conversationQueueOperations.inputId,
      operationId: conversationQueueOperations.id,
      expectedRevision: conversationQueueOperations.expectedRevision,
      claimId: conversationQueueOperations.claimId,
      installedCommentsRevision: conversationQueueOperations.installedCommentsRevision,
      state: conversationQueueOperations.state,
    })
    .from(conversationQueueOperations)
    .where(
      and(
        eq(conversationQueueOperations.sessionId, sessionId),
        inArray(conversationQueueOperations.state, ['returned', 'installed']),
      ),
    )
    .get()
  const metadata = row ? storedReceivedMetadata(row.metadataJson) : undefined
  const batch = row
    ? repo.database
        .select({ count: conversationInputBatches.memberCount })
        .from(conversationInputBatches)
        .where(eq(conversationInputBatches.clientMessageId, row.id))
        .get()
    : undefined
  const state =
    row &&
    (row.queueState === 'queued' ||
      row.queueState === 'paused' ||
      row.queueState === 'dispatching' ||
      row.queueState === 'unknown')
      ? row.queueState
      : 'paused'
  const delivery =
    row && (state === 'unknown' || state === 'dispatching')
      ? queuedSteerDelivery(repo, row)
      : undefined
  // The display-only replacement note reuses the current task when it is still the confirmed one;
  // the durable pause for a stale confirmation lives in dispatchReceivedInput, not this projection.
  const activeTask = row ? repo.collaboration(sessionId) : undefined
  const replacedTask =
    metadata?.workflowCommand && metadata.replaceTask?.taskId === activeTask?.id
      ? activeTask
      : undefined
  return {
    enabled: session.enabled,
    revision: session.revision,
    input: row
      ? {
          id: row.id,
          revision: session.revision,
          recipient: metadata?.route?.type === 'all' ? 'all' : row.actor,
          preview: row.preview,
          workflowCommand: metadata?.workflowCommand ?? false,
          state,
          ...(delivery
            ? { delivery: { runId: delivery.run.id, canRemove: Boolean(delivery.rebuildId) } }
            : {}),
          ...(row.queueReason || session.reason
            ? { reason: row.queueReason ?? session.reason! }
            : {}),
          ...(replacedTask
            ? { replacesTask: { kind: replacedTask.kind, actor: replacedTask.actor } }
            : {}),
          imageCount: metadata?.imageIds.length ?? 0,
          commentCount: batch?.count ?? 0,
          skillCount: metadata?.skills.length ?? 0,
        }
      : null,
    returnedInput: returned?.inputId
      ? {
          inputId: returned.inputId,
          operationId: returned.operationId,
          expectedRevision: returned.expectedRevision,
          ...(returned.claimId ? { claimId: returned.claimId } : {}),
          ...(returned.installedCommentsRevision === null
            ? {}
            : { installedCommentsRevision: returned.installedCommentsRevision }),
          state: returned.state === 'installed' ? 'installed' : 'pending',
        }
      : null,
  }
}

export function receiveQueuedInput(
  repo: ConversationRepositoryHost,
  input: import('@pact/contracts').ConversationSendInput,
  inputId: string,
  actor: RuntimeAgentId,
  ownerKey: string,
  anchorRunId: string,
  waitingForWork = true,
  rolePolicy?: CollaborationTask['rolePolicy'],
  options?: {
    originSideChat?: OriginSideChat
    syncMainOperationId?: string
  },
): ConversationPatch {
  const run = repo.findRun(anchorRunId)
  if (!run || run.sessionId !== input.sessionId)
    throw new RunOperationConflictError('The queue anchor Run is unavailable.')
  return repo.database.transaction(() => {
    const patch = repo.receiveCollaborationInput(
      input,
      inputId,
      actor,
      'next_round',
      ownerKey,
      waitingForWork,
      anchorRunId,
      rolePolicy,
      options,
    )
    repo.database
      .update(collaborationInputs)
      .set({ anchorRunId })
      .where(eq(collaborationInputs.id, input.clientMessageId))
      .run()
    return patch
  })
}

function queueOperation(
  repo: ConversationRepositoryHost,
  input: ConversationQueueActionInput | ConversationQueueEnabledInput,
  kind: typeof conversationQueueOperations.$inferSelect.kind,
) {
  assertSessionAvailable(repo.database, input.sessionId)
  const old = repo.database
    .select()
    .from(conversationQueueOperations)
    .where(eq(conversationQueueOperations.id, input.operationId))
    .get()
  if (old) {
    if (
      old.kind !== kind ||
      old.sessionId !== input.sessionId ||
      old.expectedRevision !== input.expectedRevision ||
      old.inputId !== ('inputId' in input ? input.inputId : null) ||
      old.enabled !== ('enabled' in input ? input.enabled : null)
    )
      throw new RunOperationConflictError('This operation belongs to a different queue action.')
    return { old, row: undefined, delivery: undefined }
  }
  const session = repo.database
    .select()
    .from(sessions)
    .where(eq(sessions.id, input.sessionId))
    .get()
  if (!session || session.queueRevision !== input.expectedRevision)
    throw new RunOperationConflictError('The queue changed. Refresh and try again.')
  const row = 'inputId' in input ? repo.receivedCollaborationInput(input.sessionId) : undefined
  if ('inputId' in input && (!row || row.id !== input.inputId))
    throw new RunOperationConflictError('This queued message is no longer available.')
  const locked = row && ['dispatching', 'unknown'].includes(row.queueState)
  const delivery = locked && kind === 'remove' ? queuedSteerDelivery(repo, row) : undefined
  if (kind !== 'steer' && locked && !(kind === 'remove' && delivery?.rebuildId))
    throw new RunOperationConflictError(
      'Delivery may have started. Resolve the original delivery before changing this message.',
    )
  return { old: undefined, row, delivery }
}

function saveQueueOperation(
  repo: ConversationRepositoryHost,
  input: ConversationQueueActionInput | ConversationQueueEnabledInput,
  kind: typeof conversationQueueOperations.$inferSelect.kind,
  state: typeof conversationQueueOperations.$inferSelect.state = 'complete',
) {
  const now = new Date().toISOString()
  repo.database
    .insert(conversationQueueOperations)
    .values({
      id: input.operationId,
      sessionId: input.sessionId,
      inputId: 'inputId' in input ? input.inputId : null,
      kind,
      state,
      expectedRevision: input.expectedRevision,
      enabled: 'enabled' in input ? input.enabled : null,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

export function advanceQueue(
  repo: ConversationRepositoryHost,
  sessionId: string,
  reason?: string | null,
): void {
  repo.database
    .update(sessions)
    .set({
      queueRevision: sql`${sessions.queueRevision} + 1`,
      ...(reason === undefined ? {} : { queuePauseReason: reason }),
    })
    .where(eq(sessions.id, sessionId))
    .run()
}

export function setConversationQueueEnabled(
  repo: ConversationRepositoryHost,
  input: ConversationQueueEnabledInput,
): ConversationPatch {
  return repo.database.transaction(() => {
    if (queueOperation(repo, input, 'enabled').old) return repo.createPatch(input.sessionId)
    saveQueueOperation(repo, input, 'enabled')
    repo.database
      .update(sessions)
      .set({ queueEnabled: input.enabled })
      .where(eq(sessions.id, input.sessionId))
      .run()
    advanceQueue(repo, input.sessionId)
    return repo.createPatch(input.sessionId)
  })
}

export function resumeConversationQueue(
  repo: ConversationRepositoryHost,
  input: ConversationQueueActionInput,
): ConversationPatch {
  return repo.database.transaction(() => {
    const check = queueOperation(repo, input, 'resume')
    if (check.old) return repo.createPatch(input.sessionId)
    const anchor = check.row && repo.findRun(check.row.anchorRunId)
    if (
      !anchor ||
      ['starting', 'running', 'recovering'].includes(anchor.status) ||
      !['ended', 'not_sent', 'rejected'].includes(anchor.dispatchPhase ?? 'not_sent') ||
      !['settled', 'not_dispatched'].includes(anchor.nativeEffectsState ?? '')
    )
      throw new RunOperationConflictError(
        'The original work has not settled. Check it, or use Edit message or Remove for this queued input.',
      )
    saveQueueOperation(repo, input, 'resume')
    repo.database
      .update(collaborationInputs)
      .set({
        state: 'accepted',
        queueState: 'queued',
        queueReason: null,
        deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
      })
      .where(eq(collaborationInputs.id, input.inputId))
      .run()
    advanceQueue(repo, input.sessionId, null)
    return repo.createPatch(input.sessionId)
  })
}

export function pauseConversationQueue(
  repo: ConversationRepositoryHost,
  sessionId: string,
  reason: string,
): ConversationPatch {
  return repo.database.transaction(() => {
    const row = repo.receivedCollaborationInput(sessionId)
    if (!row) return repo.createPatch(sessionId)
    if (!['dispatching', 'unknown'].includes(row.queueState))
      repo.database
        .update(collaborationInputs)
        .set({ queueState: 'paused', queueReason: reason.slice(0, 512) })
        .where(eq(collaborationInputs.id, row.id))
        .run()
    advanceQueue(repo, sessionId, reason.slice(0, 512))
    return repo.createPatch(sessionId)
  })
}

export function removeQueuedConversationMessage(
  repo: ConversationRepositoryHost,
  input: ConversationQueueActionInput,
): ConversationPatch {
  return repo.database.transaction(() => {
    const check = queueOperation(repo, input, 'remove')
    if (check.old) return repo.metadataPatch(input.sessionId)
    saveQueueOperation(repo, input, 'remove')
    const batch = repo.database
      .select({ id: conversationInputBatches.id })
      .from(conversationInputBatches)
      .where(eq(conversationInputBatches.clientMessageId, input.inputId))
      .get()
    if (check.delivery?.rebuildId) {
      const { run, operationId, rebuildId } = check.delivery
      repo.database
        .update(conversationQueueOperations)
        .set({ targetRunId: run.id, bindingGeneration: run.bindingGeneration })
        .where(eq(conversationQueueOperations.id, input.operationId))
        .run()
      repo.nativeFact(run.id, 'conversation.queue_item_removed', {
        operationId: input.operationId,
        inputId: input.inputId,
        steerOperationId: operationId,
        bindingGeneration: run.bindingGeneration,
        rebuildId,
        deliveryUnconfirmed: true,
      })
    } else if (batch) repo.withdrawInputBatch(batch.id)
    repo.database
      .update(collaborationInputs)
      .set({ state: 'cancelled', queueState: 'removed' })
      .where(eq(collaborationInputs.id, input.inputId))
      .run()
    advanceQueue(repo, input.sessionId, null)
    return repo.metadataPatch(input.sessionId)
  })
}

export function requireInstalledQueueReturn(
  repo: ConversationRepositoryHost,
  sessionId: string,
  operationId: string,
): void {
  const row = repo.database
    .select()
    .from(conversationQueueOperations)
    .where(
      and(
        eq(conversationQueueOperations.id, operationId),
        eq(conversationQueueOperations.sessionId, sessionId),
        eq(conversationQueueOperations.kind, 'return'),
        eq(conversationQueueOperations.state, 'installed'),
      ),
    )
    .get()
  if (!row)
    throw new RunOperationConflictError('Restore the complete queue input before sending it.')
}

export function consumeQueuedReturn(
  repo: ConversationRepositoryHost,
  sessionId: string,
  operationId?: string,
): void {
  repo.database
    .update(conversationQueueOperations)
    .set({ state: 'consumed', updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(conversationQueueOperations.sessionId, sessionId),
        eq(conversationQueueOperations.kind, 'return'),
        ...(operationId ? [eq(conversationQueueOperations.id, operationId)] : []),
        inArray(conversationQueueOperations.state, ['returned', 'installed']),
      ),
    )
    .run()
}

export function returnQueuedConversationMessage(
  repo: ConversationRepositoryHost,
  input: ConversationQueueReturnInput,
): ConversationPatch {
  return repo.database.transaction(() => {
    const checked = queueOperation(repo, input, 'return')
    if (checked.old && input.phase !== 'claim') return repo.metadataPatch(input.sessionId)
    if (
      input.phase === 'claim' &&
      (!checked.old || !['returned', 'installed'].includes(checked.old.state))
    )
      throw new RunOperationConflictError('Return this input before restoring it.')
    const row =
      checked.row ??
      repo.database
        .select()
        .from(collaborationInputs)
        .where(
          and(
            eq(collaborationInputs.id, input.inputId),
            eq(collaborationInputs.sessionId, input.sessionId),
          ),
        )
        .get()!
    const body = repo.database
      .select()
      .from(conversationBodyInputs)
      .where(eq(conversationBodyInputs.id, row.inputId))
      .get()
    if (!body?.sealed || repo.readBody(body, false).hash !== row.digest)
      throw new RunOperationConflictError(
        'The queued input source changed. Its original content remains saved.',
      )
    const batch = repo.database
      .select()
      .from(conversationInputBatches)
      .where(eq(conversationInputBatches.clientMessageId, row.id))
      .get()
    if (!batch) throw new RunOperationConflictError('The queued input manifest is unavailable.')
    if (input.phase !== 'claim') {
      consumeQueuedReturn(repo, input.sessionId)
      saveQueueOperation(repo, input, 'return', 'returned')
      repo.withdrawInputBatch(batch.id)
      repo.database
        .update(collaborationInputs)
        .set({ state: 'cancelled', queueState: 'returned' })
        .where(eq(collaborationInputs.id, row.id))
        .run()
      advanceQueue(repo, input.sessionId, null)
      return repo.metadataPatch(input.sessionId)
    }
    const session = repo.database
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .get()!
    const claimId = input.claimId ?? input.operationId
    if (checked.old?.state === 'installed' && checked.old.claimId === claimId) {
      if (session.commentsRevision !== checked.old.installedCommentsRevision)
        throw new RunOperationConflictError(
          'Comment drafts changed after this input was restored. Restore explicitly to replace them again.',
        )
      return repo.createPatch(input.sessionId)
    }
    if (
      input.expectedCommentsRevision === undefined ||
      session.commentsRevision !== input.expectedCommentsRevision
    )
      throw new RunOperationConflictError('Comment drafts changed before restoring this message.')
    const rebuildReturns = repo.database
      .select({
        id: nativeRebuildOperations.id,
        record: nativeRebuildOperations.returnedInputJson,
      })
      .from(nativeRebuildOperations)
      .where(
        and(
          eq(nativeRebuildOperations.sessionId, input.sessionId),
          sql`json_extract(${nativeRebuildOperations.returnedInputJson}, '$.state') IN ('pending','installed')`,
        ),
      )
      .limit(2)
      .all()
    for (const prior of rebuildReturns) {
      const record = repo.parseReturnedInput(prior.record)
      if (record) {
        record.state = 'consumed'
        repo.database
          .update(nativeRebuildOperations)
          .set({ returnedInputJson: JSON.stringify(record) })
          .where(eq(nativeRebuildOperations.id, prior.id))
          .run()
      }
    }
    // Explicit Edit overwrites current drafts; archived Batch sources remain immutable.
    repo.database
      .update(anchoredComments)
      .set({ pendingReceiptId: input.operationId })
      .where(
        and(
          eq(anchoredComments.sessionId, input.sessionId),
          isNull(anchoredComments.sentWithMessageId),
          isNull(anchoredComments.pendingReceiptId),
        ),
      )
      .run()
    let position =
      (repo.database
        .select({ value: max(anchoredComments.position) })
        .from(anchoredComments)
        .where(eq(anchoredComments.sessionId, input.sessionId))
        .get()?.value ?? -1) + 1
    let ordinal = -1
    const deadline = Date.now() + 10_000
    for (;;) {
      const page = repo.database
        .select({ member: conversationInputBatchMembers, comment: anchoredComments })
        .from(conversationInputBatchMembers)
        .innerJoin(
          anchoredComments,
          eq(anchoredComments.id, conversationInputBatchMembers.commentId),
        )
        .where(
          and(
            eq(conversationInputBatchMembers.batchId, batch.id),
            gt(conversationInputBatchMembers.ordinal, ordinal),
          ),
        )
        .orderBy(asc(conversationInputBatchMembers.ordinal))
        .limit(COLLABORATION_INDEX_ITEMS)
        .all()
      if (!page.length) break
      if (Date.now() >= deadline)
        throw new RunOperationConflictError(
          'The complete message could not be returned before its deadline. It remains queued.',
        )
      for (const { member, comment } of page) {
        if (
          comment.draftRevision !== member.commentRevision ||
          createHash('sha256').update(comment.body).digest('hex') !== member.bodySha256
        )
          throw new RunOperationConflictError('A frozen queued Comment changed.')
        repo.database
          .insert(anchoredComments)
          .values({
            ...comment,
            id: randomUUID(),
            position: position++,
            pendingReceiptId: null,
            sentWithMessageId: null,
            returnOperationId: input.operationId,
            draftRevision: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .run()
      }
      ordinal = page.at(-1)!.member.ordinal
    }
    repo.database
      .update(conversationQueueOperations)
      .set({
        state: 'installed',
        claimId,
        claimExpectedCommentsRevision: session.commentsRevision,
        installedCommentsRevision: session.commentsRevision + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(conversationQueueOperations.id, input.operationId))
      .run()
    repo.database
      .update(sessions)
      .set({ commentsRevision: sql`${sessions.commentsRevision} + 1` })
      .where(eq(sessions.id, input.sessionId))
      .run()
    advanceQueue(repo, input.sessionId, null)
    return repo.createPatch(input.sessionId, {
      resync: { messages: false, drafts: true, activityRunIds: [] },
      comments: {
        revision: repo.database
          .select({ value: sessions.commentsRevision })
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .get()!.value,
        upserts: [],
        removedIds: [],
      },
    })
  })
}

/** Exact provider identities, with the root retained across Claude native-round rollover. */
export function nativeInputIdsForRun(repo: ConversationRepositoryHost, runId: string): string[] {
  const row = repo.database
    .select({ nativeTurnId: agentRuns.nativeTurnId, json: agentRuns.nativeInputIdsJson })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .get()
  if (!row) return []
  if (Buffer.byteLength(row.json) > 8192)
    throw new RunOperationConflictError(
      'The native input identity receipt exceeds its existing history budget.',
    )
  const value: unknown = JSON.parse(row.json)
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((id) => typeof id !== 'string' || !id.length || id.length > 1024) ||
    new Set(value).size !== value.length
  )
    throw new RunOperationConflictError('The native input identity receipt is invalid.')
  const ids: string[] = []
  for (const id of value) {
    if (typeof id !== 'string')
      throw new RunOperationConflictError('The native input identity receipt is invalid.')
    ids.push(id)
  }
  return ids.length ? ids : row.nativeTurnId ? [row.nativeTurnId] : []
}

function activeSteerInputs(repo: ConversationRepositoryHost, runId: string) {
  // Literal predicate matches the existing partial index and excludes unbounded refused retries.
  const rows = repo.database.all<{
    operationId: string
    inputId: string | null
    revision: number
    state: string
    sessionId: string
    bindingGeneration: number | null
    nativeTurnId: string | null
    executorId: string | null
  }>(sql`SELECT id AS operationId,input_id AS inputId,input_revision AS revision,state,
      session_id AS sessionId,binding_generation AS bindingGeneration,
      native_turn_id AS nativeTurnId,executor_id AS executorId
      FROM conversation_queue_operations INDEXED BY conversation_queue_operations_active_grant_idx
      WHERE target_run_id=${runId} AND kind='steer'
      AND state IN ('prepared','possibly_sent','accepted','consumed','unknown')
      ORDER BY input_revision LIMIT 65`)
  if (rows.length > 64)
    throw new RunOperationConflictError(
      'Native input history exceeds its existing receipt capacity.',
    )
  return rows
}

export function unresolvedSteerInputs(repo: ConversationRepositoryHost, runId: string) {
  return activeSteerInputs(repo, runId).filter((entry) =>
    ['possibly_sent', 'accepted', 'unknown'].includes(entry.state),
  )
}

export function recordQueuedSteerConsumption(
  repo: ConversationRepositoryHost,
  proof: {
    runId: string
    sessionId: string
    nativeSessionId: string
    nativeTurnId: string
    bindingGeneration: number
    executorId?: string | undefined
  },
  inputId: string,
  invocation?: FrozenSkillInvocation,
): ConversationPatch {
  return repo.database.transaction(() => {
    const run = repo.findRun(proof.runId)
    const op = activeSteerInputs(repo, proof.runId).find(
      (entry) =>
        entry.inputId === inputId &&
        ['possibly_sent', 'accepted', 'unknown', 'consumed'].includes(entry.state),
    )
    if (
      !run ||
      !op ||
      run.sessionId !== proof.sessionId ||
      op.sessionId !== proof.sessionId ||
      run.nativeSessionId !== proof.nativeSessionId ||
      run.nativeTurnId !== proof.nativeTurnId ||
      run.bindingGeneration !== proof.bindingGeneration ||
      op.bindingGeneration !== proof.bindingGeneration ||
      op.nativeTurnId !== proof.nativeTurnId ||
      (run.executorId ?? undefined) !== proof.executorId ||
      (op.executorId ?? undefined) !== proof.executorId
    )
      throw new RunOperationConflictError(
        'The native input receipt does not match its original execution.',
      )
    if (op.state === 'consumed') return repo.createPatch(proof.sessionId)
    // The original native User has this UUID too. It cannot prove that a
    // legacy supplemental intent arrived; leave that intent unresolved.
    if (inputId === run.id) return repo.createPatch(proof.sessionId)
    const patch = markQueuedSteerConsumed(repo, op.operationId, inputId, invocation)
    return { ...patch, resync: { messages: true, drafts: true, activityRunIds: [] } }
  })
}

/** Receipt-only duplicate RPC recovery; never requires a still-active native Run. */
export function queuedSteerReceipt(
  repo: ConversationRepositoryHost,
  input: ConversationQueueActionInput,
  consumedByRunId?: string,
): ConversationPatch | undefined {
  const op = repo.database
    .select()
    .from(conversationQueueOperations)
    .where(eq(conversationQueueOperations.id, input.operationId))
    .get()
  if (!op) return undefined
  if (
    op.kind !== 'steer' ||
    op.sessionId !== input.sessionId ||
    op.inputId !== input.inputId ||
    op.expectedRevision !== input.expectedRevision
  )
    throw new RunOperationConflictError('This operation belongs to a different queue action.')
  if (
    consumedByRunId !== undefined &&
    (op.targetRunId !== consumedByRunId || op.state !== 'consumed')
  )
    return undefined
  return repo.createPatch(input.sessionId)
}

export function prepareQueuedSteer(
  repo: ConversationRepositoryHost,
  input: ConversationQueueActionInput,
  target: { runId: string; bindingGeneration: number; nativeTurnId: string; executorId?: string },
  invocation?: FrozenSkillInvocation,
) {
  return repo.database.transaction(() => {
    const checked = queueOperation(repo, input, 'steer')
    if (checked.old) {
      if (
        checked.old.targetRunId !== target.runId ||
        checked.old.bindingGeneration !== target.bindingGeneration ||
        checked.old.nativeTurnId !== target.nativeTurnId
      )
        throw new RunOperationConflictError(
          'This Steer operation belongs to a different execution.',
        )
      return {
        created: false,
        state: checked.old.state,
        operationId: checked.old.id,
        inputId: input.inputId,
        inputRevision: checked.old.inputRevision!,
        resultNonce: checked.old.resultNonce!,
        runId: target.runId,
        bindingGeneration: target.bindingGeneration,
      }
    }
    const row = checked.row!,
      run = repo.findRun(target.runId)
    if (
      !run ||
      run.sessionId !== input.sessionId ||
      run.agentId !== row.actor ||
      run.bindingGeneration !== target.bindingGeneration ||
      run.nativeTurnId !== target.nativeTurnId ||
      run.dispatchPhase === 'ended' ||
      !['starting', 'running'].includes(run.status) ||
      (target.executorId && run.executorId !== target.executorId) ||
      row.queueState === 'dispatching' ||
      row.queueState === 'unknown'
    )
      throw new RunOperationConflictError(
        'The target execution changed before Steer. This message remains queued.',
      )
    if (run.collaboration)
      throw new RunOperationConflictError(
        'Workflow messages are answered in the next Turn. Continue the queued reply after the current Agent finishes.',
      )
    const meta = storedReceivedMetadata(row.metadataJson)
    if (input.inputId === run.id)
      throw new RunOperationConflictError(
        'The supplemental input reuses the original native request identity. It remains queued.',
      )
    if (invocation) {
      if (!isDeepStrictEqual(invocation.selections, meta.skills))
        throw new RunOperationConflictError('The frozen Skill selections changed before Steer.')
      const { arguments: _arguments, ...metadata } = frozenSkillInvocationSchema.parse(invocation)
      meta.steerSkillInvocation = repo.saveCollaborationDocument(run.id, JSON.stringify(metadata))
      const json = JSON.stringify(meta)
      if (Buffer.byteLength(json) > 64 * 1024)
        throw new RunOperationConflictError('Received metadata exceeds 64 KiB.')
      repo.database
        .update(collaborationInputs)
        .set({ metadataJson: json })
        .where(eq(collaborationInputs.id, row.id))
        .run()
    }
    if (meta.workflowCommand || meta.route?.type === 'all' || row.taskId !== null)
      throw new RunOperationConflictError('This input cannot be steered into the target execution.')
    const reservedNativeInputs = repo.database
      .select({ count: sql<number>`count(*)` })
      .from(conversationQueueOperations)
      .where(
        and(
          eq(conversationQueueOperations.targetRunId, run.id),
          eq(conversationQueueOperations.kind, 'steer'),
          inArray(conversationQueueOperations.state, [
            'prepared',
            'possibly_sent',
            'accepted',
            'consumed',
            'unknown',
          ]),
        ),
      )
      .get()!.count
    if (reservedNativeInputs >= 63)
      throw new RunOperationConflictError(
        'This execution reached its native input history budget. The message remains queued for the next execution.',
      )
    const unresolved = repo.latestSteerGrant(run.id)
    if (unresolved && !['accepted', 'consumed'].includes(unresolved.state))
      throw new RunOperationConflictError('A previous input delivery is unresolved.')
    const batch = repo.database
      .select()
      .from(conversationInputBatches)
      .where(eq(conversationInputBatches.clientMessageId, row.id))
      .get()
    if (!batch || batch.actor !== run.agentId)
      throw new RunOperationConflictError(
        'The frozen input manifest does not match this execution.',
      )
    const revision =
      (repo.database
        .select({ value: max(conversationQueueOperations.inputRevision) })
        .from(conversationQueueOperations)
        .where(eq(conversationQueueOperations.targetRunId, run.id))
        .get()?.value ?? 0) + 1
    const resultNonce = randomUUID(),
      now = new Date().toISOString()
    saveQueueOperation(repo, input, 'steer', 'prepared')
    const body = repo.database
      .select()
      .from(conversationBodyInputs)
      .where(eq(conversationBodyInputs.id, row.inputId))
      .get()
    if (!body?.sealed || body.hash !== row.digest)
      throw new RunOperationConflictError('The frozen body changed before Steer.')
    const source = repo.saveCollaborationDocument(run.id, repo.readBody(body, true).text)
    repo.database
      .update(conversationInputBatches)
      .set({ bodyDocumentJson: JSON.stringify(source) })
      .where(eq(conversationInputBatches.id, batch.id))
      .run()
    repo.sealInputBatchSources(batch.id, run.id)
    repo.database
      .update(conversationQueueOperations)
      .set({
        targetRunId: run.id,
        bindingGeneration: target.bindingGeneration,
        nativeTurnId: target.nativeTurnId,
        executorId: target.executorId ?? run.executorId ?? null,
        inputRevision: revision,
        resultNonce,
        batchId: batch.id,
        inputScopeJson: null,
        updatedAt: now,
      })
      .where(eq(conversationQueueOperations.id, input.operationId))
      .run()
    repo.database
      .update(collaborationInputs)
      .set({ queueState: 'dispatching', queueReason: 'Delivering to the current execution.' })
      .where(eq(collaborationInputs.id, row.id))
      .run()
    advanceQueue(repo, input.sessionId)
    repo.nativeFact(run.id, 'conversation.steer_prepared', {
      operationId: input.operationId,
      inputId: row.id,
      inputRevision: revision,
      bindingGeneration: target.bindingGeneration,
      nativeTurnId: target.nativeTurnId,
    })
    return {
      created: true,
      state: 'prepared' as const,
      operationId: input.operationId,
      inputId: row.id,
      inputRevision: revision,
      resultNonce,
      runId: run.id,
      bindingGeneration: target.bindingGeneration,
    }
  })
}

export function markQueuedSteerPossiblySent(
  repo: ConversationRepositoryHost,
  operationId: string,
): ConversationPatch {
  return transitionQueuedSteer(repo, operationId, 'possibly_sent')
}

export function markQueuedSteerUnknown(
  repo: ConversationRepositoryHost,
  operationId: string,
  reason = 'Delivery is uncertain. Resolve the original execution before continuing.',
): ConversationPatch {
  return transitionQueuedSteer(repo, operationId, 'unknown', reason)
}

export function markQueuedSteerRefused(
  repo: ConversationRepositoryHost,
  operationId: string,
  reason = 'The provider did not accept this input. It remains queued.',
  provenNativeRejection = false,
): ConversationPatch {
  return transitionQueuedSteer(repo, operationId, 'refused', reason, provenNativeRejection)
}

function transitionQueuedSteer(
  repo: ConversationRepositoryHost,
  operationId: string,
  state: 'possibly_sent' | 'unknown' | 'refused',
  reason?: string,
  provenNativeRejection = false,
): ConversationPatch {
  return repo.database.transaction(() => {
    const op = repo.database
      .select()
      .from(conversationQueueOperations)
      .where(
        and(
          eq(conversationQueueOperations.id, operationId),
          eq(conversationQueueOperations.kind, 'steer'),
        ),
      )
      .get()
    if (!op?.inputId || !op.targetRunId)
      throw new RunOperationConflictError('The durable Steer intent is unavailable.')
    if (op.state === state) return repo.createPatch(op.sessionId)
    if (state === 'refused' && op.state !== 'prepared' && !provenNativeRejection)
      throw new RunOperationConflictError(
        'Possibly delivered input cannot be automatically requeued.',
      )
    if (op.state === 'accepted' || op.state === 'consumed' || op.state === 'refused')
      throw new RunOperationConflictError('The Steer delivery was already settled.')
    const row = repo.database
      .select()
      .from(collaborationInputs)
      .where(eq(collaborationInputs.id, op.inputId))
      .get()
    const historical =
      row?.queueState === 'removed' ||
      repo.findRun(op.targetRunId)?.controlDisposition === 'abandoned'
    repo.database
      .update(conversationQueueOperations)
      .set({ state, updatedAt: new Date().toISOString() })
      .where(eq(conversationQueueOperations.id, operationId))
      .run()
    if (!historical)
      repo.database
        .update(collaborationInputs)
        .set({
          queueState:
            state === 'refused' ? 'paused' : state === 'unknown' ? 'unknown' : 'dispatching',
          queueReason: reason?.slice(0, 512) ?? null,
        })
        .where(eq(collaborationInputs.id, op.inputId))
        .run()
    if (state === 'refused' && !historical) if (!historical) advanceQueue(repo, op.sessionId)
    repo.nativeFact(op.targetRunId, `conversation.steer_${state}`, {
      operationId,
      inputId: op.inputId,
      inputRevision: op.inputRevision,
      historical,
    })
    if (state === 'unknown' && !historical)
      repo.recordSchedulingRecoveryOrigin({ kind: 'queue', id: operationId })
    return repo.createPatch(op.sessionId)
  })
}

export function markQueuedSteerAccepted(
  repo: ConversationRepositoryHost,
  operationId: string,
  skillInvocation?: FrozenSkillInvocation,
): ConversationPatch {
  return repo.database.transaction(() => {
    const op = repo.database
      .select()
      .from(conversationQueueOperations)
      .where(
        and(
          eq(conversationQueueOperations.id, operationId),
          eq(conversationQueueOperations.kind, 'steer'),
        ),
      )
      .get()
    if (!op?.inputId || !op.targetRunId || !op.batchId)
      throw new RunOperationConflictError('The durable Steer intent is unavailable.')
    if (op.state === 'accepted' || op.state === 'consumed') return repo.createPatch(op.sessionId)
    if (!['prepared', 'possibly_sent', 'unknown'].includes(op.state))
      throw new RunOperationConflictError('This Steer intent was already refused.')
    const row = repo.database
      .select()
      .from(collaborationInputs)
      .where(eq(collaborationInputs.id, op.inputId))
      .get()
    const run = repo.findRun(op.targetRunId)
    if (
      !row ||
      !run ||
      row.sessionId !== op.sessionId ||
      row.actor !== run.agentId ||
      run.bindingGeneration !== op.bindingGeneration ||
      run.nativeTurnId !== op.nativeTurnId ||
      run.sessionId !== op.sessionId ||
      (op.executorId && run.executorId !== op.executorId)
    )
      throw new RunOperationConflictError(
        'The accepted input no longer matches the original execution. Its intent remains saved.',
      )
    if (run.controlDisposition === 'abandoned') {
      // Native acknowledgement is an archival fact, never authority over a replacement binding.
      repo.database
        .update(conversationQueueOperations)
        .set({ state: 'accepted', updatedAt: new Date().toISOString() })
        .where(eq(conversationQueueOperations.id, operationId))
        .run()
      repo.nativeFact(run.id, 'conversation.steer_accepted', {
        operationId,
        inputId: row.id,
        inputRevision: op.inputRevision,
        batchId: op.batchId,
        historical: true,
      })
      return repo.createPatch(op.sessionId)
    }
    const received = repo.readReceivedInput(op.sessionId)
    if (!received || received.id !== row.id)
      throw new RunOperationConflictError('The accepted input source changed.')
    if (
      !skillInvocation &&
      (received.metadata.steerSkillInvocation ||
        received.metadata.skills.length ||
        parseComposerCommandPrefix(received.content, received.metadata.skills).skills.length)
    ) {
      const source = received.metadata.steerSkillInvocation
      if (!source)
        throw new RunOperationConflictError(
          'The frozen native Skill invocation is unavailable. Original delivery remains saved.',
        )
      const metadata: unknown = JSON.parse(repo.collaborationDocumentText(op.sessionId, source))
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        throw new RunOperationConflictError('The frozen native Skill invocation changed.')
      skillInvocation = frozenSkillInvocationSchema.parse({
        ...metadata,
        arguments: skillArguments(received.content, received.metadata.skills),
      })
    }
    const route = queueRoute(repo, row),
      now = new Date().toISOString()
    const sequence = allocateSessionMessageSequence(repo.database, op.sessionId)
    repo.database
      .insert(conversationMessages)
      .values({
        id: row.id,
        sessionId: op.sessionId,
        runId: run.id,
        role: 'user',
        routeKind: route.type,
        routeAgentsJson: JSON.stringify([run.agentId]),
        originSideChatJson: received.metadata.originSideChat
          ? JSON.stringify(received.metadata.originSideChat)
          : null,
        content: received.content,
        state: 'complete',
        sequence,
        skillInvocationJson: skillInvocation ? JSON.stringify(skillInvocation) : null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const frozenSourceId = freezeOutputAtSteer(repo.database, run, row.id)
    repo.database
      .update(conversationInputBatches)
      .set({ runId: run.id, messageId: row.id })
      .where(eq(conversationInputBatches.id, op.batchId))
      .run()
    repo.database
      .update(anchoredComments)
      .set({ sentWithMessageId: row.id, pendingReceiptId: null, updatedAt: now })
      .where(eq(anchoredComments.pendingReceiptId, row.id))
      .run()
    for (const [ordinal, imageId] of received.metadata.imageIds.entries())
      repo.database
        .insert(conversationMessageImages)
        .values({ messageId: row.id, ordinal, imageId })
        .run()
    repo.database
      .update(conversationImageAssets)
      .set({ pendingReceiptId: null, committed: true })
      .where(eq(conversationImageAssets.pendingReceiptId, row.id))
      .run()
    repo.database
      .update(conversationBodyInputs)
      .set({ committedMessageId: row.id, pendingReceiptId: null })
      .where(eq(conversationBodyInputs.id, row.inputId))
      .run()
    repo.database
      .update(collaborationInputs)
      .set({
        state: 'materialized',
        materializedRunId: run.id,
        queueState: 'delivered',
        queueReason: null,
      })
      .where(eq(collaborationInputs.id, row.id))
      .run()
    repo.database
      .update(conversationQueueOperations)
      .set({ state: 'accepted', messageId: row.id, updatedAt: now })
      .where(eq(conversationQueueOperations.id, operationId))
      .run()
    repo.database
      .insert(conversationRunSourceRefs)
      .values({
        runId: run.id,
        sourceMessageId: row.id,
        sourceRevision: 0,
        batchId: op.batchId,
        documentsJson: '[]',
      })
      .onConflictDoNothing()
      .run()
    advanceQueue(repo, op.sessionId)
    repo.nativeFact(run.id, 'conversation.steer_accepted', {
      operationId,
      inputId: row.id,
      inputRevision: op.inputRevision,
      batchId: op.batchId,
    })
    return repo.createPatch(op.sessionId, {
      messages: [
        ...(frozenSourceId ? [repo.messageChange(frozenSourceId, 'metadata')] : []),
        repo.messageChange(row.id, 'replace'),
      ],
      runs: [repo.findRun(run.id)!],
      runContexts: [outputRunContext(repo.database, run.id)!],
      resync: { messages: false, drafts: true, activityRunIds: [] },
    })
  })
}

/** Exact native input UUID consumption is distinct from a transport acknowledgement. */
export function markQueuedSteerConsumed(
  repo: ConversationRepositoryHost,
  operationId: string,
  nativeInputId: string,
  skillInvocation?: FrozenSkillInvocation,
): ConversationPatch {
  return repo.database.transaction(() => {
    const op = repo.database
      .select()
      .from(conversationQueueOperations)
      .where(
        and(
          eq(conversationQueueOperations.id, operationId),
          eq(conversationQueueOperations.kind, 'steer'),
        ),
      )
      .get()
    if (!op?.inputId || nativeInputId !== op.inputId)
      throw new RunOperationConflictError(
        'The native input UUID does not match the durable Steer intent.',
      )
    if (op.state === 'consumed') return repo.createPatch(op.sessionId)
    if (!['prepared', 'possibly_sent', 'unknown', 'accepted'].includes(op.state))
      throw new RunOperationConflictError(
        'This native input is no longer eligible for consumption.',
      )
    if (op.state !== 'accepted') markQueuedSteerAccepted(repo, operationId, skillInvocation)
    repo.database
      .update(conversationQueueOperations)
      .set({ state: 'consumed', updatedAt: new Date().toISOString() })
      .where(eq(conversationQueueOperations.id, operationId))
      .run()
    const savedIds = nativeInputIdsForRun(repo, op.targetRunId!)
    const root = savedIds[0] ?? op.nativeTurnId!
    const consumed = repo.database
      .select({ id: conversationQueueOperations.inputId })
      .from(conversationQueueOperations)
      .where(
        and(
          eq(conversationQueueOperations.targetRunId, op.targetRunId!),
          eq(conversationQueueOperations.kind, 'steer'),
          eq(conversationQueueOperations.state, 'consumed'),
        ),
      )
      .orderBy(asc(conversationQueueOperations.inputRevision))
      .limit(64)
      .all()
    const inputIds = [root]
    for (const entry of consumed)
      if (entry.id && !inputIds.includes(entry.id)) inputIds.push(entry.id)
    if (inputIds.length > 64)
      throw new RunOperationConflictError(
        'The native input history budget is occupied. Original input evidence remains saved.',
      )
    repo.database
      .update(agentRuns)
      .set({ nativeInputIdsJson: JSON.stringify(inputIds) })
      .where(eq(agentRuns.id, op.targetRunId!))
      .run()
    repo.nativeFact(op.targetRunId!, 'conversation.steer_consumed', {
      operationId,
      inputId: nativeInputId,
      inputRevision: op.inputRevision,
    })
    const updatedRun = repo.findRun(op.targetRunId!)
    const context = outputRunContext(repo.database, op.targetRunId!)
    return repo.createPatch(op.sessionId, {
      ...(updatedRun ? { runs: [updatedRun] } : {}),
      ...(context ? { runContexts: [context] } : {}),
    })
  })
}

export function readQueuedInputSource(
  repo: ConversationRepositoryHost,
  input: Extract<ConversationGetInput, { scope: 'queued-input' }>,
): Extract<ConversationPage, { scope: 'queued-input' }> {
  const row = repo.database
    .select()
    .from(collaborationInputs)
    .where(
      and(
        eq(collaborationInputs.id, input.inputId),
        eq(collaborationInputs.sessionId, input.sessionId),
      ),
    )
    .get()
  const returned =
    input.source === 'returned' && input.operationId
      ? repo.database
          .select()
          .from(conversationQueueOperations)
          .where(
            and(
              eq(conversationQueueOperations.id, input.operationId),
              eq(conversationQueueOperations.sessionId, input.sessionId),
              eq(conversationQueueOperations.inputId, input.inputId),
              inArray(conversationQueueOperations.state, ['returned', 'installed']),
            ),
          )
          .get()
      : undefined
  if (
    !row ||
    (input.source === 'returned' ? !returned : !['accepted', 'blocked'].includes(row.state))
  )
    throw new RunOperationConflictError('The requested queue source is unavailable.')
  const body = repo.database
    .select()
    .from(conversationBodyInputs)
    .where(eq(conversationBodyInputs.id, row.inputId))
    .get()
  if (!body?.sealed || body.hash !== row.digest || input.offset > body.chars)
    throw new RunOperationConflictError('The queued body or cursor changed.')
  const start =
    repo.database
      .select({ offset: conversationBodyParts.offset })
      .from(conversationBodyParts)
      .where(
        and(
          eq(conversationBodyParts.inputId, body.id),
          lte(conversationBodyParts.offset, input.offset),
        ),
      )
      .orderBy(desc(conversationBodyParts.offset))
      .limit(1)
      .get()?.offset ?? 0
  const parts = repo.database
    .select()
    .from(conversationBodyParts)
    .where(
      and(eq(conversationBodyParts.inputId, body.id), gte(conversationBodyParts.offset, start)),
    )
    .orderBy(asc(conversationBodyParts.offset))
    .limit(2)
    .all()
  const available = parts
    .map((part) => part.text)
    .join('')
    .slice(input.offset - start)
  if (/[\uDC00-\uDFFF]/u.test(available[0] ?? ''))
    throw new RunOperationConflictError('The queued body cursor splits a character.')
  let text = available.slice(0, 4096)
  if (/[\uD800-\uDBFF]/u.test(text.at(-1) ?? '')) text = text.slice(0, -1)
  if (input.offset < body.chars && !text)
    throw new RunOperationConflictError('The queued body has a missing segment.')
  const meta = storedReceivedMetadata(row.metadataJson)
  const sourceComments = repo.database
    .select()
    .from(anchoredComments)
    .where(
      and(
        eq(anchoredComments.sessionId, input.sessionId),
        eq(anchoredComments.pendingReceiptId, row.id),
        gt(anchoredComments.position, input.commentsAfterPosition ?? -1),
      ),
    )
    .orderBy(asc(anchoredComments.position))
    .limit(CONVERSATION_PAGE_ITEMS + 1)
    .all()
  const comments: AnchoredComment[] = []
  for (const comment of sourceComments.slice(0, CONVERSATION_PAGE_ITEMS)) {
    const next = toComment(comment)
    if (
      Buffer.byteLength(JSON.stringify([...comments, next])) >
      CONVERSATION_PAGE_BYTES - 64 * 1024
    ) {
      if (!comments.length) throw new OversizedConversationEntityError()
      break
    }
    comments.push(next)
  }
  const batch = repo.database
    .select({ id: conversationInputBatches.id })
    .from(conversationInputBatches)
    .where(eq(conversationInputBatches.clientMessageId, row.id))
    .get()
  const page: Extract<ConversationPage, { scope: 'queued-input' }> = {
    scope: 'queued-input',
    source: input.source,
    offset: input.offset,
    sessionId: input.sessionId,
    inputId: input.inputId,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    text,
    nextOffset: input.offset + text.length,
    hasMore: input.offset + text.length < body.chars,
    comments,
    commentsNextPosition:
      sourceComments.length > comments.length ? (comments.at(-1)?.position ?? null) : null,
    route: queueRoute(repo, row),
    ...(batch ? { batchId: batch.id } : {}),
    ...(input.offset === 0
      ? { images: repo.resolveMessageImages(input.sessionId, meta.imageIds), skills: meta.skills }
      : {}),
  }
  while (!fitsPage(page) && comments.length) comments.pop()
  page.commentsNextPosition =
    sourceComments.length > comments.length ? (comments.at(-1)?.position ?? null) : null
  if (!fitsPage(page) || (sourceComments.length > 0 && comments.length === 0))
    throw new OversizedConversationEntityError()
  return page
}
