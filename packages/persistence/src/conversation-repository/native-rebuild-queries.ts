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
  lte,
  max,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'

import type { ConversationImage } from '@pact/contracts/images'

import {
  agentDisplayName,
  frozenSkillInvocationSchema,
  isAgentInPair,
  NATIVE_PERMISSION_REQUESTS,
  nativeContextRebuildChunkSchema,
  nativeEvidenceIdentitySchema,
  nativeInitializationWitnessSchema,
  nativePermissionRequestSchema,
  nativeProbeResultSchema,
  rebuildReturnedInputRecordSchema,
  type AgentRun,
  type ConversationMessageRoute,
  type ConversationPage,
  type ConversationPatch,
  type NativeAgentContext,
  type NativeContextRebuildChunk,
  type NativeContinuationState,
  type NativeInitializationWitness,
  type NativeProbeResult,
  type NativeRebuildOperation,
  type RebuildInputRecovery,
  type RebuildReturnedInputRecord,
  type RunFailureKind,
  type RuntimeAgentId,
} from '@pact/contracts'

import type { PactDrizzleDatabase } from '../drizzle-database.js'
import type { ConversationRepositoryHost } from './context.js'

import { appendAgentEvent } from '../agent-event-journal.js'
import * as forkFacts from '../conversation-fork.js'
import { outputSnapshotMetadata } from '../conversation-output-snapshots.js'
import * as scheduling from '../conversation-scheduling.js'
import {
  nativeSessionIssueMetadata,
  refreshNativeSessionMetadata,
} from '../native-presence-metadata.js'
import {
  agentRuns,
  anchoredComments,
  collaborationActionReceipts,
  conversationBodyInputs,
  conversationInputBatches,
  conversationInputBatchMembers,
  conversationMessages,
  conversationRebuildSourceRefs,
  nativeAgentContexts,
  nativeForkIntents,
  nativeRebuildOperations,
  runExecutionInputs,
  sessionForkOperations,
  sessions,
  sessionSettingsRevisions,
  workflowTurns,
} from '../schema/index.js'
import { isRetiredAgentRecoverySettled } from '../session-issues.js'
import { SessionRepository } from '../session-repository.js'
import {
  allocateSessionMessageSequence,
  preserveMessagesBeforeCutoffMutation,
} from '../side-chat-persistence.js'
import { assertSessionAvailable } from '../workspace-archive-repository.js'
import { toMessageRoute } from './helpers.js'
import {
  BODY_INTERNAL_READ_BYTES,
  COLLABORATION_INDEX_ITEMS,
  HANDOFF_SAFETY_BYTES,
  HandoffSourceUnavailableError,
  HandoffTooLargeError,
  NATIVE_REBUILD_CHUNK_CHARS,
  NATIVE_REBUILD_PAGE_ITEMS,
  publicRunColumns,
  RunOperationConflictError,
} from './types.js'

export function nativeIssueMetadata(
  repo: ConversationRepositoryHost,
  sessionId: string,
): import('@pact/contracts').SessionIssues {
  return nativeSessionIssueMetadata(repo.database, sessionId).issues
}

export function nativeRunStatus(
  repo: ConversationRepositoryHost,
  runId: string,
): AgentRun['status'] | undefined {
  return repo.database
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .get()?.status
}

export function refreshNativeAttention(repo: ConversationRepositoryHost, sessionId: string): void {
  refreshNativeSessionMetadata(repo.database, sessionId)
}

export function nativeMetadataTransaction<T>(
  repo: ConversationRepositoryHost,
  sessionId: string,
  work: (transaction: PactDrizzleDatabase) => T,
): T {
  const result = repo.database.transaction((transaction) => {
    const value = work(transaction)
    refreshNativeSessionMetadata(transaction, sessionId)
    repo.refreshSchedulingRecoveryFacts(sessionId)
    return value
  })
  repo.schedulingChanged()
  return result
}

export function initializeNativeAttention(
  repo: ConversationRepositoryHost,
  sessionIds: string[],
): void {
  if (sessionIds.length > 25)
    throw new Error('Native metadata initialization page exceeds its bound.')
  repo.database.transaction(() => {
    for (const sessionId of sessionIds) refreshNativeAttention(repo, sessionId)
  })
}

export function nativeQuitUnsettled(
  repo: ConversationRepositoryHost,
  excludedIds: string[],
): { count: number; sessionIds: string[] } {
  if (excludedIds.length > 64) throw new Error('Native quit owner metadata exceeds its bound.')
  const excluded = excludedIds.length
    ? sql`WHERE session_id NOT IN (${sql.join(
        excludedIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``
  const work = sql`WITH work(session_id) AS (
      SELECT session_id FROM agent_runs WHERE fork_source_run_id IS NULL AND ((status IN ('starting', 'running', 'recovering') AND control_disposition <> 'abandoned') OR native_effects_state IN ('pending', 'unknown') OR (dispatch_phase IN ('possibly_sent', 'accepted', 'ended') AND native_outcome IS NULL))
      UNION SELECT session_id FROM native_agent_contexts WHERE continuation_state IN ('responding', 'waiting_user')
      UNION SELECT session_id FROM native_rebuild_operations WHERE native_work_state IN ('pending', 'unknown')
      UNION SELECT coalesce(f.session_id, f.source_session_id) FROM native_fork_intents i JOIN session_fork_operations f ON f.id=i.operation_id WHERE i.native_work_state IN ('pending', 'unknown')
    )`
  const count =
    repo.database.get<{ count: number }>(
      sql`${work} SELECT count(*) AS count FROM work ${excluded}`,
    )?.count ?? 0
  const rows = repo.database.all<{ sessionId: string }>(
    sql`${work} SELECT session_id AS sessionId FROM work ${excluded} ORDER BY session_id LIMIT 5`,
  )
  return { count, sessionIds: rows.map((row) => row.sessionId) }
}

export function recordNativeEffects(
  repo: ConversationRepositoryHost,
  runId: string,
  state: 'not_dispatched' | 'pending' | 'settled' | 'unknown',
  reason?: string,
): ConversationPatch {
  const run = repo.findRun(runId)
  if (!run) throw new RunOperationConflictError('The native observation owner is unavailable.')
  const updatedAt = new Date().toISOString()
  nativeMetadataTransaction(repo, run.sessionId, (transaction) => {
    transaction
      .update(agentRuns)
      .set({ nativeEffectsState: state, nativeEffectsReason: reason?.slice(0, 128) ?? null })
      .where(eq(agentRuns.id, runId))
      .run()
    const observed = repo.findRun(runId)!
    if (
      observed.dispatchPhase === 'ended' ||
      ['completed', 'failed', 'interrupted'].includes(observed.status)
    )
      repo.settleCollaborationAction(observed)

    appendAgentEvent(transaction, {
      sessionId: run.sessionId,
      runId,
      eventType: 'run.native_effects_observed',
      payload: JSON.stringify({ state, ...(reason ? { reason: reason.slice(0, 128) } : {}) }),
      createdAt: updatedAt,
    })
    repo.recordSchedulingBusinessActivity(runId, hasCompleteResponse(repo, runId))
  })
  return repo.createPatch(run.sessionId, { runs: [repo.findRun(runId)!] })
}

export function ownsNativeControl(repo: ConversationRepositoryHost, runId: string): boolean {
  const run = repo.findRun(runId)
  if (!run || run.forkSourceRunId || run.controlDisposition === 'abandoned') return false
  const context = nativeContext(repo, run.sessionId, run.agentId)
  return (
    (!context || context.bindingGeneration === run.bindingGeneration) &&
    latestAgentRun(repo, run.sessionId, run.agentId)?.id === run.id &&
    !pendingNativeRebuild(repo, run.sessionId, run.agentId)
  )
}

/** Current durable work may need recovery even when no executor can be controlled. */
export function isCurrentBackgroundCursor(
  repo: ConversationRepositoryHost,
  runId: string,
): boolean {
  const run = repo.findRun(runId)
  if (!run || run.forkSourceRunId || !run.nativeSessionId) return false
  const context = nativeContext(repo, run.sessionId, run.agentId)
  return Boolean(context && isCurrentNativeCursor(repo, run, context))
}

/** Exact background control; later definitely-unsent attempts own no native work. */
export function ownsBackgroundControl(repo: ConversationRepositoryHost, runId: string): boolean {
  const run = repo.findRun(runId)
  if (!run || run.forkSourceRunId || !run.nativeSessionId || !run.executorId) return false
  const context = nativeContext(repo, run.sessionId, run.agentId)
  return Boolean(
    context && context.executorId === run.executorId && isCurrentNativeCursor(repo, run, context),
  )
}

export function mayProjectNativeBody(repo: ConversationRepositoryHost, run: AgentRun): boolean {
  const context = nativeContext(repo, run.sessionId, run.agentId)
  return (
    ownsNativeControl(repo, run.id) ||
    (context !== undefined && isCurrentNativeCursor(repo, run, context))
  )
}

export function nativeFact(
  repo: ConversationRepositoryHost,
  runId: string,
  eventType: string,
  payload: object,
): void {
  const run = repo.findRun(runId)
  if (!run) throw new RunOperationConflictError('The native fact has no Run.')

  appendAgentEvent(repo.database, {
    sessionId: run.sessionId,
    runId,
    eventType,
    payload: JSON.stringify(payload),
    createdAt: new Date().toISOString(),
  })
}

export function setContinuation(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
  state: NativeContinuationState,
  reason?: string,
  generation?: number,
  failure?: { kind: RunFailureKind; message: string; action?: 'retry' | 'rebuild' | 'none' },
): ConversationPatch {
  let retired: string | undefined
  nativeMetadataTransaction(repo, sessionId, () => {
    const current = nativeContext(repo, sessionId, agentId)
    if (generation !== undefined && current && current.bindingGeneration !== generation) return
    if (state === 'recovery_required')
      retired = repo.retirePendingRoute(sessionId, 'native_recovery_required')
    repo.database
      .update(nativeAgentContexts)
      .set({
        continuationState: state,
        recoveryReason: reason?.slice(0, 240) ?? null,
        ...(failure
          ? {
              recoveryFailureKind: failure.kind,
              recoveryFailureMessage: failure.message,
              recoveryAction: failure.action ?? 'retry',
            }
          : {}),
      })
      .where(
        and(
          eq(nativeAgentContexts.sessionId, sessionId),
          eq(nativeAgentContexts.agentId, agentId),
          ...(generation === undefined
            ? []
            : [eq(nativeAgentContexts.bindingGeneration, generation)]),
        ),
      )
      .run()
  })
  return repo.createPatch(sessionId, {
    messages: retired ? [repo.messageChange(retired, 'metadata')] : [],
  })
}

export function runSettingsAt(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
  revision: number,
): {
  permissionMode: (typeof sessionSettingsRevisions.$inferSelect)['claudePermissionMode']
  speed: (typeof sessionSettingsRevisions.$inferSelect)['claudeSpeed']
} {
  const settings = repo.database
    .select()
    .from(sessionSettingsRevisions)
    .where(
      and(
        eq(sessionSettingsRevisions.sessionId, sessionId),
        eq(sessionSettingsRevisions.revision, revision),
      ),
    )
    .get()
  if (!settings)
    throw new RunOperationConflictError('The task permission settings are unavailable.')
  return agentId === 'claude'
    ? { permissionMode: settings.claudePermissionMode, speed: settings.claudeSpeed }
    : agentId === 'codex'
      ? { permissionMode: settings.codexPermissionMode, speed: settings.codexSpeed }
      : { permissionMode: settings.agyPermissionMode, speed: settings.agySpeed }
}

export function recordExecutor(
  repo: ConversationRepositoryHost,
  runId: string,
  executorId: string,
): ConversationPatch {
  const run = repo.findRun(runId)
  if (
    !run ||
    !ownsNativeControl(repo, runId) ||
    !['not_sent', 'rejected'].includes(run.dispatchPhase ?? 'not_sent')
  )
    throw new RunOperationConflictError('The initializing executor no longer owns this Run.')
  repo.database.update(agentRuns).set({ executorId }).where(eq(agentRuns.id, runId)).run()
  return repo.runPatch(runId)
}

export function recordDispatch(
  repo: ConversationRepositoryHost,
  runId: string,
  phase: 'possibly_sent' | 'accepted' | 'rejected',
  nativeSessionId?: string,
  executorId?: string,
): ConversationPatch {
  const run = repo.findRun(runId)
  if (!run) throw new RunOperationConflictError('Dispatch owner is unavailable.')
  if (run.dispatchPhase === 'ended') return repo.runPatch(runId)
  nativeMetadataTransaction(repo, run.sessionId, () => {
    repo.database
      .update(agentRuns)
      .set({
        dispatchPhase: phase,
        ...(nativeSessionId ? { nativeSessionId } : {}),
        ...(executorId ? { executorId } : {}),
      })
      .where(eq(agentRuns.id, runId))
      .run()
    nativeFact(repo, runId, 'native.dispatch_observed', { phase, nativeSessionId, executorId })
    repo.recordSchedulingBusinessActivity(runId, hasCompleteResponse(repo, runId))
    if (phase === 'possibly_sent' || phase === 'accepted') {
      // A later delivery attempt supersedes the exact earlier negative receipt.
      repo.database
        .update(runExecutionInputs)
        .set({ proofJson: null })
        .where(eq(runExecutionInputs.runId, runId))
        .run()
      const receipt = repo.database
        .select({ reservationId: collaborationActionReceipts.budgetReservationId })
        .from(collaborationActionReceipts)
        .where(eq(collaborationActionReceipts.boundRunId, runId))
        .get()
      if (receipt?.reservationId)
        scheduling.settleBudget(repo.database, receipt.reservationId, 'possibly_sent')
    }
  })
  return repo.runPatch(runId)
}

export function recordNativeEvidence(
  repo: ConversationRepositoryHost,
  result: NativeProbeResult,
  unavailableAction: 'retry' | 'rebuild' = 'rebuild',
): ConversationPatch {
  const evidence = nativeProbeResultSchema.parse(result)
  if (evidence.kind === 'binding_ready') {
    nativeMetadataTransaction(repo, evidence.identity.sessionId, () => {
      const receipt = confirmedNativeInitialization(
        repo,
        evidence.identity.sessionId,
        evidence.identity.agentId,
      )
      if (
        !receipt ||
        evidence.identity.runId ||
        evidence.identity.nativeTurnId ||
        evidence.identity.executorId ||
        evidence.identity.requestId !== evidence.rebuildId ||
        receipt.rebuildId !== evidence.rebuildId ||
        receipt.sourceHash !== evidence.sourceHash ||
        receipt.nativeSessionId !== evidence.identity.nativeSessionId ||
        receipt.bindingGeneration !== evidence.identity.bindingGeneration ||
        JSON.stringify(receipt.witness) !== JSON.stringify(evidence.witness)
      )
        throw new RunOperationConflictError(
          'The checked initialization no longer owns this binding.',
        )
      repo.database
        .update(nativeAgentContexts)
        .set({
          continuationState: 'ready',
          state: 'active',
          recoveryReason: null,
          recoveryAction: null,
          recoveryFailureKind: null,
          recoveryFailureMessage: null,
        })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, evidence.identity.sessionId),
            eq(nativeAgentContexts.agentId, evidence.identity.agentId),
            eq(nativeAgentContexts.bindingGeneration, receipt.bindingGeneration),
            eq(nativeAgentContexts.nativeSessionId, receipt.nativeSessionId),
          ),
        )
        .run()

      appendAgentEvent(repo.database, {
        sessionId: evidence.identity.sessionId,
        runId: evidence.rebuildId,
        eventType: 'native.initialization_checked',
        payload: JSON.stringify({
          rebuildId: receipt.rebuildId,
          bindingGeneration: receipt.bindingGeneration,
          source: evidence.source,
        }),
        createdAt: new Date().toISOString(),
      })
    })
    return repo.createPatch(evidence.identity.sessionId)
  }
  const id = evidence.identity
  const run = id.runId ? repo.findRun(id.runId) : undefined
  const context = nativeContext(repo, id.sessionId, id.agentId)
  if (id.runId && !run)
    throw new RunOperationConflictError('Native evidence has no recorded Run owner.')
  if (
    run &&
    (run.sessionId !== id.sessionId ||
      run.agentId !== id.agentId ||
      run.id !== id.requestId ||
      run.bindingGeneration !== id.bindingGeneration ||
      (run.nativeSessionId && run.nativeSessionId !== id.nativeSessionId) ||
      (run.nativeTurnId && id.nativeTurnId && run.nativeTurnId !== id.nativeTurnId) ||
      ('source' in evidence &&
        evidence.source.startsWith('live_') &&
        run.executorId &&
        run.executorId !== id.executorId))
  )
    throw new RunOperationConflictError('Native evidence identity does not match its Run.')
  let retired: string | undefined
  nativeMetadataTransaction(repo, id.sessionId, () => {
    const currentContext = nativeContext(repo, id.sessionId, id.agentId)
    const controls =
      currentContext?.bindingGeneration === id.bindingGeneration &&
      currentContext.nativeSessionId === id.nativeSessionId &&
      (!run || ownsNativeControl(repo, run.id) || isCurrentNativeCursor(repo, run, currentContext))
    if (run && !run.nativeTurnId && id.nativeTurnId)
      repo.database
        .update(agentRuns)
        .set({ nativeTurnId: id.nativeTurnId })
        .where(and(eq(agentRuns.id, run.id), sql`${agentRuns.nativeTurnId} IS NULL`))
        .run()
    if (run)
      nativeFact(repo, run.id, 'native.state_evidence', {
        kind: evidence.kind,
        identity: id,
        ...('source' in evidence ? { source: evidence.source } : {}),
        ...(evidence.kind === 'ended' ? { outcome: evidence.outcome } : {}),
        ...(evidence.kind === 'no_evidence' ? { reason: evidence.reason } : {}),
      })
    if (run && evidence.kind === 'ended')
      repo.database
        .update(agentRuns)
        .set({
          ...(evidence.outcome ? { nativeOutcome: evidence.outcome } : {}),
          dispatchPhase: 'ended',
        })
        .where(eq(agentRuns.id, run.id))
        .run()
    if (
      run &&
      ((evidence.kind === 'ended' && evidence.planUnavailable) ||
        ('output' in evidence && evidence.output?.planUnavailable))
    )
      repo.recordWorkflowPlanUnavailable(run.id)
    else if (run && 'output' in evidence && evidence.output?.plan)
      repo.recordWorkflowPlan(run.id, evidence.output.plan)
    else if (run && 'output' in evidence && evidence.output?.retainedPlan)
      repo.recordWorkflowPlanRetained(run.id, evidence.output.retainedPlan)
    if (run) repo.recordSchedulingBusinessActivity(run.id, hasCompleteResponse(repo, run.id))
    if (
      run &&
      'output' in evidence &&
      (evidence.output?.reviewResult || evidence.output?.reviewVerdict)
    )
      repo.recordWorkflowReview(
        run.id,
        evidence.output.reviewResult ?? { verdict: evidence.output.reviewVerdict! },
      )
    if (
      run &&
      'output' in evidence &&
      (evidence.output?.inputResult || evidence.output?.inputOutcome)
    )
      repo.recordWorkflowInputResult(
        run.id,
        evidence.output.inputResult ?? { outcome: evidence.output.inputOutcome! },
      )
    if (!controls) return
    const state: NativeContinuationState =
      evidence.kind === 'ended' &&
      currentContext?.recoveryFailureKind === 'native_session_occupied' &&
      evidence.source !== 'live_terminal'
        ? 'recovery_required'
        : evidence.kind === 'ended'
          ? 'ready'
          : evidence.kind === 'running'
            ? 'responding'
            : evidence.kind === 'waiting_user'
              ? 'waiting_user'
              : 'recovery_required'
    if (state === 'recovery_required')
      retired = repo.retirePendingRoute(id.sessionId, 'native_evidence_unavailable')
    repo.database
      .update(nativeAgentContexts)
      .set({
        continuationState: state,
        recoveryAction:
          state === 'recovery_required'
            ? evidence.kind === 'missing' ||
              currentContext?.recoveryFailureKind === 'native_session_occupied' ||
              currentContext?.recoveryAction === 'rebuild'
              ? 'rebuild'
              : unavailableAction
            : null,
        recoveryFailureKind:
          evidence.kind === 'missing'
            ? 'context_resume_failed'
            : state === 'recovery_required' &&
                currentContext?.recoveryFailureKind === 'native_session_occupied'
              ? 'native_session_occupied'
              : null,
        recoveryFailureMessage: null,
        executorId: id.executorId ?? context?.executorId ?? null,
        recoveryReason:
          state === 'recovery_required' && evidence.kind === 'ended'
            ? 'Saved history is readable, but it does not confirm that another client released the native writer.'
            : evidence.kind === 'missing'
              ? 'The native session could not be found.'
              : evidence.kind === 'no_evidence'
                ? evidence.reason
                : null,
        ...(evidence.kind === 'missing'
          ? { state: 'missing' as const }
          : state !== 'recovery_required'
            ? { state: 'active' as const }
            : {}),
      })
      .where(
        and(
          eq(nativeAgentContexts.sessionId, id.sessionId),
          eq(nativeAgentContexts.agentId, id.agentId),
          eq(nativeAgentContexts.bindingGeneration, id.bindingGeneration),
        ),
      )
      .run()
  })
  return repo.createPatch(id.sessionId, {
    ...(run ? { runs: [repo.findRun(run.id)!] } : {}),
    messages: retired ? [repo.messageChange(retired, 'metadata')] : [],
  })
}

export function observationUnavailable(
  repo: ConversationRepositoryHost,
  runId: string,
  reason: string,
): ConversationPatch {
  const run = repo.findRun(runId)
  if (!run) throw new RunOperationConflictError('The observed Run is unavailable.')
  let retired: string | undefined
  nativeMetadataTransaction(repo, run.sessionId, () => {
    if (ownsNativeControl(repo, runId))
      retired = repo.retirePendingRoute(run.sessionId, 'native_observation_unavailable')
    if (
      run.dispatchPhase !== 'ended' &&
      !run.nativeOutcome &&
      run.controlDisposition !== 'abandoned'
    ) {
      repo.database
        .update(agentRuns)
        .set({
          status: 'interrupted',
          failureKind: run.failureKind ?? 'transient_transport',
          failureMessage: run.failureMessage ?? reason.slice(0, 240),
        })
        .where(eq(agentRuns.id, runId))
        .run()
      const affected = repo.database
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.runId, runId),
            eq(conversationMessages.role, 'assistant'),
            ne(conversationMessages.state, 'complete'),
          ),
        )
        .all()
      preserveMessagesBeforeCutoffMutation(
        repo.database,
        affected.map((item) => item.id),
      )
      repo.database
        .update(conversationMessages)
        .set({ state: 'incomplete' })
        .where(
          and(
            eq(conversationMessages.runId, runId),
            eq(conversationMessages.role, 'assistant'),
            ne(conversationMessages.state, 'complete'),
          ),
        )
        .run()
    }
    if (ownsNativeControl(repo, runId))
      repo.database
        .update(nativeAgentContexts)
        .set({
          continuationState:
            run.nativeOutcome || ['ended', 'not_sent', 'rejected'].includes(run.dispatchPhase ?? '')
              ? 'ready'
              : 'recovery_required',
          recoveryReason:
            run.nativeOutcome || ['ended', 'not_sent', 'rejected'].includes(run.dispatchPhase ?? '')
              ? null
              : reason.slice(0, 240),
        })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, run.sessionId),
            eq(nativeAgentContexts.agentId, run.agentId),
            eq(nativeAgentContexts.bindingGeneration, run.bindingGeneration ?? 1),
          ),
        )
        .run()
    nativeFact(repo, runId, 'pact.observation_unavailable', { reason: reason.slice(0, 240) })
    repo.recordSchedulingRecoveryOrigin({ kind: 'run', id: runId })
  })
  return repo.createPatch(run.sessionId, {
    runs: [repo.findRun(runId)!],
    messages: retired ? [repo.messageChange(retired, 'metadata')] : [],
  })
}

/** Preserve the durable prefix without promoting it to a complete native answer. */
export function recordOutputFailure(
  repo: ConversationRepositoryHost,
  runId: string,
  failure: { kind: RunFailureKind; message: string },
): ConversationPatch {
  const run = repo.findRun(runId)
  if (!run) throw new RunOperationConflictError('The failed output has no Run owner.')
  return repo.database.transaction(() => {
    const current = repo.database
      .select({ id: conversationMessages.id, state: conversationMessages.state })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.runId, runId),
          eq(conversationMessages.role, 'assistant'),
          eq(conversationMessages.isVisible, true),
        ),
      )
      .orderBy(desc(conversationMessages.sequence))
      .limit(1)
      .get()
    const frozen = current && outputSnapshotMetadata(repo.database, current.id)?.frozen
    // A completed current answer is immutable; an earlier frozen snapshot is
    // not the response to a newer accepted input.
    const completedRun =
      run.status === 'completed' &&
      run.dispatchPhase === 'ended' &&
      run.nativeOutcome === 'completed'
    if (
      current?.state === 'complete' &&
      (completedRun || !frozen || !mayProjectNativeBody(repo, run))
    )
      return repo.runPatch(runId)
    repo.database
      .update(agentRuns)
      .set({ failureKind: failure.kind, failureMessage: failure.message.slice(0, 240) })
      .where(eq(agentRuns.id, runId))
      .run()
    nativeFact(repo, runId, 'pact.output_unavailable', {
      kind: failure.kind,
      reason: failure.message.slice(0, 240),
    })
    if ((!current || frozen) && run.nativeTurnId)
      return repo.commitEvents(
        run.sessionId,
        runId,
        [
          {
            agentId: run.agentId,
            type: 'text.completed',
            turnId: run.nativeTurnId,
            outputId: `${run.id}:assistant`,
            text: '',
          },
        ],
        true,
        'incomplete',
      )
    if (current && current.state !== 'complete') {
      preserveMessagesBeforeCutoffMutation(repo.database, [current.id])
      repo.database
        .update(conversationMessages)
        .set({ state: 'incomplete' })
        .where(eq(conversationMessages.id, current.id))
        .run()
    }
    return repo.createPatch(run.sessionId, {
      runs: [repo.findRun(runId)!],
      messages: current ? [repo.messageChange(current.id, 'metadata')] : [],
    })
  })
}

/** Binding projection only: a refused local attempt cannot erase the actual native cursor. */
export function isCurrentNativeCursor(
  repo: ConversationRepositoryHost,
  run: AgentRun,
  context: NativeAgentContext,
): boolean {
  return (
    !pendingNativeRebuild(repo, run.sessionId, run.agentId) &&
    matchesDurableNativeCursor(repo, run, context)
  )
}

/** Durable identity only. A pending candidate fences live control, not its recovery source. */
function matchesDurableNativeCursor(
  repo: ConversationRepositoryHost,
  run: AgentRun,
  context: NativeAgentContext,
): boolean {
  if (
    run.controlDisposition === 'abandoned' ||
    context.lastRunId !== run.id ||
    context.sessionId !== run.sessionId ||
    context.agentId !== run.agentId ||
    context.nativeSessionId !== run.nativeSessionId ||
    context.bindingGeneration !== run.bindingGeneration
  )
    return false
  const blocker = repo.database
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.sessionId, run.sessionId),
        eq(agentRuns.agentId, run.agentId),
        eq(agentRuns.bindingGeneration, run.bindingGeneration ?? 1),
        sql`${agentRuns}.rowid > (SELECT rowid FROM agent_runs WHERE id=${run.id})`,
        sql`(${agentRuns.status} NOT IN ('failed','interrupted') OR ${agentRuns.dispatchPhase} NOT IN ('not_sent','rejected'))`,
      ),
    )
    .limit(1)
    .get()
  return blocker === undefined
}

/** The same recovery owner is used by UI scope, explicit Rebuild and Relay. */
export function nativeRecoveryRun(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
): AgentRun | undefined {
  const context = nativeContext(repo, sessionId, agentId)
  const cursor = context?.lastRunId ? repo.findRun(context.lastRunId) : undefined
  if (
    cursor &&
    context &&
    !cursor.forkSourceRunId &&
    cursor.nativeSessionId &&
    cursor.dispatchPhase === 'ended' &&
    ['pending', 'unknown'].includes(cursor.nativeEffectsState ?? '') &&
    matchesDurableNativeCursor(repo, cursor, context)
  )
    return cursor
  return (
    (!context ? unacknowledgedNativeRun(repo, sessionId, agentId) : undefined) ??
    latestAgentRun(repo, sessionId, agentId, context?.bindingGeneration)
  )
}

export function latestAgentRun(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
  generation?: number,
): AgentRun | undefined {
  const row =
    generation === undefined
      ? repo.sourceQueries.latestRun().get({ sessionId, agentId })
      : repo.sourceQueries.latestGenerationRun().get({ sessionId, agentId, generation })
  return row ? repo.toRun(row) : undefined
}

export function hasCompleteResponse(repo: ConversationRepositoryHost, runId: string): boolean {
  const message = repo.database
    .select({
      id: conversationMessages.id,
      hasBody: sql<boolean>`length(${conversationMessages.content}) > 0`,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.runId, runId),
        eq(conversationMessages.role, 'assistant'),
        eq(conversationMessages.isVisible, true),
        eq(conversationMessages.state, 'complete'),
      ),
    )
    .limit(1)
    .get()
  if (!message) return false
  if (message.hasBody) return true
  // A native Plan-only ending has a real empty canonical answer, plus its separate complete artifact.
  return Boolean(
    repo.database
      .select({ id: workflowTurns.runId })
      .from(workflowTurns)
      .innerJoin(agentRuns, eq(agentRuns.id, workflowTurns.runId))
      .innerJoin(conversationBodyInputs, eq(conversationBodyInputs.id, workflowTurns.planBodyId))
      .where(
        and(
          eq(workflowTurns.runId, runId),
          isNotNull(workflowTurns.planNativeId),
          eq(agentRuns.dispatchPhase, 'ended'),
          eq(agentRuns.nativeOutcome, 'completed'),
          eq(conversationBodyInputs.sealed, true),
          gt(conversationBodyInputs.chars, 0),
        ),
      )
      .limit(1)
      .get(),
  )
}

export function bindingHasUnsettledWork(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
  generation: number,
): boolean {
  return Boolean(
    repo.database.get<{ id: string }>(sql`
      SELECT id FROM ${agentRuns} INDEXED BY agent_runs_native_quit_unsettled_idx
      WHERE ${agentRuns.sessionId} = ${sessionId} AND ${agentRuns.forkSourceRunId} IS NULL
        AND ((${agentRuns.status} IN ('starting', 'running', 'recovering') AND ${agentRuns.controlDisposition} <> 'abandoned')
          OR ${agentRuns.nativeEffectsState} IN ('pending', 'unknown')
          OR (${agentRuns.dispatchPhase} IN ('possibly_sent', 'accepted', 'ended') AND ${agentRuns.nativeOutcome} IS NULL))
        AND ${agentRuns.agentId} = ${agentId} AND ${agentRuns.bindingGeneration} = ${generation}
        AND ${agentRuns.controlDisposition} <> 'abandoned'
        AND (${agentRuns.nativeEffectsState} IN ('pending', 'unknown')
          OR (${agentRuns.nativeOutcome} IS NULL AND ${agentRuns.dispatchPhase} IN ('possibly_sent', 'accepted')))
      LIMIT 1
    `),
  )
}

export function verifyRebuildReceipt(
  repo: ConversationRepositoryHost,
  id: string,
  sessionId: string,
  agentId: RuntimeAgentId,
  expectedRunId?: string | null,
): void {
  const row = repo.database
    .select({
      sessionId: nativeRebuildOperations.sessionId,
      agentId: nativeRebuildOperations.agentId,
      oldRunId: nativeRebuildOperations.oldRunId,
    })
    .from(nativeRebuildOperations)
    .where(eq(nativeRebuildOperations.id, id))
    .get()
  if (!row || row.sessionId !== sessionId || row.agentId !== agentId)
    throw new RunOperationConflictError('The rebuild receipt belongs to another binding.')
  if (expectedRunId !== undefined && row.oldRunId !== expectedRunId)
    throw new RunOperationConflictError('The rebuild receipt belongs to another recovery target.')
}

export function settleKnownNativeEnding(
  repo: ConversationRepositoryHost,
  runId: string,
  failure?: { kind: RunFailureKind; message: string },
): ConversationPatch {
  const run = repo.findRun(runId)
  if (!run || run.dispatchPhase !== 'ended')
    throw new RunOperationConflictError('The native ending has no evidence.')
  if (failure) recordOutputFailure(repo, runId, failure)
  const completeResponse = hasCompleteResponse(repo, runId)
  nativeMetadataTransaction(repo, run.sessionId, () => {
    repo.database
      .update(agentRuns)
      .set({
        status: run.nativeOutcome ?? 'interrupted',
        failureKind:
          run.nativeOutcome === 'completed' && completeResponse
            ? null
            : (failure?.kind ?? run.failureKind ?? null),
        failureMessage: run.nativeOutcome
          ? run.nativeOutcome === 'completed' && completeResponse
            ? null
            : (failure?.message ?? run.failureMessage ?? null)
          : 'The Turn ended, but its outcome was not recorded.',
      })
      .where(eq(agentRuns.id, runId))
      .run()
    if (ownsNativeControl(repo, runId))
      repo.database
        .update(nativeAgentContexts)
        .set({ continuationState: 'ready', recoveryReason: null })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, run.sessionId),
            eq(nativeAgentContexts.agentId, run.agentId),
            eq(nativeAgentContexts.bindingGeneration, run.bindingGeneration ?? 1),
          ),
        )
        .run()
    repo.recordSchedulingBusinessActivity(runId, completeResponse)
  })
  repo.finishCollaboration(
    runId,
    run.nativeOutcome === 'completed' && completeResponse,
    failure?.message,
  )
  return repo.runPatch(runId)
}

/** Indexed Project-wide facts, including old bindings whose native work is not settled. */
export function projectHasNativeWork(repo: ConversationRepositoryHost, projectId: string): boolean {
  if (
    repo.database
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(sessionForkOperations, eq(sessionForkOperations.sessionId, sessions.id))
      .innerJoin(nativeForkIntents, eq(nativeForkIntents.operationId, sessionForkOperations.id))
      .where(
        and(
          eq(sessions.projectId, projectId),
          inArray(nativeForkIntents.nativeWorkState, ['pending', 'unknown']),
        ),
      )
      .limit(1)
      .get()
  )
    return true
  const run = repo.database
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.projectId, projectId),
        sql`EXISTS (SELECT 1 FROM ${agentRuns} INDEXED BY agent_runs_session_unsettled_work_idx WHERE ${agentRuns.sessionId} = ${sessions.id} AND ${agentRuns.forkSourceRunId} IS NULL AND ((${agentRuns.status} IN ('starting', 'running', 'recovering') AND ${agentRuns.controlDisposition} <> 'abandoned') OR ${agentRuns.nativeEffectsState} IN ('pending', 'unknown')))`,
      ),
    )
    .limit(1)
    .get()
  if (run) return true
  return Boolean(
    repo.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.projectId, projectId),
          sql`EXISTS (SELECT 1 FROM ${nativeRebuildOperations} INDEXED BY native_rebuild_operations_unsettled_work_idx WHERE ${nativeRebuildOperations.sessionId} = ${sessions.id} AND ${nativeRebuildOperations.nativeWorkState} IN ('pending', 'unknown'))`,
        ),
      )
      .limit(1)
      .get(),
  )
}

export function recordNativeRebuildWork(
  repo: ConversationRepositoryHost,
  id: string,
  executorId: string,
  nativeSessionId: string | undefined,
  state: 'unknown' | 'settled',
): void {
  repo.database.transaction(() => {
    const row = repo.database
      .select()
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, id))
      .get()
    if (
      !row ||
      row.creationExecutorId !== executorId ||
      (row.provisionalNativeSessionId && row.provisionalNativeSessionId !== nativeSessionId)
    )
      throw new RunOperationConflictError(
        'The native work report belongs to another creation actor.',
      )
    if (
      row.nativeWorkState === 'settled' ||
      row.nativeWorkState === 'not_dispatched' ||
      row.nativeWorkState === state
    )
      return
    repo.database
      .update(nativeRebuildOperations)
      .set({ nativeWorkState: state })
      .where(eq(nativeRebuildOperations.id, id))
      .run()

    appendAgentEvent(repo.database, {
      sessionId: row.sessionId,
      runId: id,
      eventType: 'native.rebuild_work',
      payload: JSON.stringify({ operationId: id, executorId, state }),
      createdAt: new Date().toISOString(),
    })
    scheduling.recordNativeRebuildActivity(repo.database, id)
  })
  repo.schedulingChanged()
}

export function recordNativeRebuildCheck(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
  expected: NativeRebuildOperation,
  expectedNativeSessionId: string | undefined,
): ConversationPatch {
  repo.database.transaction(() => {
    const row = repo.database
      .select()
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, expected.id))
      .get()
    const context = nativeContext(repo, sessionId, agentId)
    if (
      !row ||
      row.sessionId !== sessionId ||
      row.agentId !== agentId ||
      row.stage !== 'unconfirmed' ||
      row.oldGeneration !== expected.oldGeneration ||
      row.provisionalNativeSessionId !== (expected.provisionalNativeSessionId ?? null) ||
      row.sourceHash !== (expected.sourceHash ?? null) ||
      (context?.bindingGeneration ?? 1) !== row.oldGeneration ||
      (context?.nativeSessionId ?? null) !== (expectedNativeSessionId ?? null) ||
      row.oldNativeSessionId !== (expectedNativeSessionId ?? null)
    )
      throw new RunOperationConflictError(
        'The candidate check no longer owns this recovery action.',
      )
    repo.database
      .update(nativeRebuildOperations)
      .set({ checkAction: 'rebuild' })
      .where(eq(nativeRebuildOperations.id, expected.id))
      .run()
    scheduling.recordNativeRebuildActivity(repo.database, expected.id)
  })
  repo.schedulingChanged()
  return repo.createPatch(sessionId)
}

export function nativeRebuildOperation(
  repo: ConversationRepositoryHost,
  id: string,
): NativeRebuildOperation | undefined {
  const row = repo.sourceQueries.rebuild().get({ operationId: id })
  return row
    ? {
        id: row.id,
        oldGeneration: row.oldGeneration,
        stage: row.stage,
        checkAction: row.checkAction,
        ...(row.provisionalNativeSessionId
          ? { provisionalNativeSessionId: row.provisionalNativeSessionId }
          : {}),
        ...(row.sourceHash ? { sourceHash: row.sourceHash } : {}),
        ...(row.failureReason ? { failureReason: row.failureReason.slice(0, 240) } : {}),
      }
    : undefined
}

export function pendingNativeRebuild(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
): NativeRebuildOperation | undefined {
  const row = repo.database
    .select({ id: nativeRebuildOperations.id })
    .from(nativeRebuildOperations)
    .where(
      and(
        eq(nativeRebuildOperations.sessionId, sessionId),
        eq(nativeRebuildOperations.agentId, agentId),
        inArray(nativeRebuildOperations.stage, ['preparing', 'creating', 'seeding', 'unconfirmed']),
      ),
    )
    .limit(1)
    .get()
  return row ? nativeRebuildOperation(repo, row.id) : undefined
}

export function lastNativeRebuild(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
): NativeRebuildOperation | undefined {
  const row = repo.sourceQueries.lastRebuild().get({ sessionId, agentId })
  return row ? nativeRebuildOperation(repo, row.id) : undefined
}

export function beginNativeRebuild(
  repo: ConversationRepositoryHost,
  input: {
    id: string
    sessionId: string
    agentId: RuntimeAgentId
    expectedGeneration: number
    expectedRunId?: string | null
    abandon: boolean
    reservedNativeSessionId?: string
  },
): ConversationPatch {
  const existing = nativeRebuildOperation(repo, input.id)
  if (existing) {
    verifyRebuildReceipt(repo, input.id, input.sessionId, input.agentId, input.expectedRunId)
    return repo.createPatch(input.sessionId)
  }
  nativeMetadataTransaction(repo, input.sessionId, () => {
    const context = nativeContext(repo, input.sessionId, input.agentId)
    if ((context?.bindingGeneration ?? 1) !== input.expectedGeneration)
      throw new RunOperationConflictError('The Native binding changed. Check it again.')
    const run = nativeRecoveryRun(repo, input.sessionId, input.agentId)
    if (input.expectedRunId !== undefined && (run?.id ?? null) !== input.expectedRunId)
      throw new RunOperationConflictError('The recovery target changed. Check it again.')
    if (
      bindingHasUnsettledWork(repo, input.sessionId, input.agentId, input.expectedGeneration) &&
      !input.abandon
    )
      throw new RunOperationConflictError(
        'The previous binding may still have native work. Review its effects and confirm rebuilding before continuing.',
      )
    if (
      run &&
      run.controlDisposition !== 'abandoned' &&
      run.bindingGeneration === input.expectedGeneration &&
      !run.nativeOutcome &&
      run.dispatchPhase !== 'ended' &&
      !['not_sent', 'rejected'].includes(run.dispatchPhase ?? '') &&
      !input.abandon
    )
      throw new RunOperationConflictError(
        'Confirm abandoning the unverified task before rebuilding.',
      )
    const returnable = latestAgentRun(
      repo,
      input.sessionId,
      input.agentId,
      input.expectedGeneration,
    )
    const pending = pendingNativeRebuild(repo, input.sessionId, input.agentId)
    assertSessionAvailable(repo.database, input.sessionId)
    if (pending && pending.stage !== 'unconfirmed')
      throw new RunOperationConflictError('This Native rebuild is still in progress.')
    if (pending)
      repo.database
        .update(nativeRebuildOperations)
        .set({ stage: 'superseded' })
        .where(eq(nativeRebuildOperations.id, pending.id))
        .run()
    if (pending) scheduling.recordNativeRebuildActivity(repo.database, pending.id)
    const now = new Date().toISOString()
    repo.database
      .insert(nativeRebuildOperations)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        agentId: input.agentId,
        oldGeneration: input.expectedGeneration,
        oldNativeSessionId: context?.nativeSessionId ?? null,
        oldRunId: run?.id ?? null,
        returnedInputJson:
          returnable && returnable.bindingGeneration === input.expectedGeneration
            ? freezeReturnedInput(repo, returnable)
            : null,
        abandon: input.abandon,
        provisionalNativeSessionId: input.reservedNativeSessionId ?? null,
        stage: 'preparing',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    repo.database
      .update(nativeAgentContexts)
      .set({ continuationState: 'rebuilding', recoveryReason: null })
      .where(
        and(
          eq(nativeAgentContexts.sessionId, input.sessionId),
          eq(nativeAgentContexts.agentId, input.agentId),
          eq(nativeAgentContexts.bindingGeneration, input.expectedGeneration),
        ),
      )
      .run()
  })
  return repo.createPatch(input.sessionId)
}

export function freezeNativeRebuildSource(
  repo: ConversationRepositoryHost,
  id: string,
  chunks: NativeContextRebuildChunk[],
  sourceRevisions: ReadonlyMap<string, number>,
): string {
  const json = JSON.stringify(chunks)
  if (chunks.length > 4096 || Buffer.byteLength(json) > HANDOFF_SAFETY_BYTES)
    throw new HandoffTooLargeError('The complete rebuild history exceeds its preparation limit.')
  const row = repo.database
    .select({
      sourceHash: nativeRebuildOperations.sourceHash,
      stage: nativeRebuildOperations.stage,
    })
    .from(nativeRebuildOperations)
    .where(eq(nativeRebuildOperations.id, id))
    .get()
  if (!row || row.stage !== 'preparing')
    throw new RunOperationConflictError('The rebuild source owner changed.')
  const hash = createHash('sha256').update(json).digest('hex')
  if (row.sourceHash && row.sourceHash !== hash)
    throw new RunOperationConflictError('The rebuild history changed.')
  if (row.sourceHash === hash) return hash
  if (sourceRevisions.size > 4096)
    throw new HandoffTooLargeError('The rebuild source revision map exceeds its preparation limit.')
  repo.database.transaction(() => {
    const operation = repo.database
      .select({
        sessionId: nativeRebuildOperations.sessionId,
        stage: nativeRebuildOperations.stage,
        sourceHash: nativeRebuildOperations.sourceHash,
      })
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, id))
      .get()
    if (!operation || operation.stage !== 'preparing')
      throw new RunOperationConflictError('The rebuild source owner changed.')
    if (operation.sourceHash === hash) return
    if (operation.sourceHash) throw new RunOperationConflictError('The rebuild history changed.')
    for (const messageId of new Set(chunks.map((chunk) => chunk.messageId))) {
      const revision = sourceRevisions.get(messageId)
      if (!Number.isSafeInteger(revision) || revision === undefined || revision < 0)
        throw new RunOperationConflictError('The rebuild source revision is missing or invalid.')
      const source = repo.quotedSource(operation.sessionId, messageId)
      if (source.sourceRevision !== revision)
        throw new RunOperationConflictError(
          'A Message changed while the Native Session was preparing.',
        )
      repo.database
        .insert(conversationRebuildSourceRefs)
        .values({ operationId: id, ...source })
        .run()
    }
    repo.database
      .update(nativeRebuildOperations)
      .set({
        sourceHash: hash,
        sourceChunksJson: json,
        messageCount: new Set(chunks.map((chunk) => chunk.messageId)).size,
        throughSequence: Math.max(-1, ...chunks.map((chunk) => chunk.sequence)),
      })
      .where(eq(nativeRebuildOperations.id, id))
      .run()
  })
  return hash
}

export function parseReturnedInput(
  repo: ConversationRepositoryHost,
  json: string | null,
): RebuildReturnedInputRecord | undefined {
  if (!json) return undefined
  if (Buffer.byteLength(json) > 64 * 1024)
    throw new RunOperationConflictError('Invalid input return receipt.')
  return rebuildReturnedInputRecordSchema.parse(JSON.parse(json))
}

function freezeReturnedInput(repo: ConversationRepositoryHost, run: AgentRun): string | null {
  if (rebuildInputRecovery(repo, run.sessionId)) return null
  const message = repo.database
    .select({
      ...getTableColumns(conversationMessages),
      content: sql<
        string | null
      >`CASE WHEN length(CAST(${conversationMessages.content} AS BLOB)) <= ${BODY_INTERNAL_READ_BYTES} THEN ${conversationMessages.content} ELSE NULL END`,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.id, run.userMessageId),
        eq(conversationMessages.sessionId, run.sessionId),
        eq(conversationMessages.isVisible, true),
      ),
    )
    .get()
  if (
    !message ||
    message.role !== 'user' ||
    message.content === null ||
    !returnedInputWasNotSubmitted(repo, run)
  )
    return null
  const later = repo.database
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.sessionId, run.sessionId),
        eq(conversationMessages.isVisible, true),
        gt(conversationMessages.sequence, message.sequence),
        inArray(conversationMessages.role, ['user', 'assistant']),
        // A separately attributed background report does not consume this
        // rejected input. Later user input and ordinary replies still do.
        or(
          eq(conversationMessages.role, 'user'),
          isNotNull(conversationMessages.runId),
          isNull(conversationMessages.sourceMessageId),
        ),
      ),
    )
    .orderBy(asc(conversationMessages.sequence))
    .limit(1)
    .get()
  if (later) return null
  const batch = repo.inputBatchForMessage(run.sessionId, message.id)
  if (!batch) return null
  const images = repo.imagesForMessage(message.id)
  const record: RebuildReturnedInputRecord = {
    version: 'rebuild-return-v1',
    state: 'prepared',
    messageId: message.id,
    runId: run.id,
    revision: message.contentRevision,
    hash: createHash('sha256').update(message.content).digest('hex'),
    ...(images.length
      ? {
          images: images.map((image) => ({
            id: image.id,
            sha256: image.sha256,
          })),
        }
      : {}),
    route: toMessageRoute(message)?.route ?? {
      type: 'agent',
      agentId: run.agentId,
    },
    comments: [],
    inputBatchRef: {
      id: batch.id,
      revision: batch.revision,
      memberCount: batch.memberCount,
    },
  }
  return JSON.stringify(rebuildReturnedInputRecordSchema.parse(record))
}

function returnedInputWasNotSubmitted(repo: ConversationRepositoryHost, run: AgentRun): boolean {
  if (run.status !== 'failed') return false
  const badRun = repo.database
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.sessionId, run.sessionId),
        eq(agentRuns.userMessageId, run.userMessageId),
        or(
          ne(agentRuns.status, 'failed'),
          sql`${agentRuns.dispatchPhase} NOT IN ('not_sent', 'rejected')`,
          isNotNull(agentRuns.nativeTurnId),
          isNotNull(agentRuns.nativeOutcome),
          eq(agentRuns.failureKind, 'unknown_delivery'),
        ),
      ),
    )
    .limit(1)
    .get()
  return !badRun
}

/** One revision-bound verdict over all active drafts; no clone IDs enter a Patch. */
function returnedDraftsCompatible(
  repo: ConversationRepositoryHost,
  sessionId: string,
  operationId: string,
  pending: boolean,
): boolean {
  const active = sql`${anchoredComments.sessionId}=${sessionId} AND ${anchoredComments.sentWithMessageId} IS NULL AND ${anchoredComments.pendingReceiptId} IS NULL`
  const hasForeign = pending
    ? repo.database.get<{ found: number }>(sql`
          SELECT EXISTS(SELECT 1 FROM ${anchoredComments} WHERE ${active} LIMIT 1) AS found`)
    : repo.database.get<{ found: number }>(sql`
          SELECT EXISTS(SELECT 1 FROM ${anchoredComments} WHERE ${active}
              AND ${anchoredComments.returnOperationId} IS NULL LIMIT 1)
            OR EXISTS(SELECT 1 FROM ${anchoredComments} WHERE ${active}
              AND ${anchoredComments.returnOperationId}<${operationId} LIMIT 1)
            OR EXISTS(SELECT 1 FROM ${anchoredComments} WHERE ${active}
              AND ${anchoredComments.returnOperationId}>${operationId} LIMIT 1) AS found`)
  return hasForeign?.found === 0
}

export function rebuildInputRecovery(
  repo: ConversationRepositoryHost,
  sessionId: string,
): RebuildInputRecovery | null {
  const row = repo.database
    .select({
      id: nativeRebuildOperations.id,
      agentId: nativeRebuildOperations.agentId,
      generation: nativeRebuildOperations.oldGeneration,
      json: nativeRebuildOperations.returnedInputJson,
    })
    .from(nativeRebuildOperations)
    .where(
      and(
        eq(nativeRebuildOperations.sessionId, sessionId),
        eq(nativeRebuildOperations.stage, 'completed'),
        sql`json_extract(${nativeRebuildOperations.returnedInputJson}, '$.state') IN ('pending', 'installed')`,
      ),
    )
    .limit(1)
    .get()
  if (!row) return null
  const record = parseReturnedInput(repo, row.json)
  if (!record || !['pending', 'installed'].includes(record.state)) return null
  return {
    operationId: row.id,
    agentId: row.agentId,
    messageId: record.messageId,
    bindingGeneration:
      nativeContext(repo, sessionId, row.agentId)?.bindingGeneration ?? row.generation + 1,
    route: record.route,
    state: record.state === 'pending' ? 'pending' : 'installed',
    commentIds: [],
    draftEligibility: {
      commentsRevision: repo.database
        .select({ value: sessions.commentsRevision })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get()!.value,
      canRestore: returnedDraftsCompatible(repo, sessionId, row.id, record.state === 'pending'),
    },
    ...(record.inputBatchRef ? { inputBatchRef: record.inputBatchRef } : {}),
  }
}

export function verifyReturnedInput(
  repo: ConversationRepositoryHost,
  operationId: string,
  sessionId: string,
): {
  row: {
    stage: (typeof nativeRebuildOperations.$inferSelect)['stage']
    agentId: RuntimeAgentId
    returnedInputJson: string | null
  }
  record: RebuildReturnedInputRecord
  message: Omit<typeof conversationMessages.$inferSelect, 'content'> & { content: string }
  batch: typeof conversationInputBatches.$inferSelect
  images: ConversationImage[]
} {
  const row = repo.database
    .select({
      stage: nativeRebuildOperations.stage,
      agentId: nativeRebuildOperations.agentId,
      returnedInputJson: nativeRebuildOperations.returnedInputJson,
    })
    .from(nativeRebuildOperations)
    .where(
      and(
        eq(nativeRebuildOperations.id, operationId),
        eq(nativeRebuildOperations.sessionId, sessionId),
      ),
    )
    .get()
  const record = parseReturnedInput(repo, row?.returnedInputJson ?? null)
  if (
    !row ||
    row.stage !== 'completed' ||
    !record ||
    !['pending', 'installed'].includes(record.state)
  )
    throw new RunOperationConflictError('The returned input is no longer available.')
  const message = repo.database
    .select({
      ...getTableColumns(conversationMessages),
      content: sql<
        string | null
      >`CASE WHEN length(CAST(${conversationMessages.content} AS BLOB)) <= ${BODY_INTERNAL_READ_BYTES} THEN ${conversationMessages.content} ELSE NULL END`,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.id, record.messageId),
        eq(conversationMessages.sessionId, sessionId),
      ),
    )
    .get()
  if (message?.content === null)
    throw new RunOperationConflictError(
      'This body exceeds the 8 MiB internal working capacity. Its original content was preserved.',
    )
  if (
    !message ||
    message.role !== 'user' ||
    message.contentRevision !== record.revision ||
    createHash('sha256').update(message.content).digest('hex') !== record.hash
  )
    throw new RunOperationConflictError('The original returned input changed.')
  const images = repo.imagesForMessage(record.messageId, sessionId)
  if (
    JSON.stringify(images.map((image) => ({ id: image.id, sha256: image.sha256 }))) !==
    JSON.stringify(record.images ?? [])
  )
    throw new RunOperationConflictError('The original returned images changed.')
  const originalRun = repo.findRun(record.runId)
  if (
    !originalRun ||
    originalRun.sessionId !== sessionId ||
    originalRun.userMessageId !== record.messageId ||
    !returnedInputWasNotSubmitted(repo, originalRun)
  )
    throw new RunOperationConflictError('The original input no longer has non-dispatch proof.')
  if (!record.inputBatchRef)
    throw new RunOperationConflictError('The original input Batch source is unavailable.')
  const batch = repo.database
    .select()
    .from(conversationInputBatches)
    .where(
      and(
        eq(conversationInputBatches.id, record.inputBatchRef.id),
        eq(conversationInputBatches.sessionId, sessionId),
        eq(conversationInputBatches.messageId, record.messageId),
      ),
    )
    .get()
  if (
    !batch ||
    batch.commentsRevision !== record.inputBatchRef.revision ||
    batch.memberCount !== record.inputBatchRef.memberCount
  )
    throw new RunOperationConflictError('The frozen input Batch changed.')
  let cursor = -1,
    count = 0
  const deadline = Date.now() + 5000
  for (;;) {
    if (Date.now() >= deadline)
      throw new RunOperationConflictError(
        'The original input Batch verification timed out; its sources remain saved.',
      )
    const page = repo.database
      .select({ member: conversationInputBatchMembers, comment: anchoredComments })
      .from(conversationInputBatchMembers)
      .innerJoin(anchoredComments, eq(anchoredComments.id, conversationInputBatchMembers.commentId))
      .where(
        and(
          eq(conversationInputBatchMembers.batchId, batch.id),
          gt(conversationInputBatchMembers.ordinal, cursor),
        ),
      )
      .orderBy(asc(conversationInputBatchMembers.ordinal))
      .limit(COLLABORATION_INDEX_ITEMS)
      .all()
    if (!page.length) break
    for (const { member, comment } of page) {
      if (
        comment.sessionId !== sessionId ||
        comment.sentWithMessageId !== record.messageId ||
        comment.draftRevision !== member.commentRevision ||
        comment.anchorJson !== member.anchorJson ||
        createHash('sha256').update(comment.body).digest('hex') !== member.bodySha256
      )
        throw new RunOperationConflictError('The original frozen Comment changed.')
      count++
    }
    cursor = page.at(-1)!.member.ordinal
  }
  if (count !== batch.memberCount)
    throw new RunOperationConflictError('The original input Batch has missing members.')
  return { row, record, message: { ...message, content: message.content }, batch, images }
}

export function readReturnedInput(
  repo: ConversationRepositoryHost,
  sessionId: string,
  operationId: string,
  offset: number,
): Extract<ConversationPage, { scope: 'rebuild-input' }> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > BODY_INTERNAL_READ_BYTES)
    throw new RunOperationConflictError('Invalid returned input offset.')
  // Only page zero verifies complete originals; the final claim verifies them again.
  // Later pages are bounded header/revision reads. Cursors count SQLite Unicode characters.
  const verified = offset === 0 ? verifyReturnedInput(repo, operationId, sessionId) : undefined
  if (verified?.message.content.includes('\0'))
    throw new RunOperationConflictError(
      'This input contains an unsupported zero character. Its original content remains saved.',
    )
  const receipt =
    verified?.row ??
    repo.database
      .select({
        stage: nativeRebuildOperations.stage,
        agentId: nativeRebuildOperations.agentId,
        returnedInputJson: nativeRebuildOperations.returnedInputJson,
      })
      .from(nativeRebuildOperations)
      .where(
        and(
          eq(nativeRebuildOperations.id, operationId),
          eq(nativeRebuildOperations.sessionId, sessionId),
        ),
      )
      .get()
  const record = parseReturnedInput(repo, receipt?.returnedInputJson ?? null)
  if (
    !receipt ||
    receipt.stage !== 'completed' ||
    !record ||
    !['pending', 'installed'].includes(record.state)
  )
    throw new RunOperationConflictError('The returned input is no longer available.')
  const message = repo.database
    .select({
      role: conversationMessages.role,
      revision: conversationMessages.contentRevision,
      text: sql<string>`substr(${conversationMessages.content}, ${offset + 1}, 4097)`,
      prior: sql<string>`substr(${conversationMessages.content}, ${Math.max(1, offset)}, 1)`,
      skills: sql<
        string | null
      >`CASE WHEN ${offset} = 0 THEN ${conversationMessages.skillInvocationJson} ELSE NULL END`,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.id, record.messageId),
        eq(conversationMessages.sessionId, sessionId),
      ),
    )
    .get()
  if (
    !message ||
    message.role !== 'user' ||
    message.revision !== record.revision ||
    (offset > 0 && !message.prior)
  )
    throw new RunOperationConflictError(
      'The original returned input changed or its cursor is invalid.',
    )
  const characters = Array.from(message.text)
  const count = Math.min(4096, characters.length)
  return {
    scope: 'rebuild-input',
    sessionId,
    operationId,
    messageId: record.messageId,
    text: characters.slice(0, count).join(''),
    nextOffset: offset + count,
    hasMore: characters.length > count,
    route: record.route,
    ...(offset === 0 && verified?.images.length ? { images: verified.images } : {}),
    ...(offset === 0 && message.skills
      ? { skills: frozenSkillInvocationSchema.parse(JSON.parse(message.skills)).selections }
      : {}),
  }
}

export function claimReturnedInput(
  repo: ConversationRepositoryHost,
  sessionId: string,
  operationId: string,
  expectedGeneration: number,
  expectedCommentsRevision: number,
): ConversationPatch {
  let installed = false
  repo.database.transaction(() => {
    const { row, record, batch } = verifyReturnedInput(repo, operationId, sessionId)
    if (expectedGeneration !== nativeContext(repo, sessionId, row.agentId)?.bindingGeneration)
      throw new RunOperationConflictError('Input recovery generation changed.')
    const session = repo.database.select().from(sessions).where(eq(sessions.id, sessionId)).get()!
    if (session.commentsRevision !== expectedCommentsRevision)
      throw new RunOperationConflictError('Comment drafts changed during input recovery.')
    if (!returnedDraftsCompatible(repo, sessionId, operationId, record.state === 'pending'))
      throw new RunOperationConflictError(
        'Keep your current Comment drafts before restoring this input.',
      )
    if (record.state === 'installed') return
    let position =
      (repo.database
        .select({ value: max(anchoredComments.position) })
        .from(anchoredComments)
        .where(eq(anchoredComments.sessionId, sessionId))
        .get()?.value ?? -1) + 1
    let cursor = -1
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
            gt(conversationInputBatchMembers.ordinal, cursor),
          ),
        )
        .orderBy(asc(conversationInputBatchMembers.ordinal))
        .limit(COLLABORATION_INDEX_ITEMS)
        .all()
      if (!page.length) break
      for (const { comment } of page)
        repo.database
          .insert(anchoredComments)
          .values({
            ...comment,
            id: randomUUID(),
            position: position++,
            sentWithMessageId: null,
            pendingReceiptId: null,
            returnOperationId: operationId,
            draftRevision: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .run()
      cursor = page.at(-1)!.member.ordinal
    }
    repo.database
      .update(conversationInputBatchMembers)
      .set({ state: 'withdrawn', updatedAt: new Date().toISOString() })
      .where(eq(conversationInputBatchMembers.batchId, batch.id))
      .run()
    repo.database
      .update(conversationInputBatches)
      .set({ bodyState: 'withdrawn', state: 'closed', closedAt: new Date().toISOString() })
      .where(eq(conversationInputBatches.id, batch.id))
      .run()
    record.state = 'installed'
    repo.database
      .update(nativeRebuildOperations)
      .set({ returnedInputJson: JSON.stringify(record) })
      .where(eq(nativeRebuildOperations.id, operationId))
      .run()
    repo.database
      .update(sessions)
      .set({ commentsRevision: session.commentsRevision + 1 })
      .where(eq(sessions.id, sessionId))
      .run()

    appendAgentEvent(repo.database, {
      sessionId,
      runId: record.runId,
      eventType: 'native.input_returned',
      payload: JSON.stringify({
        operationId,
        messageId: record.messageId,
        inputBatchRef: record.inputBatchRef,
      }),
      createdAt: new Date().toISOString(),
    })
    installed = true
  })
  return repo.createPatch(sessionId, {
    comments: {
      revision: repo.database
        .select({ revision: sessions.commentsRevision })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get()!.revision,
      upserts: [],
      removedIds: [],
    },
    resync: { messages: false, drafts: installed, activityRunIds: [] },
  })
}

export function discardReturnedInput(
  repo: ConversationRepositoryHost,
  sessionId: string,
  operationId: string,
): ConversationPatch {
  let removed: string | undefined
  repo.database.transaction(() => {
    const { record } = verifyReturnedInput(repo, operationId, sessionId)
    if (record.state === 'installed')
      throw new RunOperationConflictError(
        'Send or keep the restored input before discarding its receipt.',
      )
    record.state = 'consumed'
    if (record.inputBatchRef) repo.withdrawInputBatch(record.inputBatchRef.id)
    repo.database
      .update(nativeRebuildOperations)
      .set({ returnedInputJson: JSON.stringify(record) })
      .where(eq(nativeRebuildOperations.id, operationId))
      .run()
    preserveMessagesBeforeCutoffMutation(repo.database, [record.messageId])
    repo.database
      .update(conversationMessages)
      .set({ isVisible: false })
      .where(eq(conversationMessages.id, record.messageId))
      .run()
    nativeFact(repo, record.runId, 'native.input_dismissed', {
      operationId,
      messageId: record.messageId,
    })
    removed = record.messageId
  })
  return repo.createPatch(sessionId, removed ? { removedMessageIds: [removed] } : {})
}

export function returnedInputRoute(
  repo: ConversationRepositoryHost,
  sessionId: string,
  operationId: string,
): ConversationMessageRoute {
  return verifyReturnedInput(repo, operationId, sessionId).record.route
}

export function markNativeRebuildDispatched(
  repo: ConversationRepositoryHost,
  id: string,
  executorId?: string,
): void {
  repo.database.transaction(() => {
    const operation = repo.database
      .select({ sessionId: nativeRebuildOperations.sessionId })
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, id))
      .get()
    if (!operation) throw new RunOperationConflictError('This native rebuild is unavailable.')
    assertSessionAvailable(repo.database, operation.sessionId)
    repo.database
      .update(nativeRebuildOperations)
      .set({
        stage: 'creating',
        nativeWorkState: 'pending',
        creationExecutorId: executorId ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(eq(nativeRebuildOperations.id, id), eq(nativeRebuildOperations.stage, 'preparing')),
      )
      .run()
    scheduling.recordNativeRebuildActivity(repo.database, id)
  })
  repo.schedulingChanged()
}

export function readNativeRebuildSource(
  repo: ConversationRepositoryHost,
  id: string,
): NativeContextRebuildChunk[] {
  const row = repo.database
    .select({
      sourceHash: nativeRebuildOperations.sourceHash,
      sourceChunksJson: nativeRebuildOperations.sourceChunksJson,
    })
    .from(nativeRebuildOperations)
    .where(eq(nativeRebuildOperations.id, id))
    .get()
  if (!row?.sourceHash || !row.sourceChunksJson)
    throw new RunOperationConflictError(
      'The candidate has no complete saved initialization source.',
    )
  if (
    Buffer.byteLength(row.sourceChunksJson) > HANDOFF_SAFETY_BYTES ||
    createHash('sha256').update(row.sourceChunksJson).digest('hex') !== row.sourceHash
  )
    throw new RunOperationConflictError('The saved initialization source cannot be verified.')
  const chunks: unknown = JSON.parse(row.sourceChunksJson)
  if (!Array.isArray(chunks) || chunks.length > 4096)
    throw new RunOperationConflictError('The saved initialization source exceeds its limit.')
  return chunks.map((chunk: unknown) => nativeContextRebuildChunkSchema.parse(chunk))
}

export function recordNativeRebuildIdentity(
  repo: ConversationRepositoryHost,
  id: string,
  nativeSessionId: string,
): void {
  nativeEvidenceIdentitySchema.shape.nativeSessionId.parse(nativeSessionId)
  const op = nativeRebuildOperation(repo, id)
  if (!op || !['creating', 'seeding'].includes(op.stage))
    throw new RunOperationConflictError('The Native creation acknowledgement has no owner.')
  if (op.provisionalNativeSessionId && op.provisionalNativeSessionId !== nativeSessionId)
    throw new RunOperationConflictError('Native acknowledged a different rebuild identity.')
  repo.database.transaction(() => {
    repo.database
      .update(nativeRebuildOperations)
      .set({
        stage: 'seeding',
        provisionalNativeSessionId: nativeSessionId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(nativeRebuildOperations.id, id))
      .run()
    scheduling.recordNativeRebuildActivity(repo.database, id)
  })
  repo.schedulingChanged()
}

export function failNativeRebuild(
  repo: ConversationRepositoryHost,
  id: string,
  reason: string,
): ConversationPatch {
  const row = repo.database
    .select({
      sessionId: nativeRebuildOperations.sessionId,
      agentId: nativeRebuildOperations.agentId,
      stage: nativeRebuildOperations.stage,
      oldGeneration: nativeRebuildOperations.oldGeneration,
    })
    .from(nativeRebuildOperations)
    .where(eq(nativeRebuildOperations.id, id))
    .get()
  if (!row) throw new RunOperationConflictError('The rebuild operation is unavailable.')
  if (['completed', 'superseded'].includes(row.stage)) return repo.createPatch(row.sessionId)
  nativeMetadataTransaction(repo, row.sessionId, () => {
    repo.database
      .update(nativeRebuildOperations)
      .set({
        stage: ['creating', 'seeding', 'unconfirmed'].includes(row.stage)
          ? 'unconfirmed'
          : 'failed',
        failureReason: reason.slice(0, 240),
        nativeWorkState: sql`CASE WHEN ${nativeRebuildOperations.nativeWorkState} = 'pending' THEN 'unknown' ELSE ${nativeRebuildOperations.nativeWorkState} END`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(nativeRebuildOperations.id, id))
      .run()
    repo.database
      .update(nativeAgentContexts)
      .set({ continuationState: 'recovery_required', recoveryReason: reason.slice(0, 240) })
      .where(
        and(
          eq(nativeAgentContexts.sessionId, row.sessionId),
          eq(nativeAgentContexts.agentId, row.agentId),
          eq(nativeAgentContexts.bindingGeneration, row.oldGeneration),
        ),
      )
      .run()
    if (['creating', 'seeding', 'unconfirmed'].includes(row.stage)) {
      appendAgentEvent(repo.database, {
        sessionId: row.sessionId,
        runId: id,
        eventType: 'native.rebuild_unconfirmed',
        payload: JSON.stringify({ operationId: id }),
        createdAt: new Date().toISOString(),
      })
      repo.recordSchedulingRecoveryOrigin({ kind: 'rebuild', id })
    }
    scheduling.recordNativeRebuildActivity(repo.database, id)
  })
  return repo.createPatch(row.sessionId)
}

export function completeNativeRebuild(
  repo: ConversationRepositoryHost,
  id: string,
  nativeSessionId: string,
  executorId?: string,
  initializationWitness?: NativeInitializationWitness,
): ConversationPatch {
  nativeEvidenceIdentitySchema.shape.nativeSessionId.parse(nativeSessionId)
  nativeEvidenceIdentitySchema.shape.executorId.parse(executorId)
  const parsedWitness =
    initializationWitness === undefined
      ? undefined
      : nativeInitializationWitnessSchema.safeParse(initializationWitness)
  if (parsedWitness && !parsedWitness.success) {
    const candidateKind =
      typeof initializationWitness === 'object' && initializationWitness !== null
        ? Reflect.get(initializationWitness, 'kind')
        : undefined
    if (candidateKind === 'codex_rollout_v1' || candidateKind === 'agy_rebuild_v1') {
      throw new RunOperationConflictError(
        'The initialization witness is incomplete or does not match its required schema.',
      )
    }
    throw new RunOperationConflictError('The initialization witness belongs to another Agent.')
  }
  const witness = parsedWitness?.data
  if (witness && witness.nativeSessionId !== nativeSessionId)
    throw new RunOperationConflictError(
      'The initialization witness belongs to another Native Session.',
    )
  const row = repo.database
    .select()
    .from(nativeRebuildOperations)
    .where(eq(nativeRebuildOperations.id, id))
    .get()
  if (!row) throw new RunOperationConflictError('The rebuild operation is unavailable.')
  if (row.stage === 'completed') return repo.createPatch(row.sessionId)

  if (
    !['seeding', 'unconfirmed'].includes(row.stage) ||
    !row.sourceHash ||
    !row.sourceChunksJson ||
    row.provisionalNativeSessionId !== nativeSessionId
  )
    throw new RunOperationConflictError('The complete Native seed has not been confirmed.')
  if ((row.agentId === 'codex' || row.agentId === 'agy') && !witness)
    throw new RunOperationConflictError(
      'The complete native initialization has no durable readback witness.',
    )
  if (
    witness &&
    (row.agentId === 'claude' ||
      (row.agentId === 'codex' && witness.kind !== 'codex_rollout_v1') ||
      (row.agentId === 'agy' && witness.kind !== 'agy_rebuild_v1'))
  )
    throw new RunOperationConflictError('The initialization witness belongs to another Agent.')
  if (
    row.agentId === 'agy' &&
    (witness?.kind !== 'agy_rebuild_v1' ||
      witness.nativeSessionId !== row.provisionalNativeSessionId ||
      !row.sourceHash ||
      witness.sourceHash !== row.sourceHash ||
      witness.stepCount !== 2 ||
      !witness.coldLoadVerifiedAt)
  )
    throw new RunOperationConflictError(
      'The initialization witness does not match the rebuilt Antigravity source.',
    )

  const dividerId = randomUUID()
  let returnedMessageId: string | undefined
  let retiredMessages: ConversationPatch['messages'] = []
  nativeMetadataTransaction(repo, row.sessionId, () => {
    assertSessionAvailable(repo.database, row.sessionId)
    const context = nativeContext(repo, row.sessionId, row.agentId)
    if (
      (context?.bindingGeneration ?? 1) !== row.oldGeneration ||
      (context?.nativeSessionId ?? null) !== row.oldNativeSessionId
    )
      throw new RunOperationConflictError('The original Native binding changed during rebuild.')
    retiredMessages = repo.cancelPendingRoutedContinuation(
      row.sessionId,
      'native_binding_rebuilt',
    ).messages
    const now = new Date().toISOString()
    const oldRun = row.oldRunId ? repo.findRun(row.oldRunId) : undefined
    repo.database
      .update(agentRuns)
      .set({ peerProposalState: 'superseded' })
      .where(
        and(
          eq(agentRuns.sessionId, row.sessionId),
          eq(agentRuns.agentId, row.agentId),
          eq(agentRuns.bindingGeneration, row.oldGeneration),
          eq(agentRuns.peerProposalState, 'pending'),
        ),
      )
      .run()
    if (row.abandon && oldRun && oldRun.bindingGeneration === row.oldGeneration) {
      repo.database
        .update(agentRuns)
        .set({ controlDisposition: 'abandoned', peerProposalState: 'superseded' })
        .where(eq(agentRuns.id, oldRun.id))
        .run()
      repo.database
        .update(conversationMessages)
        .set({ routePendingAgentId: null })
        .where(eq(conversationMessages.id, oldRun.userMessageId))
        .run()
      nativeFact(repo, oldRun.id, 'pact.run_abandoned', {
        rebuildId: id,
        oldGeneration: row.oldGeneration,
      })
    }
    const next = {
      nativeSessionId,
      bindingGeneration: row.oldGeneration + 1,
      executorId: executorId ?? null,
      state: 'active' as const,
      continuationState: 'ready' as const,
      permissionRequestsJson: null,
      lastRunId: null,
      recoveryReason: null,
      recoveryFailureKind: null,
      recoveryFailureMessage: null,
      recoveryAction: null,
      rebuildMessageCount: row.messageCount,
      rebuiltThroughSequence:
        row.throughSequence !== null && row.throughSequence >= 0 ? row.throughSequence : null,
      deliveredCutoffIdsJson: null,
      updatedAt: now,
    }
    repo.database
      .insert(nativeAgentContexts)
      .values({ sessionId: row.sessionId, agentId: row.agentId, ...next })
      .onConflictDoUpdate({
        target: [nativeAgentContexts.sessionId, nativeAgentContexts.agentId],
        set: next,
      })
      .run()
    repo.database
      .update(nativeRebuildOperations)
      .set({
        stage: 'completed',
        nativeWorkState: 'settled',
        initializationWitnessJson: witness ? JSON.stringify(witness) : null,
        returnedInputJson: (() => {
          const returned = parseReturnedInput(repo, row.returnedInputJson)
          if (!returned || returned.state !== 'prepared') return row.returnedInputJson
          const returnedRun = repo.findRun(returned.runId)
          const current =
            returnedRun &&
            returnedRun.sessionId === row.sessionId &&
            returnedRun.agentId === row.agentId &&
            returnedRun.bindingGeneration === row.oldGeneration &&
            returnedRun.userMessageId === returned.messageId &&
            (returnedRun.id === oldRun?.id || returnedRun.controlDisposition !== 'abandoned')
              ? parseReturnedInput(repo, freezeReturnedInput(repo, returnedRun))
              : undefined
          if (
            !current ||
            JSON.stringify(current) !== JSON.stringify(returned) ||
            readNativeRebuildSource(repo, id).some(
              (chunk) => chunk.messageId === returned.messageId,
            )
          )
            return null
          returnedMessageId = returned.messageId
          preserveMessagesBeforeCutoffMutation(repo.database, [returned.messageId])
          repo.database
            .update(conversationMessages)
            .set({ isVisible: false })
            .where(eq(conversationMessages.id, returned.messageId))
            .run()
          nativeFact(repo, returned.runId, 'native.input_return_prepared', {
            operationId: id,
            messageId: returned.messageId,
          })
          return JSON.stringify({ ...returned, state: 'pending' })
        })(),
        updatedAt: now,
      })
      .where(eq(nativeRebuildOperations.id, id))
      .run()
    scheduling.recordNativeRebuildActivity(repo.database, id)
    const sequence = allocateSessionMessageSequence(repo.database, row.sessionId)
    repo.database
      .insert(conversationMessages)
      .values({
        id: dividerId,
        sessionId: row.sessionId,
        agentId: row.agentId,
        role: 'system',
        content: `${agentDisplayName(row.agentId)} native session rebuilt`,
        state: 'complete',
        sequence,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    appendAgentEvent(repo.database, {
      sessionId: row.sessionId,
      runId: id,
      eventType: 'native.rebuild_completed',
      payload: JSON.stringify({
        rebuildId: id,
        agentId: row.agentId,
        bindingGeneration: next.bindingGeneration,
        dividerId,
      }),
      createdAt: now,
    })
    const queued = repo.receivedCollaborationInput(row.sessionId)
    if (queued && repo.queuedSteerDelivery(queued)?.rebuildId === id)
      repo.advanceQueue(row.sessionId)
  })
  return repo.createPatch(row.sessionId, {
    ...(returnedMessageId ? { removedMessageIds: [returnedMessageId] } : {}),
    messages: [...retiredMessages, repo.messageChange(dividerId, 'replace')],
    runs: latestAgentRun(repo, row.sessionId, row.agentId)
      ? [latestAgentRun(repo, row.sessionId, row.agentId)!]
      : [],
  })
}

export function expireNativePermissions(repo: ConversationRepositoryHost): void {
  repo.database
    .update(nativeAgentContexts)
    .set({ permissionRequestsJson: null })
    .where(isNotNull(nativeAgentContexts.permissionRequestsJson))
    .run()
}

export function recordContextPermissions(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
  operationId: string,
  requests: import('@pact/contracts').NativePermissionRequest[],
  decision?: {
    permissionId: string
    decision?: 'once' | 'session' | 'deny' | 'accept' | 'decline' | 'cancel'
    source?: 'user' | 'expired' | 'aborted'
    actionId?: string
    actionKind?: 'allow' | 'decline' | 'cancel' | 'rule'
  },
  scope?: { bindingGeneration: number; projectionAllowed: boolean },
): ConversationPatch {
  const parsed = nativePermissionRequestSchema
    .array()
    .max(NATIVE_PERMISSION_REQUESTS)
    .parse(requests)
  const summaries = parsed.map((request) => {
    const summary: import('@pact/contracts').NativePermissionRequest = {
      id: request.id,
      kind: request.kind ?? 'approval',
      title: 'Native interaction',
      detail: '',
      createdAt: request.createdAt,
    }
    if (request.operationId) summary.operationId = request.operationId
    return summary
  })
  repo.database.transaction((transaction) => {
    const createdAt = new Date().toISOString()

    appendAgentEvent(transaction, {
      sessionId,
      runId: operationId,
      eventType: decision ? 'native.permission_decided' : 'native.permission_requested',
      payload: JSON.stringify({ agentId, requests: summaries, decision }),
      createdAt,
    })
    const binding = nativeContext(repo, sessionId, agentId)
    const rebuild = pendingNativeRebuild(repo, sessionId, agentId)
    const projectionAllowed =
      scope === undefined ||
      (scope.projectionAllowed &&
        (binding?.bindingGeneration === scope.bindingGeneration ||
          (rebuild?.id === operationId && rebuild.oldGeneration + 1 === scope.bindingGeneration)))
    if (projectionAllowed)
      transaction
        .update(nativeAgentContexts)
        .set({
          permissionRequestsJson: summaries.length ? JSON.stringify(summaries) : null,
          updatedAt: createdAt,
        })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, sessionId),
            eq(nativeAgentContexts.agentId, agentId),
          ),
        )
        .run()
  })
  return repo.createPatch(sessionId, {})
}

export function nativeContexts(
  repo: ConversationRepositoryHost,
  sessionId: string,
): NativeAgentContext[] {
  return repo.database
    .select()
    .from(nativeAgentContexts)
    .where(eq(nativeAgentContexts.sessionId, sessionId))
    .orderBy(asc(nativeAgentContexts.agentId))
    .all()
    .map((context) => repo.projectNativeContext(context))
}

export function nativeRecoveryBlocksInput(
  repo: ConversationRepositoryHost,
  sessionId: string,
): boolean {
  if (forkFacts.forkBlocksInput(repo.database, sessionId)) return true
  const activePair = repo.activePairForSession(sessionId)
  const contexts = repo.database
    .select({
      agentId: nativeAgentContexts.agentId,
      continuationState: nativeAgentContexts.continuationState,
      recoveryAction: nativeAgentContexts.recoveryAction,
      recoveryFailureKind: nativeAgentContexts.recoveryFailureKind,
      permissionRequestsJson: nativeAgentContexts.permissionRequestsJson,
    })
    .from(nativeAgentContexts)
    .where(eq(nativeAgentContexts.sessionId, sessionId))
    .limit(3)
    .all()
  for (const ctx of contexts) {
    if (!activePair || isAgentInPair(ctx.agentId, activePair)) {
      if (['recovery_required', 'checking', 'rebuilding'].includes(ctx.continuationState)) {
        return true
      }
      continue
    }
    const retiredGate = SessionRepository.replacementGateQueries(sessionId, [ctx.agentId])
      .retired[0]!
    const hasPendingPermission =
      ctx.permissionRequestsJson !== null && ctx.permissionRequestsJson !== '[]'
    const hasPendingRebuild = Boolean(
      repo.database.get(retiredGate.pendingRebuildStage) ||
      repo.database.get(retiredGate.pendingRebuildWork),
    )
    const hasUnsettledRun = Boolean(repo.database.get(retiredGate.unsettledRun))
    if (
      !isRetiredAgentRecoverySettled({
        continuationState: ctx.continuationState,
        recoveryAction: ctx.recoveryAction,
        recoveryFailureKind: ctx.recoveryFailureKind,
        hasPendingPermission,
        hasPendingRebuild,
        hasUnsettledRun,
      })
    ) {
      return true
    }
  }
  return unacknowledgedNativeRun(repo, sessionId) !== undefined
}

/** Same durable blocker used by the send gate and recovery card, including older attempts. */
export function unacknowledgedNativeRun(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId?: RuntimeAgentId,
): AgentRun | undefined {
  const row = repo.database
    .select(publicRunColumns)
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.sessionId, sessionId),
        ...(agentId ? [eq(agentRuns.agentId, agentId)] : []),
        ne(agentRuns.controlDisposition, 'abandoned'),
        isNull(agentRuns.forkSourceRunId),
        inArray(agentRuns.dispatchPhase, ['possibly_sent', 'accepted']),
        inArray(agentRuns.status, ['failed', 'interrupted', 'recovering']),
        sql`${agentRuns.nativeOutcome} IS NULL`,
        sql`NOT EXISTS (SELECT 1 FROM native_agent_contexts c
              WHERE c.session_id = ${agentRuns.sessionId} AND c.agent_id = ${agentRuns.agentId})`,
      ),
    )
    .orderBy(desc(agentRuns.createdAt), desc(sql`${agentRuns}.rowid`))
    .limit(1)
    .get()
  return row ? repo.toRun(row) : undefined
}

export function markNativeContextsMissing(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentIds: RuntimeAgentId[],
  message = 'The saved Native Session is unavailable.',
): ConversationPatch {
  const now = new Date().toISOString()
  let retired: string | undefined
  nativeMetadataTransaction(repo, sessionId, (transaction) => {
    retired = repo.retirePendingRoute(sessionId, 'native_session_missing')
    for (const agentId of agentIds) {
      transaction
        .update(nativeAgentContexts)
        .set({
          state: 'missing',
          continuationState: 'recovery_required',
          recoveryAction: 'rebuild',
          recoveryReason: message.slice(0, 240),
          recoveryFailureKind: 'context_resume_failed',
          recoveryFailureMessage: message,
          updatedAt: now,
        })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, sessionId),
            eq(nativeAgentContexts.agentId, agentId),
          ),
        )
        .run()
    }
    transaction.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, sessionId)).run()
  })
  return repo.createPatch(sessionId, {
    messages: retired ? [repo.messageChange(retired, 'metadata')] : [],
  })
}

export async function* nativeContextRebuildSource(
  repo: ConversationRepositoryHost,
  sessionId: string,
  signal: AbortSignal,
  operationId?: string,
  sourceRevisions?: Map<string, number>,
): AsyncIterable<NativeContextRebuildChunk> {
  if (sourceRevisions && sourceRevisions.size > 4096)
    throw new HandoffTooLargeError('The rebuild source revision map exceeds its preparation limit.')
  const operation = operationId
    ? repo.database
        .select()
        .from(nativeRebuildOperations)
        .where(
          and(
            eq(nativeRebuildOperations.id, operationId),
            eq(nativeRebuildOperations.sessionId, sessionId),
          ),
        )
        .get()
    : repo.database
        .select()
        .from(nativeRebuildOperations)
        .where(
          and(
            eq(nativeRebuildOperations.sessionId, sessionId),
            inArray(nativeRebuildOperations.stage, ['preparing', 'creating', 'seeding']),
          ),
        )
        .limit(1)
        .get()
  const returned = parseReturnedInput(repo, operation?.returnedInputJson ?? null)
  const activeInput = rebuildInputRecovery(repo, sessionId)
  const exclude = [
    ...(returned?.state === 'prepared' ? [returned.messageId] : []),
    ...(activeInput ? [activeInput.messageId] : []),
  ]
  // Recovery may already have retired the pending route. Use the frozen route
  // and dispatch facts, never that transient flag, to bound an unsent secondary.
  const routedThroughSequence = operation
    ? undispatchedRoutedHistoryBoundary(repo, sessionId, operation.agentId)
    : undefined
  const throughSequence =
    repo.database
      .select({ value: max(conversationMessages.sequence) })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.sessionId, sessionId),
          eq(conversationMessages.isVisible, true),
          ...(routedThroughSequence === undefined
            ? []
            : [lte(conversationMessages.sequence, routedThroughSequence)]),
          ...(exclude.length ? [notInArray(conversationMessages.id, exclude)] : []),
          inArray(conversationMessages.role, ['user', 'assistant']),
          inArray(conversationMessages.state, ['complete', 'incomplete']),
        ),
      )
      .get()?.value ?? -1
  let afterSequence = -1
  while (afterSequence < throughSequence) {
    if (signal.aborted) throw new Error('Native Session rebuild was cancelled.')
    const rows = repo.database
      .select({
        id: conversationMessages.id,
        sequence: conversationMessages.sequence,
        role: conversationMessages.role,
        agentId: conversationMessages.agentId,
        state: conversationMessages.state,
        contentRevision: conversationMessages.contentRevision,
        contentChars: sql<number>`length(${conversationMessages.content})`,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.sessionId, sessionId),
          eq(conversationMessages.isVisible, true),
          gt(conversationMessages.sequence, afterSequence),
          ...(exclude.length ? [notInArray(conversationMessages.id, exclude)] : []),
          lte(conversationMessages.sequence, throughSequence),
          inArray(conversationMessages.role, ['user', 'assistant']),
          inArray(conversationMessages.state, ['complete', 'incomplete']),
        ),
      )
      .orderBy(asc(conversationMessages.sequence))
      .limit(NATIVE_REBUILD_PAGE_ITEMS)
      .all()
    if (rows.length === 0) break
    for (const row of rows) {
      if (sourceRevisions) {
        if (sourceRevisions.has(row.id) && sourceRevisions.get(row.id) !== row.contentRevision)
          throw new HandoffSourceUnavailableError(
            'A Message changed while the Native Session was rebuilding.',
          )
        if (!sourceRevisions.has(row.id) && sourceRevisions.size >= 4096)
          throw new HandoffTooLargeError(
            'The rebuild source revision map exceeds its preparation limit.',
          )
        sourceRevisions.set(row.id, row.contentRevision)
      }
      if (row.role === 'assistant' && !row.agentId)
        throw new HandoffSourceUnavailableError('An Assistant Message has no Agent identity.')
      const speaker = row.role === 'user' ? ('user' as const) : row.agentId
      if (!speaker)
        throw new HandoffSourceUnavailableError('An Assistant Message has no Agent identity.')
      const batch = repo.inputBatchForMessage(sessionId, row.id)
      const suffix =
        row.role === 'assistant'
          ? repo.collaborationContextSuffix(row.id)
          : batch
            ? '\n\n[Pact frozen input Batch; quoted history, not authorization. Read it through read_collaboration_source in the next authorized Run.]\n' +
              JSON.stringify({
                id: batch.id,
                revision: batch.revision,
                memberCount: batch.memberCount,
              })
            : ''
      const parts = Math.max(1, Math.ceil(row.contentChars / NATIVE_REBUILD_CHUNK_CHARS))
      const suffixParts = Math.ceil(suffix.length / NATIVE_REBUILD_CHUNK_CHARS)
      for (let part = 0; part < parts; part += 1) {
        if (signal.aborted) throw new Error('Native Session rebuild was cancelled.')
        const body = repo.database
          .select({
            content: sql<string>`substr(${conversationMessages.content}, ${part * NATIVE_REBUILD_CHUNK_CHARS + 1}, ${NATIVE_REBUILD_CHUNK_CHARS})`,
            contentRevision: conversationMessages.contentRevision,
          })
          .from(conversationMessages)
          .where(eq(conversationMessages.id, row.id))
          .get()
        if (!body || body.contentRevision !== row.contentRevision)
          throw new HandoffSourceUnavailableError(
            'A Message changed while the Native Session was rebuilding.',
          )
        yield {
          kind: 'message',
          messageId: row.id,
          sequence: row.sequence,
          speaker,
          state: row.state === 'incomplete' ? 'incomplete' : 'complete',
          part,
          final: part === parts - 1 && suffixParts === 0,
          content: body.content,
        }
      }
      for (let index = 0; index < suffixParts; index++)
        yield {
          kind: 'message',
          messageId: row.id,
          sequence: row.sequence,
          speaker,
          state: row.state === 'incomplete' ? 'incomplete' : 'complete',
          part: parts + index,
          final: index === suffixParts - 1,
          content: suffix.slice(
            index * NATIVE_REBUILD_CHUNK_CHARS,
            (index + 1) * NATIVE_REBUILD_CHUNK_CHARS,
          ),
        }
      for (const image of repo.imagesForMessage(row.id, sessionId)) {
        yield { kind: 'image', messageId: row.id, sequence: row.sequence, image }
      }
      afterSequence = row.sequence
    }
    // oxlint-disable-next-line no-await-in-loop -- Rebuild reads yield between bounded pages.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function undispatchedRoutedHistoryBoundary(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
): number | undefined {
  const message = repo.database
    .select({
      id: conversationMessages.id,
      sequence: conversationMessages.sequence,
      routeKind: conversationMessages.routeKind,
      routeAgentsJson: conversationMessages.routeAgentsJson,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.sessionId, sessionId),
        eq(conversationMessages.isVisible, true),
        eq(conversationMessages.role, 'user'),
      ),
    )
    .orderBy(desc(conversationMessages.sequence))
    .limit(1)
    .get()
  const route = message && toMessageRoute(message)?.route
  if (!message || route?.type !== 'all' || route.secondAgentId !== agentId) return undefined
  const dispatched = repo.database
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userMessageId, message.id),
        eq(agentRuns.agentId, agentId),
        or(
          sql`${agentRuns.dispatchPhase} NOT IN ('not_sent', 'rejected')`,
          isNotNull(agentRuns.nativeTurnId),
          isNotNull(agentRuns.nativeOutcome),
          eq(agentRuns.failureKind, 'unknown_delivery'),
        ),
      ),
    )
    .limit(1)
    .get()
  return dispatched ? undefined : message.sequence - 1
}

export function nativeContext(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
): NativeAgentContext | undefined {
  const context = repo.sourceQueries.nativeContext().get({ sessionId, agentId })
  return context ? repo.projectNativeContext(context) : undefined
}

export function rebuildOperations(repo: ConversationRepositoryHost, sessionId: string) {
  return (['codex', 'claude', 'agy'] as const).flatMap((agentId) => {
    const operation = lastNativeRebuild(repo, sessionId, agentId)
    return operation &&
      ['preparing', 'creating', 'seeding', 'unconfirmed', 'failed'].includes(operation.stage)
      ? [{ agentId, operation }]
      : []
  })
}

export function confirmedNativeInitialization(
  repo: ConversationRepositoryHost,
  sessionId: string,
  agentId: RuntimeAgentId,
) {
  const context = nativeContext(repo, sessionId, agentId)
  const operation = lastNativeRebuild(repo, sessionId, agentId)
  if (
    !context ||
    !operation ||
    operation.stage !== 'completed' ||
    !operation.sourceHash ||
    operation.provisionalNativeSessionId !== context.nativeSessionId ||
    operation.oldGeneration + 1 !== context.bindingGeneration ||
    pendingNativeRebuild(repo, sessionId, agentId)
  )
    return undefined
  const laterRun = repo.database
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.sessionId, sessionId),
        eq(agentRuns.agentId, agentId),
        eq(agentRuns.bindingGeneration, context.bindingGeneration ?? 1),
      ),
    )
    .limit(1)
    .get()
  const witnessRow = repo.database
    .select({ value: nativeRebuildOperations.initializationWitnessJson })
    .from(nativeRebuildOperations)
    .where(eq(nativeRebuildOperations.id, operation.id))
    .get()
  const parsedWitness = witnessRow?.value
    ? nativeInitializationWitnessSchema.safeParse(JSON.parse(witnessRow.value))
    : undefined
  if (parsedWitness && !parsedWitness.success) return undefined
  const witness = parsedWitness?.data
  if (
    ((agentId === 'codex' || agentId === 'agy') && !witness) ||
    (witness &&
      (agentId === 'claude' ||
        witness.nativeSessionId !== context.nativeSessionId ||
        (agentId === 'codex' && witness.kind !== 'codex_rollout_v1') ||
        (agentId === 'agy' &&
          (witness.kind !== 'agy_rebuild_v1' ||
            witness.sourceHash !== operation.sourceHash ||
            witness.stepCount !== 2 ||
            !witness.coldLoadVerifiedAt))))
  )
    return undefined
  return laterRun
    ? undefined
    : {
        rebuildId: operation.id,
        sourceHash: operation.sourceHash,
        nativeSessionId: context.nativeSessionId,
        bindingGeneration: context.bindingGeneration ?? 1,
        ...(witness ? { witness } : {}),
      }
}
