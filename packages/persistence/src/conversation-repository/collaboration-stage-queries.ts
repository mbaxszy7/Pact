import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'

import {
  agentDisplayName,
  bindCollaborationQuestions,
  collaborationActor,
  collaborationInputGate,
  collaborationInputProcessing,
  collaborationOpenPlanPublishAllowed,
  collaborationPlanAccepted,
  collaborationPlanMode,
  collaborationTurnAuthorizationSchema,
  collaborationWorkflowInputBasis,
  settleCollaborationStage,
  type CollaborationTask,
  type ConversationPatch,
} from '@pact/contracts'

import type { ConversationRepositoryHost } from './context.js'

import { appendAgentEvent } from '../agent-event-journal.js'
import * as scheduling from '../conversation-scheduling.js'
import {
  agentEventJournal,
  agentRuns,
  collaborationActionReceipts,
  collaborationInputs,
  collaborationTasks,
  conversationInputBatches,
  conversationInputBatchMembers,
  relayDecisions,
  sessions,
  sessionSettingsRevisions,
  workflowTurns,
} from '../schema/index.js'
import { assertSessionAvailable } from '../workspace-archive-repository.js'
import { settleCollaborationAction } from './collaboration-action-queries.js'
import {
  receivedCollaborationInput,
  decodedCollaboration,
  collaboration,
  collaborationDocumentRow,
  storedCollaboration,
  workflowInputWasNotSent,
} from './collaboration-document-queries.js'
import { storedReceivedMetadata } from './helpers.js'
import { activeRunStatuses, RunOperationConflictError } from './types.js'

export function withdrawInputBatch(repo: ConversationRepositoryHost, batchId: string): void {
  const batch = repo.database
    .select()
    .from(conversationInputBatches)
    .where(eq(conversationInputBatches.id, batchId))
    .get()
  if (!batch) return
  const now = new Date().toISOString()
  repo.database
    .update(conversationInputBatchMembers)
    .set({ state: 'withdrawn', updatedAt: now })
    .where(eq(conversationInputBatchMembers.batchId, batchId))
    .run()
  repo.database
    .update(conversationInputBatches)
    .set({ bodyState: 'withdrawn', state: 'closed', closedAt: now })
    .where(eq(conversationInputBatches.id, batchId))
    .run()
  const task = collaboration(repo, batch.sessionId)
  if (
    task &&
    !batch.taskId &&
    collaborationInputProcessing(task).pending?.inputId === batch.clientMessageId
  ) {
    const receipt = repo.database
      .select()
      .from(collaborationInputs)
      .where(eq(collaborationInputs.id, batch.clientMessageId))
      .get()
    if (
      receipt?.sessionId === task.sessionId &&
      !receipt.taskId &&
      storedReceivedMetadata(receipt.metadataJson).workflowCommand
    ) {
      task.inputProcessing = { ...collaborationInputProcessing(task), pending: undefined }
      task.revision++
      saveCollaboration(repo, task)
      return
    }
    const intent = receipt ? storedReceivedMetadata(receipt.metadataJson) : undefined
    if (
      receipt?.sessionId === task.sessionId &&
      receipt.taskId === task.id &&
      intent?.replyIntentBasis?.kind === 'ask_only'
    ) {
      const run = batch.runId ? repo.findRun(batch.runId) : undefined
      if (
        !run ||
        workflowInputWasNotSent(repo, run) ||
        (run.dispatchPhase === 'ended' && run.nativeOutcome && run.nativeEffectsState === 'settled')
      ) {
        task.inputProcessing = { ...collaborationInputProcessing(task), pending: undefined }
        repo.restoreAskCheckpoint(
          task,
          intent.replyIntentBasis,
          'restored',
          'The question was withdrawn.',
        )
        task.revision++
        saveCollaboration(repo, task)
      }
      return
    }
  }
  if (batch.taskId === task?.id && task.latestUserMessageId === batch.clientMessageId) {
    const latest = repo.database
      .select({ messageId: conversationInputBatches.messageId })
      .from(conversationInputBatches)
      .where(
        and(
          eq(conversationInputBatches.taskId, task.id),
          ne(conversationInputBatches.bodyState, 'withdrawn'),
          isNotNull(conversationInputBatches.messageId),
        ),
      )
      .orderBy(desc(conversationInputBatches.sequence))
      .limit(1)
      .get()
    task.latestUserMessageId = latest?.messageId ?? undefined
    const processing = collaborationInputProcessing(task)
    if (processing.pending?.inputSequence === batch.sequence) {
      // Withdrawal changes the input basis without a new confirmed reply. Retain
      // explicit pauses and require reconciliation before any automatic handoff.
      if (task.automation === 'active') {
        task.automation = 'paused'
        task.pauseReason = 'failure'
      }
      task.notice =
        'An input was withdrawn. Confirm the current scope before continuing collaboration.'
      const turn = repo.database
        .select()
        .from(workflowTurns)
        .where(and(eq(workflowTurns.runId, task.runId), eq(workflowTurns.taskId, task.id)))
        .get()
      const auth = turn
        ? collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
        : undefined
      const previous =
        (auth?.stage === 'reply' || auth?.stage === 'collaborate') && turn
          ? (
              auth.inputProcessing ??
              collaborationInputProcessing(decodedCollaboration(repo, turn.stateJson))
            ).pending
          : undefined
      const source = previous
        ? repo.database
            .select({ id: conversationInputBatches.id })
            .from(conversationInputBatches)
            .where(
              and(
                eq(conversationInputBatches.taskId, task.id),
                eq(conversationInputBatches.clientMessageId, previous.inputId),
                eq(conversationInputBatches.sequence, previous.inputSequence),
                ne(conversationInputBatches.bodyState, 'withdrawn'),
              ),
            )
            .get()
        : undefined
      const settled = source
        ? repo.database
            .select({ sequence: agentEventJournal.sequence })
            .from(agentEventJournal)
            .where(
              and(
                eq(agentEventJournal.runId, task.runId),
                eq(agentEventJournal.eventType, 'workflow.input_settled'),
              ),
            )
            .limit(1)
            .get()
        : undefined
      task.inputProcessing = {
        ...processing,
        pending: source && !settled ? previous : undefined,
      }
    }
    task.revision++
    const previousRun = task.inputProcessing?.pending ? repo.findRun(task.runId) : undefined
    if (
      (task.stage === 'reply' || task.stage === 'collaborate') &&
      previousRun?.dispatchPhase === 'ended'
    ) {
      task.status = 'failed'
      task.notice =
        'A later message was withdrawn. Check the previous reply and send a follow-up if its input still needs confirmation.'
    }
    saveCollaboration(repo, task)
    if (previousRun?.dispatchPhase === 'ended') repo.recoverAppliedWorkflowResult(task.runId)
  }
}

export function saveCollaboration(repo: ConversationRepositoryHost, task: CollaborationTask): void {
  task = { ...task, inputProcessing: collaborationInputProcessing(task) }
  const persistent = repo.database
    .select({ inputSequence: collaborationTasks.inputSequence })
    .from(collaborationTasks)
    .where(eq(collaborationTasks.id, task.id))
    .get()
  task.inputSequence = persistent?.inputSequence ?? task.inputSequence
  if (task.planAcceptanceCoverage?.throughInputSequence !== task.inputSequence)
    task.planAcceptanceCoverage = undefined
  if (task.reviewControlCoverage?.inputSequence !== task.inputSequence)
    task.reviewControlCoverage = undefined
  task = storedCollaboration(repo, task)
  const now = new Date().toISOString()
  repo.database
    .update(collaborationTasks)
    .set({ stateJson: JSON.stringify(task), updatedAt: now })
    .where(eq(collaborationTasks.id, task.id))
    .run()
  const run = repo.findRun(task.runId)
  if (run)
    repo.database
      .update(agentRuns)
      .set({
        updatedAt: new Date(Math.max(Date.now(), Date.parse(run.updatedAt) + 1)).toISOString(),
      })
      .where(eq(agentRuns.id, run.id))
      .run()
}

/** Explicit maintenance operation for an accepted plan with no code authority to transfer. */

/** Explicit maintenance operation for an accepted plan with no code authority to transfer. */
export function adoptSplitStageRoles(
  repo: ConversationRepositoryHost,
  input: {
    sessionId: string
    taskId: string
    revision: number
    settingsRevision: number
    operationId: string
  },
): ConversationPatch {
  return repo.database.transaction(() => {
    assertSessionAvailable(repo.database, input.sessionId)
    const task = collaboration(repo, input.sessionId)
    if (!task || task.id !== input.taskId)
      throw new RunOperationConflictError('The requested collaboration task is no longer current.')
    if (task.rolePolicy === 'split-stages-v1') return repo.metadataPatch(input.sessionId)
    const session = repo.database
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .get()
    const settings = repo.database
      .select()
      .from(sessionSettingsRevisions)
      .where(
        and(
          eq(sessionSettingsRevisions.sessionId, input.sessionId),
          eq(sessionSettingsRevisions.revision, input.settingsRevision),
        ),
      )
      .get()
    const run = repo.findRun(task.runId)
    const live = repo.database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, input.sessionId),
          inArray(agentRuns.status, [...activeRunStatuses]),
        ),
      )
      .limit(1)
      .get()
    const unsafeTaskRun = repo.database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.collaborationTaskId, task.id),
          or(
            inArray(agentRuns.collaborationStage, ['implement', 'repair']),
            isNull(agentRuns.nativeEffectsState),
            ne(agentRuns.nativeEffectsState, 'settled'),
          ),
        ),
      )
      .limit(1)
      .get()
    const authority = repo.database
      .select({ id: collaborationActionReceipts.id })
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.taskId, task.id))
      .limit(1)
      .get()
    if (
      !/^[a-f0-9-]{36}$/u.test(input.operationId) ||
      !session ||
      session.settingsRevision !== input.settingsRevision ||
      !settings ||
      task.revision !== input.revision ||
      task.kind !== 'plan' ||
      task.status !== 'ready' ||
      task.owner !== settings.primaryAgentId ||
      task.reviewer !== settings.secondaryAgentId ||
      !collaborationPlanAccepted(task) ||
      task.codeRunId ||
      task.pendingWork ||
      collaborationInputGate(task) ||
      receivedCollaborationInput(repo, input.sessionId) ||
      repo.nativeRecoveryBlocksInput(input.sessionId) ||
      repo.activeRelayDecisionRow(input.sessionId) ||
      live ||
      unsafeTaskRun ||
      authority ||
      !run ||
      run.nativeOutcome !== 'completed' ||
      run.dispatchPhase !== 'ended' ||
      !repo.hasCompleteResponse(run.id)
    )
      throw new RunOperationConflictError(
        'Only a settled accepted plan without existing code authority can adopt split stage roles.',
      )
    collaborationDocumentRow(repo, input.sessionId, task.planReference!.document)
    const next = { ...task, rolePolicy: 'split-stages-v1' as const, revision: task.revision + 1 }
    if (next.actor !== collaborationActor(next, next.stage))
      throw new RunOperationConflictError(
        'The completed stage does not match the requested responsibilities.',
      )
    saveCollaboration(repo, next)
    repo.nativeFact(task.runId, 'workflow.role_policy_adopted', {
      operationId: input.operationId,
      taskId: task.id,
      previousRevision: task.revision,
      revision: next.revision,
      settingsRevision: input.settingsRevision,
      rolePolicy: next.rolePolicy,
      owner: next.owner,
      reviewer: next.reviewer,
    })
    return repo.metadataPatch(input.sessionId)
  })
}

export function planRevisionBasisMatches(
  repo: ConversationRepositoryHost,
  current: CollaborationTask,
  next: CollaborationTask,
): boolean {
  return (
    isDeepStrictEqual(current.planRevision, next.planRevision) &&
    (!current.planRevision ||
      (current.inputSequence === next.inputSequence &&
        current.handledInputSequence === next.handledInputSequence &&
        isDeepStrictEqual(
          collaborationInputProcessing(current),
          collaborationInputProcessing(next),
        ) &&
        current.planVersion === next.planVersion &&
        current.planInputSequence === next.planInputSequence &&
        current.codeRunId === next.codeRunId &&
        isDeepStrictEqual(current.planReference, next.planReference) &&
        isDeepStrictEqual(current.review, next.review) &&
        isDeepStrictEqual(current.reviewScopeRef, next.reviewScopeRef)))
  )
}

export function setCollaborationState(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
): ConversationPatch {
  return repo.database.transaction(() => {
    const current = collaboration(repo, task.sessionId)
    if (
      !current ||
      current.id !== task.id ||
      current.revision + 1 !== task.revision ||
      current.owner !== task.owner ||
      current.reviewer !== task.reviewer ||
      current.rolePolicy !== task.rolePolicy ||
      !isDeepStrictEqual(current.stageRoles, task.stageRoles) ||
      !isDeepStrictEqual(current.planAcceptanceCoverage, task.planAcceptanceCoverage) ||
      !isDeepStrictEqual(current.reviewControlCoverage, task.reviewControlCoverage) ||
      !planRevisionBasisMatches(repo, current, task) ||
      (current.planRevision &&
        (task.status === 'complete' ||
          task.stage !== current.stage ||
          task.actor !== current.actor ||
          task.runId !== current.runId ||
          !isDeepStrictEqual(current.pendingWork, task.pendingWork)))
    )
      throw new RunOperationConflictError('The collaboration changed before this action.')
    saveCollaboration(repo, task)
    return repo.metadataPatch(task.sessionId)
  })
}

export function pauseCollaboration(
  repo: ConversationRepositoryHost,
  sessionId: string,
  reason: NonNullable<CollaborationTask['pauseReason']>,
): ConversationPatch {
  return repo.database.transaction(() => {
    if (reason !== 'failure') repo.cancelSchedulingRecoveryFaults(sessionId)
    const task = collaboration(repo, sessionId)
    if (task && task.status !== 'complete') {
      task.automation = 'paused'
      task.pauseReason = reason
      task.revision++
      task.notice =
        reason === 'user_message'
          ? 'Automatic collaboration is paused. Your message will be answered next.'
          : 'Collaboration is paused. Continue when ready.'
      saveCollaboration(repo, task)
    }
    return repo.metadataPatch(sessionId)
  })
}

/** Terminal retirement for confirmed replacement, inside the caller's transaction. */

/** Whether the latest authorized write lacks a successful settled review of that exact write. */
function collaborationUnreviewedWrite(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
): boolean {
  // A current or interrupted write is reviewed before an earlier code Run it may supersede.
  const currentWrite =
    task.pendingWork?.runId ??
    (task.stage === 'implement' || task.stage === 'repair' ? task.runId : undefined)
  const currentRun = currentWrite ? repo.findRun(currentWrite) : undefined
  const lastWrite =
    currentRun && !workflowInputWasNotSent(repo, currentRun) ? currentRun.id : task.codeRunId
  if (!lastWrite) return false
  const review = task.review
  if (
    !review ||
    review.stage !== 'code_review' ||
    review.verdict === 'incomplete' ||
    !review.scopeRef ||
    !review.document
  )
    return true
  const reviewRun = repo.findRun(review.runId)
  const turn = repo.database
    .select({ applied: workflowTurns.applied, state: workflowTurns.stateJson })
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, review.runId))
    .get()
  if (
    !turn?.applied ||
    !reviewRun ||
    reviewRun.dispatchPhase !== 'ended' ||
    reviewRun.nativeOutcome !== 'completed' ||
    reviewRun.nativeEffectsState !== 'settled' ||
    !repo.hasCompleteResponse(review.runId)
  )
    return true
  const frozen = decodedCollaboration(repo, turn.state)
  return !(
    frozen.codeRunId === lastWrite &&
    frozen.review?.stage === 'code_review' &&
    frozen.review.verdict !== 'incomplete' &&
    Boolean(frozen.review.scopeRef) &&
    Boolean(frozen.review.document)
  )
}

/** Terminal retirement for confirmed replacement, inside the caller's transaction. */
export function replaceCollaborationTask(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  input: {
    clientMessageId: string
    taskRevision: number
  },
): void {
  const now = new Date().toISOString()
  // Only unused task-bound grants retire; bound receipts and native evidence stay fenced by CAS.
  repo.database
    .update(collaborationActionReceipts)
    .set({ state: 'cancelled', active: false, updatedAt: now })
    .where(
      and(
        eq(collaborationActionReceipts.taskId, task.id),
        eq(collaborationActionReceipts.state, 'available'),
        eq(collaborationActionReceipts.active, true),
        isNull(collaborationActionReceipts.boundRunId),
      ),
    )
    .run()
  const gate = repo.activeRelayDecisionRow(task.sessionId)
  if (gate && gate.taskId === task.id) {
    repo.database
      .update(relayDecisions)
      .set({ state: 'invalid', active: false, revision: gate.revision + 1, updatedAt: now })
      .where(eq(relayDecisions.id, gate.id))
      .run()
    scheduling.recordRelayDecisionActivity(repo.database, gate.id)
    repo.database
      .update(collaborationActionReceipts)
      .set({ state: 'cancelled', active: false, updatedAt: now })
      .where(
        and(
          eq(collaborationActionReceipts.decisionId, gate.id),
          eq(collaborationActionReceipts.state, 'available'),
          isNull(collaborationActionReceipts.boundRunId),
        ),
      )
      .run()
    appendAgentEvent(repo.database, {
      sessionId: task.sessionId,
      runId: task.runId,
      eventType: 'scheduling.user_decision_invalidated',
      payload: JSON.stringify({ decisionId: gate.id, reason: 'task_replaced' }),
      createdAt: now,
    })
  }
  const unreviewedChanges = collaborationUnreviewedWrite(repo, task)
  appendAgentEvent(repo.database, {
    sessionId: task.sessionId,
    runId: task.runId,
    eventType: 'collaboration.task_replaced',
    payload: JSON.stringify({
      taskId: task.id,
      nonce: input.clientMessageId,
      stage: task.stage,
      status: task.status,
      pendingWorkStage: task.pendingWork?.stage ?? null,
      planRevision: Boolean(task.planRevision),
      unreviewedChanges,
      inputId: input.clientMessageId,
    }),
    createdAt: now,
  })
  task.ending = {
    clientMessageId: input.clientMessageId,
    taskRevision: input.taskRevision,
    endedAt: now,
    reason: 'replaced',
    replacementMessageId: input.clientMessageId,
    unreviewedChanges,
  }
  task.automation = 'paused'
  task.nextStage = undefined
  task.revision++
  saveCollaboration(repo, task)
  repo.database
    .update(collaborationTasks)
    .set({ active: false, updatedAt: now })
    .where(eq(collaborationTasks.id, task.id))
    .run()
}

/** Whether the latest authorized write lacks a successful settled review of that exact write. */

export function collaborationReplacementProjection(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
): NonNullable<import('@pact/contracts').CollaborationView['replacement']> {
  const agentName = (stage: Parameters<typeof collaborationActor>[1]) =>
    agentDisplayName(collaborationActor(task, stage))
  const unreviewedChanges = collaborationUnreviewedWrite(repo, task)
  const review = task.review
  const summary = task.planRevision
    ? 'The requirement change has not been re-planned.'
    : task.pendingWork
      ? `${agentName(task.pendingWork.stage)}'s ${
          task.pendingWork.stage === 'implement' ? 'implementation' : 'repair'
        } was interrupted and will not be resumed.`
      : task.status === 'running' && (task.stage === 'implement' || task.stage === 'repair')
        ? `${agentName(task.stage)} is still working. That response finishes first; its changes will not be reviewed.`
        : unreviewedChanges
          ? `${agentName('implement')}'s changes have not been reviewed.`
          : review?.stage === 'code_review' &&
              review.verdict === 'changes_requested' &&
              review.inputSequence === collaborationWorkflowInputBasis(task).inputSequence
            ? `${agentName('code_review')} requested changes that have not been addressed.`
            : collaborationPlanAccepted(task) && !task.codeRunId
              ? `Plan v${task.planReference?.version ?? task.planVersion} is accepted but not implemented.`
              : task.stage === 'plan'
                ? 'The plan is still being prepared.'
                : task.stage === 'plan_review'
                  ? `Plan v${task.planReference?.version ?? task.planVersion} is still in review.`
                  : 'This task is paused.'
  return {
    summary: summary.slice(0, 512),
    unreviewedChanges,
  }
}

export function reconcileCompletedCollaboration(
  repo: ConversationRepositoryHost,
  runId: string,
): ConversationPatch | undefined {
  const run = repo.findRun(runId)
  if (
    !run?.collaboration ||
    run.forkSourceRunId ||
    (run.dispatchPhase !== 'ended' && !workflowInputWasNotSent(repo, run))
  )
    return undefined
  const task = collaboration(repo, run.sessionId)
  const before = task?.revision
  finishCollaboration(
    repo,
    runId,
    run.dispatchPhase === 'ended' && run.nativeOutcome === 'completed',
  )
  return collaboration(repo, run.sessionId)?.revision !== before
    ? repo.metadataPatch(run.sessionId)
    : undefined
}

export function finishCollaboration(
  repo: ConversationRepositoryHost,
  runId: string,
  complete: boolean,
  notice?: string,
): void {
  repo.database.transaction(() => {
    const run = repo.findRun(runId)
    const turn = repo.database
      .select()
      .from(workflowTurns)
      .where(eq(workflowTurns.runId, runId))
      .get()
    if (!run || run.forkSourceRunId || !turn || run.controlDisposition === 'abandoned') return
    settleCollaborationAction(repo, run)
    if (turn.applied) {
      if (complete) repo.recoverAppliedWorkflowResult(runId)
      return
    }
    const current = collaboration(repo, run.sessionId)
    const isCurrent = current?.id === turn.taskId && current.runId === runId
    if (!isCurrent) return
    const task = current
    task.inputProcessing = collaborationInputProcessing(task)
    const auth = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
    const frozen = decodedCollaboration(repo, turn.stateJson)
    const nativeCompleted =
      complete && run.dispatchPhase === 'ended' && run.nativeOutcome === 'completed'
    if (auth.replyIntentBasis?.kind === 'ask_only') {
      repo.finishAskOnly(task, run, auth, nativeCompleted, notice)
      return
    }
    const unstarted = workflowInputWasNotSent(repo, run)
    const effectsSettled =
      run.nativeEffectsState === 'settled' || run.nativeEffectsState === 'not_dispatched'
    if (nativeCompleted && !effectsSettled) {
      if (
        run.nativeEffectsState === 'unknown' &&
        (task.status !== 'failed' || task.automation !== 'paused')
      ) {
        Object.assign(
          task,
          settleCollaborationStage(task, { kind: 'unavailable', reason: 'effects' }),
        )
        task.revision++
        saveCollaboration(repo, task)
      }
      return
    }
    if (nativeCompleted && !repo.hasCompleteResponse(runId) && run.status !== 'completed') return
    if (!nativeCompleted) {
      const ended = run.dispatchPhase === 'ended'
      Object.assign(
        task,
        settleCollaborationStage(task, {
          kind: 'interrupted',
          authorization: auth,
          stopped: run.nativeOutcome === 'interrupted' || run.failureKind === 'user_stopped',
          unstarted,
          failed: run.nativeOutcome === 'failed',
          ended,
          effectsSettled,
          completeResponse: false,
          ...(turn.reservation ? { reservation: turn.reservation } : {}),
          ...(notice !== undefined ? { notice } : {}),
        }),
      )
      task.revision++
      saveCollaboration(repo, task)
      if (unstarted || run.dispatchPhase === 'ended')
        repo.database
          .update(workflowTurns)
          .set({
            applied: true,
            stateJson: JSON.stringify({
              ...task,
              inputSequence: auth.inputSequence,
              latestUserMessageId: frozen.latestUserMessageId,
            }),
          })
          .where(eq(workflowTurns.runId, runId))
          .run()
      return
    }
    const messageId = run.responseMessageId
    const report = messageId ? repo.messageDocument(run.sessionId, runId, messageId) : undefined
    const plan =
      turn.planBodyId && turn.planNativeId
        ? repo.documentReference(run.sessionId, turn.planBodyId)
        : undefined
    const planner = collaborationPlanMode(frozen, auth)
    const canPublishPlan = planner || collaborationOpenPlanPublishAllowed(frozen, auth)
    if (
      (!report && !plan) ||
      ((auth.stage === 'plan_review' || auth.stage === 'code_review') && !report)
    ) {
      Object.assign(task, settleCollaborationStage(task, { kind: 'unavailable', reason: 'source' }))
      task.revision++
      saveCollaboration(repo, task)
      return
    }
    const retained = repo.workflowPlanRetention(runId, turn.planNativeId)
    const planSettled = Boolean(
      canPublishPlan && turn.planNativeId && repo.settleWorkflowPlan(task, run, auth, turn),
    )
    // A completed older root cannot settle or fail a newer accepted input.
    // A real failed Plan capture still pauses automation when newer input is queued.
    const supersededInput =
      ((auth.inputSequence < task.inputSequence &&
        task.inputProcessing?.pending?.inputSequence === task.inputSequence) ||
        Boolean(receivedCollaborationInput(repo, task.sessionId))) &&
      (!canPublishPlan || !repo.workflowPlanCaptureFailed(runId))
    task.sourceMessageId = messageId ?? run.userMessageId
    task.authorization = auth
    task.handledInputSequence = Math.max(task.handledInputSequence, auth.inputSequence)
    task.notice = undefined
    if (auth.stage === 'reply') {
      Object.assign(task, settleCollaborationStage(task, { kind: 'reply' }))
      if (
        !supersededInput &&
        !repo.settleWorkflowInput(task, run, auth, turn, planSettled) &&
        task.status === 'waiting'
      )
        Object.assign(
          task,
          settleCollaborationStage(task, { kind: 'unavailable', reason: 'reply' }),
        )
    } else if (auth.stage === 'plan') {
      const unanswered =
        !planSettled && !supersededInput && repo.workflowPlanHasUnansweredInput(runId)
      const observed =
        !planSettled &&
        !supersededInput &&
        !unanswered &&
        Boolean(
          plan ||
          retained ||
          repo.workflowPlanCaptureFailed(runId) ||
          repo.workflowInputResult(runId),
        )
      Object.assign(
        task,
        settleCollaborationStage(task, {
          kind: 'plan',
          authorization: auth,
          settled: planSettled,
          supersededInput,
          observed,
          ...(unanswered
            ? {
                decision: {
                  runId,
                  inputSequence: auth.inputSequence,
                  ...(messageId ? { messageId } : {}),
                  questions: bindCollaborationQuestions(repo.workflowInputResult(runId)?.questions),
                  actor: auth.actor,
                },
              }
            : {}),
        }),
      )
    } else if (auth.stage === 'plan_review' || auth.stage === 'code_review') {
      const verdict =
        !turn.verdictConflict && turn.verdict && report?.chars ? turn.verdict : 'incomplete'
      const needsDecision = verdict === 'needs_user'
      Object.assign(
        task,
        settleCollaborationStage(task, {
          kind: 'review',
          authorization: { ...auth, stage: auth.stage },
          verdict,
          verdictConflict: turn.verdictConflict,
          supersededInput,
          ...(report ? { document: report } : {}),
          ...(needsDecision
            ? {
                decision: {
                  runId,
                  inputSequence: auth.inputSequence,
                  ...(messageId ? { messageId } : {}),
                  questions: bindCollaborationQuestions(
                    repo.workflowReviewResult(runId)?.questions,
                  ),
                  actor: auth.actor,
                },
              }
            : {}),
        }),
      )
    } else if (auth.stage === 'collaborate') {
      const hasCodeChanges = repo.runHasRecordedCodeChanges(run.sessionId, runId)
      const hasPublishedPlan = Boolean(planSettled && turn.planBodyId)
      const planCaptureFailed = !hasPublishedPlan && repo.workflowPlanCaptureFailed(runId)
      const unanswered = !supersededInput && repo.workflowPlanHasUnansweredInput(runId)
      Object.assign(
        task,
        settleCollaborationStage(task, {
          kind: 'collaborate',
          authorization: auth,
          hasCodeChanges,
          hasPublishedPlan,
          ...(planCaptureFailed ? { planCaptureFailed: true } : {}),
          ...(unanswered
            ? {
                decision: {
                  runId,
                  inputSequence: auth.inputSequence,
                  ...(messageId ? { messageId } : {}),
                  questions: bindCollaborationQuestions(repo.workflowInputResult(runId)?.questions),
                  actor: auth.actor,
                },
              }
            : {}),
        }),
      )
    } else if (auth.stage === 'implement' || auth.stage === 'repair' || auth.stage === 'respond') {
      const hasCodeChanges = repo.runHasRecordedCodeChanges(run.sessionId, runId)
      const hasPublishedPlan = Boolean(planSettled && turn.planBodyId)
      const planCaptureFailed = !hasPublishedPlan && repo.workflowPlanCaptureFailed(runId)
      const unanswered = !supersededInput && repo.workflowPlanHasUnansweredInput(runId)
      Object.assign(
        task,
        settleCollaborationStage(task, {
          kind: 'work',
          authorization: { ...auth, stage: auth.stage },
          hasCodeChanges,
          hasPublishedPlan,
          ...(planCaptureFailed ? { planCaptureFailed: true } : {}),
          ...(unanswered
            ? {
                decision: {
                  runId,
                  inputSequence: auth.inputSequence,
                  ...(messageId ? { messageId } : {}),
                  questions: bindCollaborationQuestions(repo.workflowInputResult(runId)?.questions),
                  actor: auth.actor,
                },
              }
            : {}),
        }),
      )
    }
    task.revision++
    const snapshot = storedCollaboration(repo, {
      ...task,
      inputProcessing:
        task.inputProcessing?.pending &&
        task.inputProcessing.pending.inputSequence > auth.inputSequence
          ? (auth.inputProcessing ?? collaborationInputProcessing(frozen))
          : task.inputProcessing,
      inputSequence: auth.inputSequence,
      handledInputSequence: Math.min(task.handledInputSequence, auth.inputSequence),
      latestUserMessageId: frozen.latestUserMessageId,
    })
    repo.database
      .update(workflowTurns)
      .set({
        applied: true,
        reportBodyId: report?.id ?? null,
        stateJson: JSON.stringify(snapshot),
      })
      .where(eq(workflowTurns.runId, runId))
      .run()
    saveCollaboration(repo, task)
  })
}
