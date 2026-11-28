import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import {
  bindCollaborationQuestions,
  claudePlanCheckpointSchema,
  COLLABORATION_PLAN_SYNC_FAILURE_NOTICE,
  COLLABORATION_PROTOCOL,
  collaborationActor,
  collaborationInputObservationSchema,
  collaborationInputOutcomeAllowed,
  collaborationInputProcessing,
  collaborationOpenPlanFinalIntentInputSchema,
  collaborationOpenPlanPublishAllowed,
  collaborationOpenPlanPublishIntentSchema,
  collaborationPlanAccepted,
  collaborationPlanMode,
  collaborationPlanSettlementSchema,
  collaborationRetainedPlanSchema,
  collaborationReviewObservationSchema,
  collaborationTaskSchema,
  collaborationTurnAuthorizationSchema,
  DECISION_INPUT_BYTES,
  DECISION_SOURCES,
  decisionInputSchema,
  isCollaborationOpenMode,
  otherAgent,
  settleCollaborationStage,
  type AgentRun,
  type ClaudePlanCheckpoint,
  type CollaborationDocument,
  type CollaborationInputObservation,
  type CollaborationOpenPlanFinalIntentInput,
  type CollaborationOpenPlanPublishIntent,
  type CollaborationReplyIntentBasis,
  type CollaborationRetainedPlan,
  type CollaborationReviewObservation,
  type CollaborationTask,
  type CollaborationTurnAuthorization,
  type RelaySourceRole,
  type RuntimeAgentId,
} from '@pact/contracts'

import type { ConversationRepositoryHost } from './context.js'

import * as scheduling from '../conversation-scheduling.js'
import {
  agentEventJournal,
  agentRuns,
  collaborationInputs,
  collaborationTasks,
  conversationBodyInputs,
  conversationInputBatches,
  runReexecutionOperations,
  workflowTurns,
} from '../schema/index.js'
import { storedReceivedMetadata } from './helpers.js'
import { RunOperationConflictError, type FrozenCollaborationAuthorization } from './types.js'

export function recordWorkflowPlan(
  repo: ConversationRepositoryHost,
  runId: string,
  plan: { nativeId: string; text: string },
): void {
  repo.database.transaction(() => {
    const run = repo.findRun(runId)
    const turn = repo.database
      .select()
      .from(workflowTurns)
      .where(eq(workflowTurns.runId, runId))
      .get()
    if (!run || run.forkSourceRunId || !turn || run.controlDisposition === 'abandoned') return
    const auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
    const frozen = repo.decodedCollaboration(turn.stateJson)
    const planner = collaborationPlanMode(frozen, auth)
    const openPublisher = collaborationOpenPlanPublishAllowed(frozen, auth)
    if ((!planner || auth.actor !== collaborationActor(frozen, 'plan')) && !openPublisher)
      throw new RunOperationConflictError('Only the current plan author can submit a native plan.')
    if (run.agentId !== auth.actor)
      throw new RunOperationConflictError('Only the current turn author can publish a plan.')
    if (!plan.nativeId || plan.nativeId.length > 1024 || !plan.text.trim())
      throw new RunOperationConflictError('The native plan is incomplete.')
    const digest = createHash('sha256').update(plan.text).digest('hex')
    const settled = workflowPlanSettlement(repo, runId)
    if (settled) {
      if (
        settled.kind === 'published' &&
        settled.nativeId === plan.nativeId &&
        settled.planReference.document.sha256 === digest
      )
        return
      throw new RunOperationConflictError('A settled plan result cannot be replaced.')
    }
    if (turn.planBodyId) {
      const old = repo.documentReference(run.sessionId, turn.planBodyId)
      if (old.sha256 === digest && turn.planNativeId === plan.nativeId) return
      if (turn.applied && frozen.planReference?.sourceRunId === runId)
        throw new RunOperationConflictError('A completed native plan cannot be replaced.')
    }
    const source = repo.saveCollaborationDocument(runId, plan.text)
    repo.database
      .update(workflowTurns)
      .set({ planBodyId: source.id, planNativeId: plan.nativeId })
      .where(eq(workflowTurns.runId, runId))
      .run()
    repo.nativeFact(runId, 'workflow.plan_observed', { nativeId: plan.nativeId, source })
  })
}

export function recordWorkflowPlanRetained(
  repo: ConversationRepositoryHost,
  runId: string,
  evidence: CollaborationRetainedPlan,
): void {
  repo.database.transaction(() => {
    const retained = collaborationRetainedPlanSchema.parse(evidence)
    const run = repo.findRun(runId),
      turn = repo.database.select().from(workflowTurns).where(eq(workflowTurns.runId, runId)).get()
    if (!run || !turn || run.forkSourceRunId || run.controlDisposition === 'abandoned') return
    const auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson)),
      frozen = repo.decodedCollaboration(turn.stateJson)
    if (
      auth.actor !== collaborationActor(frozen, 'plan') ||
      run.agentId !== auth.actor ||
      !collaborationPlanMode(frozen, auth)
    )
      throw new RunOperationConflictError('This root does not own a plan response.')
    // Cold native readers may return legacy candidates. They cannot demote
    // or invalidate the host's already persisted final confirmation.
    const prior = workflowPlanRetention(repo, runId, turn.planNativeId)
    if (prior) {
      if (!retained.confirmation || isDeepStrictEqual(prior, retained)) return
      throw new RunOperationConflictError('A confirmed plan retention cannot be replaced.')
    }
    const basis = auth.planReference?.document
    if (
      !basis ||
      basis.sha256 !== retained.sha256 ||
      basis.bytes !== retained.bytes ||
      basis.chars !== retained.chars
    ) {
      recordWorkflowPlanUnavailable(repo, runId)
      return
    }
    const settled = workflowPlanSettlement(repo, runId)
    if (settled) {
      if (
        settled.kind === 'retained' &&
        settled.nativeId === retained.nativeId &&
        isDeepStrictEqual(settled.planReference, auth.planReference)
      )
        return
      throw new RunOperationConflictError('A settled plan result cannot be replaced.')
    }
    if (turn.planBodyId)
      throw new RunOperationConflictError(
        'A root with a new plan artifact cannot retain the prior version.',
      )
    repo.database
      .update(workflowTurns)
      .set({ planNativeId: retained.nativeId })
      .where(eq(workflowTurns.runId, runId))
      .run()
    repo.nativeFact(runId, 'workflow.plan_retained', retained)
  })
}

const MAX_OPEN_PLAN_PUBLISH_INTENTS_PER_RUN = 32

export interface WorkflowPlanRecoveryState {
  recoveryRequired: boolean
  canRecoverNow: boolean
  actor: RuntimeAgentId
  kind: 'plan' | 'response'
  retainedVersion: number
}

export function workflowOpenPlanPublishIntents(
  repo: ConversationRepositoryHost,
  runId: string,
): CollaborationOpenPlanPublishIntent[] {
  const rows = repo.database
    .select({ payload: agentEventJournal.payload })
    .from(agentEventJournal)
    .where(
      and(
        eq(agentEventJournal.runId, runId),
        eq(agentEventJournal.eventType, 'workflow.plan_publish_intent'),
      ),
    )
    .orderBy(asc(agentEventJournal.sequence))
    .limit(MAX_OPEN_PLAN_PUBLISH_INTENTS_PER_RUN)
    .all()
  return rows.map((row) => collaborationOpenPlanPublishIntentSchema.parse(JSON.parse(row.payload)))
}

export function readOpenPlanPublishIntentText(
  repo: ConversationRepositoryHost,
  runId: string,
  callKey: string,
): string | undefined {
  const run = repo.findRun(runId)
  if (!run || run.forkSourceRunId || run.controlDisposition === 'abandoned') return undefined
  const intent = workflowOpenPlanPublishIntents(repo, runId).find(
    (entry) => entry.callKey === callKey,
  )
  return intent ? repo.collaborationDocumentText(run.sessionId, intent.document) : undefined
}

export function recordOpenPlanFinalIntent(
  repo: ConversationRepositoryHost,
  runId: string,
  intent: CollaborationOpenPlanFinalIntentInput,
): CollaborationOpenPlanPublishIntent | undefined {
  const parsed = collaborationOpenPlanFinalIntentInputSchema.parse(intent)
  return repo.database.transaction(() => {
    const run = repo.findRun(runId)
    const turn = repo.database
      .select()
      .from(workflowTurns)
      .where(eq(workflowTurns.runId, runId))
      .get()
    if (!run || run.forkSourceRunId || !turn || run.controlDisposition === 'abandoned')
      return undefined
    const auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
    const frozen = repo.decodedCollaboration(turn.stateJson)
    if (!collaborationOpenPlanPublishAllowed(frozen, auth) || run.agentId !== auth.actor)
      throw new RunOperationConflictError(
        'Only an authorized open-mode turn author can record a plan publish intent.',
      )
    const candidateDigest = createHash('sha256').update(parsed.candidateMarkdown).digest('hex')
    const existing = workflowOpenPlanPublishIntents(repo, runId)
    const matched = existing.find((entry) => entry.callKey === parsed.callKey)
    if (matched) {
      if (
        matched.document.sha256 === candidateDigest &&
        matched.executionId === parsed.executionId &&
        matched.progressToken === parsed.progressToken &&
        matched.nativePlanId === parsed.nativePlanId
      )
        return matched
      throw new RunOperationConflictError(
        'Conflicting open-mode plan publish intent for the same callKey.',
      )
    }
    if (workflowPlanSettlement(repo, runId))
      throw new RunOperationConflictError('A settled plan result cannot be replaced.')
    if (existing.length >= MAX_OPEN_PLAN_PUBLISH_INTENTS_PER_RUN)
      throw new RunOperationConflictError('Too many open-mode plan publish intents for this Run.')
    const document = repo.saveCollaborationDocument(runId, parsed.candidateMarkdown)
    const fact = collaborationOpenPlanPublishIntentSchema.parse({
      runId,
      ...(parsed.executionId ? { executionId: parsed.executionId } : {}),
      actor: auth.actor,
      callKey: parsed.callKey,
      ...(parsed.progressToken ? { progressToken: parsed.progressToken } : {}),
      ...(parsed.nativePlanId ? { nativePlanId: parsed.nativePlanId } : {}),
      document,
    })
    repo.nativeFact(runId, 'workflow.plan_publish_intent', fact)
    return fact
  })
}

function resolvePlanUnavailablePausedReason(
  current: Pick<CollaborationTask, 'automation' | 'pauseReason' | 'planSyncPaused'>,
): {
  pauseReason: CollaborationTask['pauseReason']
  planSyncPaused: boolean | undefined
} {
  const hasExplicitNonFailurePause =
    current.automation === 'paused' &&
    current.pauseReason !== undefined &&
    current.pauseReason !== 'failure'
  if (hasExplicitNonFailurePause) {
    return { pauseReason: current.pauseReason, planSyncPaused: undefined }
  }
  return { pauseReason: 'failure', planSyncPaused: true }
}

function applyAppliedPlanUnavailableProjection(
  repo: ConversationRepositoryHost,
  run: AgentRun,
  turn: typeof workflowTurns.$inferSelect,
  auth: CollaborationTurnAuthorization,
  frozen: CollaborationTask,
): void {
  const task = repo.collaboration(run.sessionId)
  const taskMatches = Boolean(
    task &&
    task.id === turn.taskId &&
    task.runId === run.id &&
    task.planReference?.sourceRunId !== run.id &&
    isDeepStrictEqual(task.planReference, auth.planReference) &&
    task.inputSequence === auth.inputSequence,
  )
  if (taskMatches && task) {
    const taskDecision = collaborationInputProcessing(task).decision
    const desiredTaskStatus = taskDecision?.runId === run.id ? 'questions' : 'failed'
    const desiredTaskPause = resolvePlanUnavailablePausedReason(task)
    const taskNeedsUpdate =
      task.status !== desiredTaskStatus ||
      task.automation !== 'paused' ||
      task.pauseReason !== desiredTaskPause.pauseReason ||
      task.planSyncPaused !== desiredTaskPause.planSyncPaused ||
      task.notice !== COLLABORATION_PLAN_SYNC_FAILURE_NOTICE
    if (taskNeedsUpdate) {
      task.status = desiredTaskStatus
      task.automation = 'paused'
      task.pauseReason = desiredTaskPause.pauseReason
      if (desiredTaskPause.planSyncPaused) task.planSyncPaused = true
      else delete task.planSyncPaused
      task.notice = COLLABORATION_PLAN_SYNC_FAILURE_NOTICE
      task.revision++
      repo.saveCollaboration(task)
    }
  }
  const turnDecision = collaborationInputProcessing(frozen).decision
  const desiredTurnStatus = turnDecision?.runId === run.id ? 'questions' : 'failed'
  const desiredTurnPause = resolvePlanUnavailablePausedReason(frozen)
  const targetRevision = taskMatches && task ? task.revision : frozen.revision
  const turnNeedsUpdate =
    frozen.status !== desiredTurnStatus ||
    frozen.automation !== 'paused' ||
    frozen.pauseReason !== desiredTurnPause.pauseReason ||
    frozen.planSyncPaused !== desiredTurnPause.planSyncPaused ||
    frozen.notice !== COLLABORATION_PLAN_SYNC_FAILURE_NOTICE ||
    frozen.revision !== targetRevision
  if (turnNeedsUpdate) {
    const nextSnapshotBase: CollaborationTask = {
      ...frozen,
      status: desiredTurnStatus,
      automation: 'paused',
      pauseReason: desiredTurnPause.pauseReason,
      notice: COLLABORATION_PLAN_SYNC_FAILURE_NOTICE,
      revision: targetRevision,
    }
    if (desiredTurnPause.planSyncPaused) nextSnapshotBase.planSyncPaused = true
    else delete nextSnapshotBase.planSyncPaused
    const nextSnapshot = repo.storedCollaboration(nextSnapshotBase)
    repo.database
      .update(workflowTurns)
      .set({ stateJson: JSON.stringify(nextSnapshot) })
      .where(eq(workflowTurns.runId, run.id))
      .run()
  }
}

export function projectAppliedPlanUnavailable(
  repo: ConversationRepositoryHost,
  run: AgentRun,
  turn: Pick<typeof workflowTurns.$inferSelect, 'applied' | 'authorizationJson'>,
  snapshot: CollaborationTask,
): CollaborationTask {
  if (
    !turn.applied ||
    run.forkSourceRunId ||
    run.controlDisposition === 'abandoned' ||
    snapshot.ending ||
    snapshot.planReference?.sourceRunId === run.id ||
    workflowPlanSettled(repo, run.id) ||
    !workflowPlanCaptureFailed(repo, run.id)
  )
    return snapshot
  const auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
  const canPublish =
    collaborationPlanMode(snapshot, auth) || collaborationOpenPlanPublishAllowed(snapshot, auth)
  if (!canPublish || run.agentId !== auth.actor) return snapshot
  const snapshotDecision = collaborationInputProcessing(snapshot).decision
  const desiredStatus = snapshotDecision?.runId === run.id ? 'questions' : 'failed'
  const hasExplicitNonFailurePause =
    snapshot.automation === 'paused' &&
    snapshot.pauseReason !== undefined &&
    snapshot.pauseReason !== 'failure'
  const desiredPauseReason = hasExplicitNonFailurePause ? snapshot.pauseReason : 'failure'
  const desiredPlanSyncPaused = hasExplicitNonFailurePause ? undefined : true
  if (
    snapshot.status === desiredStatus &&
    snapshot.automation === 'paused' &&
    snapshot.pauseReason === desiredPauseReason &&
    snapshot.planSyncPaused === desiredPlanSyncPaused &&
    snapshot.notice === COLLABORATION_PLAN_SYNC_FAILURE_NOTICE
  )
    return snapshot
  const nextSnapshot: CollaborationTask = {
    ...snapshot,
    status: desiredStatus,
    automation: 'paused',
    pauseReason: desiredPauseReason,
    notice: COLLABORATION_PLAN_SYNC_FAILURE_NOTICE,
  }
  if (desiredPlanSyncPaused) nextSnapshot.planSyncPaused = true
  else delete nextSnapshot.planSyncPaused
  return nextSnapshot
}

export function recordWorkflowPlanUnavailable(
  repo: ConversationRepositoryHost,
  runId: string,
): void {
  repo.database.transaction(() => {
    const run = repo.findRun(runId)
    const turn = repo.database
      .select()
      .from(workflowTurns)
      .where(eq(workflowTurns.runId, runId))
      .get()
    if (
      !run ||
      run.forkSourceRunId ||
      !turn ||
      workflowPlanSettlement(repo, runId) ||
      (turn.applied &&
        repo.decodedCollaboration(turn.stateJson).planReference?.sourceRunId === runId) ||
      run.controlDisposition === 'abandoned'
    )
      return
    const auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
    const frozen = repo.decodedCollaboration(turn.stateJson)
    const planner = collaborationPlanMode(frozen, auth)
    const openPublisher = collaborationOpenPlanPublishAllowed(frozen, auth)
    if (
      ((!planner || auth.actor !== collaborationActor(frozen, 'plan')) && !openPublisher) ||
      run.agentId !== auth.actor
    )
      return
    const alreadyFailed = workflowPlanCaptureFailed(repo, runId)
    if (alreadyFailed && !turn.applied && turn.planNativeId === null) return
    if (turn.planNativeId !== null) {
      repo.database
        .update(workflowTurns)
        .set({ planNativeId: null })
        .where(eq(workflowTurns.runId, runId))
        .run()
    }
    if (!alreadyFailed) {
      repo.nativeFact(runId, 'workflow.plan_unavailable', {
        reason: 'The latest native plan operation could not be verified completely.',
      })
    }
    if (turn.applied) {
      applyAppliedPlanUnavailableProjection(repo, run, turn, auth, frozen)
    }
  })
}

export function workflowPlanCaptureFailed(
  repo: ConversationRepositoryHost,
  runId: string,
): boolean {
  return (
    repo.database
      .select({ eventType: agentEventJournal.eventType })
      .from(agentEventJournal)
      .where(
        and(
          eq(agentEventJournal.runId, runId),
          inArray(agentEventJournal.eventType, [
            'workflow.plan_observed',
            'workflow.plan_unavailable',
            'workflow.plan_retained',
          ]),
        ),
      )
      .orderBy(desc(agentEventJournal.sequence))
      .limit(1)
      .get()?.eventType === 'workflow.plan_unavailable'
  )
}

export function workflowPlanSettlement(
  repo: ConversationRepositoryHost,
  runId: string,
): ReturnType<typeof collaborationPlanSettlementSchema.parse> | undefined {
  const row = repo.database
    .select({ payload: agentEventJournal.payload })
    .from(agentEventJournal)
    .where(
      and(
        eq(agentEventJournal.runId, runId),
        eq(agentEventJournal.eventType, 'workflow.plan_settled'),
      ),
    )
    .orderBy(desc(agentEventJournal.sequence))
    .limit(1)
    .get()
  return row ? collaborationPlanSettlementSchema.parse(JSON.parse(row.payload)) : undefined
}

export function workflowPlanSettled(repo: ConversationRepositoryHost, runId: string): boolean {
  if (workflowPlanSettlement(repo, runId)) return true
  const turn = repo.database
    .select({ applied: workflowTurns.applied, state: workflowTurns.stateJson })
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, runId))
    .get()
  return Boolean(
    turn?.applied && repo.decodedCollaboration(turn.state).planReference?.sourceRunId === runId,
  )
}

export function workflowPlanRetention(
  repo: ConversationRepositoryHost,
  runId: string,
  nativeId: string | null,
): CollaborationRetainedPlan | undefined {
  if (!nativeId) return undefined
  const row = repo.database
    .select({ type: agentEventJournal.eventType, payload: agentEventJournal.payload })
    .from(agentEventJournal)
    .where(
      and(
        eq(agentEventJournal.runId, runId),
        inArray(agentEventJournal.eventType, [
          'workflow.plan_observed',
          'workflow.plan_unavailable',
          'workflow.plan_retained',
        ]),
      ),
    )
    .orderBy(desc(agentEventJournal.sequence))
    .limit(1)
    .get()
  if (row?.type !== 'workflow.plan_retained') return undefined
  const retained = collaborationRetainedPlanSchema.parse(JSON.parse(row.payload))
  return retained.nativeId === nativeId && retained.confirmation === 'native_root_settled_v1'
    ? retained
    : undefined
}

export function workflowPlanHasUnansweredInput(
  repo: ConversationRepositoryHost,
  runId: string,
): boolean {
  return (
    workflowInputResult(repo, runId)?.outcome === 'needs_user' ||
    Boolean(
      repo.database.get(sql`WITH accepted AS MATERIALIZED (
      SELECT json_extract(payload, '$.decision.permissionId') AS id FROM agent_event_journal
      WHERE run_id = ${runId} AND event_type = 'native.permission_decided'
        AND json_extract(payload, '$.decision.decision') = 'accept'
        AND json_extract(payload, '$.decision.source') = 'user'
    ) SELECT 1 AS blocked FROM agent_event_journal AS requested,
      json_each(requested.payload, '$.requests') AS request
      LEFT JOIN accepted ON accepted.id = json_extract(request.value, '$.id')
      WHERE requested.run_id = ${runId} AND requested.event_type = 'native.permission_requested'
        AND json_extract(request.value, '$.kind') <> 'approval' AND accepted.id IS NULL LIMIT 1`),
    )
  )
}

export function workflowPlanSourceExpected(
  repo: ConversationRepositoryHost,
  runId: string,
): boolean {
  const turn = repo.database
    .select({ state: workflowTurns.stateJson, auth: workflowTurns.authorizationJson })
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, runId))
    .get()
  if (!turn) return false
  const task = repo.decodedCollaboration(turn.state),
    auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.auth))
  return collaborationPlanMode(task, auth)
}

/** Only the current planner's frozen, published source may seed native readback. */
export function workflowPlanCheckpoint(
  repo: ConversationRepositoryHost,
  runId: string,
  nativeSessionId: string,
): { checkpoint: ClaudePlanCheckpoint; read(signal: AbortSignal): Promise<string> } | undefined {
  const run = repo.findRun(runId),
    current = run && repo.collaboration(run.sessionId),
    turn = repo.database.select().from(workflowTurns).where(eq(workflowTurns.runId, runId)).get()
  if (
    !run ||
    run.agentId !== 'claude' ||
    run.forkSourceRunId ||
    run.controlDisposition === 'abandoned' ||
    !turn ||
    current?.runId !== runId ||
    current.id !== turn.taskId
  )
    return undefined
  const auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson)),
    frozen = repo.decodedCollaboration(turn.stateJson),
    basis = auth.planReference,
    binding = repo.nativeContext(run.sessionId, 'claude')
  if (
    !basis ||
    !collaborationPlanMode(frozen, auth) ||
    auth.actor !== 'claude' ||
    auth.inputSequence !== current.inputSequence ||
    !binding ||
    binding.nativeSessionId !== nativeSessionId ||
    binding.bindingGeneration !== run.bindingGeneration ||
    (run.nativeSessionId && run.nativeSessionId !== nativeSessionId)
  )
    return undefined
  const source = repo.findRun(basis.sourceRunId),
    sourceTurn = repo.database
      .select()
      .from(workflowTurns)
      .where(eq(workflowTurns.runId, basis.sourceRunId))
      .get(),
    settled = workflowPlanSettlement(repo, basis.sourceRunId)
  if (
    !source ||
    source.id === runId ||
    source.sessionId !== run.sessionId ||
    source.agentId !== 'claude' ||
    source.forkSourceRunId ||
    source.controlDisposition === 'abandoned' ||
    source.nativeSessionId !== nativeSessionId ||
    source.bindingGeneration !== run.bindingGeneration ||
    !source.nativeTurnId ||
    source.dispatchPhase !== 'ended' ||
    source.nativeOutcome !== 'completed' ||
    source.nativeEffectsState !== 'settled' ||
    source.responseMessageId !== basis.sourceMessageId ||
    !repo.hasCompleteResponse(source.id) ||
    !sourceTurn ||
    sourceTurn.taskId !== turn.taskId ||
    !settled ||
    settled.kind !== 'published' ||
    !isDeepStrictEqual(settled.planReference, basis) ||
    sourceTurn.planNativeId !== settled.nativeId ||
    sourceTurn.planBodyId !== basis.document.id
  )
    return undefined
  // A positively observed intervening root rules out the checkpoint shortcut.
  // Native readback still verifies the full ancestor chain and all Plan operations.
  const intervening = repo.database.get(sql`SELECT 1 FROM conversation_messages m
      CROSS JOIN agent_runs r ON r.user_message_id=m.id
      WHERE m.session_id=${run.sessionId} AND m.role='user'
      AND m.sequence>(SELECT sequence FROM conversation_messages WHERE id=${source.userMessageId})
      AND m.sequence<(SELECT sequence FROM conversation_messages WHERE id=${run.userMessageId})
      AND r.agent_id='claude' AND r.native_session_id=${nativeSessionId}
      AND r.binding_generation=${run.bindingGeneration} AND r.native_turn_id IS NOT NULL
      AND r.fork_source_run_id IS NULL LIMIT 1`)
  if (intervening) return undefined
  const document = repo.collaborationDocumentRow(run.sessionId, basis.document)
  if (
    document.sourceRunId !== source.id ||
    document.ownerKey !== `collaboration:${source.id}` ||
    document.purpose !== 'collaboration'
  )
    return undefined
  const checkpoint = claudePlanCheckpointSchema.parse({
    targetRunId: runId,
    targetNativeTurnId: run.nativeTurnId ?? runId,
    nativeSessionId,
    bindingGeneration: run.bindingGeneration,
    basis,
    sourceNativeTurnId: source.nativeTurnId,
    sourceNativeId: settled.nativeId,
  })
  return {
    checkpoint,
    read: async (signal) => {
      const check = () => {
        signal.throwIfAborted()
        if (
          !isDeepStrictEqual(
            workflowPlanCheckpoint(repo, runId, nativeSessionId)?.checkpoint,
            checkpoint,
          )
        )
          throw new RunOperationConflictError('The authenticated native plan source changed.')
      }
      check()
      const chunks: string[] = []
      for (let offset = 0; offset < basis.document.chars; offset += 8192) {
        signal.throwIfAborted()
        chunks.push(
          repo.collaborationRawRange(
            run.sessionId,
            basis.document,
            offset,
            Math.min(basis.document.chars, offset + 8192),
          ),
        )
        // oxlint-disable-next-line no-await-in-loop -- The admitted native owner retains its deadline and capacity while complete source parts are read.
        await yieldImmediate(undefined, { signal })
      }
      check()
      const text = chunks.join('')
      if (
        text.length !== basis.document.chars ||
        Buffer.byteLength(text) !== basis.document.bytes ||
        createHash('sha256').update(text).digest('hex') !== basis.document.sha256
      )
        throw new RunOperationConflictError('The authenticated native plan body changed.')
      return text
    },
  }
}

/** Separate recovery need from whether recover_plan is currently executable. */
export function workflowPlanRecoveryState(
  repo: ConversationRepositoryHost,
  runId: string,
): WorkflowPlanRecoveryState | undefined {
  const run = repo.findRun(runId)
  const task = run && repo.collaboration(run.sessionId)
  const turn = repo.database
    .select()
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, runId))
    .get()
  if (
    !run ||
    run.forkSourceRunId ||
    !turn?.applied ||
    !task ||
    task.runId !== runId ||
    task.id !== turn.taskId ||
    workflowPlanSettled(repo, runId) ||
    run.controlDisposition === 'abandoned' ||
    run.dispatchPhase !== 'ended' ||
    run.nativeOutcome !== 'completed'
  )
    return undefined
  const auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
  const frozen = repo.decodedCollaboration(turn.stateJson)
  const planner = collaborationPlanMode(frozen, auth)
  const openPublisher = collaborationOpenPlanPublishAllowed(frozen, auth)
  const authorized =
    ((planner && auth.actor === collaborationActor(task, 'plan')) || openPublisher) &&
    run.agentId === auth.actor
  if (!authorized || auth.inputSequence !== task.inputSequence) return undefined
  const retained = workflowPlanRetention(repo, runId, turn.planNativeId)
  const needsRecovery =
    Boolean(turn.planBodyId || retained) || workflowPlanCaptureFailed(repo, runId)
  if (!needsRecovery) return undefined
  const decision = collaborationInputProcessing(task).decision
  const blockedByInput =
    workflowPlanHasUnansweredInput(repo, runId) || Boolean(decision && decision.runId === runId)
  return {
    recoveryRequired: true,
    canRecoverNow: !blockedByInput,
    actor: auth.actor,
    kind: retained ? 'response' : 'plan',
    retainedVersion: task.planVersion,
  }
}

/** Recovery repairs a missing result; it never resumes business work. */
export function needsWorkflowPlanRecovery(
  repo: ConversationRepositoryHost,
  runId: string,
): boolean {
  return Boolean(workflowPlanRecoveryState(repo, runId)?.canRecoverNow)
}

/** Normal completion and late recovery share one plan-result settlement. */
export function settleWorkflowPlan(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  run: AgentRun,
  auth: CollaborationTurnAuthorization,
  turn: typeof workflowTurns.$inferSelect,
): boolean {
  if (workflowPlanSettled(repo, run.id)) return false
  const context = repo.nativeContext(run.sessionId, run.agentId)
  const frozen = repo.decodedCollaboration(turn.stateJson)
  const openPublisher = collaborationOpenPlanPublishAllowed(frozen, auth)
  if (
    task.runId !== run.id ||
    task.id !== auth.taskId ||
    (!openPublisher && collaborationActor(task, 'plan') !== auth.actor) ||
    run.agentId !== auth.actor ||
    task.inputSequence !== auth.inputSequence ||
    task.planVersion !== (auth.planReference?.version ?? 0) ||
    !isDeepStrictEqual(task.planReference, auth.planReference) ||
    run.forkSourceRunId ||
    run.controlDisposition === 'abandoned' ||
    run.dispatchPhase !== 'ended' ||
    run.nativeOutcome !== 'completed' ||
    run.nativeEffectsState !== 'settled' ||
    !repo.hasCompleteResponse(run.id) ||
    workflowPlanHasUnansweredInput(repo, run.id) ||
    !context ||
    context.nativeSessionId !== run.nativeSessionId ||
    context.bindingGeneration !== run.bindingGeneration ||
    !repo.isCurrentNativeCursor(run, context) ||
    !turn.planNativeId
  )
    return false
  const document = turn.planBodyId
    ? repo.documentReference(run.sessionId, turn.planBodyId)
    : undefined
  const retained = !document ? workflowPlanRetention(repo, run.id, turn.planNativeId) : undefined
  const result = workflowInputResult(repo, run.id)
  if (result && !(result.outcome === 'explanation_only' && retained)) return false
  if (document) {
    task.planAcceptanceCoverage = undefined
    const changed = task.planReference?.document.sha256 !== document.sha256
    task.planVersion = changed ? task.planVersion + 1 : Math.max(1, task.planVersion)
    task.planAuthor = auth.actor
    task.planReference = {
      version: task.planVersion,
      author: auth.actor,
      sourceRunId: run.id,
      sourceMessageId: run.responseMessageId ?? run.userMessageId,
      document,
    }
  } else {
    const basis = auth.planReference?.document
    const response = run.responseMessageId
      ? repo.messageDocument(run.sessionId, run.id, run.responseMessageId)
      : undefined
    if (
      !retained ||
      !basis ||
      !response?.chars ||
      workflowPlanHasUnansweredInput(repo, run.id) ||
      retained.sha256 !== basis.sha256 ||
      retained.bytes !== basis.bytes ||
      retained.chars !== basis.chars
    )
      return false
  }
  // Advancement is a result of the same authenticated settlement for live and recovered turns.
  task.handledInputSequence = Math.max(task.handledInputSequence, auth.inputSequence)
  task.planInputSequence = auth.inputSequence
  task.sourceMessageId = run.responseMessageId ?? run.userMessageId
  repo.nativeFact(
    run.id,
    'workflow.plan_settled',
    collaborationPlanSettlementSchema.parse({
      kind: document ? 'published' : 'retained',
      nativeId: turn.planNativeId,
      planReference: task.planReference,
      sourceMessageId: task.sourceMessageId,
      inputSequence: auth.inputSequence,
    }),
  )
  return true
}

export function recoverAppliedWorkflowResult(
  repo: ConversationRepositoryHost,
  runId: string,
): void {
  repo.database.transaction(() => {
    const run = repo.findRun(runId),
      turn = repo.database.select().from(workflowTurns).where(eq(workflowTurns.runId, runId)).get()
    if (
      !run ||
      run.forkSourceRunId ||
      run.controlDisposition === 'abandoned' ||
      repo.hasCommittedUserStop(run.id) ||
      !turn?.applied
    )
      return
    const task = repo.collaboration(run.sessionId),
      auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson)),
      frozen = repo.decodedCollaboration(turn.stateJson)
    if (auth.replyIntentBasis?.kind === 'ask_only') {
      if (
        task &&
        collaborationInputProcessing(task).pending?.inputId === auth.replyIntentBasis.inputId
      )
        finishAskOnly(repo, task, run, auth, run.nativeOutcome === 'completed')
      return
    }
    if (task && auth.stage === 'reply' && !collaborationPlanMode(frozen, auth)) {
      if (!workflowInputResult(repo, runId) || !collaborationInputProcessing(task).pending) return
      const before = { input: task.inputProcessing, status: task.status, notice: task.notice }
      if (settleWorkflowInput(repo, task, run, auth, turn, false)) {
        const explanationRestored = Boolean(
          task.inputProcessing?.settled?.runId === run.id && task.inputProcessing.settled.unchanged,
        )
        if (!explanationRestored)
          Object.assign(task, settleCollaborationStage(task, { kind: 'recovered_reply' }))
      }
      if (
        isDeepStrictEqual(before, {
          input: task.inputProcessing,
          status: task.status,
          notice: task.notice,
        })
      )
        return
      task.revision++
      repo.saveCollaboration(task)
      repo.database
        .update(workflowTurns)
        .set({ stateJson: JSON.stringify(repo.storedCollaboration(task)) })
        .where(eq(workflowTurns.runId, runId))
        .run()
      return
    }
    const planner = collaborationPlanMode(frozen, auth)
    const openPublisher = collaborationOpenPlanPublishAllowed(frozen, auth)
    const canPublishPlan = planner || openPublisher
    if (!turn.planNativeId) {
      if (
        canPublishPlan &&
        run.agentId === auth.actor &&
        !workflowPlanSettled(repo, runId) &&
        workflowPlanCaptureFailed(repo, runId)
      ) {
        applyAppliedPlanUnavailableProjection(repo, run, turn, auth, frozen)
      }
      return
    }
    if (
      !task ||
      task.id !== turn.taskId ||
      task.runId !== runId ||
      task.stage !== auth.stage ||
      !canPublishPlan ||
      (!openPublisher && auth.actor !== collaborationActor(task, 'plan')) ||
      run.agentId !== auth.actor ||
      task.inputSequence !== auth.inputSequence ||
      !isDeepStrictEqual(task.planReference, auth.planReference) ||
      (task.planAcceptanceCoverage?.producerRunId === runId && collaborationPlanAccepted(task))
    )
      return
    const planCaptureFailed = workflowPlanCaptureFailed(repo, runId)
    if (
      workflowPlanHasUnansweredInput(repo, runId) &&
      repo.ownsNativeControl(runId) &&
      task.inputSequence === auth.inputSequence &&
      isDeepStrictEqual(task.planReference, auth.planReference)
    ) {
      const needsDecisionUpdate =
        task.status !== 'questions' ||
        collaborationInputProcessing(task).decision?.runId !== runId ||
        (planCaptureFailed &&
          (task.automation !== 'paused' ||
            task.pauseReason !== 'failure' ||
            task.notice !== COLLABORATION_PLAN_SYNC_FAILURE_NOTICE))
      if (needsDecisionUpdate) {
        const decision = {
          runId,
          inputSequence: auth.inputSequence,
          ...(run.responseMessageId ? { messageId: run.responseMessageId } : {}),
          questions: bindCollaborationQuestions(workflowInputResult(repo, runId)?.questions),
          actor: auth.actor,
        }
        Object.assign(
          task,
          settleCollaborationStage(
            task,
            auth.stage === 'collaborate'
              ? {
                  kind: 'collaborate',
                  authorization: auth,
                  hasCodeChanges: repo.runHasRecordedCodeChanges(run.sessionId, runId),
                  hasPublishedPlan: false,
                  ...(planCaptureFailed ? { planCaptureFailed: true } : {}),
                  decision,
                }
              : auth.stage === 'implement' || auth.stage === 'repair' || auth.stage === 'respond'
                ? {
                    kind: 'work',
                    authorization: { ...auth, stage: auth.stage },
                    hasCodeChanges: repo.runHasRecordedCodeChanges(run.sessionId, runId),
                    hasPublishedPlan: false,
                    ...(planCaptureFailed ? { planCaptureFailed: true } : {}),
                    decision,
                  }
                : {
                    kind: 'plan',
                    authorization: auth,
                    settled: false,
                    supersededInput: false,
                    observed: false,
                    decision,
                  },
          ),
        )
        task.revision++
        repo.saveCollaboration(task)
        repo.database
          .update(workflowTurns)
          .set({
            stateJson: JSON.stringify(
              repo.storedCollaboration({
                ...task,
                inputSequence: auth.inputSequence,
                handledInputSequence: Math.min(task.handledInputSequence, auth.inputSequence),
                latestUserMessageId: frozen.latestUserMessageId,
              }),
            ),
          })
          .where(eq(workflowTurns.runId, runId))
          .run()
      }
      return
    }
    if (!settleWorkflowPlan(repo, task, run, auth, turn)) return
    if (isCollaborationOpenMode(task)) {
      Object.assign(
        task,
        settleCollaborationStage(task, { kind: 'recovered_plan', actor: auth.actor }),
      )
    } else {
      Object.assign(task, settleCollaborationStage(task, { kind: 'recovered_plan' }))
    }
    if (
      auth.stage === 'reply' &&
      !settleWorkflowInput(repo, task, run, auth, turn, true) &&
      task.status === 'waiting'
    )
      Object.assign(
        task,
        settleCollaborationStage(task, { kind: 'unavailable', reason: 'recovered_reply' }),
      )
    task.revision++
    repo.saveCollaboration(task)
    repo.database
      .update(workflowTurns)
      .set({
        stateJson: JSON.stringify(
          repo.storedCollaboration({
            ...task,
            inputSequence: auth.inputSequence,
            handledInputSequence: Math.min(task.handledInputSequence, auth.inputSequence),
            latestUserMessageId: frozen.latestUserMessageId,
          }),
        ),
      })
      .where(eq(workflowTurns.runId, runId))
      .run()
    repo.nativeFact(runId, 'workflow.plan_recovered', {
      nativeId: turn.planNativeId,
      version: task.planVersion,
      source: task.planReference?.document,
    })
  })
}

export function workflowInputResult(
  repo: ConversationRepositoryHost,
  runId: string,
): CollaborationInputObservation | undefined {
  const row = repo.database
    .select({ payload: agentEventJournal.payload })
    .from(agentEventJournal)
    .where(
      and(
        eq(agentEventJournal.runId, runId),
        eq(agentEventJournal.eventType, 'workflow.input_result_observed'),
      ),
    )
    .orderBy(desc(agentEventJournal.sequence))
    .limit(1)
    .get()
  return row ? collaborationInputObservationSchema.parse(JSON.parse(row.payload)) : undefined
}

export function recordWorkflowInputResult(
  repo: ConversationRepositoryHost,
  runId: string,
  result: CollaborationInputObservation,
): void {
  repo.database.transaction(() => {
    const run = repo.findRun(runId)
    const turn = repo.database
      .select()
      .from(workflowTurns)
      .where(eq(workflowTurns.runId, runId))
      .get()
    if (
      !run ||
      !turn ||
      run.forkSourceRunId ||
      run.controlDisposition === 'abandoned' ||
      !repo.ownsNativeControl(runId)
    )
      return
    const auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
    const frozen = repo.decodedCollaboration(turn.stateJson)
    const pending = (auth.inputProcessing ?? collaborationInputProcessing(frozen)).pending
    const planner = collaborationPlanMode(frozen, auth)
    const parsed = collaborationInputObservationSchema.parse(result)
    if (
      auth.actor !== run.agentId ||
      !collaborationInputOutcomeAllowed(frozen, auth, parsed.outcome) ||
      (!planner &&
        !['reply', 'collaborate'].includes(auth.stage) &&
        (!pending || pending.inputSequence !== auth.inputSequence)) ||
      (!planner &&
        auth.stage === 'reply' &&
        (!pending || pending.inputSequence !== auth.inputSequence))
    )
      throw new RunOperationConflictError('This Turn does not own this input result.')
    const current = repo.collaboration(run.sessionId)
    if (parsed.outcome === 'plan_revision_required') {
      if (
        !current ||
        current.id !== auth.taskId ||
        current.runId !== run.id ||
        current.inputSequence < auth.inputSequence ||
        pending?.inputId !== run.userMessageId ||
        !auth.inputBatchRef ||
        !isDeepStrictEqual(current.authorization, auth) ||
        turn.applied
      )
        return
      // A newer queued input supersedes this reply's settlement, but does not retire
      // its native root or the restriction established by an authenticated tool result.
      const batchOwner = run.reexecutedFromRunId
        ? originalPactUnsentTurn(repo, run, auth)?.run
        : run
      const batch =
        batchOwner &&
        repo.database
          .select({ id: conversationInputBatches.id })
          .from(conversationInputBatches)
          .where(
            and(
              eq(conversationInputBatches.id, auth.inputBatchRef.id),
              eq(conversationInputBatches.taskId, auth.taskId),
              eq(conversationInputBatches.sessionId, run.sessionId),
              eq(conversationInputBatches.runId, batchOwner.id),
              eq(conversationInputBatches.messageId, run.userMessageId),
              eq(conversationInputBatches.sequence, auth.inputSequence),
              eq(conversationInputBatches.actor, auth.actor),
              eq(conversationInputBatches.commentsRevision, auth.inputBatchRef.revision),
              eq(conversationInputBatches.memberCount, auth.inputBatchRef.memberCount),
              ne(conversationInputBatches.bodyState, 'withdrawn'),
            ),
          )
          .get()
      if (!batch) return
      if (!current.planRevision) {
        const writeRunId = auth.planRevisionWriteRunId!
        const planReference = auth.planReference
        if (
          !planReference ||
          writeRunId !== (current.pendingWork?.runId ?? current.codeRunId) ||
          !isDeepStrictEqual(current.planReference, planReference)
        )
          throw new RunOperationConflictError('The original Plan write basis changed.')
        const revision: NonNullable<CollaborationTask['planRevision']> = {
          origin: 'agent',
          requestRunId: run.id,
          inputSequence: auth.inputSequence,
          writeRunId,
          planReference,
          ...(current.planInputSequence !== undefined
            ? { priorPlanInputSequence: current.planInputSequence }
            : {}),
          ...(current.review ? { priorReviewRunId: current.review.runId } : {}),
        }
        current.planRevision = revision
        current.automation = 'paused'
        current.pauseReason ??= 'user'
        current.revision++
        repo.saveCollaboration(current)
        repo.nativeFact(run.id, 'workflow.plan_revision_required', revision)
      }
    }
    const old = workflowInputResult(repo, runId)
    if (isDeepStrictEqual(old, parsed) || old?.outcome === 'incomplete') return
    if (collaborationInputProcessing(current ?? frozen).settled?.runId === runId)
      throw new RunOperationConflictError('A settled input result cannot change.')
    repo.nativeFact(
      runId,
      'workflow.input_result_observed',
      old ? { outcome: 'incomplete' } : parsed,
    )
  })
}

/** A replacement may use the original Batch or grant only through its admitted unsent lineage. */
function originalPactUnsentTurn(
  repo: ConversationRepositoryHost,
  run: AgentRun,
  auth: CollaborationTurnAuthorization,
) {
  if (!run.reexecutedFromRunId) return undefined
  const replacement = repo.database
    .select({ operationId: agentRuns.reexecutionOperationId })
    .from(agentRuns)
    .where(eq(agentRuns.id, run.id))
    .get()
  const operation = repo.database
    .select()
    .from(runReexecutionOperations)
    .where(eq(runReexecutionOperations.replacementRunId, run.id))
    .get()
  const original = operation && repo.findRun(operation.originalRunId)
  const originalAuth = original && collaborationTurnAuthorization(repo, original.id)
  const capture = original && repo.executionInput(original.id)
  if (
    !operation ||
    operation.id !== replacement?.operationId ||
    operation.originalRunId !== run.reexecutedFromRunId ||
    !original ||
    original.reexecutedFromRunId ||
    !originalAuth ||
    !capture?.proof ||
    !repo.workflowInputWasNotSent(original) ||
    original.sessionId !== run.sessionId ||
    original.agentId !== run.agentId ||
    original.userMessageId !== run.userMessageId ||
    original.settingsRevision !== run.settingsRevision ||
    capture.proof.runId !== original.id ||
    capture.proof.inputSha256 !== capture.input.inputSha256 ||
    capture.proof.nativeSessionId !== run.nativeSessionId ||
    capture.proof.bindingGeneration !== run.bindingGeneration ||
    !isDeepStrictEqual(
      {
        ...auth,
        runId: original.id,
        taskRevision: originalAuth.taskRevision,
      },
      originalAuth,
    )
  )
    return undefined
  return { run: original, auth: originalAuth }
}

export function currentReplyIntent(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  run: AgentRun,
  auth: CollaborationTurnAuthorization,
): CollaborationReplyIntentBasis | undefined {
  const intent = auth.replyIntentBasis
  if (
    !intent ||
    intent.inputId !== run.userMessageId ||
    auth.inputSequence !== intent.priorInputSequence + (intent.kind === 'ask_only' ? 0 : 1) ||
    task.inputSequence !== auth.inputSequence ||
    !isDeepStrictEqual(task.review, intent.review) ||
    !isDeepStrictEqual(task.stageRoles, intent.stageRoles) ||
    !isDeepStrictEqual(task.planReference, intent.planReference)
  )
    return undefined
  const predecessor = originalPactUnsentTurn(repo, run, auth)
  if (run.reexecutedFromRunId && !predecessor) return undefined
  const received = repo.database
    .select({ digest: collaborationInputs.digest, metadata: collaborationInputs.metadataJson })
    .from(collaborationInputs)
    .where(
      and(
        eq(collaborationInputs.id, intent.inputId),
        eq(collaborationInputs.sessionId, task.sessionId),
        eq(collaborationInputs.taskId, task.id),
        eq(collaborationInputs.state, 'materialized'),
        eq(collaborationInputs.materializedRunId, predecessor?.run.id ?? run.id),
      ),
    )
    .get()
  return received?.digest === intent.inputDigest &&
    isDeepStrictEqual(storedReceivedMetadata(received.metadata).replyIntentBasis, intent)
    ? intent
    : undefined
}

export function finishAskOnly(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  run: AgentRun,
  auth: CollaborationTurnAuthorization,
  nativeCompleted: boolean,
  notice?: string,
): void {
  const intent = auth.replyIntentBasis
  const state = collaborationInputProcessing(task)
  const pending = state.pending
  if (intent?.kind !== 'ask_only' || task.runId !== run.id) return
  const own = pending?.inputId === intent.inputId && pending.inputSequence === auth.inputSequence
  const newer =
    task.inputSequence > auth.inputSequence &&
    (!pending || pending.inputSequence > auth.inputSequence)
  if (!own && !newer) return
  const ended =
    run.dispatchPhase === 'ended' &&
    Boolean(run.nativeOutcome) &&
    run.nativeEffectsState === 'settled'
  const unstarted = repo.workflowInputWasNotSent(run)
  if (!ended && !unstarted) {
    if (!nativeCompleted || run.nativeEffectsState === 'unknown') {
      task.status = 'failed'
      task.automation = 'paused'
      task.pauseReason ??= 'failure'
      task.notice = (notice ?? 'Check the original question before continuing.').slice(0, 512)
      task.revision++
      repo.saveCollaboration(task)
    }
    return
  }
  if (nativeCompleted && !repo.hasCompleteResponse(run.id) && run.status !== 'completed') return
  const report =
    nativeCompleted && run.responseMessageId && repo.hasCompleteResponse(run.id)
      ? repo.messageDocument(run.sessionId, run.id, run.responseMessageId)
      : undefined
  if (newer) {
    // Newer ordinary input supersedes this question; never restore its checkpoint over it.
    task.status = 'waiting'
    task.nextStage = undefined
    if (ended && run.nativeOutcome !== 'completed' && task.automation === 'active') {
      task.automation = 'paused'
      task.pauseReason = run.nativeOutcome === 'interrupted' ? 'stopped' : 'failure'
      task.notice = (notice ?? 'The question did not complete.').slice(0, 512)
    }
  } else {
    const batch =
      auth.inputBatchRef &&
      repo.database
        .select()
        .from(conversationInputBatches)
        .where(eq(conversationInputBatches.id, auth.inputBatchRef.id))
        .get()
    const binding = repo.nativeContext(run.sessionId, run.agentId)
    const settled = Boolean(
      report &&
      report.chars &&
      auth.stage === 'reply' &&
      auth.actor === run.agentId &&
      task.id === auth.taskId &&
      run.id === auth.runId &&
      currentReplyIntent(repo, task, run, auth) &&
      batch &&
      batch.sessionId === task.sessionId &&
      batch.taskId === null &&
      batch.sequence === 0 &&
      batch.memberCount === 0 &&
      batch.runId === run.id &&
      batch.messageId === intent.inputId &&
      batch.bodyState !== 'withdrawn' &&
      intent.askBinding &&
      binding &&
      binding.nativeSessionId === run.nativeSessionId &&
      binding.bindingGeneration === run.bindingGeneration &&
      binding.nativeSessionId === intent.askBinding.nativeSessionId &&
      binding.bindingGeneration === intent.askBinding.generation &&
      repo.isCurrentNativeCursor(run, binding) &&
      (intent.askCheckpoint ||
        collaborationPlanAccepted({
          ...task,
          inputProcessing: { ...state, pending: undefined },
        })),
    )
    task.inputProcessing = { ...state, pending: undefined }
    if (settled) {
      task.sourceMessageId = run.responseMessageId
      restoreAskCheckpoint(repo, task, intent, 'restored')
      repo.nativeFact(run.id, 'workflow.plan_question_answered', {
        inputId: intent.inputId,
        ...(intent.review ? { reviewRunId: intent.review.runId } : {}),
      })
    } else {
      task.automation = 'paused'
      task.pauseReason ??= run.nativeOutcome === 'interrupted' ? 'stopped' : 'failure'
      restoreAskCheckpoint(repo, task, intent, 'failed')
      task.notice = (notice ?? 'The question did not complete with its original sources.').slice(
        0,
        512,
      )
    }
  }
  task.revision++
  repo.saveCollaboration(task)
  repo.database
    .update(workflowTurns)
    .set({
      applied: true,
      reportBodyId: report ? report.id : null,
      stateJson: JSON.stringify(repo.storedCollaboration(task)),
    })
    .where(eq(workflowTurns.runId, run.id))
    .run()
}

/**
 * Return a finished or withdrawn Ask to the checkpoint its host receipt froze. A pause
 * imposed after the checkpoint stays authoritative over the frozen automation.
 */
export function restoreAskCheckpoint(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  intent: CollaborationReplyIntentBasis,
  outcome: 'restored' | 'failed',
  notice?: string,
): void {
  const checkpoint = intent.askCheckpoint
  if (checkpoint) {
    task.stage = checkpoint.stage
    task.actor = checkpoint.actor
    task.nextStage = checkpoint.nextStage
  } else {
    task.nextStage = undefined
  }
  if (outcome === 'failed') {
    // Keep the paused/recovery state the caller already set; only the stage returns.
    task.status = 'failed'
    return
  }
  const laterPause =
    checkpoint !== undefined &&
    task.automation === 'paused' &&
    (checkpoint.automation !== 'paused' || task.pauseReason !== checkpoint.pauseReason)
  if (laterPause) {
    task.status = 'waiting'
    if (notice !== undefined) task.notice = notice
    return
  }
  if (checkpoint) {
    task.status = checkpoint.status
    task.automation = checkpoint.automation
    task.pauseReason = checkpoint.pauseReason
    task.notice = notice ?? checkpoint.notice
    return
  }
  // Legacy Asks return to the accepted-Plan checkpoint.
  task.status = collaborationPlanAccepted(task) ? 'ready' : 'waiting'
  if (notice !== undefined || task.automation !== 'paused') task.notice = notice
}

/** Only this frozen reply can acknowledge its real input, after native and source settlement. */
export function settleWorkflowInput(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  run: AgentRun,
  auth: CollaborationTurnAuthorization,
  turn: typeof workflowTurns.$inferSelect,
  planSettled: boolean,
): boolean {
  const state = collaborationInputProcessing(task)
  const frozen = repo.decodedCollaboration(turn.stateJson)
  const pending = (auth.inputProcessing ?? collaborationInputProcessing(frozen)).pending
  const binding = repo.nativeContext(run.sessionId, run.agentId)
  if (
    auth.stage !== 'reply' ||
    !pending ||
    pending.inputSequence !== auth.inputSequence ||
    state.pending?.inputSequence !== auth.inputSequence ||
    task.id !== auth.taskId ||
    task.runId !== run.id ||
    auth.actor !== run.agentId ||
    run.forkSourceRunId ||
    run.controlDisposition === 'abandoned' ||
    run.dispatchPhase !== 'ended' ||
    run.nativeOutcome !== 'completed' ||
    run.nativeEffectsState !== 'settled' ||
    !repo.hasCompleteResponse(run.id) ||
    !binding ||
    binding.bindingGeneration !== run.bindingGeneration ||
    binding.nativeSessionId !== run.nativeSessionId ||
    !repo.isCurrentNativeCursor(run, binding)
  )
    return false
  const planner = collaborationPlanMode(frozen, auth)
  if (task.inputSequence !== auth.inputSequence) {
    const later = repo.database
      .select({
        total: sql<number>`count(*)`,
        withdrawn: sql<number>`coalesce(sum(case when ${conversationInputBatches.bodyState} = 'withdrawn' then 1 else 0 end), 0)`,
      })
      .from(conversationInputBatches)
      .where(
        and(
          eq(conversationInputBatches.taskId, task.id),
          gt(conversationInputBatches.sequence, auth.inputSequence),
          lte(conversationInputBatches.sequence, task.inputSequence),
        ),
      )
      .get()
    if (
      !later ||
      later.total !== task.inputSequence - auth.inputSequence ||
      later.withdrawn !== later.total
    )
      return false
    // Withdrawal does not rewrite a planner's frozen source/input authority.
    if (planner) {
      Object.assign(task, settleCollaborationStage(task, { kind: 'input_plan_withdrawn' }))
      return false
    }
  }
  const result = workflowInputResult(repo, run.id)
  const observed = result?.outcome
  const outcome =
    observed === 'explanation_only'
      ? 'explanation_only'
      : planner
        ? planSettled
          ? 'processed'
          : undefined
        : observed
  const unanswered = workflowPlanHasUnansweredInput(repo, run.id)
  if (
    !unanswered &&
    outcome === 'explanation_only' &&
    settleExplanationOnly(repo, task, run, auth, turn, planSettled)
  )
    return true
  if (
    !unanswered &&
    (outcome === 'processed' ||
      (outcome === 'plan_revision_required' && task.planRevision && !result?.questions))
  ) {
    Object.assign(
      task,
      settleCollaborationStage(task, {
        kind: 'input_processed',
        runId: run.id,
        inputSequence: auth.inputSequence,
      }),
    )
    repo.nativeFact(run.id, 'workflow.input_settled', { inputSequence: auth.inputSequence })
    return true
  }
  // A newer received input supersedes this unconfirmed root; its own reply settles it.
  if (repo.receivedCollaborationInput(task.sessionId)) return false
  const needsUser =
    unanswered ||
    outcome === 'needs_user' ||
    (outcome === 'plan_revision_required' && Boolean(task.planRevision && result?.questions))
  const settlement = needsUser
    ? {
        kind: 'input_needs_user' as const,
        decision: {
          runId: run.id,
          inputSequence: auth.inputSequence,
          ...(run.responseMessageId ? { messageId: run.responseMessageId } : {}),
          questions: bindCollaborationQuestions(workflowInputResult(repo, run.id)?.questions),
          actor: auth.actor,
        },
      }
    : { kind: 'input_unconfirmed' as const }
  Object.assign(task, settleCollaborationStage(task, settlement))
  return false
}

/**
 * A proven pure explanation keeps the real input receipt and restores the frozen
 * checkpoint; the settled receipt carries the prior material basis, never the
 * question itself. No review, Plan, role or pending-work authority follows.
 */
function settleExplanationOnly(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  run: AgentRun,
  auth: CollaborationTurnAuthorization,
  turn: typeof workflowTurns.$inferSelect,
  planSettled: boolean,
): boolean {
  const intent = currentReplyIntent(repo, task, run, auth)
  const checkpoint = intent?.askCheckpoint
  const frozen = repo.decodedCollaboration(turn.stateJson)
  if (
    intent?.kind !== 'explanation_only' ||
    !checkpoint?.inputBasis ||
    task.inputSequence !== auth.inputSequence ||
    repo.receivedCollaborationInput(task.sessionId) ||
    !isDeepStrictEqual(task.pendingWork, frozen.pendingWork) ||
    !isDeepStrictEqual(task.codeRunId, frozen.codeRunId) ||
    !isDeepStrictEqual(task.planRevision, frozen.planRevision) ||
    turn.planBodyId ||
    workflowPlanCaptureFailed(repo, run.id)
  )
    return false
  if (collaborationPlanMode(frozen, auth)) {
    if (intent.planReference) {
      // A planning reply with an existing Plan must prove native retention.
      if (!planSettled || !turn.planNativeId) return false
    } else if (turn.planNativeId) {
      return false
    }
  } else if (turn.planNativeId) {
    return false
  }
  task.inputProcessing = {
    settled: {
      runId: run.id,
      inputSequence: auth.inputSequence,
      unchanged: checkpoint.inputBasis,
    },
  }
  task.handledInputSequence = auth.inputSequence
  task.planInputSequence = checkpoint.planInputSequence
  task.sourceMessageId = run.responseMessageId ?? run.userMessageId
  restoreAskCheckpoint(repo, task, intent, 'restored')
  repo.nativeFact(run.id, 'workflow.explanation_settled', {
    inputId: intent.inputId,
    inputDigest: intent.inputDigest,
    inputSequence: auth.inputSequence,
    basis: checkpoint.inputBasis,
  })
  return true
}

export function workflowReviewResult(
  repo: ConversationRepositoryHost,
  runId: string,
): CollaborationReviewObservation | undefined {
  const row = repo.database
    .select({ payload: agentEventJournal.payload })
    .from(agentEventJournal)
    .where(
      and(
        eq(agentEventJournal.runId, runId),
        eq(agentEventJournal.eventType, 'workflow.review_observed'),
      ),
    )
    .orderBy(desc(agentEventJournal.sequence))
    .limit(1)
    .get()
  if (!row) return undefined
  const value = JSON.parse(row.payload)
  return value.conflict
    ? { verdict: 'incomplete' }
    : collaborationReviewObservationSchema.parse({
        verdict: value.verdict,
        ...(value.questions ? { questions: value.questions } : {}),
      })
}

export function recordWorkflowReview(
  repo: ConversationRepositoryHost,
  runId: string,
  result: CollaborationReviewObservation,
): void {
  repo.database.transaction(() => {
    const run = repo.findRun(runId)
    const turn = repo.database
      .select()
      .from(workflowTurns)
      .where(eq(workflowTurns.runId, runId))
      .get()
    if (!run || run.forkSourceRunId || !turn || run.controlDisposition === 'abandoned') return
    const auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
    if (
      !['plan_review', 'code_review'].includes(auth.stage) ||
      auth.actor !== run.agentId ||
      auth.actor !== collaborationActor(repo.decodedCollaboration(turn.stateJson), auth.stage)
    )
      throw new RunOperationConflictError('This Turn does not own an independent review.')
    const parsed = collaborationReviewObservationSchema.parse(result)
    const old = workflowReviewResult(repo, runId)
    if (isDeepStrictEqual(old, parsed) || turn.verdictConflict) return
    if (turn.applied)
      throw new RunOperationConflictError('A completed review cannot change its result.')
    const conflict =
      Boolean(old && !isDeepStrictEqual(old, parsed)) ||
      (turn.verdict !== null && turn.verdict !== parsed.verdict)
    repo.database
      .update(workflowTurns)
      .set({ verdict: parsed.verdict, verdictConflict: conflict })
      .where(eq(workflowTurns.runId, runId))
      .run()
    repo.nativeFact(runId, 'workflow.review_observed', { ...parsed, conflict })
  })
}

export function pendingWorkflowTasks(
  repo: ConversationRepositoryHost,
  after?: { updatedAt: string; id: string },
) {
  return repo.database
    .select({
      sessionId: collaborationTasks.sessionId,
      id: collaborationTasks.id,
      updatedAt: collaborationTasks.updatedAt,
    })
    .from(collaborationTasks)
    .where(
      and(
        eq(collaborationTasks.active, true),
        sql`json_extract(${collaborationTasks.stateJson}, '$.protocol') = ${COLLABORATION_PROTOCOL}`,
        sql`(json_extract(${collaborationTasks.stateJson}, '$.automation') = 'active' OR (json_extract(${collaborationTasks.stateJson}, '$.automation') = 'paused' AND json_extract(${collaborationTasks.stateJson}, '$.pauseReason') = 'limit' AND json_extract(${collaborationTasks.stateJson}, '$.kind') = 'plan' AND json_extract(${collaborationTasks.stateJson}, '$.stage') IN ('plan','reply')))`,
        sql`json_extract(${collaborationTasks.stateJson}, '$.status') IN ('waiting','ready')`,
        after
          ? sql`(${collaborationTasks.updatedAt}, ${collaborationTasks.id}) > (${after.updatedAt}, ${after.id})`
          : undefined,
      ),
    )
    .orderBy(asc(collaborationTasks.updatedAt), asc(collaborationTasks.id))
    .limit(5)
    .all()
}

export function registerWorkflowInput(
  repo: ConversationRepositoryHost,
  sessionId: string,
  messageId: string,
  askOnly = false,
): void {
  const task = repo.collaboration(sessionId)
  if (!task || task.status === 'complete') return
  task.inputProcessing = {
    ...collaborationInputProcessing(task),
    pending: { inputId: messageId, inputSequence: task.inputSequence },
  }
  if (!askOnly) task.latestUserMessageId = messageId
  task.revision++
  task.notice = askOnly
    ? 'Your question will be answered next.'
    : 'Your message will be answered before collaboration continues.'
  if (task.status !== 'running') task.status = 'waiting'
  repo.saveCollaboration(task)
}

export function isInTaskReviewCommand(
  repo: ConversationRepositoryHost,
  task: CollaborationTask | undefined,
  command: 'plan' | 'build' | 'review' | undefined,
): boolean {
  return Boolean(
    task &&
    !task.ending &&
    task.status !== 'complete' &&
    command === 'review' &&
    isCollaborationOpenMode(task) &&
    (task.kind === 'plan' || task.kind === 'build'),
  )
}

export function workflowReply(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  actor: RuntimeAgentId,
  askOnly = false,
): CollaborationTask {
  if (task.status === 'running')
    throw new RunOperationConflictError('The current Agent is still working.')
  const open = !askOnly && isCollaborationOpenMode(task)
  const next = {
    ...task,
    inputProcessing: collaborationInputProcessing(task),
    stage: open ? ('collaborate' as const) : ('reply' as const),
    actor,
    ...(open
      ? {
          openMode: true,
          automation: 'active' as const,
          pauseReason: undefined,
          notice: undefined,
        }
      : {}),
    status: 'running' as const,
    authorization: undefined,
    revision: task.revision + 1,
  }
  return collaborationTaskSchema.parse(next)
}

export function workflowInTaskReview(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  explicitReviewer?: RuntimeAgentId,
): CollaborationTask {
  if (task.status === 'running')
    throw new RunOperationConflictError('The current Agent is still working.')
  const peerBase =
    task.unreviewedCodeActor ?? task.lastCodeActor ?? collaborationActor(task, 'implement')
  const taskPair = task.owner !== task.reviewer ? ([task.owner, task.reviewer] as const) : undefined
  const reviewer = explicitReviewer ?? otherAgent(peerBase, taskPair)
  return collaborationTaskSchema.parse({
    ...task,
    inputProcessing: collaborationInputProcessing(task),
    openMode: true,
    stage: 'code_review',
    actor: reviewer,
    status: 'running',
    automation: 'active',
    pauseReason: undefined,
    nextStage: undefined,
    authorization: undefined,
    notice: undefined,
    reviewCycles: task.reviewCycles + 1,
    revision: task.revision + 1,
  })
}

export function adoptOpenModeInputRecipient(
  repo: ConversationRepositoryHost,
  sessionId: string,
  inputId: string,
  actor: RuntimeAgentId,
): void {
  repo.database.transaction((transaction) => {
    const updated = transaction
      .update(collaborationInputs)
      .set({ actor })
      .where(
        and(
          eq(collaborationInputs.id, inputId),
          eq(collaborationInputs.sessionId, sessionId),
          eq(collaborationInputs.state, 'accepted'),
        ),
      )
      .run()
    if (updated.changes !== 1) return
    transaction
      .update(conversationInputBatches)
      .set({ actor })
      .where(
        and(
          eq(conversationInputBatches.sessionId, sessionId),
          eq(conversationInputBatches.clientMessageId, inputId),
          isNull(conversationInputBatches.runId),
        ),
      )
      .run()
  })
}

export async function readOpenModeRoutingSources(
  repo: ConversationRepositoryHost,
  sessionId: string,
  task: CollaborationTask,
  receivedId: string,
  candidates: import('@pact/contracts').DecisionInput['candidates'],
  options: { signal: AbortSignal; deadlineAt: number },
) {
  const check = () => {
    options.signal.throwIfAborted()
    if (!Number.isSafeInteger(options.deadlineAt) || Date.now() >= options.deadlineAt)
      throw new RunOperationConflictError('Open-mode routing advice preparation timed out.')
  }
  check()
  const currentTask = repo.collaboration(sessionId)
  const received = repo.receivedCollaborationInput(sessionId)
  if (
    !currentTask ||
    currentTask.id !== task.id ||
    currentTask.revision !== task.revision ||
    !received ||
    received.id !== receivedId ||
    received.taskId !== task.id
  )
    throw new RunOperationConflictError('The open-mode task changed before routing advice.')
  const handoff = repo.workflowHandoff(
    currentTask,
    currentTask.lastCodeActor ?? collaborationActor(currentTask, 'implement'),
    received.id,
  )
  const body = repo.database
    .select()
    .from(conversationBodyInputs)
    .where(eq(conversationBodyInputs.id, received.inputId))
    .get()
  if (!body?.sealed || !body.hash)
    throw new RunOperationConflictError('The sealed input body is unavailable.')
  const bodyRead = repo.readBody(body, true)
  if (bodyRead.hash !== received.digest)
    throw new RunOperationConflictError('The received input body changed.')
  const sources: import('@pact/contracts').DecisionInput['sources'] = []
  const descriptors: Array<{
    id: string
    sha256: string
    bytes: number
    roles: RelaySourceRole[]
    actor: RuntimeAgentId | null
  }> = []
  let totalBytes = 0
  const addSource = (
    text: string,
    sha256: string,
    roles: RelaySourceRole[],
    actor: RuntimeAgentId | null,
  ) => {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (descriptors.length >= DECISION_SOURCES || totalBytes + bytes > DECISION_INPUT_BYTES) return
    const id = `s${descriptors.length}`
    totalBytes += bytes
    descriptors.push({ id, sha256, bytes, roles, actor })
    sources.push({ id, digest: sha256, text })
  }
  addSource(bodyRead.text, body.hash, ['input'], null)
  // Add bounded open-mode task context (Current Plan + latest completed report/review)
  const readDocText = async (doc: CollaborationDocument): Promise<string> => {
    let text = ''
    for (const chunk of repo.planRevisionDocumentChunks(sessionId, doc, check)) {
      text += chunk
      // oxlint-disable-next-line no-await-in-loop -- Bounded per chunk under active deadline.
      await yieldImmediate(undefined, { signal: options.signal })
    }
    return text
  }
  if (currentTask.planReference) {
    const planText = await readDocText(currentTask.planReference.document)
    addSource(
      planText,
      currentTask.planReference.document.sha256,
      ['plan'],
      currentTask.planReference.author ??
        currentTask.planAuthor ??
        collaborationActor(currentTask, 'plan'),
    )
  }
  if (currentTask.review) {
    const reviewText = await readDocText(currentTask.review.document)
    addSource(reviewText, currentTask.review.document.sha256, ['review'], currentTask.review.actor)
  }
  check()
  const freshTask = repo.collaboration(sessionId)
  const freshHandoff = freshTask
    ? repo.workflowHandoff(
        freshTask,
        freshTask.lastCodeActor ?? collaborationActor(freshTask, 'implement'),
        received.id,
      )
    : undefined
  if (!freshTask || !freshHandoff || !isDeepStrictEqual(handoff, freshHandoff))
    throw new RunOperationConflictError('Open-mode routing facts changed during preparation.')
  const fallbackActor = freshTask.lastCodeActor ?? collaborationActor(freshTask, 'implement')
  const input = decisionInputSchema.parse({
    version: 1,
    handoff,
    candidates,
    sources,
    objective:
      `Select one supplied recipient (${candidates.map((c) => c.id).join(' or ')}) for this open-mode task message when the evidence clearly favors switching or continuing with a specific agent. Return false to keep the current default implementer. ` +
      JSON.stringify({
        defaultActor: fallbackActor,
        lastCodeActor: freshTask.lastCodeActor ?? null,
        sources: descriptors.map(({ id, roles, actor }) => ({ id, roles, actor })),
      }),
  })
  return {
    handoff,
    input,
    sources: descriptors,
    sourceFingerprint: scheduling.fingerprint(descriptors),
    inputSha256: scheduling.fingerprint(input),
  }
}

export function collaborationTurnAuthorization(
  repo: ConversationRepositoryHost,
  runId: string,
): FrozenCollaborationAuthorization | undefined {
  const row = repo.database
    .select({ authorization: workflowTurns.authorizationJson })
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, runId))
    .get()
  return row ? collaborationTurnAuthorizationSchema.parse(JSON.parse(row.authorization)) : undefined
}

export function collaborationReplyActor(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  reference?: import('@pact/contracts').ConversationSendInput['replyToDecision'],
): RuntimeAgentId {
  if (!reference) return collaborationActor(task, 'reply')
  const decision = collaborationInputProcessing(task).decision
  const run = repo.findRun(reference.runId)
  const authorization = collaborationTurnAuthorization(repo, reference.runId)
  if (
    !decision ||
    !run ||
    !authorization ||
    reference.taskId !== task.id ||
    decision.runId !== reference.runId ||
    decision.inputSequence !== reference.decisionInputSequence ||
    task.inputSequence !== reference.expectedInputSequence ||
    run.sessionId !== task.sessionId ||
    authorization.runId !== run.id ||
    authorization.taskId !== task.id ||
    authorization.inputSequence !== reference.decisionInputSequence ||
    authorization.actor !== run.agentId ||
    (decision.actor !== undefined && decision.actor !== run.agentId)
  )
    throw new RunOperationConflictError(
      'The Agent that asked these questions could not be verified. Your answers were preserved.',
    )
  return run.agentId
}
