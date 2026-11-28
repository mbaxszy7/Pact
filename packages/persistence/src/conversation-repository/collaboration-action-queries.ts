import { and, eq, gt, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  advanceCollaboration,
  collaborationActionSchema,
  collaborationActor,
  collaborationDocumentSchema,
  collaborationInputGate,
  collaborationInputProcessing,
  collaborationPlanAccepted,
  collaborationTurnAuthorizationSchema,
  deriveCollaborationDecision,
  relaySchedulingDecisionProofSchema,
  type AgentRun,
  type CollaborationActionInput,
  type CollaborationDocument,
  type CollaborationLimits,
  type CollaborationTask,
  type CollaborationTurnAuthorization,
  type RuntimeAgentId,
  type SchedulingHandoff,
  type WorkflowRelayCandidateId,
} from '@pact/contracts'

import type { ConversationRepositoryHost } from './context.js'

import { appendAgentEvent } from '../agent-event-journal.js'
import * as scheduling from '../conversation-scheduling.js'
import {
  agentEventJournal,
  agentRuns,
  collaborationActionReceipts,
  conversationInputBatches,
  relayDecisions,
  runReexecutionOperations,
  schedulingBudgetReservations,
  sessionSettingsRevisions,
  workflowTurns,
} from '../schema/index.js'
import {
  receivedCollaborationInput,
  decodedCollaboration,
  collaboration,
  saveCollaborationDocument,
  collaborationDocumentRow,
  workflowInputWasNotSent,
} from './collaboration-document-queries.js'
import { samePlanContent } from './helpers.js'
import {
  RunOperationConflictError,
  type BeginRunInput,
  type RelayWorkflowSnapshot,
} from './types.js'

export function actionReceiptBasis(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  next: CollaborationTask,
  handoff: SchedulingHandoff,
): {
  handoff: SchedulingHandoff
  taskId: string
  rolePolicy?: CollaborationTask['rolePolicy']
  stageRoles?: CollaborationTask['stageRoles']
  inputSequence: number
  stage: CollaborationTask['stage']
  actor: RuntimeAgentId
  planReference: CollaborationTask['planReference'] | null
  review: CollaborationTask['review'] | null
  reviewScopeRef: CollaborationDocument | null
  previousRunId: string | null
  planRevision?: CollaborationTask['planRevision']
  actorBinding: {
    generation: number
    nativeSessionId: string | null
    continuationState: string | null
    permissions: string
  }
} {
  const binding = repo.nativeContext(task.sessionId, next.actor)
  return {
    handoff,
    taskId: task.id,
    ...(task.rolePolicy ? { rolePolicy: task.rolePolicy } : {}),
    ...(task.stageRoles ? { stageRoles: task.stageRoles } : {}),
    inputSequence: task.inputSequence,
    stage: next.stage,
    actor: next.actor,
    planReference: task.planReference ?? null,
    review: task.review ?? null,
    reviewScopeRef: task.reviewScopeRef ?? null,
    previousRunId: task.pendingWork?.runId ?? null,
    ...(task.planRevision ? { planRevision: task.planRevision } : {}),
    actorBinding: {
      generation: binding?.bindingGeneration ?? 1,
      nativeSessionId: binding?.nativeSessionId ?? null,
      continuationState: binding?.continuationState ?? null,
      permissions: scheduling.fingerprint(binding?.permissionRequests ?? []),
    },
  }
}

export function authorityJson(repo: ConversationRepositoryHost, value: unknown): string {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > 4 * 1024)
    throw new RunOperationConflictError('The complete action receipt exceeds its metadata budget.')
  return json
}

export function collaborationActionProjection(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
): {
  availableActions: import('@pact/contracts').CollaborationAction[]
} {
  const workflowDecision = deriveCollaborationDecision(task, repo.planReviewLimits(task.sessionId))
  try {
    const projected = workflowDecision.availableActions.filter(
      (action) =>
        action !== 'swap_code_roles' || repo.codeRoleChangeAvailable(task, undefined, true),
    )
    return { availableActions: projected }
  } catch (error) {
    if (!(error instanceof RunOperationConflictError)) throw error
    return { availableActions: [] }
  }
}

export function collaborationActionReceipt(
  repo: ConversationRepositoryHost,
  input: CollaborationActionInput,
) {
  const receipt = repo.database
    .select()
    .from(collaborationActionReceipts)
    .where(
      and(
        eq(collaborationActionReceipts.sessionId, input.sessionId),
        eq(collaborationActionReceipts.clientNonce, input.clientMessageId),
      ),
    )
    .get()
  if (receipt && receipt.requestDigest !== scheduling.fingerprint(input))
    throw new RunOperationConflictError('This action nonce belongs to a different request.')
  return receipt
}

/** Resolve the frozen scope, independently of the cursor of later processed input. */

/** Resolve the frozen scope, independently of the cursor of later processed input. */
export function unfinishedWriteSource(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  runId: string,
  forPlanRevision = false,
): {
  run: AgentRun
  turn: typeof workflowTurns.$inferSelect
  auth: CollaborationTurnAuthorization
  frozen: CollaborationTask
} {
  const run = repo.findRun(runId)
  const turn = repo.database
    .select()
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, runId))
    .get()
  const auth = turn
    ? collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorizationJson))
    : undefined
  const frozen = turn ? decodedCollaboration(repo, turn.stateJson) : undefined
  if (
    !run ||
    !turn ||
    !auth ||
    !frozen ||
    run.forkSourceRunId ||
    run.controlDisposition === 'abandoned' ||
    run.sessionId !== task.sessionId ||
    auth.runId !== run.id ||
    auth.taskId !== task.id ||
    turn.taskId !== task.id ||
    !['implement', 'repair'].includes(auth.stage) ||
    auth.actor !== collaborationActor(forPlanRevision ? frozen : task, 'implement') ||
    turn.stage !== auth.stage ||
    turn.actor !== auth.actor ||
    turn.inputSequence !== auth.inputSequence ||
    run.collaboration?.taskId !== task.id ||
    run.collaboration.stage !== auth.stage ||
    run.agentId !== auth.actor ||
    frozen.id !== task.id ||
    frozen.sessionId !== task.sessionId ||
    frozen.owner !== task.owner ||
    frozen.reviewer !== task.reviewer ||
    frozen.rolePolicy !== task.rolePolicy ||
    (!forPlanRevision && !isDeepStrictEqual(frozen.stageRoles, task.stageRoles)) ||
    (forPlanRevision &&
      (collaborationActor(frozen, 'plan') !== collaborationActor(task, 'plan') ||
        collaborationActor(frozen, 'plan_review') !== collaborationActor(task, 'plan_review'))) ||
    !isDeepStrictEqual(auth.stageRoles, frozen.stageRoles) ||
    frozen.kind !== task.kind ||
    frozen.taskMessageId !== task.taskMessageId ||
    !frozen.taskDocument ||
    !isDeepStrictEqual(frozen.taskDocument, task.taskDocument) ||
    (!forPlanRevision &&
      (!samePlanContent(auth.planReference, task.planReference) ||
        !isDeepStrictEqual(auth.reviewScopeRef, task.reviewScopeRef))) ||
    (!workflowInputWasNotSent(repo, run) &&
      !(
        run.dispatchPhase === 'ended' &&
        run.nativeEffectsState === 'settled' &&
        (['failed', 'interrupted'].includes(run.nativeOutcome ?? '') ||
          (forPlanRevision && run.nativeOutcome === 'completed' && turn.applied))
      ))
  )
    throw new RunOperationConflictError(
      'The original write authorization or settled execution could not be verified. Start a new explicitly authorized action.',
    )
  // A stage alone is not a legacy grant: retain its original task, complete input Batch,
  // published Plan/review scope and host-frozen authorization together.
  let inputOwnerRunId = run.id
  const operationId = repo.database
    .select({ id: agentRuns.reexecutionOperationId })
    .from(agentRuns)
    .where(eq(agentRuns.id, run.id))
    .get()?.id
  if (run.reexecutedFromRunId || operationId) {
    const operation = repo.database
      .select()
      .from(runReexecutionOperations)
      .where(eq(runReexecutionOperations.replacementRunId, run.id))
      .get()
    const parent =
      operation &&
      repo.database
        .select({
          id: agentRuns.id,
          reexecutedFromRunId: agentRuns.reexecutedFromRunId,
          reexecutionOperationId: agentRuns.reexecutionOperationId,
          userMessageId: agentRuns.userMessageId,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, operation.originalRunId))
        .get()
    const capture = parent && repo.executionInput(parent.id)
    if (
      !operation ||
      operation.id !== operationId ||
      operation.originalRunId !== run.reexecutedFromRunId ||
      !parent ||
      parent.reexecutedFromRunId ||
      parent.reexecutionOperationId ||
      parent.userMessageId !== run.userMessageId ||
      !capture?.proof ||
      capture.proof.runId !== parent.id ||
      capture.proof.inputSha256 !== capture.input.inputSha256
    )
      throw new RunOperationConflictError('The original replacement input lineage is unavailable.')
    const original = unfinishedWriteSource(repo, task, parent.id, forPlanRevision)
    const comparable = {
      ...auth,
      runId: original.auth.runId,
      taskRevision: original.auth.taskRevision,
    }
    for (const field of ['sourceManifestRef', 'relayWorkRef'] as const) {
      const prior = original.auth[field],
        current = auth[field]
      if (isDeepStrictEqual(prior, current)) continue
      if (
        !prior ||
        !current ||
        prior.sha256 !== current.sha256 ||
        prior.bytes !== current.bytes ||
        prior.chars !== current.chars ||
        collaborationDocumentRow(repo, task.sessionId, prior).sourceRunId !== parent.id ||
        collaborationDocumentRow(repo, task.sessionId, current).sourceRunId !== run.id
      )
        throw new RunOperationConflictError('The replacement host instruction changed.')
      comparable[field] = prior
    }
    if (!isDeepStrictEqual(comparable, original.auth))
      throw new RunOperationConflictError('The replacement write authorization changed.')
    inputOwnerRunId = original.run.id
  }
  const batch =
    auth.inputBatchRef &&
    repo.database
      .select()
      .from(conversationInputBatches)
      .where(eq(conversationInputBatches.id, auth.inputBatchRef.id))
      .get()
  if (
    !batch ||
    batch.runId !== inputOwnerRunId ||
    batch.sessionId !== task.sessionId ||
    batch.messageId !== run.userMessageId ||
    batch.actor !== auth.actor ||
    batch.memberCount !== auth.inputBatchRef?.memberCount ||
    batch.commentsRevision !== auth.inputBatchRef?.revision ||
    !batch.bodyDocumentJson ||
    batch.bodyState === 'withdrawn'
  )
    throw new RunOperationConflictError('The original complete write input is unavailable.')
  collaborationDocumentRow(repo, task.sessionId, frozen.taskDocument)
  collaborationDocumentRow(
    repo,
    task.sessionId,
    collaborationDocumentSchema.parse(JSON.parse(batch.bodyDocumentJson)),
  )
  if (auth.planReference)
    collaborationDocumentRow(repo, task.sessionId, auth.planReference.document)
  if (task.planReference)
    collaborationDocumentRow(repo, task.sessionId, task.planReference.document)
  if (auth.reviewScopeRef) collaborationDocumentRow(repo, task.sessionId, auth.reviewScopeRef)
  if (
    !auth.userAuthority &&
    !(
      (auth.stage === 'implement' && frozen.kind === 'build') ||
      (auth.stage === 'implement' &&
        frozen.review?.stage === 'plan_review' &&
        frozen.review.actor === collaborationActor(frozen, 'plan_review') &&
        frozen.review.verdict === 'accepted' &&
        samePlanContent(frozen.review.planReference, auth.planReference)) ||
      (auth.stage === 'repair' &&
        frozen.review?.stage === 'code_review' &&
        frozen.review.actor === collaborationActor(frozen, 'code_review') &&
        frozen.review.verdict === 'changes_requested' &&
        isDeepStrictEqual(frozen.review.scopeRef, auth.reviewScopeRef))
    )
  )
    throw new RunOperationConflictError(
      'The legacy write has no complete original authorization basis.',
    )
  return { run, turn, auth, frozen }
}

export function originalWriteAuthority(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  preserveLegacy = false,
): typeof collaborationActionReceipts.$inferSelect {
  if (task.planRevision)
    throw new RunOperationConflictError(
      'The changed requirements require a newly accepted and authorized Plan.',
    )
  const pending = task.pendingWork
  if (!pending) throw new RunOperationConflictError('There is no original unfinished write.')
  const source = unfinishedWriteSource(repo, task, pending.runId)
  if (
    pending.stage !== source.auth.stage ||
    pending.inputSequence !== source.auth.inputSequence ||
    task.inputSequence < source.auth.inputSequence ||
    collaborationInputGate(task) ||
    receivedCollaborationInput(repo, task.sessionId)
  )
    throw new RunOperationConflictError(
      'The original unfinished write or its input is no longer current.',
    )
  if (task.inputSequence !== source.auth.inputSequence) {
    const processed = collaborationInputProcessing(task).settled
    const reply = processed ? repo.findRun(processed.runId) : undefined
    const observation = processed ? repo.workflowInputResult(processed.runId) : undefined
    const settled =
      processed &&
      repo.database
        .select({ sequence: agentEventJournal.sequence })
        .from(agentEventJournal)
        .where(
          and(
            eq(agentEventJournal.runId, processed.runId),
            eq(agentEventJournal.eventType, 'workflow.input_settled'),
          ),
        )
        .limit(1)
        .get()
    if (
      task.handledInputSequence !== task.inputSequence ||
      processed?.inputSequence !== task.inputSequence ||
      !reply ||
      reply.forkSourceRunId ||
      reply.controlDisposition === 'abandoned' ||
      reply.sessionId !== task.sessionId ||
      reply.collaboration?.taskId !== task.id ||
      reply.collaboration.stage !== 'reply' ||
      reply.dispatchPhase !== 'ended' ||
      reply.nativeOutcome !== 'completed' ||
      reply.nativeEffectsState !== 'settled' ||
      !repo.hasCompleteResponse(reply.id) ||
      !settled ||
      (observation?.outcome !== 'processed' && !repo.workflowPlanSettled(reply.id))
    )
      throw new RunOperationConflictError(
        'Later input has not been completely processed within the original write scope.',
      )
  }
  return originalWriteReceipt(repo, task, source, preserveLegacy)
}

export function originalWriteReceipt(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
  source: ReturnType<typeof unfinishedWriteSource>,
  preserveLegacy: boolean,
  forPlanRevision = false,
): typeof collaborationActionReceipts.$inferSelect {
  const rootId = source.auth.userAuthority?.rootReceiptId
  let receipt = repo.database
    .select()
    .from(collaborationActionReceipts)
    .where(
      rootId
        ? eq(collaborationActionReceipts.id, rootId)
        : eq(collaborationActionReceipts.boundRunId, source.run.id),
    )
    .get()
  const legacyBasis = (value: typeof source) => ({
    version: 'legacy-native-workflow-write-v1',
    sourceRunId: value.run.id,
    authorizationSha256: createHash('sha256').update(value.turn.authorizationJson).digest('hex'),
    taskId: task.id,
    actor: value.auth.actor,
    stage: value.auth.stage,
    inputSequence: value.auth.inputSequence,
    taskMessageId: value.frozen.taskMessageId,
    taskDocument: value.frozen.taskDocument,
    planReference: value.auth.planReference ?? null,
    reviewScopeRef: value.auth.reviewScopeRef ?? null,
  })
  if (!receipt && !source.auth.userAuthority && preserveLegacy) {
    const id = randomUUID(),
      now = new Date().toISOString(),
      basis = legacyBasis(source)
    receipt = repo.database
      .insert(collaborationActionReceipts)
      .values({
        id,
        sessionId: task.sessionId,
        taskId: task.id,
        // This reserved native Run identity is a derivation key, not fabricated user consent.
        clientNonce: source.run.id,
        requestDigest: scheduling.fingerprint(basis),
        action: 'legacy_write',
        actor: collaborationActor(task, 'implement'),
        handoffId: scheduling.fingerprint(basis),
        rootReceiptId: id,
        basisJson: authorityJson(repo, basis),
        state: 'settled',
        boundRunId: source.run.id,
        active: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    appendAgentEvent(repo.database, {
      sessionId: task.sessionId,
      runId: source.run.id,
      eventType: 'collaboration.legacy_write_authority_preserved',
      payload: JSON.stringify({
        receiptId: id,
        sourceRunId: source.run.id,
        authorizationSha256: basis.authorizationSha256,
      }),
      createdAt: now,
    })
  }
  if (
    !receipt ||
    receipt.taskId !== task.id ||
    receipt.sessionId !== task.sessionId ||
    receipt.actor !== source.auth.actor ||
    !receipt.boundRunId ||
    receipt.rootReceiptId !== receipt.id ||
    !['build', 'execute', 'repair', 'legacy_write'].includes(receipt.action) ||
    !['bound', 'settled', 'unknown', 'not_sent'].includes(receipt.state)
  )
    throw new RunOperationConflictError('The original concrete write authorization is unavailable.')
  const original = unfinishedWriteSource(repo, task, receipt.boundRunId, forPlanRevision)
  if (original.auth.stage !== source.auth.stage || original.auth.actor !== source.auth.actor)
    throw new RunOperationConflictError('The original write stage changed.')
  if (receipt.action === 'legacy_write') {
    if (
      original.auth.userAuthority ||
      receipt.basisJson !== authorityJson(repo, legacyBasis(original))
    )
      throw new RunOperationConflictError('The frozen legacy write authorization changed.')
  } else if (
    original.auth.userAuthority?.receiptId !== receipt.id ||
    original.auth.userAuthority.rootReceiptId !== receipt.id ||
    original.auth.userAuthority.purpose !== 'action'
  ) {
    throw new RunOperationConflictError('The write continuation has no original action root.')
  }
  return receipt
}

/** Capture the exact user action synchronously, before any preparation or advice await. */

/** Capture the exact user action synchronously, before any preparation or advice await. */
export function prepareCollaborationAction(
  repo: ConversationRepositoryHost,
  input: CollaborationActionInput,
  limits: CollaborationLimits,
) {
  return repo.database.transaction(() => {
    const duplicate = collaborationActionReceipt(repo, input)
    const task = collaboration(repo, input.sessionId)
    if (duplicate) {
      if (duplicate.boundRunId)
        return { receipt: duplicate, task, next: undefined, handoff: undefined }
      if (duplicate.state !== 'available')
        throw new RunOperationConflictError(
          'This action was already settled or cancelled. Refresh its receipt.',
        )
    }
    if (!task || task.id !== input.taskId || (!duplicate && task.revision !== input.revision))
      throw new RunOperationConflictError('This collaboration action is no longer current.')
    if (
      receivedCollaborationInput(repo, input.sessionId) ||
      repo.nativeRecoveryBlocksInput(input.sessionId)
    )
      throw new RunOperationConflictError(
        'Resolve the current input or native recovery before starting this action.',
      )
    repo.assertRelayDecisionResolved(task.sessionId)
    const next = advanceCollaboration(task, input.action, limits)
    const handoff = repo.workflowHandoff(task, next.actor)
    const basisJson = authorityJson(repo, actionReceiptBasis(repo, task, next, handoff))
    if (duplicate) {
      if (duplicate.basisJson !== basisJson)
        throw new RunOperationConflictError('The authorized action changed before dispatch.')
      return { receipt: duplicate, task, next, handoff }
    }
    if (
      repo.database
        .select({ id: collaborationActionReceipts.id })
        .from(collaborationActionReceipts)
        .where(
          and(
            eq(collaborationActionReceipts.handoffId, handoff.id),
            eq(collaborationActionReceipts.active, true),
          ),
        )
        .get()
    )
      throw new RunOperationConflictError(
        'Another action already owns this handoff. Read its original receipt.',
      )
    const continuingWrite =
      !task.openMode &&
      Boolean(task.pendingWork) &&
      (next.stage === 'implement' || next.stage === 'repair') &&
      input.action !== 'execute' &&
      input.action !== 'fix'
    const root = continuingWrite ? originalWriteAuthority(repo, task, true) : undefined
    const id = randomUUID(),
      now = new Date().toISOString()
    const receipt = repo.database
      .insert(collaborationActionReceipts)
      .values({
        id,
        sessionId: task.sessionId,
        taskId: task.id,
        clientNonce: input.clientMessageId,
        requestDigest: scheduling.fingerprint(input),
        action: input.action,
        actor: next.actor,
        handoffId: handoff.id,
        rootReceiptId: root?.id ?? id,
        basisJson,
        state: 'available',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    appendAgentEvent(repo.database, {
      sessionId: task.sessionId,
      runId: task.runId,
      eventType: 'collaboration.action_authorized',
      payload: JSON.stringify({
        receiptId: id,
        action: input.action,
        actor: next.actor,
        handoffId: handoff.id,
        rootReceiptId: receipt.rootReceiptId,
      }),
      createdAt: now,
    })
    return { receipt, task, next, handoff }
  })
}

export function cancelPreparedCollaborationAction(
  repo: ConversationRepositoryHost,
  id: string,
): void {
  repo.database
    .update(collaborationActionReceipts)
    .set({ state: 'cancelled', active: false, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(collaborationActionReceipts.id, id),
        eq(collaborationActionReceipts.state, 'available'),
      ),
    )
    .run()
}

export function admitCollaborationAction(
  repo: ConversationRepositoryHost,
  input: BeginRunInput,
  handoff: SchedulingHandoff | undefined,
  runId: string,
  current: CollaborationTask | undefined,
  candidateId?: WorkflowRelayCandidateId,
  approvedRelayScope?: RelayWorkflowSnapshot,
):
  | {
      userAuthority: NonNullable<CollaborationTurnAuthorization['userAuthority']>
      relayWorkRef?: CollaborationDocument
    }
  | undefined {
  const next = input.collaboration
  if (!next) return undefined
  if (
    input.expectedCollaborationRevision === undefined &&
    next.kind === 'build' &&
    next.stage === 'implement' &&
    next.taskMessageId === input.clientMessageId
  ) {
    const id = randomUUID(),
      now = new Date().toISOString()
    repo.database
      .insert(collaborationActionReceipts)
      .values({
        id,
        sessionId: next.sessionId,
        taskId: next.id,
        clientNonce: input.clientMessageId,
        requestDigest: scheduling.fingerprint({
          action: 'build',
          taskId: next.id,
          clientNonce: input.clientMessageId,
          contentSha256: createHash('sha256').update(input.content).digest('hex'),
        }),
        action: 'build',
        actor: collaborationActor(next, 'implement'),
        handoffId: scheduling.fingerprint({
          taskId: next.id,
          initialBuild: input.clientMessageId,
        }),
        rootReceiptId: id,
        basisJson: authorityJson(repo, {
          taskId: next.id,
          inputSequence: next.inputSequence,
          stage: next.stage,
          actor: next.actor,
          ...(next.stageRoles ? { stageRoles: next.stageRoles } : {}),
          planReference: null,
          reviewScopeRef: null,
        }),
        state: 'bound',
        boundRunId: runId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return { userAuthority: { receiptId: id, rootReceiptId: id, purpose: 'action' } }
  }
  let receipt = input.collaborationActionReceiptId
    ? repo.database
        .select()
        .from(collaborationActionReceipts)
        .where(eq(collaborationActionReceipts.id, input.collaborationActionReceiptId))
        .get()
    : undefined
  if (
    !receipt &&
    !input.collaborationActionReceiptId &&
    current &&
    handoff &&
    current.pendingWork?.stage === next.stage &&
    (next.stage === 'implement' || next.stage === 'repair') &&
    current.automation === 'active'
  ) {
    // Automatic return from a required Plan review uses the existing write authority.
    // This is an idempotent derivation, not a new user action or an extra Repair.
    const root = originalWriteAuthority(repo, current, true)
    const id = randomUUID(),
      now = new Date().toISOString()
    const basisJson = authorityJson(repo, actionReceiptBasis(repo, current, next, handoff))
    receipt = repo.database
      .insert(collaborationActionReceipts)
      .values({
        id,
        sessionId: current.sessionId,
        taskId: current.id,
        clientNonce: input.clientMessageId,
        requestDigest: scheduling.fingerprint({
          version: 'unfinished-write-continuation-v1',
          rootReceiptId: root.id,
          clientOperationId: input.clientMessageId,
          basisJson,
        }),
        action: 'continue',
        actor: next.actor,
        handoffId: handoff.id,
        rootReceiptId: root.id,
        basisJson,
        state: 'available',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    appendAgentEvent(repo.database, {
      sessionId: current.sessionId,
      runId,
      eventType: 'collaboration.write_continuation_prepared',
      payload: JSON.stringify({ receiptId: id, rootReceiptId: root.id }),
      createdAt: now,
    })
  }
  if (!receipt) {
    if (['implement', 'repair', 'respond'].includes(next.stage))
      throw new RunOperationConflictError(
        'This action requires its original concrete user receipt.',
      )
    return undefined
  }
  if (
    !current ||
    !handoff ||
    receipt.state !== 'available' ||
    !receipt.active ||
    receipt.boundRunId ||
    receipt.sessionId !== input.sessionId ||
    receipt.taskId !== next.id ||
    receipt.clientNonce !== input.clientMessageId ||
    receipt.actor !== next.actor ||
    receipt.handoffId !== handoff.id ||
    receipt.basisJson !== authorityJson(repo, actionReceiptBasis(repo, current, next, handoff))
  )
    throw new RunOperationConflictError('The concrete user authorization is no longer current.')
  if (
    current.planRevision &&
    ['implement', 'repair', 'respond'].includes(next.stage) &&
    (receipt.action !== 'execute' ||
      receipt.rootReceiptId !== receipt.id ||
      next.stage !== 'implement' ||
      next.pendingWork ||
      !collaborationPlanAccepted(current) ||
      !isDeepStrictEqual(next.planReference, current.planReference))
  )
    throw new RunOperationConflictError(
      'The revised Plan requires a new explicit Implement action.',
    )
  const continuation =
    !current.openMode &&
    Boolean(current.pendingWork) &&
    (next.stage === 'implement' || next.stage === 'repair') &&
    !['execute', 'fix'].includes(receipt.action)
  const relayAction =
    receipt.action === 'extend_plan_review' ? ('extend_plan_review' as const) : undefined
  const limits = repo.database
    .select()
    .from(sessionSettingsRevisions)
    .where(
      and(
        eq(sessionSettingsRevisions.sessionId, input.sessionId),
        eq(sessionSettingsRevisions.revision, input.settingsRevision),
      ),
    )
    .get()
  if (!limits)
    throw new RunOperationConflictError('The original collaboration limits are unavailable.')
  const expected =
    receipt.action === 'extend_plan_review'
      ? repo.relayWorkflowActionNext(current, 'extend_plan_review')
      : advanceCollaboration(current, collaborationActionSchema.parse(receipt.action), limits)
  if (!isDeepStrictEqual(next, expected))
    throw new RunOperationConflictError(
      'The authorized action, scope or original business counters changed before admission.',
    )
  let budgetReservationId: string | undefined
  let relayWorkRef: CollaborationDocument | undefined
  if (relayAction) {
    const decided = receipt.decisionId
      ? repo.database
          .select()
          .from(relayDecisions)
          .where(eq(relayDecisions.id, receipt.decisionId))
          .get()
      : undefined
    const accepted =
      decided?.formatVersion === 2 && decided.state === 'available' && decided.active
        ? relaySchedulingDecisionProofSchema.safeParse(JSON.parse(decided.proofJson))
        : undefined
    const confirmed =
      accepted?.success &&
      accepted.data.card.request.category === 'new_authorization' &&
      accepted.data.card.request.operation.kind === 'extend_plan_review' &&
      accepted.data.card.request.operation.taskId === current.id &&
      accepted.data.card.request.operation.afterRunId === current.runId &&
      accepted.data.card.request.operation.actor === next.actor &&
      next.stage === 'plan_review' &&
      accepted.data.card.request.operation.expectedDiscussionRounds === current.discussionRounds &&
      accepted.data.card.request.operation.maximum === limits.maxDiscussionRounds &&
      accepted.data.card.request.operation.inputSequence === current.inputSequence &&
      isDeepStrictEqual(
        accepted.data.card.request.operation.planReference,
        current.planReference,
      ) &&
      accepted.data.operationFingerprint ===
        scheduling.fingerprint(accepted.data.card.request.operation) &&
      accepted.data.configurationGeneration === repo.schedulingConfigurationGeneration() &&
      accepted.data.executionFingerprint ===
        repo.relayWorkflowActionExecutionFingerprint(current, handoff, relayAction) &&
      accepted.data.handoff.id === handoff.id &&
      accepted.data.sourceFingerprint === approvedRelayScope?.sourceFingerprint &&
      decided?.answerNonce === receipt.clientNonce &&
      decided.answerJson === authorityJson(repo, { kind: 'confirm' })
    if (!confirmed || !repo.planReviewExtensionAvailable(current))
      throw new RunOperationConflictError(
        'The plan-review extension was not selected by a current decision or is unavailable.',
      )
    if (confirmed && accepted?.success) {
      const card = accepted.data.card
      const scope = approvedRelayScope
      if (!scope)
        throw new RunOperationConflictError('The approved scheduling sources are unavailable.')
      const sources = card.sources.map((reference) => {
        const source = scope.sources.find((entry) => entry.id === reference.id)
        if (!source)
          throw new RunOperationConflictError('An approved scheduling citation is unavailable.')
        return { label: reference.label, document: source.document }
      })
      relayWorkRef = saveCollaborationDocument(
        repo,
        runId,
        authorityJson(repo, {
          version: 'relay-approved-work-v1',
          decisionId: card.decisionId,
          title: card.title,
          responsibility: card.reason,
          consequence: card.consequence,
          operation:
            card.request.category === 'new_authorization' ? card.request.operation : undefined,
          sources,
        }),
      )
    }
    const reserved = scheduling.reserveBudget(repo.database, {
      handoff,
      budget: 'extra_plan_turn',
      authorizationId: receipt.id,
    })
    if (reserved.status !== 'reserved')
      throw new RunOperationConflictError(
        'This plan-review extension allowance was already reserved.',
      )
    budgetReservationId = reserved.reservation.id
  }
  if (continuation && originalWriteAuthority(repo, current).id !== receipt.rootReceiptId)
    throw new RunOperationConflictError('The continued write has a different authorization root.')
  repo.database
    .update(collaborationActionReceipts)
    .set({
      state: 'bound',
      boundRunId: runId,
      budgetReservationId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(collaborationActionReceipts.id, receipt.id))
    .run()
  if (receipt.decisionId)
    repo.database
      .update(relayDecisions)
      .set({ state: 'bound', active: false, updatedAt: new Date().toISOString() })
      .where(eq(relayDecisions.id, receipt.decisionId))
      .run()
  if (receipt.decisionId) scheduling.recordRelayDecisionActivity(repo.database, receipt.decisionId)
  return {
    userAuthority: {
      receiptId: receipt.id,
      rootReceiptId: receipt.rootReceiptId,
      purpose: continuation ? 'write_continuation' : 'action',
    },
    ...(relayWorkRef ? { relayWorkRef } : {}),
  }
}

export function settleCollaborationAction(repo: ConversationRepositoryHost, run: AgentRun): void {
  const receipt = repo.database
    .select()
    .from(collaborationActionReceipts)
    .where(eq(collaborationActionReceipts.boundRunId, run.id))
    .get()
  if (!receipt || ['settled', 'not_sent'].includes(receipt.state)) return
  const reservation = receipt.budgetReservationId
    ? repo.database
        .select()
        .from(schedulingBudgetReservations)
        .where(eq(schedulingBudgetReservations.id, receipt.budgetReservationId))
        .get()
    : undefined
  const notSent =
    workflowInputWasNotSent(repo, run) &&
    (!reservation || reservation.state === 'reserved' || reservation.state === 'not_sent')
  const state = notSent
    ? 'not_sent'
    : run.dispatchPhase === 'ended' && run.nativeEffectsState === 'settled'
      ? 'settled'
      : 'unknown'
  repo.database
    .update(collaborationActionReceipts)
    .set({
      state,
      active: false,
      ...(notSent && receipt.reviewState === 'pending'
        ? { reviewState: 'not_required' as const }
        : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(collaborationActionReceipts.id, receipt.id))
    .run()
  if (reservation && state !== 'unknown')
    scheduling.settleBudget(
      repo.database,
      reservation.id,
      state === 'not_sent' ? 'not_sent' : 'settled',
    )
  if (notSent && receipt.decisionId)
    scheduling.recordPactRepairBusinessActivity(repo.database, run.id)
}

export function reconcileCollaborationActionReceipts(repo: ConversationRepositoryHost): void {
  let cursor: string | undefined
  for (;;) {
    const rows = repo.database
      .select({
        id: collaborationActionReceipts.id,
        runId: collaborationActionReceipts.boundRunId,
      })
      .from(collaborationActionReceipts)
      .where(
        and(
          sql`${collaborationActionReceipts.boundRunId} IS NOT NULL AND ${collaborationActionReceipts.state} IN ('bound', 'unknown')`,
          cursor ? gt(collaborationActionReceipts.id, cursor) : undefined,
        ),
      )
      .orderBy(collaborationActionReceipts.id)
      .limit(25)
      .all()
    if (!rows.length) return
    repo.database.transaction(() => {
      for (const row of rows) {
        const run = row.runId ? repo.findRun(row.runId) : undefined
        if (
          run &&
          !run.forkSourceRunId &&
          (run.dispatchPhase === 'ended' ||
            ['completed', 'failed', 'interrupted'].includes(run.status))
        )
          settleCollaborationAction(repo, run)
      }
    })
    cursor = rows.at(-1)!.id
  }
}
