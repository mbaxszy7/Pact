import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setImmediate as yieldImmediate } from 'node:timers/promises'

import {
  CONVERSATION_PATCH_ACTIVITY_ITEMS,
  CONVERSATION_PATCH_TEXT_BYTES,
  CONVERSATION_STREAM_BATCH_BYTES,
  CONVERSATION_STREAM_BATCH_ITEMS,
  conversationStreamDeltaKey,
  type AgentRun,
  type ConversationActivityChange,
  type ConversationMessageChange,
  type ConversationPatch,
  type NativeBackgroundReport,
  type NativeRecoveredOutput,
  type NormalizedAgentEvent,
  type RunFailureKind,
} from '@pact/contracts'

import type { PactDrizzleDatabase } from '../drizzle-database.js'
import type { ConversationRepositoryHost } from './context.js'

import { appendAgentEvent } from '../agent-event-journal.js'
import {
  outputHasBodySql,
  outputRunContext,
  outputSnapshotMetadata,
} from '../conversation-output-snapshots.js'
import * as scheduling from '../conversation-scheduling.js'
import { refreshNativeSessionMetadata } from '../native-presence-metadata.js'
import {
  agentEventJournal,
  agentRunActivities,
  agentRuns,
  anchoredComments,
  conversationBodyInputs,
  conversationInputBatches,
  conversationMessages,
  conversationOutputSnapshots,
  nativeAgentContexts,
  nativeRebuildOperations,
  sessionForkOperations,
  sessions,
} from '../schema/index.js'
import {
  allocateSessionMessageSequence,
  preserveMessagesBeforeCutoffMutation,
} from '../side-chat-persistence.js'
import { backgroundReportId, validBodyText } from './helpers.js'
import {
  activeRunStatuses,
  BODY_PART_UNITS,
  RunOperationConflictError,
  type BackgroundReportIdentity,
  type CompleteAnswerMetadata,
  type EventChanges,
  type SealedBodyFact,
  type StreamDeltaEvent,
} from './types.js'

export function applyEvent(
  repo: ConversationRepositoryHost,
  sessionId: string,
  runId: string,
  event: NormalizedAgentEvent,
): ConversationPatch {
  return commitEvents(repo, sessionId, runId, [event])
}

/** Seal a complete authority snapshot before replacing a saved partial body. */
export async function completeAnswer(
  repo: ConversationRepositoryHost,
  runId: string,
  metadata: CompleteAnswerMetadata,
  source: (physicalSignal: AbortSignal) => AsyncIterable<string>,
  signal: AbortSignal,
  options: { archive?: boolean; bodyState?: 'complete' | 'incomplete' } = {},
): Promise<ConversationPatch> {
  signal.throwIfAborted()
  const run = repo.findRun(runId)
  if (
    !run ||
    metadata.agentId !== run.agentId ||
    (run.nativeTurnId && run.nativeTurnId !== metadata.turnId)
  )
    throw new RunOperationConflictError('This complete answer has no matching Run owner.')
  return sealAnswerBody(repo, run, randomUUID(), metadata.outputId, source, signal, (body) =>
    commitEvents(
      repo,
      run.sessionId,
      runId,
      [{ ...metadata, text: '' }],
      options.archive ?? false,
      options.bodyState,
      body,
    ),
  )
}

export async function recordBackgroundReport(
  repo: ConversationRepositoryHost,
  report: NativeBackgroundReport,
  source: (physicalSignal: AbortSignal) => AsyncIterable<string>,
  signal: AbortSignal,
): Promise<ConversationPatch | undefined> {
  signal.throwIfAborted()
  const run = backgroundReportRun(repo, report)
  const id = backgroundReportId(report)
  const digest = createHash('sha256').update(report.text).digest('hex')
  const previous = repo.database
    .select({
      hash: conversationBodyInputs.hash,
      committed: conversationBodyInputs.committedMessageId,
      clientMessageId: conversationBodyInputs.clientMessageId,
    })
    .from(conversationBodyInputs)
    .where(eq(conversationBodyInputs.id, id))
    .get()
  if (previous) {
    if (
      previous.committed !== id ||
      previous.hash !== digest ||
      previous.clientMessageId !== `${report.nativeMessageId}:${id}`
    )
      throw new RunOperationConflictError('A background update repeated with a different source.')
    return undefined
  }
  // A prior unavailable admission is already durable. Never re-seal a replay
  // after its uncommitted body was discarded on cancellation or cold startup.
  if (
    repo.database
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, id))
      .get()
  )
    return undefined
  commitBackgroundReport(repo, report, id, undefined, 'pending')
  return sealAnswerBody(repo, run, id, report.nativeMessageId, source, signal, (body) => {
    if (body.sha256 !== digest)
      throw new RunOperationConflictError('The complete background update source changed.')
    return commitBackgroundReport(repo, report, id, body)
  })
}

export function recordBackgroundReportUnavailable(
  repo: ConversationRepositoryHost,
  report: BackgroundReportIdentity,
): ConversationPatch | undefined {
  return commitBackgroundReport(repo, report, backgroundReportId(report))
}

function backgroundReportRun(
  repo: ConversationRepositoryHost,
  report: BackgroundReportIdentity,
): AgentRun {
  const run = repo.findRun(report.runId)
  if (
    !run ||
    run.forkSourceRunId ||
    run.agentId !== report.agentId ||
    run.dispatchPhase !== 'ended' ||
    run.nativeOutcome !== 'completed' ||
    run.nativeSessionId !== report.nativeSessionId ||
    run.nativeTurnId !== report.nativeTurnId ||
    run.bindingGeneration !== report.bindingGeneration ||
    run.executorId !== report.executorId
  )
    throw new RunOperationConflictError(
      'The background update has no matching completed native owner.',
    )
  return run
}

function commitBackgroundReport(
  repo: ConversationRepositoryHost,
  report: BackgroundReportIdentity,
  id: string,
  body?: SealedBodyFact,
  phase: 'pending' | 'unavailable' = 'unavailable',
): ConversationPatch | undefined {
  return repo.database.transaction((transaction) => {
    const run = backgroundReportRun(repo, report)
    const binding = repo.nativeContext(run.sessionId, run.agentId)
    const visible =
      repo.ownsBackgroundControl(run.id) &&
      binding?.nativeSessionId === report.nativeSessionId &&
      binding.executorId === report.executorId &&
      repo.sourceQueries.session().get({ sessionId: run.sessionId })?.status !== 'archived'
    const previous = transaction
      .select({
        state: conversationMessages.state,
        visible: conversationMessages.isVisible,
        revision: conversationMessages.contentRevision,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, id))
      .get()
    if (
      previous &&
      (previous.state === 'complete' || (!body && (phase === 'pending' || previous.revision > 0)))
    )
      return undefined
    const current = visible && (previous?.visible ?? true)

    const content = body
      ? sql<string>`(SELECT group_concat(text, '') FROM (SELECT text FROM conversation_body_parts WHERE input_id=${body.inputId} ORDER BY offset))`
      : ''
    const now = new Date().toISOString()
    const state = body ? 'complete' : 'incomplete'
    if (previous) {
      preserveMessagesBeforeCutoffMutation(transaction, [id])
      transaction
        .update(conversationMessages)
        .set({
          state,
          content,
          updatedAt: now,
          isVisible: current,
          contentRevision: sql`${conversationMessages.contentRevision} + 1`,
        })
        .where(eq(conversationMessages.id, id))
        .run()
    } else {
      const messageSequence = allocateSessionMessageSequence(transaction, run.sessionId)
      transaction
        .insert(conversationMessages)
        .values({
          id,
          sessionId: run.sessionId,
          sourceMessageId: run.userMessageId,
          role: 'assistant',
          agentId: report.agentId,
          isVisible: current,
          state,
          content,
          contentRevision: !body && phase === 'unavailable' ? 1 : 0,
          sequence: messageSequence,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }
    if (body)
      transaction
        .update(conversationBodyInputs)
        .set({ committedMessageId: id })
        .where(eq(conversationBodyInputs.id, body.inputId))
        .run()
    appendAgentEvent(transaction, {
      sessionId: run.sessionId,
      runId: run.id,
      eventType: body ? 'background.report' : `background.report_${phase}`,
      payload: JSON.stringify({
        frameId: report.frameId,
        nativeMessageId: report.nativeMessageId,
        executorId: report.executorId,
        bindingGeneration: report.bindingGeneration,
        messageId: id,
        ...(body ? { source: body } : {}),
      }),
      createdAt: now,
    })
    if (!current || (!body && phase === 'pending')) return undefined
    transaction.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, run.sessionId)).run()
    return repo.createPatch(run.sessionId, {
      messages: [repo.messageChange(id, 'replace')],
    })
  })
}

async function sealAnswerBody<T>(
  repo: ConversationRepositoryHost,
  run: AgentRun,
  inputId: string,
  outputId: string,
  source: (physicalSignal: AbortSignal) => AsyncIterable<string>,
  signal: AbortSignal,
  commit: (body: SealedBodyFact) => T,
): Promise<T> {
  const runId = run.id
  const ownerKey = `answer:${runId}`
  repo.sweepConversationInputs()
  const now = new Date().toISOString()
  const expiresAt = performance.now() + 10_000
  repo.database.transaction(() => {
    repo.bodyCapacity(ownerKey, 0, true)
    repo.database
      .insert(conversationBodyInputs)
      .values({
        id: inputId,
        sessionId: run.sessionId,
        clientMessageId: `${outputId}:${inputId}`,
        ownerKey,
        purpose: 'answer',
        sourceRunId: runId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), Math.max(1, expiresAt - performance.now()))
  const observed = AbortSignal.any([signal, deadline.signal])
  const check = (): void => {
    if (performance.now() >= expiresAt) deadline.abort()
    observed.throwIfAborted()
  }
  let iterator: AsyncIterator<string> | undefined
  try {
    // This seam accepts only controlled, cooperative snapshot sources. It does not
    // admit arbitrary external readers whose next/return cannot respond to abort.
    iterator = source(observed)[Symbol.asyncIterator]()
    for (;;) {
      check()
      // oxlint-disable-next-line no-await-in-loop -- This candidate has one physical source read in flight.
      const next = await iterator.next()
      check()
      if (next.done) break
      const text = next.value
      if (typeof text !== 'string' || text.length > 64 * 1024 || !validBodyText(text))
        throw new RunOperationConflictError(
          'Complete answer source must provide bounded Unicode segments.',
        )
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(text.length, offset + BODY_PART_UNITS)
        if (
          end < text.length &&
          text.charCodeAt(end - 1) >= 0xd800 &&
          text.charCodeAt(end - 1) <= 0xdbff
        )
          end--
        const part = text.slice(offset, end)
        check()
        repo.database.transaction(() => {
          const row = repo.bodyInput(inputId, run.sessionId, ownerKey)
          repo.appendBodyPart(row, row.chars, part)
        })
        offset = end
        // oxlint-disable-next-line no-await-in-loop -- Durable candidate segments yield the Utility control plane between writes.
        await yieldImmediate(undefined, { signal: observed })
      }
    }
    check()
    repo.database.transaction(() => repo.sealBody(repo.bodyInput(inputId, run.sessionId, ownerKey)))
    const row = repo.bodyInput(inputId, run.sessionId, ownerKey)
    if (!row.hash) throw new RunOperationConflictError('Complete answer candidate changed.')
    check()
    return commit({ version: 1, inputId, sha256: row.hash, bytes: row.bytes, chars: row.chars })
  } finally {
    deadline.abort()
    try {
      // A logical cancellation cannot release the candidate before its source closes.
      await iterator?.return?.()
    } finally {
      clearTimeout(timer)
      // Committed versions are durable Journal sources; only abandoned candidates can be removed.
      repo.database
        .delete(conversationBodyInputs)
        .where(
          and(
            eq(conversationBodyInputs.id, inputId),
            isNull(conversationBodyInputs.committedMessageId),
            isNull(conversationBodyInputs.pendingReceiptId),
          ),
        )
        .run()
    }
  }
}

export function applyArchivedEvent(
  repo: ConversationRepositoryHost,
  sessionId: string,
  runId: string,
  event: NormalizedAgentEvent,
): ConversationPatch {
  return commitEvents(repo, sessionId, runId, [event], true)
}

function prepareNativeOutput(
  repo: ConversationRepositoryHost,
  runId: string,
  output: NativeRecoveredOutput,
): { run: AgentRun } | { patch: ConversationPatch } {
  const run = repo.findRun(runId)
  if (!run) throw new RunOperationConflictError('Native output has no recorded Run owner.')
  if (!run.nativeTurnId) {
    repo.nativeFact(runId, 'native.unbound_output_not_projected', {
      outputId: output.outputId,
      hash: createHash('sha256').update(output.text).digest('hex'),
      reason: 'No native Turn identity was confirmed for this output.',
    })
    return { patch: repo.runPatch(runId) }
  }
  // A complete archived version is durable evidence, not proof of UI delivery.
  // Preserve every accepted visible answer, including one before a newer archive.
  const acceptedComplete = repo.hasCompleteResponse(runId)
  const previous = !acceptedComplete
    ? repo.database
        .select({
          content: conversationMessages.content,
          state: conversationMessages.state,
          isVisible: conversationMessages.isVisible,
        })
        .from(conversationMessages)
        .where(
          and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')),
        )
        .orderBy(desc(conversationMessages.sequence))
        .limit(1)
        .get()
    : undefined
  const repeatedHidden =
    previous?.isVisible === false &&
    previous.content === output.text &&
    previous.state === (output.completeness === 'complete' ? 'complete' : 'incomplete') &&
    !repo.mayProjectNativeBody(run)
  if (
    acceptedComplete ||
    repeatedHidden ||
    (previous && output.completeness === 'partial' && !output.text.startsWith(previous.content))
  ) {
    repo.nativeFact(runId, 'native.recovered_output_not_projected', {
      outputId: output.outputId,
      completeness: output.completeness,
      hash: createHash('sha256').update(output.text).digest('hex'),
      reason: acceptedComplete
        ? 'The accepted completed answer was preserved.'
        : repeatedHidden
          ? 'This hidden recovered version was already recorded.'
          : 'Partial readback cannot replace the saved answer.',
    })
    return { patch: repo.runPatch(runId) }
  }
  return { run }
}

export function recordNativeOutput(
  repo: ConversationRepositoryHost,
  runId: string,
  output: NativeRecoveredOutput,
): ConversationPatch {
  const prepared = prepareNativeOutput(repo, runId, output)
  if ('patch' in prepared) return prepared.patch
  const { run } = prepared
  return commitEvents(
    repo,
    run.sessionId,
    runId,
    [
      {
        agentId: run.agentId,
        type: 'text.completed',
        turnId: run.nativeTurnId!,
        outputId: output.outputId,
        text: output.text,
      },
    ],
    true,
    output.completeness === 'complete' ? 'complete' : 'incomplete',
  )
}

export async function recordNativeOutputComplete(
  repo: ConversationRepositoryHost,
  runId: string,
  output: NativeRecoveredOutput,
  signal: AbortSignal,
): Promise<ConversationPatch> {
  if (Buffer.byteLength(output.text) <= CONVERSATION_PATCH_TEXT_BYTES)
    return recordNativeOutput(repo, runId, output)
  const prepared = prepareNativeOutput(repo, runId, output)
  if ('patch' in prepared) return prepared.patch
  const { run } = prepared
  const source = (physicalSignal: AbortSignal): AsyncIterable<string> =>
    (async function* (): AsyncIterable<string> {
      for (let offset = 0; offset < output.text.length;) {
        let end = Math.min(output.text.length, offset + BODY_PART_UNITS)
        if (
          end < output.text.length &&
          output.text.charCodeAt(end - 1) >= 0xd800 &&
          output.text.charCodeAt(end - 1) <= 0xdbff
        )
          end--
        physicalSignal.throwIfAborted()
        yield output.text.slice(offset, end)
        offset = end
      }
    })()
  return completeAnswer(
    repo,
    runId,
    {
      agentId: run.agentId,
      type: 'text.completed',
      turnId: run.nativeTurnId!,
      outputId: output.outputId,
    },
    source,
    signal,
    { archive: true, bodyState: output.completeness === 'complete' ? 'complete' : 'incomplete' },
  )
}

export function applyArchivedBatch(
  repo: ConversationRepositoryHost,
  sessionId: string,
  runId: string,
  events: readonly StreamDeltaEvent[],
): ConversationPatch {
  return commitEvents(repo, sessionId, runId, events, true)
}

export function applyStreamBatch(
  repo: ConversationRepositoryHost,
  sessionId: string,
  runId: string,
  events: readonly StreamDeltaEvent[],
): ConversationPatch {
  if (events.length === 0 || events.length > CONVERSATION_STREAM_BATCH_ITEMS)
    throw new Error('Invalid stream batch size.')
  if (Buffer.byteLength(JSON.stringify(events), 'utf8') > CONVERSATION_STREAM_BATCH_BYTES)
    throw new Error('Stream batch exceeds its serialized byte limit.')
  // Buffer owns coalescing; reject ambiguous batches rather than merge twice.
  const keys = new Set<string>()
  for (const event of events) {
    const key = conversationStreamDeltaKey(event)
    if (keys.has(key)) throw new Error('Stream batch must contain coalesced keys.')
    keys.add(key)
  }
  return commitEvents(repo, sessionId, runId, events)
}

export function commitEvents(
  repo: ConversationRepositoryHost,
  sessionId: string,
  runId: string,
  events: readonly NormalizedAgentEvent[],
  archive = false,
  bodyState?: 'complete' | 'incomplete',
  sealedBody?: SealedBodyFact,
): ConversationPatch {
  if (
    events.every((event) => event.type === 'session.title.updated') &&
    !repo.ownsNativeControl(runId)
  )
    archive = true
  const observation = repo.observations.get(sessionId)
  const patchesBefore = repo.patchCount
  try {
    const patch = repo.database.transaction((transaction) => {
      if (events.some((event) => event.type !== 'session.title.updated')) {
        const current = transaction
          .select({
            id: agentRuns.id,
            agentId: agentRuns.agentId,
            status: agentRuns.status,
            nativeTurnId: agentRuns.nativeTurnId,
          })
          .from(agentRuns)
          .where(
            archive
              ? and(eq(agentRuns.id, runId), eq(agentRuns.sessionId, sessionId))
              : eq(agentRuns.sessionId, sessionId),
          )
          .orderBy(desc(agentRuns.createdAt), desc(sql`rowid`))
          .limit(1)
          .get()
        if (
          current?.id !== runId ||
          events.some((event) => event.agentId !== current.agentId) ||
          !(archive || activeRunStatuses.some((status) => status === current.status))
        )
          throw new RunOperationConflictError('This Run no longer owns the Session.')
        if (
          events.some(
            (event) =>
              'turnId' in event && current.nativeTurnId && event.turnId !== current.nativeTurnId,
          )
        )
          throw new RunOperationConflictError('This result belongs to an earlier native Turn.')
      }
      const changes = events.map((event) =>
        applyEventWithinTransaction(
          repo,
          transaction,
          sessionId,
          runId,
          event,
          archive,
          bodyState,
          sealedBody,
        ),
      )
      if (!archive)
        transaction
          .update(sessions)
          .set({ updatedAt: new Date().toISOString() })
          .where(eq(sessions.id, sessionId))
          .run()
      const messageChanges = changes.flatMap((change) => [
        ...(change.snapshotMessageId
          ? [{ id: change.snapshotMessageId, mode: 'metadata' as const }]
          : []),
        ...(change.message ? [change.message] : []),
      ])
      if (
        events.some((event) => event.type === 'turn.completed' && event.outcome !== 'completed')
      ) {
        const failedRun = transaction
          .select({ userMessageId: agentRuns.userMessageId })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId))
          .get()
        if (failedRun)
          messageChanges.push({ id: failedRun.userMessageId, mode: 'metadata' as const })
      }
      const uniqueMessages = new Map<string, (typeof messageChanges)[number]>()
      for (const change of messageChanges) {
        const previous = uniqueMessages.get(change.id)
        uniqueMessages.set(change.id, previous?.mode === 'replace' ? previous : change)
      }
      const messages = [...uniqueMessages.values()]
        .filter(
          (change) =>
            transaction
              .select({ visible: conversationMessages.isVisible })
              .from(conversationMessages)
              .where(eq(conversationMessages.id, change.id))
              .get()?.visible || outputSnapshotMetadata(repo.database, change.id)?.frozen,
        )
        .map((change) =>
          repo.messageChange(change.id, change.mode, change.text, change.previousRevision),
        )
      const activityChanges = changes.flatMap((change) =>
        change.activity ? [change.activity] : [],
      )
      const activities = activityChanges
        .slice(0, CONVERSATION_PATCH_ACTIVITY_ITEMS)
        .map((change) =>
          repo.activityChange(change.id, change.mode, change.detail, change.previousRevision),
        )
      if (
        events.some((event) =>
          ['session.started', 'turn.started', 'turn.completed', 'text.completed'].includes(
            event.type,
          ),
        )
      )
        refreshNativeSessionMetadata(transaction, sessionId)
      const run = repo.findRun(runId)
      const runContext = outputRunContext(repo.database, runId)
      if (
        events.some((event) => event.type === 'turn.completed' || event.type === 'text.completed')
      )
        repo.recordSchedulingBusinessActivity(runId, repo.hasCompleteResponse(runId))
      return repo.createPatch(sessionId, {
        ...(runContext ? { runContexts: [runContext] } : {}),
        messages,
        removedMessageIds: changes.flatMap((change) => change.removedMessageIds ?? []),
        activities,
        ...(run ? { runs: [run] } : {}),
        activityStates: changes.flatMap((change) => change.activityStates),
        ...(activityChanges.length > activities.length
          ? { resync: { messages: false, drafts: false, activityRunIds: [runId] } }
          : {}),
      })
    })
    repo.eventTransactionCount += 1
    if (events.some((event) => event.type === 'turn.completed' || event.type === 'text.completed'))
      repo.schedulingChanged()
    return patch
  } catch (error) {
    // Projection validation and writes are atomic; no Patch escapes before COMMIT.
    if (observation) repo.observations.set(sessionId, observation)
    else repo.observations.delete(sessionId)
    repo.patchCount = patchesBefore
    throw error
  }
}

function applyEventWithinTransaction(
  repo: ConversationRepositoryHost,
  transaction: Pick<PactDrizzleDatabase, 'select' | 'insert' | 'update'>,
  sessionId: string,
  runId: string,
  event: NormalizedAgentEvent,
  archive = false,
  bodyState?: 'complete' | 'incomplete',
  sealedBody?: SealedBodyFact,
): EventChanges {
  const now = new Date().toISOString()
  const removedMessageIds: string[] = []
  let messageChange:
    | {
        id: string
        mode: ConversationMessageChange['mode']
        text?: string
        previousRevision?: number
      }
    | undefined
  let snapshotMessageId: string | undefined
  let activityChange:
    | {
        id: string
        mode: ConversationActivityChange['mode']
        detail?: string
        previousRevision?: number
      }
    | undefined
  const activityStates: ConversationPatch['activityStates'] = []

  let eventSequence: number | undefined
  if (!sealedBody && event.type !== 'text.delta' && event.type !== 'reasoning.summary.delta') {
    eventSequence = appendAgentEvent(transaction, {
      sessionId,
      runId,
      eventType: event.type,
      payload: JSON.stringify(event),
      createdAt: now,
    })
  }

  if (event.type === 'session.started') {
    const run = repo.findRun(runId)
    if (!run) throw new RunOperationConflictError('The native Run is unavailable.')
    if (run.nativeSessionId && run.nativeSessionId !== event.nativeSessionId)
      throw new RunOperationConflictError('Native startup acknowledged a different Run binding.')
    if (archive) {
      transaction
        .update(agentRuns)
        .set({ nativeSessionId: event.nativeSessionId })
        .where(eq(agentRuns.id, runId))
        .run()
      return { activityStates, removedMessageIds }
    }
    const priorContext = transaction
      .select({
        nativeSessionId: nativeAgentContexts.nativeSessionId,
        bindingGeneration: nativeAgentContexts.bindingGeneration,
        rebuildMessageCount: nativeAgentContexts.rebuildMessageCount,
        rebuiltThroughSequence: nativeAgentContexts.rebuiltThroughSequence,
        deliveredCutoffIdsJson: nativeAgentContexts.deliveredCutoffIdsJson,
      })
      .from(nativeAgentContexts)
      .where(
        and(
          eq(nativeAgentContexts.sessionId, sessionId),
          eq(nativeAgentContexts.agentId, event.agentId),
        ),
      )
      .get()
    const sameNativeContext = priorContext?.nativeSessionId === event.nativeSessionId
    if (
      priorContext &&
      (!sameNativeContext || priorContext.bindingGeneration !== run.bindingGeneration)
    )
      throw new RunOperationConflictError(
        'The native binding changed before startup acknowledgement.',
      )
    transaction
      .insert(nativeAgentContexts)
      .values({
        sessionId,
        agentId: event.agentId,
        nativeSessionId: event.nativeSessionId,
        bindingGeneration: run.bindingGeneration ?? 1,
        executorId: run.executorId ?? null,
        continuationState: 'responding',
        state: 'active',
        lastRunId: runId,
        recoveryFailureKind: null,
        recoveryFailureMessage: null,
        deliveredCutoffIdsJson: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [nativeAgentContexts.sessionId, nativeAgentContexts.agentId],
        set: {
          nativeSessionId: event.nativeSessionId,
          bindingGeneration: run.bindingGeneration ?? 1,
          executorId: run.executorId ?? null,
          continuationState: 'responding',
          state: 'active',
          lastRunId: runId,
          recoveryFailureKind: null,
          recoveryFailureMessage: null,
          rebuildMessageCount: sameNativeContext ? priorContext.rebuildMessageCount : null,
          rebuiltThroughSequence: sameNativeContext ? priorContext.rebuiltThroughSequence : null,
          deliveredCutoffIdsJson: sameNativeContext ? priorContext.deliveredCutoffIdsJson : null,
          updatedAt: now,
        },
      })
      .run()
    transaction
      .update(agentRuns)
      .set({ nativeSessionId: event.nativeSessionId, status: 'running', updatedAt: now })
      .where(eq(agentRuns.id, runId))
      .run()
  } else if (event.type === 'run.speed.resolved') {
    transaction
      .update(agentRuns)
      .set({
        ...(event.speed ? { observedSpeed: event.speed } : {}),
        speedDetail: event.detail ?? null,
        updatedAt: now,
      })
      .where(eq(agentRuns.id, runId))
      .run()
  } else if (event.type === 'run.model.resolved') {
    transaction
      .update(agentRuns)
      .set({
        model: event.model,
        ...(event.effort !== undefined ? { effort: event.effort } : {}),
        updatedAt: now,
      })
      .where(eq(agentRuns.id, runId))
      .run()
  } else if (event.type === 'session.title.updated') {
    if (archive) return { activityStates, removedMessageIds }
    if (event.origin !== 'turn_result') {
      const current = transaction
        .select({ title: sessions.title, source: sessions.titleSource })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get()
      // A successfully reported Pact title survives failed/uncertain Native naming
      // and cold resume. Older Native-only titles retain their existing priority.
      if (
        current?.source === 'agent' &&
        transaction
          .select({ sequence: agentEventJournal.sequence })
          .from(agentEventJournal)
          .where(
            and(
              eq(agentEventJournal.sessionId, sessionId),
              sql`${agentEventJournal.eventType} = 'session.title.updated'`,
              sql`json_extract(${agentEventJournal.payload}, '$.titleAdopted') = 1`,
              sql`json_extract(${agentEventJournal.payload}, '$.title') = ${current.title}`,
            ),
          )
          .limit(1)
          .get()
      )
        return { activityStates, removedMessageIds }
    }
    const latestRunId = transaction
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(conversationMessages, eq(conversationMessages.id, agentRuns.userMessageId))
      .where(eq(agentRuns.sessionId, sessionId))
      .orderBy(
        desc(conversationMessages.sequence),
        desc(agentRuns.createdAt),
        desc(sql`${agentRuns}.rowid`),
      )
      .limit(1)
      .get()?.id
    if (latestRunId === runId && repo.ownsNativeControl(runId)) {
      const adopted = transaction
        .update(sessions)
        .set({ title: event.title, titleSource: 'agent', updatedAt: now })
        .where(
          and(
            eq(sessions.id, sessionId),
            ne(sessions.titleSource, 'user'),
            ...(event.origin === 'turn_result'
              ? [inArray(sessions.titleSource, ['placeholder', 'local'])]
              : []),
            // A Fork's local title is frozen inherited metadata, not the first
            // question's temporary fallback. Native readback cannot replace it.
            or(
              ne(sessions.titleSource, 'local'),
              sql`NOT EXISTS (
              SELECT 1 FROM ${sessionForkOperations}
              WHERE ${sessionForkOperations.sessionId} = ${sessions.id}
            )`,
            ),
          ),
        )
        .returning({ id: sessions.id })
        .get()
      if (adopted && event.origin === 'turn_result' && eventSequence !== undefined)
        transaction
          .update(agentEventJournal)
          .set({ payload: JSON.stringify({ ...event, titleAdopted: true }) })
          .where(
            and(
              eq(agentEventJournal.sessionId, sessionId),
              eq(agentEventJournal.sequence, eventSequence),
            ),
          )
          .run()
    }
  } else if (event.type === 'turn.started') {
    transaction
      .update(agentRuns)
      .set({
        nativeTurnId: sql`COALESCE(${agentRuns.nativeTurnId}, ${event.turnId})`,
        dispatchPhase: sql`CASE WHEN ${agentRuns.dispatchPhase} = 'ended' THEN 'ended' ELSE 'accepted' END`,
        ...(!archive ? { status: 'running' as const, updatedAt: now } : {}),
      })
      .where(eq(agentRuns.id, runId))
      .run()
  } else if (event.type === 'peer.assistance.requested') {
    if (archive) return { activityStates, removedMessageIds }
    if (event.targetAgentId === event.agentId)
      throw new RunOperationConflictError('An Agent cannot request itself as a peer.')
    const owner = transaction
      .select({
        id: agentRuns.peerProposalId,
        state: agentRuns.peerProposalState,
        agentId: agentRuns.agentId,
        routeKind: conversationMessages.routeKind,
      })
      .from(agentRuns)
      .innerJoin(conversationMessages, eq(conversationMessages.id, agentRuns.userMessageId))
      .where(eq(agentRuns.id, runId))
      .get()
    if (!owner || owner.agentId !== event.agentId)
      throw new RunOperationConflictError('This peer request does not belong to the Agent Run.')
    if (owner.routeKind === 'all')
      throw new RunOperationConflictError('@all Runs cannot request additional peer assistance.')
    if (owner.id && owner.state === 'accepted')
      return { message: undefined, activity: undefined, activityStates: [], removedMessageIds }
    transaction
      .update(agentRuns)
      .set({
        peerProposalId: event.proposalId,
        peerProposalTargetAgentId: event.targetAgentId,
        peerProposalKind: event.kind,
        peerProposalReason: event.reason ?? null,
        peerProposalState: 'pending',
        peerProposalAcceptedMessageId: null,
        updatedAt: now,
      })
      .where(eq(agentRuns.id, runId))
      .run()
  } else if (event.type === 'interaction.requested') {
    transaction
      .update(sessions)
      .set({ status: 'waiting_for_user', updatedAt: now })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.archivedAt)))
      .run()
  } else if (
    event.type === 'reasoning.summary.delta' ||
    event.type === 'reasoning.summary.completed' ||
    event.type === 'tool.started' ||
    event.type === 'tool.completed'
  ) {
    const nativeId =
      event.type === 'reasoning.summary.delta' || event.type === 'reasoning.summary.completed'
        ? event.activityId
        : event.toolCallId
    const kind =
      event.type === 'reasoning.summary.delta' || event.type === 'reasoning.summary.completed'
        ? ('reasoning' as const)
        : ('tool' as const)
    const existing = transaction
      .select()
      .from(agentRunActivities)
      .where(
        and(
          eq(agentRunActivities.runId, runId),
          eq(agentRunActivities.kind, kind),
          eq(agentRunActivities.nativeId, nativeId),
        ),
      )
      .get()
    repo.streamLookups.activity.queries += 1
    repo.streamLookups.activity.returnedRows += Number(existing !== undefined)
    const title =
      event.type === 'tool.started' || event.type === 'tool.completed' ? event.title : 'Reasoning'
    const toolName =
      event.type === 'tool.started' || event.type === 'tool.completed' ? event.toolName : undefined
    const detail =
      event.type === 'reasoning.summary.delta'
        ? `${existing?.detail ?? ''}${event.text}`
        : event.type === 'reasoning.summary.completed'
          ? event.text
          : event.detail
    const status =
      event.type === 'reasoning.summary.completed'
        ? ('completed' as const)
        : event.type === 'tool.completed'
          ? event.outcome
          : ('running' as const)

    if (existing) {
      transaction
        .update(agentRunActivities)
        .set({
          toolName: toolName ?? null,
          title,
          detail: detail || null,
          detailRevision: existing.detailRevision + 1,
          status,
          updatedAt: now,
        })
        .where(eq(agentRunActivities.id, existing.id))
        .run()
      activityChange = {
        id: existing.id,
        mode: event.type === 'reasoning.summary.delta' ? 'append' : 'replace',
        ...(event.type === 'reasoning.summary.delta'
          ? { detail: event.text, previousRevision: existing.detailRevision }
          : { detail: detail ?? '' }),
      }
    } else {
      const sequence =
        (transaction
          .select({ value: max(agentRunActivities.sequence) })
          .from(agentRunActivities)
          .where(eq(agentRunActivities.sessionId, sessionId))
          .get()?.value ?? -1) + 1
      const activityId = randomUUID()
      transaction
        .insert(agentRunActivities)
        .values({
          id: activityId,
          sessionId,
          runId,
          agentId: event.agentId,
          nativeId,
          kind,
          toolName: toolName ?? null,
          title,
          detail: detail || null,
          status,
          sequence,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      activityChange = {
        id: activityId,
        mode: detail === undefined ? 'metadata' : 'replace',
        ...(detail === undefined ? {} : { detail }),
      }
    }
  } else if (event.type === 'text.delta' || event.type === 'text.completed') {
    const archivedRun = archive ? repo.findRun(runId) : undefined
    const mayProjectBody =
      !archive ||
      (bodyState !== undefined &&
        archivedRun !== undefined &&
        repo.mayProjectNativeBody(archivedRun))
    if (event.type === 'text.completed')
      transaction
        .update(agentRuns)
        .set({ nativeTurnId: event.turnId })
        .where(and(eq(agentRuns.id, runId), sql`${agentRuns.nativeTurnId} IS NULL`))
        .run()
    // Re-read the cut inside this transaction, after any asynchronous answer seal.
    const cut = transaction
      .select()
      .from(conversationOutputSnapshots)
      .where(eq(conversationOutputSnapshots.runId, runId))
      .orderBy(desc(conversationOutputSnapshots.ordinal))
      .limit(1)
      .get()
    if (cut && event.type === 'text.delta' && !event.text)
      return { activityStates, removedMessageIds }
    const previous = transaction
      .select({
        ...getTableColumns(conversationMessages),
        content: sealedBody ? sql<string>`''` : conversationMessages.content,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.runId, runId),
          eq(conversationMessages.role, 'assistant'),
          cut && mayProjectBody ? eq(conversationMessages.isVisible, true) : undefined,
        ),
      )
      .orderBy(desc(conversationMessages.sequence))
      .limit(1)
      .get()
    repo.streamLookups.text.queries += 1
    repo.streamLookups.text.returnedRows += Number(previous !== undefined)
    const nextContent = sealedBody
      ? sql<string>`(SELECT group_concat(text, '') FROM (SELECT text FROM conversation_body_parts WHERE input_id=${sealedBody.inputId} ORDER BY offset))`
      : event.type === 'text.delta'
        ? `${previous?.content ?? ''}${event.text}`
        : event.text
    const previousSnapshot = previous
      ? transaction
          .select({ frozen: conversationOutputSnapshots.frozen })
          .from(conversationOutputSnapshots)
          .where(eq(conversationOutputSnapshots.sourceMessageId, previous.id))
          .get()
      : undefined
    const identicalFrozenSnapshot = Boolean(
      cut &&
      !cut.sourceMessageId &&
      previous &&
      event.type === 'text.completed' &&
      transaction
        .select({ same: sql<number>`${conversationMessages.content} = ${nextContent}` })
        .from(conversationMessages)
        .where(eq(conversationMessages.id, previous.id))
        .get()?.same,
    )
    const anchoredSource =
      archive &&
      previous &&
      !previous.isVisible &&
      previous.state === 'streaming' &&
      transaction
        .select({ id: anchoredComments.id })
        .from(anchoredComments)
        .where(
          and(
            eq(anchoredComments.sessionId, sessionId),
            sql`json_extract(${anchoredComments.anchorJson}, '$.type') = 'message'`,
            sql`json_extract(${anchoredComments.anchorJson}, '$.messageId') = ${previous.id}`,
          ),
        )
        .limit(1)
        .get()
    // Recovery can extend a body already referenced by a Comment; preserve its source row.
    const existing =
      previous &&
      !previousSnapshot?.frozen &&
      !(
        (archive && (previous.isVisible || previous.state !== 'streaming' || anchoredSource)) ||
        (event.type === 'text.completed' &&
          bodyState !== undefined &&
          (previous.content !== event.text || (bodyState === 'complete' && !previous.isVisible)))
      )
        ? previous
        : undefined
    if (identicalFrozenSnapshot && previous) {
      // No new text after Steer: retain one exact source, relocate only its final display.
      if (bodyState) {
        preserveMessagesBeforeCutoffMutation(transaction, [previous.id])
        transaction
          .update(conversationMessages)
          .set({ state: bodyState, updatedAt: now })
          .where(eq(conversationMessages.id, previous.id))
          .run()
      }
      messageChange = { id: previous.id, mode: 'metadata' }
    } else if (existing) {
      preserveMessagesBeforeCutoffMutation(transaction, [existing.id])
      transaction
        .update(conversationMessages)
        .set({
          content: nextContent,
          contentRevision: existing.contentRevision + 1,
          state: bodyState ?? 'streaming',
          updatedAt: now,
        })
        .where(eq(conversationMessages.id, existing.id))
        .run()
      if (cut)
        transaction
          .update(conversationOutputSnapshots)
          .set({
            hasBody: sealedBody
              ? sql`(SELECT ${outputHasBodySql(conversationMessages.content)} FROM conversation_messages WHERE id=${existing.id})`
              : typeof nextContent === 'string' && nextContent.trim().length > 0,
          })
          .where(eq(conversationOutputSnapshots.sourceMessageId, existing.id))
          .run()
      messageChange = {
        id: existing.id,
        mode: event.type === 'text.delta' ? 'append' : 'replace',
        ...(sealedBody ? {} : { text: event.text }),
        ...(event.type === 'text.delta' ? { previousRevision: existing.contentRevision } : {}),
      }
    } else {
      const run = repo.findRun(runId)
      if (!run) throw new Error('Agent Run does not exist.')
      const visible = transaction
        .select({
          id: conversationMessages.id,
          runId: conversationMessages.runId,
          hasBody: sql<number>`length(trim(${conversationMessages.content}, char(9) || char(10) || char(13) || ' ')) > 0`,
        })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.replyToMessageId, run.userMessageId),
            eq(conversationMessages.role, 'assistant'),
            eq(conversationMessages.agentId, run.agentId),
            eq(conversationMessages.isVisible, true),
          ),
        )
        .limit(1)
        .get()
      const replacesRecoveredSource =
        bodyState === 'complete' && visible?.runId === runId && repo.ownsNativeControl(runId)
      const replacesSnapshot = Boolean(cut && mayProjectBody && visible?.runId === runId)
      if (
        visible &&
        ((!visible.hasBody && !archive) || replacesRecoveredSource || replacesSnapshot)
      ) {
        preserveMessagesBeforeCutoffMutation(transaction, [visible.id])
        transaction
          .update(conversationMessages)
          .set({ isVisible: false })
          .where(eq(conversationMessages.id, visible.id))
          .run()
        if (replacesSnapshot && outputSnapshotMetadata(repo.database, visible.id)?.frozen)
          snapshotMessageId = visible.id
        else removedMessageIds.push(visible.id)
      }
      const messageSequence = allocateSessionMessageSequence(transaction, sessionId)
      const messageId = randomUUID()
      transaction
        .insert(conversationMessages)
        .values({
          id: messageId,
          sessionId,
          runId,
          role: 'assistant',
          replyToMessageId: run.userMessageId,
          isVisible:
            mayProjectBody && (replacesSnapshot || replacesRecoveredSource || !visible?.hasBody),
          agentId: event.agentId,
          content: nextContent,
          state: bodyState ?? 'streaming',
          sequence: messageSequence,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      if (cut && mayProjectBody)
        transaction
          .update(conversationOutputSnapshots)
          .set({
            sourceMessageId: messageId,
            sourceSequence: messageSequence,
            hasBody: sealedBody
              ? sql`(SELECT ${outputHasBodySql(conversationMessages.content)} FROM conversation_messages WHERE id=${messageId})`
              : typeof nextContent === 'string' && nextContent.trim().length > 0,
          })
          .where(
            and(
              eq(conversationOutputSnapshots.runId, runId),
              eq(conversationOutputSnapshots.ordinal, cut.ordinal),
            ),
          )
          .run()
      messageChange = {
        id: messageId,
        mode: 'replace',
        // A delta starting a snapshot needs the prior complete prefix too.
        ...(sealedBody ? {} : { text: typeof nextContent === 'string' ? nextContent : event.text }),
      }
    }
  } else if (event.type === 'turn.completed') {
    if (!archive)
      transaction
        .update(nativeAgentContexts)
        .set({
          state: event.outcome === 'completed' ? 'active' : 'interrupted',
          continuationState: 'ready',
          recoveryReason: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, sessionId),
            eq(nativeAgentContexts.agentId, event.agentId),
            eq(nativeAgentContexts.lastRunId, runId),
          ),
        )
        .run()
    const currentSessionStatus = transaction
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get()?.status
    transaction
      .update(agentRuns)
      .set({
        status: event.outcome,
        nativeOutcome: event.outcome,
        dispatchPhase: 'ended',
        failureKind: null,
        failureMessage: null,
        updatedAt: now,
      })
      .where(eq(agentRuns.id, runId))
      .run()
    if (event.outcome !== 'completed' && !archive) {
      transaction
        .update(agentRuns)
        .set({ peerProposalState: 'superseded', updatedAt: now })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.peerProposalState, 'pending')))
        .run()
      const failedRun = transaction
        .select({ userMessageId: agentRuns.userMessageId })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .get()
      if (failedRun)
        transaction
          .update(conversationMessages)
          .set({ routePendingAgentId: null, updatedAt: now })
          .where(eq(conversationMessages.id, failedRun.userMessageId))
          .run()
    }
    transaction
      .update(agentRunActivities)
      .set({
        status: event.outcome === 'completed' ? 'completed' : 'failed',
        updatedAt: now,
      })
      .where(and(eq(agentRunActivities.runId, runId), eq(agentRunActivities.status, 'running')))
      .run()
    const assistantMessage = transaction
      .select({
        id: conversationMessages.id,
        state: conversationMessages.state,
        visible: conversationMessages.isVisible,
        sequence: conversationMessages.sequence,
        replyTo: conversationMessages.replyToMessageId,
        hasBody: sql<number>`length(trim(${conversationMessages.content}, char(9) || char(10) || char(13) || ' ')) > 0`,
      })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')))
      .orderBy(desc(conversationMessages.sequence))
      .limit(1)
      .get()
    if (
      assistantMessage &&
      (!archive || !assistantMessage.visible || repo.ownsNativeControl(runId))
    ) {
      if (
        event.outcome === 'completed' &&
        assistantMessage.state !== 'incomplete' &&
        assistantMessage.replyTo &&
        assistantMessage.hasBody
      ) {
        const previous = transaction
          .select({
            id: conversationMessages.id,
            runId: conversationMessages.runId,
            state: conversationMessages.state,
          })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.replyToMessageId, assistantMessage.replyTo),
              eq(conversationMessages.role, 'assistant'),
              eq(conversationMessages.agentId, event.agentId),
              eq(conversationMessages.isVisible, true),
              ne(conversationMessages.id, assistantMessage.id),
            ),
          )
          .get()
        const replacesArchivedSource =
          archive &&
          previous?.runId === runId &&
          previous.state === 'incomplete' &&
          repo.ownsNativeControl(runId)
        if (previous && (!archive || replacesArchivedSource)) {
          preserveMessagesBeforeCutoffMutation(transaction, [previous.id])
          transaction
            .update(conversationMessages)
            .set({ isVisible: false })
            .where(eq(conversationMessages.id, previous.id))
            .run()
          if (outputSnapshotMetadata(repo.database, previous.id)?.frozen)
            snapshotMessageId = previous.id
          else removedMessageIds.push(previous.id)
        }
        if (!archive || replacesArchivedSource) {
          preserveMessagesBeforeCutoffMutation(transaction, [assistantMessage.id])
          transaction
            .update(conversationMessages)
            .set({ isVisible: true })
            .where(eq(conversationMessages.id, assistantMessage.id))
            .run()
          if (!assistantMessage.visible) {
            const cut = transaction
              .select()
              .from(conversationOutputSnapshots)
              .where(eq(conversationOutputSnapshots.runId, runId))
              .orderBy(desc(conversationOutputSnapshots.ordinal))
              .limit(1)
              .get()
            if (cut)
              transaction
                .update(conversationOutputSnapshots)
                .set({
                  sourceMessageId: assistantMessage.id,
                  sourceSequence: assistantMessage.sequence,
                  hasBody: sql`(SELECT ${outputHasBodySql(conversationMessages.content)} FROM conversation_messages WHERE id=${assistantMessage.id})`,
                })
                .where(
                  and(
                    eq(conversationOutputSnapshots.runId, runId),
                    eq(conversationOutputSnapshots.ordinal, cut.ordinal),
                  ),
                )
                .run()
          }
        }
      }
      preserveMessagesBeforeCutoffMutation(transaction, [assistantMessage.id])
      transaction
        .update(conversationMessages)
        .set({
          state:
            event.outcome === 'completed' && assistantMessage.state !== 'incomplete'
              ? 'complete'
              : 'incomplete',
          updatedAt: now,
        })
        .where(eq(conversationMessages.id, assistantMessage.id))
        .run()
      messageChange = {
        id: assistantMessage.id,
        mode: assistantMessage.visible ? 'metadata' : 'replace',
      }
    }
    if (!archive) repo.finishCollaboration(runId, event.outcome === 'completed')
    if (event.outcome === 'completed' && !assistantMessage?.hasBody)
      transaction
        .update(agentRuns)
        .set({ peerProposalState: 'superseded', updatedAt: now })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.peerProposalState, 'pending')))
        .run()
    activityStates.push({
      runId,
      status: event.outcome === 'completed' ? 'completed' : 'failed',
    })
    if (!archive)
      transaction
        .update(sessions)
        .set({
          status:
            event.outcome === 'completed'
              ? currentSessionStatus === 'waiting_for_user'
                ? 'waiting_for_user'
                : 'idle'
              : 'paused',
          updatedAt: now,
        })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.archivedAt)))
        .run()
  }
  if (sealedBody && event.type === 'text.completed' && messageChange) {
    transaction
      .update(conversationBodyInputs)
      .set({ committedMessageId: messageChange.id })
      .where(eq(conversationBodyInputs.id, sealedBody.inputId))
      .run()

    const version = transaction
      .select({ revision: conversationMessages.contentRevision })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, messageChange.id))
      .get()!
    appendAgentEvent(transaction, {
      sessionId,
      runId,
      eventType: 'text.body.sealed',
      createdAt: now,
      payload: JSON.stringify({
        agentId: event.agentId,
        turnId: event.turnId,
        outputId: event.outputId,
        source: { ...sealedBody, messageId: messageChange.id, revision: version.revision },
      }),
    })
  }
  return {
    message: messageChange,
    snapshotMessageId,
    activity: activityChange,
    activityStates,
    removedMessageIds,
  }
}

export function failRun(
  repo: ConversationRepositoryHost,
  runId: string,
  failureKind: RunFailureKind,
  failureMessage: string,
  interrupted = false,
): ConversationPatch {
  const run = repo.findRun(runId)
  if (!run) throw new Error('Agent Run does not exist.')
  const latest = repo.database
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.sessionId, run.sessionId))
    .orderBy(desc(agentRuns.createdAt), desc(sql`rowid`))
    .limit(1)
    .get()
  if (latest?.id !== runId || run.status === 'completed')
    throw new RunOperationConflictError('This Run no longer owns failure settlement.')
  const updatedAt = new Date().toISOString()
  repo.nativeMetadataTransaction(run.sessionId, (transaction) => {
    const partialMessage = transaction
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')))
      .orderBy(desc(conversationMessages.sequence))
      .limit(1)
      .get()
    appendAgentEvent(transaction, {
      sessionId: run.sessionId,
      runId,
      eventType: interrupted ? 'run.interrupted' : 'run.failed',
      payload: JSON.stringify({
        failureKind,
        partialOutputPreserved: Boolean(partialMessage?.content),
        partialOutputLength: partialMessage?.content.length ?? 0,
      }),
      createdAt: updatedAt,
    })
    transaction
      .update(agentRuns)
      .set({
        status: interrupted ? 'interrupted' : 'failed',
        failureKind,
        failureMessage,
        updatedAt,
      })
      .where(eq(agentRuns.id, runId))
      .run()
    transaction
      .update(agentRuns)
      .set({ peerProposalState: 'superseded', updatedAt })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.peerProposalState, 'pending')))
      .run()
    transaction
      .update(conversationMessages)
      .set({ routePendingAgentId: null, updatedAt })
      .where(eq(conversationMessages.id, run.userMessageId))
      .run()
    const failedAssistantMessages = transaction
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')))
      .all()
    preserveMessagesBeforeCutoffMutation(
      transaction,
      failedAssistantMessages.map((item) => item.id),
    )
    transaction
      .update(conversationMessages)
      .set({ state: 'incomplete', updatedAt })
      .where(and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')))
      .run()
    transaction
      .update(agentRunActivities)
      .set({ status: 'failed', updatedAt })
      .where(and(eq(agentRunActivities.runId, runId), eq(agentRunActivities.status, 'running')))
      .run()
    transaction
      .update(nativeAgentContexts)
      .set({ state: 'interrupted', updatedAt })
      .where(
        and(
          eq(nativeAgentContexts.sessionId, run.sessionId),
          eq(nativeAgentContexts.agentId, run.agentId),
          eq(nativeAgentContexts.lastRunId, runId),
        ),
      )
      .run()
    transaction
      .update(sessions)
      .set({ status: 'paused', updatedAt })
      .where(and(eq(sessions.id, run.sessionId), isNull(sessions.archivedAt)))
      .run()
    if (!interrupted) repo.recordSchedulingRecoveryOrigin({ kind: 'run', id: runId })
  })
  const updated = repo.findRun(runId)
  if (!updated) throw new Error('Agent Run does not exist.')
  const assistantMessage = repo.database
    .select({ id: conversationMessages.id, visible: conversationMessages.isVisible })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.runId, runId), eq(conversationMessages.role, 'assistant')))
    .orderBy(desc(conversationMessages.sequence))
    .limit(1)
    .get()
  const messages = [repo.messageChange(run.userMessageId, 'metadata')]
  if (assistantMessage?.visible) messages.push(repo.messageChange(assistantMessage.id, 'metadata'))
  return repo.createPatch(run.sessionId, {
    runs: [updated],
    messages,
    activityStates: [{ runId, status: 'failed' }],
  })
}

export function recoverInterruptedRuns(repo: ConversationRepositoryHost): string[] {
  const recovered = new Set<string>()
  // The paused partial index bounds each legacy scan independently of retained Batch history.
  let afterSession: string | undefined
  for (;;) {
    const paused = repo.database
      .select({ id: conversationInputBatches.id, sessionId: conversationInputBatches.sessionId })
      .from(conversationInputBatches)
      .where(
        and(
          sql`${conversationInputBatches.dispatchState} = 'paused'`,
          ...(afterSession ? [gt(conversationInputBatches.sessionId, afterSession)] : []),
        ),
      )
      .orderBy(asc(conversationInputBatches.sessionId))
      .limit(25)
      .all()
    if (!paused.length) break
    repo.database.transaction(() => {
      for (const receipt of paused) {
        const batch = repo.database
          .select()
          .from(conversationInputBatches)
          .where(eq(conversationInputBatches.id, receipt.id))
          .get()!
        if (!repo.isCancelledPreparedInformation(batch)) continue
        repo.closeCancelledPreparedInformation(batch)
        recovered.add(batch.sessionId)
      }
    })
    afterSession = paused.at(-1)!.sessionId
  }
  for (;;) {
    const prepared = repo.database
      .select({
        batchId: conversationInputBatches.id,
        sessionId: conversationInputBatches.sessionId,
      })
      .from(conversationInputBatches)
      .where(eq(conversationInputBatches.dispatchState, 'prepared'))
      .limit(25)
      .all()
    if (!prepared.length) break
    for (const receipt of prepared) {
      repo.cancelPreparedInputDispatch(receipt, 'restarted')
      recovered.add(receipt.sessionId)
    }
  }
  while (true) {
    const page = repo.database.all<{ sessionId: string }>(sql`WITH pending(session_id) AS (
        SELECT session_id FROM agent_runs WHERE status IN ('starting', 'running', 'recovering') AND control_disposition <> 'abandoned' AND fork_source_run_id IS NULL
        UNION SELECT session_id FROM agent_runs WHERE native_effects_state IN ('pending', 'unknown') AND native_effects_state='pending' AND fork_source_run_id IS NULL
        UNION SELECT session_id FROM native_agent_contexts WHERE continuation_state IN ('responding','waiting_user','checking','rebuilding')
        UNION SELECT session_id FROM native_rebuild_operations WHERE native_work_state IN ('pending','unknown') AND native_work_state='pending'
        UNION SELECT session_id FROM native_rebuild_operations WHERE stage IN ('preparing','creating','seeding','unconfirmed') AND stage IN ('preparing','creating','seeding')
      ) SELECT session_id AS sessionId FROM pending ORDER BY session_id LIMIT 25`)
    if (!page.length) break
    const sessionIds = page.map((row) => row.sessionId)
    repo.database.transaction(() => {
      repo.database
        .update(nativeRebuildOperations)
        .set({ nativeWorkState: 'unknown' })
        .where(
          and(
            inArray(nativeRebuildOperations.sessionId, sessionIds),
            eq(nativeRebuildOperations.nativeWorkState, 'pending'),
          ),
        )
        .run()
      repo.database
        .update(agentRuns)
        .set({ nativeEffectsState: 'unknown', nativeEffectsReason: 'pact_restarted' })
        .where(
          and(
            inArray(agentRuns.sessionId, sessionIds),
            eq(agentRuns.nativeEffectsState, 'pending'),
            isNull(agentRuns.forkSourceRunId),
          ),
        )
        .run()
      repo.database
        .update(nativeRebuildOperations)
        .set({
          stage: 'unconfirmed',
          failureReason: 'Pact restarted before the Native rebuild was confirmed.',
        })
        .where(
          and(
            inArray(nativeRebuildOperations.sessionId, sessionIds),
            inArray(nativeRebuildOperations.stage, ['creating', 'seeding']),
          ),
        )
        .run()
      repo.database
        .update(nativeRebuildOperations)
        .set({
          stage: 'failed',
          failureReason: 'Pact restarted before Native creation was dispatched.',
        })
        .where(
          and(
            inArray(nativeRebuildOperations.sessionId, sessionIds),
            eq(nativeRebuildOperations.stage, 'preparing'),
          ),
        )
        .run()
      scheduling.refreshNativeRebuildActivityForRecovery(repo.database, sessionIds)
      repo.database
        .update(nativeAgentContexts)
        .set({
          continuationState: 'recovery_required',
          recoveryReason: 'Pact restarted before the native state was confirmed.',
        })
        .where(
          and(
            inArray(nativeAgentContexts.sessionId, sessionIds),
            inArray(nativeAgentContexts.continuationState, [
              'responding',
              'waiting_user',
              'checking',
              'rebuilding',
            ]),
          ),
        )
        .run()
      const active = repo.database
        .select({
          id: agentRuns.id,
          nativeOutcome: agentRuns.nativeOutcome,
          dispatchPhase: agentRuns.dispatchPhase,
          sessionId: agentRuns.sessionId,
        })
        .from(agentRuns)
        .where(
          and(
            inArray(agentRuns.sessionId, sessionIds),
            inArray(agentRuns.status, [...activeRunStatuses]),
            ne(agentRuns.controlDisposition, 'abandoned'),
            isNull(agentRuns.forkSourceRunId),
          ),
        )
        .limit(25)
        .all()
      for (const run of active) {
        recovered.add(run.sessionId)
        if (run.nativeOutcome || run.dispatchPhase === 'ended') {
          repo.database
            .update(agentRuns)
            .set({ dispatchPhase: 'ended' })
            .where(eq(agentRuns.id, run.id))
            .run()
          repo.settleKnownNativeEnding(run.id)
        } else
          repo.observationUnavailable(
            run.id,
            'Pact lost observation before the native Turn was confirmed.',
          )
      }
      for (const sessionId of sessionIds) refreshNativeSessionMetadata(repo.database, sessionId)
    })
  }
  repo.database
    .update(conversationMessages)
    .set({ routePendingAgentId: null })
    .where(
      and(
        isNotNull(conversationMessages.routePendingAgentId),
        or(
          sql`NOT EXISTS (SELECT 1 FROM agent_runs AS first WHERE first.id=${conversationMessages.runId} AND first.status='completed' AND first.control_disposition<>'abandoned')`,
          sql`EXISTS (SELECT 1 FROM agent_runs AS second WHERE second.user_message_id=${conversationMessages.id} AND second.agent_id=${conversationMessages.routePendingAgentId})`,
        ),
      ),
    )
    .run()
  return [...recovered]
}

export function interruptRun(
  repo: ConversationRepositoryHost,
  runId: string,
  deliveryPossible?: boolean,
): void {
  const run = repo.findRun(runId)
  if (!run || !activeRunStatuses.some((status) => status === run.status)) return
  const reconcilingDelivery =
    run.failureKind === 'unknown_delivery' || (deliveryPossible ?? Boolean(run.nativeSessionId))
  failRun(
    repo,
    run.id,
    reconcilingDelivery ? 'unknown_delivery' : 'agent_process_crash',
    reconcilingDelivery
      ? 'Pact stopped while reconciling Agent delivery. Recovery can continue safely.'
      : 'Pact stopped before this Run completed.',
    true,
  )
  repo.database
    .update(nativeAgentContexts)
    .set({ state: 'interrupted', updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(nativeAgentContexts.sessionId, run.sessionId),
        eq(nativeAgentContexts.agentId, run.agentId),
      ),
    )
    .run()
}

export function recordSystemMessage(
  repo: ConversationRepositoryHost,
  sessionId: string,
  runId: string,
  content: string,
): ConversationPatch {
  const now = new Date().toISOString()
  const messageId = randomUUID()
  repo.database.transaction((transaction) => {
    const messageSequence = allocateSessionMessageSequence(transaction, sessionId)

    transaction
      .insert(conversationMessages)
      .values({
        id: messageId,
        sessionId,
        runId,
        role: 'system',
        content,
        state: 'complete',
        sequence: messageSequence,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    appendAgentEvent(transaction, {
      sessionId,
      runId,
      eventType: 'context_rebuilt',
      payload: JSON.stringify({ content }),
      createdAt: now,
    })
    transaction.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, sessionId)).run()
  })
  return repo.createPatch(sessionId, {
    messages: [repo.messageChange(messageId, 'replace', content)],
  })
}
