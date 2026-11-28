import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  agentDisplayName,
  collaborationActor,
  collaborationInitialStage,
  collaborationInputGate,
  collaborationInputProcessing,
  collaborationNextStage,
  collaborationTaskSchema,
  collaborationTurnAuthorizationSchema,
  confirmedUnsentProofSchema,
  CONVERSATION_PATCH_TEXT_BYTES,
  defaultTaskStageRoles,
  FROZEN_EXECUTION_INPUT_BYTES,
  frozenExecutionEnvelopeSchema,
  frozenExecutionInputSchema,
  isAgentInPair,
  isCollaborationOpenMode,
  MAX_COMMENTS_PER_MESSAGE,
  originSideChatSchema,
  otherAgent,
  pactCommandRouteAllowed,
  pactEntryPrimary,
  parseComposerCommandPrefix,
  PLAN_REVISION_GUIDANCE_BYTES,
  reexecutionDispatchGuardSchema,
  resolveActiveAgentPair,
  runEffectiveExecutionSettingsSchema,
  runRequestedExecutionSettingsSchema,
  unsentBoundaryMatchesProvider,
  workspaceChangeSetSchema,
  type AgentRun,
  type CollaborationTask,
  type CollaborationTurnAuthorization,
  type ConfirmedUnsentBoundary,
  type ConversationMessageRoute,
  type ConversationPatch,
  type RunEffectiveExecutionSettings,
  type RunRequestedExecutionSettings,
  type RuntimeAgentId,
  type SchedulingHandoff,
  type WorkspaceArchiveScope,
  type WorkspaceChangeSet,
} from '@pact/contracts'

import type { ConversationRepositoryHost } from './context.js'

import { appendAgentEvent } from '../agent-event-journal.js'
import * as scheduling from '../conversation-scheduling.js'
import { refreshNativeSessionMetadata } from '../native-presence-metadata.js'
import {
  agentRuns,
  anchoredComments,
  collaborationActionReceipts,
  collaborationInputs,
  collaborationTasks,
  collaborationTurnAuthorizations,
  conversationBodyInputs,
  conversationImageAssets,
  conversationMessageImages,
  conversationMessages,
  conversationQueueOperations,
  conversationRunSourceRefs,
  nativeRebuildOperations,
  relayDecisions,
  runExecutionInputs,
  runReexecutionOperations,
  schedulingRecoveryFaults,
  sessions,
  sessionSettingsRevisions,
  workflowTurns,
  workspaceChangeSets,
} from '../schema/index.js'
import {
  allocateSessionMessageSequence,
  finalizeMainSyncBackReceipt,
} from '../side-chat-persistence.js'
import { assertSessionAvailable } from '../workspace-archive-repository.js'
import { buildWorkspaceChangeSetSummary } from '../workspace-changes-repository.js'
import { storedReceivedMetadata, toMessageRoute } from './helpers.js'
import {
  activeRunStatuses,
  BODY_PART_UNITS,
  HANDOFF_SOURCE_IDS_BYTES,
  HandoffTooLargeError,
  publicRunColumns,
  RunOperationConflictError,
  type BeginRoutedContinuationInput,
  type BeginRunInput,
  type BeginRunResult,
} from './types.js'

/** Optional eligibility capture. Overflow closes recovery only; the original Send remains intact. */
export async function captureExecutionInput(
  repo: ConversationRepositoryHost,
  input: {
    runId: string
    nativeGeneration: string
    requested: RunRequestedExecutionSettings
    source: AsyncIterable<Uint8Array>
    signal: AbortSignal
  },
): Promise<import('@pact/contracts').FrozenExecutionInput | undefined> {
  const run = findRun(repo, input.runId)
  const settings = repo.schedulingSettings()
  const epoch = repo.schedulingRecoveryEpoch
  if (!run || !epoch || !settings.enabled) return undefined
  const prior = executionInput(repo, input.runId)
  if (prior) return prior.input
  const requested = runRequestedExecutionSettingsSchema.parse(input.requested)
  const configurationGeneration = repo.schedulingConfigurationGeneration()
  const ownerKey = `execution:${run.id}`
  const id = randomUUID()
  const now = new Date().toISOString()
  const deadline = Date.now() + 5000
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  repo.database
    .insert(conversationBodyInputs)
    .values({
      id,
      sessionId: run.sessionId,
      clientMessageId: input.nativeGeneration,
      ownerKey,
      purpose: 'collaboration',
      sourceRunId: run.id,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  try {
    for await (const chunk of input.source) {
      input.signal.throwIfAborted()
      bytes += chunk.byteLength
      if (bytes > FROZEN_EXECUTION_INPUT_BYTES || Date.now() >= deadline) return undefined
      const text = decoder.decode(chunk, { stream: true })
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(text.length, offset + BODY_PART_UNITS)
        if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--
        const row = repo.bodyInput(id, run.sessionId, ownerKey)
        repo.appendBodyPart(row, row.chars, text.slice(offset, end))
        offset = end
      }
    }
    const tail = decoder.decode()
    if (tail) {
      const row = repo.bodyInput(id, run.sessionId, ownerKey)
      repo.appendBodyPart(row, row.chars, tail)
    }
    input.signal.throwIfAborted()
    if (
      epoch !== repo.schedulingRecoveryEpoch ||
      configurationGeneration !== repo.schedulingConfigurationGeneration() ||
      !repo.schedulingSettings().enabled ||
      !repo.ownsNativeControl(run.id)
    )
      return undefined
    const row = repo.bodyInput(id, run.sessionId, ownerKey)
    const receipt = repo.sealBody(row)
    const sealed = repo.bodyInput(id, run.sessionId, ownerKey)
    if (!sealed.hash) return undefined
    const captured = frozenExecutionInputSchema.parse({
      version: 1,
      runId: run.id,
      document: { id, sha256: sealed.hash, bytes: receipt.bytes, chars: receipt.chars },
      inputSha256: sealed.hash,
    })
    repo.database
      .insert(runExecutionInputs)
      .values({
        runId: run.id,
        documentJson: repo.authorityJson(captured),
        requestedJson: repo.authorityJson(requested),
        nativeGeneration: input.nativeGeneration,
        configurationGeneration,
        utilityEpoch: epoch,
        createdAt: now,
      })
      .run()
    return captured
  } finally {
    if (
      !repo.database
        .select({ id: runExecutionInputs.runId })
        .from(runExecutionInputs)
        .where(eq(runExecutionInputs.runId, run.id))
        .get()
    )
      repo.database.delete(conversationBodyInputs).where(eq(conversationBodyInputs.id, id)).run()
  }
}

export function executionInput(repo: ConversationRepositoryHost, runId: string) {
  const row = repo.database
    .select()
    .from(runExecutionInputs)
    .where(eq(runExecutionInputs.runId, runId))
    .get()
  if (!row) return undefined
  return {
    row,
    input: frozenExecutionInputSchema.parse(JSON.parse(row.documentJson)),
    requested: runRequestedExecutionSettingsSchema.parse(JSON.parse(row.requestedJson)),
    effective: row.effectiveJson
      ? runEffectiveExecutionSettingsSchema.parse(JSON.parse(row.effectiveJson))
      : undefined,
    proof: row.proofJson ? confirmedUnsentProofSchema.parse(JSON.parse(row.proofJson)) : undefined,
  }
}

export function recordEffectiveExecutionSettings(
  repo: ConversationRepositoryHost,
  runId: string,
  nativeGeneration: string,
  raw: RunEffectiveExecutionSettings,
  identity: { executorId: string; nativeSessionId: string },
): void {
  const settings = runEffectiveExecutionSettingsSchema.parse(raw)
  const saved = executionInput(repo, runId)
  const run = findRun(repo, runId)
  if (
    !saved ||
    !run ||
    saved.row.nativeGeneration !== nativeGeneration ||
    saved.row.utilityEpoch !== repo.schedulingRecoveryEpoch ||
    settings.provider !== run.agentId ||
    run.nativeTurnId ||
    run.nativeOutcome ||
    !repo.ownsNativeControl(runId) ||
    (run.executorId && run.executorId !== identity.executorId) ||
    (run.nativeSessionId && run.nativeSessionId !== identity.nativeSessionId)
  )
    return
  const json = repo.authorityJson(settings)
  if (
    saved.row.effectiveJson &&
    (saved.row.effectiveJson !== json ||
      saved.row.executorId !== identity.executorId ||
      saved.row.nativeSessionId !== identity.nativeSessionId)
  )
    throw new RunOperationConflictError('The native-effective execution settings changed.')
  repo.database
    .update(runExecutionInputs)
    .set({ effectiveJson: json, ...identity })
    .where(eq(runExecutionInputs.runId, runId))
    .run()
}

export function recordConfirmedUnsent(
  repo: ConversationRepositoryHost,
  runId: string,
  nativeGeneration: string,
  boundary: ConfirmedUnsentBoundary,
  identity: { executorId: string; nativeSessionId: string },
): void {
  const saved = executionInput(repo, runId)
  const run = findRun(repo, runId)
  if (
    !saved?.effective ||
    !run ||
    run.nativeTurnId ||
    run.nativeOutcome ||
    ['accepted', 'ended'].includes(run.dispatchPhase ?? '') ||
    saved.row.nativeGeneration !== nativeGeneration ||
    saved.row.utilityEpoch !== repo.schedulingRecoveryEpoch ||
    saved.row.executorId !== identity.executorId ||
    saved.row.nativeSessionId !== identity.nativeSessionId ||
    !unsentBoundaryMatchesProvider(run.agentId, boundary.kind)
  )
    return
  const proof = confirmedUnsentProofSchema.parse({
    version: 1,
    runId,
    bindingGeneration: run.bindingGeneration ?? 1,
    nativeGeneration,
    ...identity,
    inputSha256: saved.input.inputSha256,
    effectiveSettingsSha256: createHash('sha256')
      .update(JSON.stringify(saved.effective))
      .digest('hex'),
    boundary,
  })
  repo.database.transaction(() => {
    repo.database
      .update(runExecutionInputs)
      .set({ proofJson: repo.authorityJson(proof) })
      .where(eq(runExecutionInputs.runId, runId))
      .run()
    repo.nativeFact(runId, 'native.root_confirmed_unsent', {
      boundary: boundary.kind,
      inputSha256: proof.inputSha256,
      effectiveSettingsSha256: proof.effectiveSettingsSha256,
      nativeGeneration,
    })
    repo.refreshSchedulingRecoveryFacts(run.sessionId)
  })
}

/** Bounded full immutable input, never reconstructed from the current Composer or history page. */
export function frozenExecutionEnvelope(repo: ConversationRepositoryHost, runId: string) {
  const saved = executionInput(repo, runId)
  const run = findRun(repo, runId)
  if (!saved || !run || saved.input.document.bytes > FROZEN_EXECUTION_INPUT_BYTES)
    throw new RunOperationConflictError('The complete original execution input is unavailable.')
  return frozenExecutionEnvelopeSchema.parse(
    JSON.parse(repo.collaborationDocumentText(run.sessionId, saved.input.document)),
  )
}

function confirmedUnsentTarget(
  repo: ConversationRepositoryHost,
  faultId: string,
  node: SchedulingHandoff,
) {
  const fault = repo.database
    .select()
    .from(schedulingRecoveryFaults)
    .where(eq(schedulingRecoveryFaults.id, faultId))
    .get()
  const run = fault && findRun(repo, fault.runId)
  const saved = run && executionInput(repo, run.id)
  const raw = run && repo.database.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()
  const context = run && repo.nativeContext(run.sessionId, run.agentId)
  const session =
    run && repo.database.select().from(sessions).where(eq(sessions.id, run.sessionId)).get()
  const latestInput =
    run &&
    repo.database
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.sessionId, run.sessionId),
          eq(conversationMessages.role, 'user'),
        ),
      )
      .orderBy(desc(conversationMessages.sequence))
      .limit(1)
      .get()
  if (
    !fault ||
    !run ||
    !saved?.effective ||
    !saved.proof ||
    !raw ||
    !session ||
    !context ||
    fault.faultKind !== 'run' ||
    !fault.active ||
    fault.utilityEpoch !== repo.schedulingRecoveryEpoch ||
    fault.configurationGeneration !== repo.schedulingConfigurationGeneration() ||
    saved.row.utilityEpoch !== fault.utilityEpoch ||
    saved.row.configurationGeneration !== fault.configurationGeneration ||
    !repo.schedulingSettings().enabled ||
    raw.automaticRecoveryRevoked ||
    run.reexecutedFromRunId ||
    run.forkSourceRunId ||
    repo.collaborationTurnAuthorization(run.id)?.replyIntentBasis?.kind === 'ask_only' ||
    run.controlDisposition === 'abandoned' ||
    !['failed', 'interrupted'].includes(run.status) ||
    run.nativeTurnId ||
    run.nativeOutcome ||
    ['accepted', 'ended'].includes(run.dispatchPhase ?? '') ||
    !['not_dispatched', 'settled'].includes(run.nativeEffectsState ?? '') ||
    repo.hasCompleteResponse(run.id) ||
    session.archivedAt ||
    session.status === 'archived' ||
    session.settingsRevision !== run.settingsRevision ||
    latestInput?.id !== run.userMessageId ||
    repo.latestAgentRun(run.sessionId, run.agentId)?.id !== run.id ||
    context.bindingGeneration !== saved.proof.bindingGeneration ||
    context.nativeSessionId !== saved.proof.nativeSessionId ||
    context.executorId !== saved.proof.executorId ||
    context.continuationState !== 'ready' ||
    context.permissionRequests?.length ||
    repo.receivedCollaborationInput(run.sessionId) ||
    repo.pendingNativeRebuild(run.sessionId, run.agentId) ||
    saved.proof.runId !== run.id ||
    saved.proof.inputSha256 !== saved.input.inputSha256 ||
    !unsentBoundaryMatchesProvider(run.agentId, saved.proof.boundary.kind) ||
    saved.proof.effectiveSettingsSha256 !==
      createHash('sha256').update(JSON.stringify(saved.effective)).digest('hex') ||
    [
      'user_stopped',
      'authentication_required',
      'quota_or_rate_limit',
      'permission_blocked',
      'runtime_incompatible',
    ].includes(run.failureKind ?? '')
  )
    throw new RunOperationConflictError('The original unsent execution is no longer eligible.')
  assertSessionAvailable(repo.database, run.sessionId)
  repo.assertRelayDecisionResolved(run.sessionId)
  repo.assertSchedulingFreshness(node)
  if (
    node.fault?.kind !== fault.faultKind ||
    node.fault.id !== fault.faultId ||
    node.freshnessGuard.runId !== run.id
  )
    throw new RunOperationConflictError('The replacement must retain its original fault target.')
  return { fault, run, saved, raw, context, session }
}

/** Independent operation, same user input and duty. Never freezes drafts or reclaims the handoff. */
export function beginConfirmedUnsentReexecution(
  repo: ConversationRepositoryHost,
  input: {
    operationId: string
    faultId: string
    handoff: SchedulingHandoff
  },
) {
  if (!/^[a-f0-9-]{36}$/u.test(input.operationId))
    throw new RunOperationConflictError('The replacement operation identity is invalid.')
  const result = repo.database.transaction(() => {
    const prior = repo.database
      .select()
      .from(runReexecutionOperations)
      .where(eq(runReexecutionOperations.id, input.operationId))
      .get()
    if (prior) {
      if (prior.faultId !== input.faultId)
        throw new RunOperationConflictError('This operation belongs to another original fault.')
      return { run: findRun(repo, prior.replacementRunId)!, created: false }
    }
    if (
      repo.database
        .select({ id: runReexecutionOperations.id })
        .from(runReexecutionOperations)
        .where(eq(runReexecutionOperations.faultId, input.faultId))
        .get()
    )
      throw new RunOperationConflictError('The original fault already used its one replacement.')
    const { fault, run, saved, raw } = confirmedUnsentTarget(repo, input.faultId, input.handoff)
    if (
      repo.database
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.sessionId, run.sessionId),
            inArray(agentRuns.status, [...activeRunStatuses]),
            ne(agentRuns.controlDisposition, 'abandoned'),
          ),
        )
        .get()
    )
      throw new RunOperationConflictError('The Session already has an active Run.')
    const envelope = frozenExecutionEnvelope(repo, run.id)
    if (
      envelope.message.id !== run.userMessageId ||
      envelope.sessionId !== run.sessionId ||
      envelope.inputBatchRef?.id !== repo.inputBatchForRun(run.id)?.id
    )
      throw new RunOperationConflictError('The original frozen input no longer matches its Run.')
    const now = new Date().toISOString(),
      replacementId = randomUUID()
    const node = scheduling.handoff({
      ...input.handoff,
      slot: 'confirmed_resend',
      eventId: `${fault.faultId}:confirmed_unsent`,
      factFingerprint: scheduling.fingerprint([input.handoff.factFingerprint, saved.proof]),
    })
    const reservation = scheduling.reserveBudget(repo.database, {
      handoff: node,
      budget: 'automatic_resend',
    })
    if (reservation.status !== 'reserved')
      throw new RunOperationConflictError('The automatic replacement allowance is unavailable.')
    const task = repo.collaboration(run.sessionId)
    const turn = repo.database
      .select()
      .from(workflowTurns)
      .where(eq(workflowTurns.runId, run.id))
      .get()
    let next: CollaborationTask | undefined
    let auth: CollaborationTurnAuthorization | undefined
    if (turn) {
      const before = envelope.collaboration,
        originalAuth = envelope.collaborationAuthorization
      const failed = repo.decodedCollaboration(turn.stateJson)
      const normalized = task && { ...task, inputProcessing: collaborationInputProcessing(task) }
      const expected = { ...failed, inputProcessing: collaborationInputProcessing(failed) }
      if (
        !task ||
        !before ||
        !originalAuth ||
        !turn.applied ||
        task.id !== turn.taskId ||
        task.runId !== run.id ||
        task.status !== 'failed' ||
        task.pauseReason !== 'failure' ||
        (task.planRevision && ['implement', 'repair', 'respond'].includes(originalAuth.stage)) ||
        !isDeepStrictEqual(normalized, expected) ||
        !isDeepStrictEqual(originalAuth, JSON.parse(turn.authorizationJson)) ||
        before.id !== task.id ||
        before.inputSequence !== task.inputSequence ||
        before.actor !== task.actor ||
        before.stage !== task.stage ||
        before.owner !== task.owner ||
        before.reviewer !== task.reviewer ||
        before.rolePolicy !== task.rolePolicy ||
        !isDeepStrictEqual(before.stageRoles, task.stageRoles) ||
        !isDeepStrictEqual(before.planReference, task.planReference) ||
        !isDeepStrictEqual(before.review, task.review)
      )
        throw new RunOperationConflictError('The original workflow duty changed after its failure.')
      next = {
        ...task,
        runId: replacementId,
        revision: task.revision + 1,
        status: 'running',
        automation: before.automation,
        pauseReason: before.pauseReason,
        notice: before.notice,
        nextStage: before.nextStage,
        pendingWork: before.pendingWork,
      }
      auth = collaborationTurnAuthorizationSchema.parse({
        ...originalAuth,
        runId: replacementId,
        taskRevision: next.revision,
      })
      next.authorization = auth
      if (turn.reservation) {
        const limits = repo.database
          .select()
          .from(sessionSettingsRevisions)
          .where(
            and(
              eq(sessionSettingsRevisions.sessionId, run.sessionId),
              eq(sessionSettingsRevisions.revision, run.settingsRevision),
            ),
          )
          .get()!
        let limit =
          turn.reservation === 'discussionRounds'
            ? limits.maxDiscussionRounds
            : turn.reservation === 'reviewCycles'
              ? limits.maxReviewCycles
              : limits.maxRepairAttempts
        if (
          turn.reservation === 'discussionRounds' &&
          task.discussionRounds + 1 > limit &&
          originalAuth.userAuthority?.purpose === 'action'
        ) {
          const extension = scheduling.confirmedPlanReviewExtension(
            repo.database,
            originalAuth.userAuthority.receiptId,
          )
          if (
            extension &&
            extension.taskId === task.id &&
            extension.actor === originalAuth.actor &&
            extension.inputSequence === originalAuth.inputSequence &&
            extension.expectedDiscussionRounds === task.discussionRounds &&
            extension.maximum === limits.maxDiscussionRounds &&
            isDeepStrictEqual(extension.planReference, originalAuth.planReference)
          )
            limit = task.discussionRounds + 1
        }
        if (
          task[turn.reservation] !== before[turn.reservation] - 1 ||
          task[turn.reservation] + 1 > limit
        )
          throw new RunOperationConflictError(
            'The original workflow reservation was not refunded exactly once.',
          )
        next[turn.reservation]++
      }
    } else if (run.collaboration || task?.status === 'running')
      throw new RunOperationConflictError('The original workflow authorization is unavailable.')
    repo.database
      .insert(agentRuns)
      .values({
        id: replacementId,
        sessionId: run.sessionId,
        userMessageId: run.userMessageId,
        agentId: run.agentId,
        collaborationTaskId: raw.collaborationTaskId,
        collaborationKind: raw.collaborationKind,
        collaborationStage: raw.collaborationStage,
        answerFormat: raw.answerFormat,
        status: 'starting',
        attemptCount: 1,
        settingsRevision: run.settingsRevision,
        model: saved.requested.model,
        effort: saved.requested.effort,
        permissionMode: saved.requested.permissionMode,
        speed: saved.requested.speed,
        bindingGeneration: run.bindingGeneration ?? 1,
        nativeSessionId: saved.proof!.nativeSessionId,
        nativeEffectsState: 'not_dispatched',
        reexecutedFromRunId: run.id,
        reexecutionOperationId: input.operationId,
        handoffSourceIds: raw.handoffSourceIds,
        handoffMessageCount: raw.handoffMessageCount,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    if (auth && next) {
      for (const field of ['relayWorkRef', 'sourceManifestRef'] as const) {
        const document = auth[field]
        if (!document) continue
        const owner = repo.collaborationDocumentRow(run.sessionId, document)
        if (owner.sourceRunId !== run.id) continue
        if (document.bytes > PLAN_REVISION_GUIDANCE_BYTES)
          throw new RunOperationConflictError(
            'The exact frozen host instruction exceeds its metadata bound.',
          )
        // The same approved host instruction now has the actual completing execution as carrier.
        auth[field] = repo.saveCollaborationDocument(
          replacementId,
          repo.collaborationDocumentText(run.sessionId, document),
        )
      }
      next.authorization = auth
    }
    repo.database
      .insert(runReexecutionOperations)
      .values({
        id: input.operationId,
        faultId: fault.id,
        originalRunId: run.id,
        replacementRunId: replacementId,
        budgetReservationId: reservation.reservation.id,
        handoffJson: repo.authorityJson(node),
        createdAt: now,
        updatedAt: now,
      })
      .run()
    repo.database.run(sql`INSERT INTO conversation_run_source_refs
        (run_id,source_message_id,source_revision,batch_id,documents_json)
        SELECT ${replacementId},source_message_id,source_revision,batch_id,documents_json
        FROM conversation_run_source_refs WHERE run_id=${run.id}`)
    repo.database
      .insert(conversationRunSourceRefs)
      .values({ runId: replacementId, ...repo.quotedSource(run.sessionId, run.userMessageId) })
      .onConflictDoNothing()
      .run()
    if (next && auth && turn) {
      if (auth.userAuthority) {
        const receipt = repo.database
          .select()
          .from(collaborationActionReceipts)
          .where(eq(collaborationActionReceipts.id, auth.userAuthority.receiptId))
          .get()
        if (
          !receipt ||
          receipt.boundRunId !== run.id ||
          receipt.state !== 'not_sent' ||
          receipt.taskId !== auth.taskId ||
          receipt.actor !== auth.actor ||
          receipt.rootReceiptId !== auth.userAuthority.rootReceiptId
        )
          throw new RunOperationConflictError('The original concrete action cannot be rebound.')
        const budgetReservationId = receipt.budgetReservationId
          ? scheduling.reacquireUnsentExtraTurnBudget(
              repo.database,
              receipt.budgetReservationId,
              input.operationId,
            ).id
          : null
        repo.database
          .update(collaborationActionReceipts)
          .set({
            boundRunId: replacementId,
            state: 'bound',
            active: false,
            budgetReservationId,
            updatedAt: now,
          })
          .where(eq(collaborationActionReceipts.id, receipt.id))
          .run()
      }
      repo.database
        .update(collaborationActionReceipts)
        .set({ reviewRunId: replacementId, updatedAt: now })
        .where(
          and(
            eq(collaborationActionReceipts.reviewRunId, run.id),
            eq(collaborationActionReceipts.reviewState, 'pending'),
          ),
        )
        .run()
      repo.saveCollaboration(next)
      repo.database
        .insert(workflowTurns)
        .values({
          runId: replacementId,
          taskId: next.id,
          stage: auth.stage,
          actor: auth.actor,
          inputSequence: auth.inputSequence,
          taskRevision: next.revision,
          authorizationJson: JSON.stringify(auth),
          stateJson: JSON.stringify(repo.storedCollaboration(next)),
          reservation: turn.reservation,
          applied: false,
          createdAt: now,
        })
        .run()
      const originalAuthorization = repo.database
        .select()
        .from(collaborationTurnAuthorizations)
        .where(eq(collaborationTurnAuthorizations.runId, run.id))
        .get()
      if (originalAuthorization)
        repo.database
          .insert(collaborationTurnAuthorizations)
          .values({
            ...originalAuthorization,
            runId: replacementId,
            authorizationJson: JSON.stringify(auth),
            createdAt: now,
          })
          .run()
    }
    const message = repo.internalMessage(run.userMessageId, run.sessionId)
    if (message?.route?.type === 'all' && run.agentId === message.route.firstAgentId) {
      if (
        repo.database
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.userMessageId, run.userMessageId),
              eq(agentRuns.agentId, message.route.secondAgentId),
            ),
          )
          .get()
      )
        throw new RunOperationConflictError('The second routed stage already exists.')
      repo.database
        .update(conversationMessages)
        .set({ routePendingAgentId: message.route.secondAgentId, updatedAt: now })
        .where(eq(conversationMessages.id, run.userMessageId))
        .run()
    }
    scheduling.claimHandoff(repo.database, node, 'confirmed_resend', {
      runId: replacementId,
      operationId: input.operationId,
    })
    repo.database
      .update(schedulingRecoveryFaults)
      .set({
        latestAction: 'resend',
        result: 'reserved',
        armed: false,
        pending: false,
        physicalUnconfirmed: false,
        activityAt: now,
      })
      .where(eq(schedulingRecoveryFaults.id, fault.id))
      .run()
    scheduling.syncRecoveryActivity(repo.database, fault.id, node.id)
    repo.nativeFact(replacementId, 'scheduling.confirmed_unsent_reexecution_admitted', {
      operationId: input.operationId,
      originalRunId: run.id,
      faultId: fault.id,
      inputSha256: saved.input.inputSha256,
      effectiveSettingsSha256: saved.proof!.effectiveSettingsSha256,
      reservationId: reservation.reservation.id,
    })
    refreshNativeSessionMetadata(repo.database, run.sessionId)
    repo.database
      .update(runReexecutionOperations)
      .set({
        dispatchGuardJson: repo.authorityJson(reexecutionDispatchGuard(repo, replacementId)),
      })
      .where(eq(runReexecutionOperations.id, input.operationId))
      .run()
    return { run: findRun(repo, replacementId)!, created: true }
  })
  repo.schedulingChanged()
  return { ...result, patch: repo.runPatch(result.run.id) }
}

function reexecutionDispatchGuard(repo: ConversationRepositoryHost, runId: string) {
  const run = findRun(repo, runId)
  if (!run) throw new RunOperationConflictError('The replacement execution is unavailable.')
  const session = repo.database.select().from(sessions).where(eq(sessions.id, run.sessionId)).get()!
  const task = repo.collaboration(run.sessionId)
  return reexecutionDispatchGuardSchema.parse({
    version: 1,
    settingsRevision: session.settingsRevision,
    queueRevision: session.queueRevision,
    receivedInputId: repo.receivedCollaborationInput(run.sessionId)?.id ?? null,
    taskFingerprint: task
      ? scheduling.fingerprint({
          id: task.id,
          revision: task.revision,
          inputSequence: task.inputSequence,
          runId: task.runId,
          status: task.status,
          automation: task.automation,
          pauseReason: task.pauseReason,
        })
      : null,
  })
}

/** Final native-write fence; no await can separate this validation from the native producer. */
export function canDispatchReexecution(repo: ConversationRepositoryHost, runId: string): boolean {
  try {
    const run = findRun(repo, runId)
    const row = repo.database.select().from(agentRuns).where(eq(agentRuns.id, runId)).get()
    const operation = row?.reexecutionOperationId
      ? repo.database
          .select()
          .from(runReexecutionOperations)
          .where(eq(runReexecutionOperations.id, row.reexecutionOperationId))
          .get()
      : undefined
    const saved = operation && executionInput(repo, operation.originalRunId)
    const binding = run && repo.nativeContext(run.sessionId, run.agentId)
    if (
      !run ||
      !['starting', 'running'].includes(run.status) ||
      !row ||
      row.automaticRecoveryRevoked ||
      !operation ||
      !operation.dispatchGuardJson ||
      !saved?.proof ||
      operation.replacementRunId !== runId ||
      !['reserved', 'possibly_sent'].includes(operation.result) ||
      saved.row.utilityEpoch !== repo.schedulingRecoveryEpoch ||
      saved.row.configurationGeneration !== repo.schedulingConfigurationGeneration() ||
      !repo.schedulingSettings().enabled ||
      !repo.ownsNativeControl(runId) ||
      !binding ||
      binding.permissionRequests?.length ||
      binding.nativeSessionId !== saved.proof.nativeSessionId ||
      binding.bindingGeneration !== saved.proof.bindingGeneration ||
      binding.executorId !== saved.proof.executorId ||
      (run.executorId !== undefined && run.executorId !== saved.proof.executorId) ||
      repo
        .nativeContexts(run.sessionId)
        .some(
          (other) => other.agentId !== run.agentId && other.continuationState === 'waiting_user',
        )
    )
      return false
    const guard = reexecutionDispatchGuardSchema.parse(JSON.parse(operation.dispatchGuardJson))
    if (
      guard.receivedInputId !== null ||
      !isDeepStrictEqual(guard, reexecutionDispatchGuard(repo, runId))
    )
      return false
    assertSessionAvailable(repo.database, run.sessionId)
    repo.assertRelayDecisionResolved(run.sessionId)
    repo.assertWorkflowDispatch(runId)
    return true
  } catch {
    return false
  }
}

export function beginRun(repo: ConversationRepositoryHost, input: BeginRunInput): BeginRunResult {
  if (
    input.userInformation &&
    (input.collaboration ||
      input.receivedInputId ||
      input.sourceProposalId ||
      input.sourceMessageId ||
      input.preserveDraftComments ||
      input.skillInvocation ||
      input.skills?.length ||
      input.imageIds?.length ||
      input.returnedInputOperationId ||
      input.queueReturnOperationId ||
      input.replyToDecision ||
      input.route?.type === 'all')
  )
    throw new RunOperationConflictError('Declared information belongs to a new ordinary Send only.')
  const existing = repo.submittedRunReceipt(input)
  if (existing) return existing
  const commandPrefix = parseComposerCommandPrefix(input.content, input.skills)
  if (commandPrefix.error && !input.collaboration && !input.sourceMessageId) {
    throw new RunOperationConflictError(commandPrefix.error)
  }
  if (commandPrefix.pact && !pactCommandRouteAllowed(input.route, commandPrefix.route))
    throw new RunOperationConflictError(
      'The explicit Agent recipients conflict. Your draft was preserved.',
    )
  const currentTask =
    input.collaboration && input.expectedCollaborationRevision !== undefined
      ? repo.collaboration(input.sessionId)
      : undefined
  const handoff =
    (input.preparedInput ? repo.preparedInputHandoff(input.preparedInput.batchId) : undefined) ??
    input.schedulingHandoff ??
    (currentTask
      ? repo.workflowHandoff(currentTask, input.agentId, input.receivedInputId)
      : undefined)
  if (handoff) {
    const receipt = repo.handoffReceipt(handoff.id)
    if (receipt?.runId) {
      const run = findRun(repo, receipt.runId)
      if (!run || receipt.sessionId !== input.sessionId)
        throw new RunOperationConflictError('The original handoff receipt is unavailable.')
      if (
        input.collaboration &&
        (run.agentId !== input.agentId || run.collaboration?.stage !== input.collaboration.stage)
      )
        throw new RunOperationConflictError('A different action already owns this handoff.')
      return { run, patch: repo.runPatch(run.id), created: false }
    }
  }

  const handoffSourceIds = JSON.stringify(input.handoffSourceRefs ?? [])
  if (Buffer.byteLength(handoffSourceIds, 'utf8') > HANDOFF_SOURCE_IDS_BYTES)
    throw new HandoffTooLargeError('The required Agent context is too large to save safely.')

  const runId = randomUUID()
  const userMessageId = input.clientMessageId
  const createdAt = new Date().toISOString()
  const isPeerProposal = Boolean(input.sourceProposalId)
  const isRoutedSecondLeg = Boolean(input.sourceMessageId && !input.sourceProposalId)
  const unfrozenRun =
    (!input.sourceMessageId || isPeerProposal) &&
    !input.receivedInputId &&
    !input.collaborationActionReceiptId
  const supersededProposalRunIds: string[] = []
  let replacedTaskRunId: string | undefined
  const receivedMeta = input.receivedInputId
    ? storedReceivedMetadata(
        repo.database
          .select({ json: collaborationInputs.metadataJson })
          .from(collaborationInputs)
          .where(eq(collaborationInputs.id, input.receivedInputId))
          .get()!.json,
      )
    : undefined
  const effectiveOriginSideChat = input.originSideChat
    ? originSideChatSchema.parse(input.originSideChat)
    : receivedMeta?.originSideChat
  const freezeDrafts = receivedMeta
    ? (receivedMeta.freezeDrafts ?? true)
    : (input.freezeDrafts ?? !input.preserveDraftComments)
  if (!freezeDrafts && !input.receivedInputId && input.commentIds.length)
    throw new RunOperationConflictError(
      'A preserved draft cannot also be included in this message.',
    )

  const committedCommentsRevision = repo.nativeMetadataTransaction(
    input.sessionId,
    (transaction) => {
      assertSessionAvailable(transaction, input.sessionId)
      repo.assertRelayDecisionResolved(input.sessionId, input.collaborationActionReceiptId)
      if (
        !input.receivedInputId &&
        !(
          input.collaboration &&
          input.expectedCollaborationRevision !== undefined &&
          input.preserveDraftComments
        )
      )
        repo.assertDecisionInput(input)
      const session = transaction
        .select()
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .get()
      if (!session) throw new Error('Session does not exist.')
      if (unfrozenRun && session.settingsRevision !== input.settingsRevision)
        throw new RunOperationConflictError('Session settings changed during workflow preparation.')
      const usesLiveSettings = unfrozenRun || Boolean(input.receivedInputId)
      const effectiveSettingsRevision = usesLiveSettings
        ? session.settingsRevision
        : input.settingsRevision
      const activePairForRun = usesLiveSettings
        ? repo.activePairForSession(input.sessionId, session.settingsRevision)
        : (repo.activePairForSession(input.sessionId, input.settingsRevision) ??
          repo.activePairForSession(input.sessionId))
      const ongoingTask = repo.collaboration(input.sessionId)
      const effectiveAllowedPair: readonly [RuntimeAgentId, RuntimeAgentId] | undefined =
        input.collaboration && input.collaboration.owner !== input.collaboration.reviewer
          ? [input.collaboration.owner, input.collaboration.reviewer]
          : !commandPrefix.pact &&
              ongoingTask &&
              ongoingTask.status !== 'complete' &&
              !ongoingTask.ending &&
              ongoingTask.owner !== ongoingTask.reviewer
            ? [ongoingTask.owner, ongoingTask.reviewer]
            : activePairForRun
      if (effectiveAllowedPair && !isRoutedSecondLeg) {
        if (!isAgentInPair(input.agentId, effectiveAllowedPair)) {
          throw new RunOperationConflictError(
            `${agentDisplayName(input.agentId)} is not an active Agent in this Session.`,
          )
        }
        if (
          commandPrefix.route?.type === 'agent' &&
          !isAgentInPair(commandPrefix.route.agentId, effectiveAllowedPair)
        ) {
          throw new RunOperationConflictError(
            `@${commandPrefix.route.agentId} is not an active Agent in this Session.`,
          )
        }
        if (
          input.route?.type === 'agent' &&
          !isAgentInPair(input.route.agentId, effectiveAllowedPair)
        ) {
          throw new RunOperationConflictError(
            `@${input.route.agentId} is not an active Agent in this Session.`,
          )
        }
        if (
          input.route?.type === 'all' &&
          'firstAgentId' in input.route &&
          (!isAgentInPair(input.route.firstAgentId, effectiveAllowedPair) ||
            !isAgentInPair(input.route.secondAgentId, effectiveAllowedPair))
        ) {
          throw new RunOperationConflictError(
            'The routed @all Agents do not match this Session’s active Agent pair.',
          )
        }
        for (const skill of input.skills ?? []) {
          if (!isAgentInPair(skill.agentId, effectiveAllowedPair)) {
            throw new RunOperationConflictError(
              `Skill /${skill.name} belongs to ${agentDisplayName(skill.agentId)}, which is not an active Agent in this Session.`,
            )
          }
        }
        for (const selection of input.skillInvocation?.selections ?? []) {
          if (!isAgentInPair(selection.agentId, effectiveAllowedPair)) {
            throw new RunOperationConflictError(
              `Skill /${selection.name} belongs to ${agentDisplayName(selection.agentId)}, which is not an active Agent in this Session.`,
            )
          }
        }
        for (const binding of input.skillInvocation?.bindings ?? []) {
          if (!isAgentInPair(binding.agentId, effectiveAllowedPair)) {
            throw new RunOperationConflictError(
              `Skill /${binding.name} belongs to ${agentDisplayName(binding.agentId)}, which is not an active Agent in this Session.`,
            )
          }
        }
      }
      const route: ConversationMessageRoute =
        input.route?.type === 'all'
          ? 'firstAgentId' in input.route
            ? input.route
            : {
                type: 'all',
                firstAgentId: input.agentId,
                secondAgentId: effectiveAllowedPair
                  ? otherAgent(input.agentId, effectiveAllowedPair)
                  : input.agentId === 'claude'
                    ? 'codex'
                    : 'claude',
              }
          : input.route?.type === 'agent'
            ? input.route
            : { type: 'primary', agentId: input.agentId }
      const routeAgents =
        route.type === 'all' ? [route.firstAgentId, route.secondAgentId] : [route.agentId]
      if (handoff) repo.assertSchedulingFreshness(handoff)
      const roleMetadata = input.preparedInput?.metadata.taskRoles
      const newTask = input.collaboration
      const previousTask = roleMetadata ? repo.collaboration(input.sessionId) : undefined
      if (roleMetadata) {
        const prefix = parseComposerCommandPrefix(input.content, input.skills)
        if (
          !newTask ||
          prefix.error ||
          prefix.route ||
          prefix.pact !== roleMetadata.kind ||
          newTask.kind !== roleMetadata.kind ||
          newTask.stage !== collaborationInitialStage(roleMetadata.kind) ||
          newTask.rolePolicy !== 'split-stages-v1' ||
          newTask.sessionId !== input.sessionId ||
          newTask.taskMessageId !== input.clientMessageId ||
          newTask.revision !== 0 ||
          newTask.inputSequence !== 0 ||
          newTask.handledInputSequence !== 0 ||
          newTask.status !== 'running' ||
          newTask.automation !== 'active' ||
          newTask.authorization ||
          newTask.pendingWork ||
          newTask.planReference ||
          newTask.review ||
          newTask.reviewScopeRef ||
          newTask.codeRunId ||
          newTask.planVersion !== 0 ||
          newTask.discussionRounds !== 0 ||
          newTask.repairAttempts !== 0 ||
          newTask.reviewCycles !== (roleMetadata.kind === 'review' ? 1 : 0) ||
          (previousTask &&
            (previousTask.status !== 'complete' || previousTask.id === newTask.id)) ||
          input.expectedCollaborationRevision !== undefined ||
          input.receivedInputId ||
          input.collaborationActionReceiptId ||
          input.schedulingHandoff ||
          input.sourceMessageId ||
          input.sourceProposalId ||
          input.preserveDraftComments ||
          input.returnedInputOperationId ||
          input.queueReturnOperationId ||
          input.replyToDecision ||
          input.userInformation ||
          input.skillInvocation ||
          input.skills?.length ||
          input.imageIds?.length ||
          input.inputRouting ||
          (input.route && input.route.type !== 'primary')
        )
          throw new RunOperationConflictError('The prepared roles do not belong to this new task.')
      }
      if (input.initialTaskRoles && !roleMetadata)
        throw new RunOperationConflictError(
          'Initial task roles require their original prepared input.',
        )
      if (input.inputRouting && input.initialTaskRoles)
        throw new RunOperationConflictError('Only one prepared input selection may be adopted.')
      const adoptedInputSelection = input.preparedInput
        ? repo.admittedPreparedInputSelection(
            input.preparedInput,
            input.initialTaskRoles ?? input.inputRouting,
          )
        : undefined
      const initialTaskRoles = input.preparedInput
        ? repo.preparedInitialTaskRoles(input.preparedInput, input.initialTaskRoles)
        : undefined
      if (
        input.preparedInput &&
        (input.receivedInputId ||
          (input.collaboration && !input.preparedInput.metadata.taskRoles) ||
          input.agentId !==
            repo.preparedInputRecipient(
              input.preparedInput,
              input.initialTaskRoles ?? input.inputRouting,
            ) ||
          (input.collaboration &&
            (!initialTaskRoles ||
              !isDeepStrictEqual(input.collaboration.stageRoles, initialTaskRoles))))
      )
        throw new RunOperationConflictError('The prepared input recipient is no longer authorized.')
      const authoritySources =
        input.collaborationActionReceiptId && handoff
          ? repo.relayWorkflowBusinessSources(handoff)
          : undefined
      const actionDecision = input.collaborationActionReceiptId
        ? transaction
            .select({ version: relayDecisions.formatVersion })
            .from(collaborationActionReceipts)
            .innerJoin(
              relayDecisions,
              eq(relayDecisions.id, collaborationActionReceipts.decisionId),
            )
            .where(eq(collaborationActionReceipts.id, input.collaborationActionReceiptId))
            .get()
        : undefined
      // Capture the admitted original source scope before the same transaction advances task state.
      const approvedRelayScope =
        actionDecision?.version === 2 && handoff ? repo.relayWorkflowSnapshot(handoff) : undefined
      const images = repo.resolveMessageImages(
        input.sessionId,
        input.imageIds ?? [],
        input.imageOwnerKey,
      )
      if (
        freezeDrafts &&
        !input.receivedInputId &&
        !input.preparedInput &&
        !input.originSideChat &&
        session.commentsRevision !== input.expectedCommentsRevision
      ) {
        throw new Error('Comment drafts changed. Refresh and try again.')
      }
      const activeRun = transaction
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.sessionId, input.sessionId),
            inArray(agentRuns.status, [...activeRunStatuses]),
            ne(agentRuns.controlDisposition, 'abandoned'),
            isNull(agentRuns.forkSourceRunId),
          ),
        )
        .get()
      if (activeRun) throw new RunOperationConflictError('This Session already has an active Run.')
      const draftsCondition = and(
        eq(anchoredComments.sessionId, input.sessionId),
        freezeDrafts ? undefined : sql`0`,
        input.preparedInput
          ? eq(anchoredComments.pendingReceiptId, input.preparedInput.clientMessageId)
          : input.receivedInputId
            ? eq(anchoredComments.pendingReceiptId, input.receivedInputId)
            : input.originSideChat
              ? eq(anchoredComments.pendingReceiptId, input.clientMessageId)
              : and(
                  isNull(anchoredComments.sentWithMessageId),
                  isNull(anchoredComments.pendingReceiptId),
                ),
      )
      const draftCount = transaction
        .select({ value: sql<number>`count(*)` })
        .from(anchoredComments)
        .where(draftsCondition)
        .get()!.value
      if (input.preserveDraftComments && !input.receivedInputId && input.commentIds.length > 0)
        throw new Error('Peer actions cannot consume Comment drafts.')
      if (!input.content.trim() && !images.length && (!draftCount || !freezeDrafts))
        throw new RunOperationConflictError(
          'Write a message, add a Comment, or attach an image before sending.',
        )
      const sourceProposal = input.sourceProposalId
        ? transaction
            .select({
              runId: agentRuns.id,
              runStatus: agentRuns.status,
              sourceAgentId: agentRuns.agentId,
              targetAgentId: agentRuns.peerProposalTargetAgentId,
              state: agentRuns.peerProposalState,
              sourceMessageId: conversationMessages.id,
              sourceMessageAgentId: conversationMessages.agentId,
              sourceMessageState: conversationMessages.state,
              sourceHasBody: sql<number>`length(trim(${conversationMessages.content}, char(9) || char(10) || char(13) || ' ')) > 0`,
            })
            .from(agentRuns)
            .innerJoin(
              conversationMessages,
              and(
                eq(conversationMessages.runId, agentRuns.id),
                eq(conversationMessages.role, 'assistant'),
                eq(conversationMessages.isVisible, true),
              ),
            )
            .where(
              and(
                eq(agentRuns.sessionId, input.sessionId),
                eq(agentRuns.peerProposalId, input.sourceProposalId),
              ),
            )
            .orderBy(desc(conversationMessages.sequence))
            .limit(1)
            .get()
        : undefined
      if (
        input.sourceProposalId &&
        (!sourceProposal ||
          sourceProposal.state !== 'pending' ||
          sourceProposal.targetAgentId !== input.agentId ||
          sourceProposal.runStatus !== 'completed' ||
          sourceProposal.sourceMessageId !== input.sourceMessageId ||
          sourceProposal.sourceMessageState !== 'complete' ||
          !sourceProposal.sourceHasBody ||
          sourceProposal.sourceMessageAgentId !== sourceProposal.sourceAgentId)
      )
        throw new RunOperationConflictError('This peer request is no longer available.')
      const queueReturn = input.queueReturnOperationId
        ? transaction
            .select()
            .from(conversationQueueOperations)
            .where(
              and(
                eq(conversationQueueOperations.id, input.queueReturnOperationId),
                eq(conversationQueueOperations.sessionId, input.sessionId),
                eq(conversationQueueOperations.kind, 'return'),
              ),
            )
            .get()
        : undefined
      if (input.queueReturnOperationId && (!queueReturn || queueReturn.state !== 'installed'))
        throw new RunOperationConflictError('The returned queue source was already consumed.')
      if (input.queueReturnOperationId)
        repo.consumeQueuedReturn(input.sessionId, input.queueReturnOperationId)
      const returnId =
        input.returnedInputOperationId ??
        (!input.preserveDraftComments
          ? repo.rebuildInputRecovery(input.sessionId)?.operationId
          : undefined)
      if (returnId) {
        const returned = repo.verifyReturnedInput(returnId, input.sessionId)
        if (input.returnedInputOperationId && returned.record.state !== 'installed')
          throw new RunOperationConflictError('Restore this input before sending it.')
        returned.record.state = 'consumed'
        transaction
          .update(nativeRebuildOperations)
          .set({ returnedInputJson: JSON.stringify(returned.record) })
          .where(eq(nativeRebuildOperations.id, returnId))
          .run()
        repo.nativeFact(returned.record.runId, 'native.input_consumed', {
          operationId: returnId,
          messageId: returned.record.messageId,
          replacementMessageId: userMessageId,
          reason: input.returnedInputOperationId ? 'returned_input_sent' : 'new_input_sent',
        })
      }
      const superseded = transaction
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.sessionId, input.sessionId),
            eq(agentRuns.peerProposalState, 'pending'),
            ...(input.sourceProposalId
              ? [ne(agentRuns.peerProposalId, input.sourceProposalId)]
              : []),
          ),
        )
        .all()
      supersededProposalRunIds.push(...superseded.map((entry) => entry.id))
      if (supersededProposalRunIds.length > 0)
        transaction
          .update(agentRuns)
          .set({ peerProposalState: 'superseded', updatedAt: createdAt })
          .where(inArray(agentRuns.id, supersededProposalRunIds))
          .run()
      const messageSequence = allocateSessionMessageSequence(transaction, input.sessionId)

      if (input.receivedInputId) {
        const received = repo.receivedCollaborationInput(input.sessionId)
        if (
          !received ||
          received.id !== input.receivedInputId ||
          received.state !== 'accepted' ||
          received.queueState !== 'queued' ||
          (!session.queueEnabled && !input.collaboration) ||
          session.queuePauseReason
        )
          throw new RunOperationConflictError('This received input is no longer eligible.')
      }
      if (input.collaboration) {
        const task = collaborationTaskSchema.parse({ ...input.collaboration, runId })
        const current = repo.collaboration(input.sessionId)
        if (
          task.rolePolicy &&
          (input.agentId !== task.actor ||
            (!['reply', 'collaborate'].includes(task.stage) &&
              !(
                isCollaborationOpenMode(task) &&
                (task.stage === 'code_review' || task.stage === 'plan_review')
              ) &&
              task.actor !== collaborationActor(task, task.stage)))
        )
          throw new RunOperationConflictError(
            'The Run does not match its frozen stage responsibility.',
          )
        if (task.rolePolicy && current?.id !== task.id) {
          const queued = input.receivedInputId ? repo.readReceivedInput(input.sessionId) : undefined
          const settings = transaction
            .select()
            .from(sessionSettingsRevisions)
            .where(
              and(
                eq(sessionSettingsRevisions.sessionId, input.sessionId),
                eq(sessionSettingsRevisions.revision, input.settingsRevision),
              ),
            )
            .get()
          const activePair = settings
            ? resolveActiveAgentPair({
                primaryAgentId: settings.primaryAgentId,
                secondaryAgentId: settings.secondaryAgentId,
              })
            : undefined
          const rolePair = roleMetadata
            ? resolveActiveAgentPair({
                primaryAgentId: roleMetadata.primaryAgentId,
                secondaryAgentId:
                  roleMetadata.secondaryAgentId ?? roleMetadata.defaults.planReviewer,
              })
            : activePair
          const primary =
            roleMetadata?.primaryAgentId ??
            (queued?.metadata.rolePolicy
              ? task.kind === 'build'
                ? otherAgent(queued.actor, rolePair)
                : queued.actor
              : settings
                ? pactEntryPrimary(
                    task.kind,
                    settings.primaryAgentId,
                    input.route?.type === 'agent' ? input.route.agentId : undefined,
                    settings.secondaryAgentId,
                  )
                : undefined)
          if (
            !primary ||
            !rolePair ||
            !isAgentInPair(primary, rolePair) ||
            task.owner !== primary ||
            task.reviewer !== otherAgent(primary, rolePair) ||
            (queued &&
              (queued.id !== input.receivedInputId ||
                queued.metadata.rolePolicy !== task.rolePolicy ||
                queued.actor !== input.agentId))
          )
            throw new RunOperationConflictError(
              'The new task does not match its accepted Primary responsibility.',
            )
          if (
            task.stageRoles &&
            !isDeepStrictEqual(
              task.stageRoles,
              roleMetadata
                ? initialTaskRoles
                : defaultTaskStageRoles(primary, otherAgent(primary, rolePair)),
            )
          )
            throw new RunOperationConflictError(
              'The initial stage roles have no current selection receipt.',
            )
        }
        const resuming = input.collaborationActionReceiptId
          ? transaction
              .select()
              .from(collaborationActionReceipts)
              .where(eq(collaborationActionReceipts.id, input.collaborationActionReceiptId))
              .get()
          : undefined
        const explicitResume = Boolean(
          resuming &&
          [
            'resume',
            'retry',
            'extend_plan_review',
            'execute',
            'review_plan',
            'review_code',
            'fix',
          ].includes(resuming.action) &&
          resuming.state === 'available' &&
          resuming.active &&
          resuming.taskId === current?.id &&
          task.automation === 'active',
        )
        if (current?.id === task.id) {
          if (
            input.expectedCollaborationRevision === undefined ||
            current.revision !== input.expectedCollaborationRevision ||
            task.revision !== current.revision + 1 ||
            task.inputSequence !== current.inputSequence ||
            task.owner !== current.owner ||
            task.reviewer !== current.reviewer ||
            task.rolePolicy !== current.rolePolicy ||
            !isDeepStrictEqual(task.stageRoles, current.stageRoles) ||
            !isDeepStrictEqual(task.planAcceptanceCoverage, current.planAcceptanceCoverage) ||
            !isDeepStrictEqual(task.reviewControlCoverage, current.reviewControlCoverage) ||
            !repo.planRevisionBasisMatches(current, task) ||
            (current.planRevision &&
              (task.status !== 'running' ||
                (task.stage !== 'reply' &&
                  (task.actor !== collaborationActor(current, task.stage) ||
                    (task.stage !== 'implement' &&
                      task.stage !== collaborationNextStage(current)))) ||
                (task.stage !== 'implement' &&
                  !isDeepStrictEqual(task.pendingWork, current.pendingWork)))) ||
            current.status === 'running' ||
            (!['reply', 'collaborate'].includes(task.stage) &&
              !(
                isCollaborationOpenMode(task) &&
                task.stage === 'code_review' &&
                Boolean(input.receivedInputId)
              ) &&
              current.automation !== 'active' &&
              !explicitResume) ||
            (!['reply', 'collaborate'].includes(task.stage) &&
              Boolean(collaborationInputGate(current)))
          )
            throw new RunOperationConflictError(
              'The collaboration changed before this Turn was admitted.',
            )
          transaction
            .update(collaborationTasks)
            .set({ stateJson: JSON.stringify(task), updatedAt: createdAt })
            .where(eq(collaborationTasks.id, task.id))
            .run()
        } else {
          if (
            input.expectedCollaborationRevision !== undefined ||
            task.planAcceptanceCoverage ||
            task.reviewControlCoverage ||
            task.planRevision ||
            task.taskMessageId !== input.clientMessageId
          )
            throw new RunOperationConflictError('This workflow task is no longer current.')
          const unfinished = current && current.status !== 'complete' ? current : undefined
          if (unfinished) {
            const reference = input.replaceTask
            if (!reference || reference.taskId !== unfinished.id)
              throw new RunOperationConflictError(
                'The current task changed. Confirm replacing it before sending this command again.',
              )
            if (input.receivedInputId) {
              // The queued command re-proves only identity; the immutable receipt holds the revision.
              const received = repo.receivedCollaborationInput(input.sessionId)
              const saved = received && storedReceivedMetadata(received.metadataJson).replaceTask
              if (
                !received ||
                received.id !== input.receivedInputId ||
                !isDeepStrictEqual(saved, reference)
              )
                throw new RunOperationConflictError(
                  'The original task replacement could not be verified.',
                )
            } else if (unfinished.revision !== reference.revision)
              throw new RunOperationConflictError(
                'The current task changed. Confirm replacing it before sending this command again.',
              )
            repo.replaceCollaborationTask(unfinished, {
              clientMessageId: input.clientMessageId,
              taskRevision: reference.revision,
            })
            replacedTaskRunId = unfinished.runId
          } else if (input.replaceTask && current?.id !== input.replaceTask.taskId)
            throw new RunOperationConflictError(
              'The confirmed task replacement is no longer current.',
            )
          transaction
            .update(collaborationTasks)
            .set({ active: false })
            .where(
              and(
                eq(collaborationTasks.sessionId, input.sessionId),
                eq(collaborationTasks.active, true),
              ),
            )
            .run()
          transaction
            .insert(collaborationTasks)
            .values({
              id: task.id,
              sessionId: task.sessionId,
              stateJson: JSON.stringify(task),
              active: true,
              updatedAt: createdAt,
            })
            .run()
        }
      } else if (!input.sourceProposalId) {
        repo.registerWorkflowInput(input.sessionId, userMessageId)
      }
      transaction
        .insert(conversationMessages)
        .values({
          id: userMessageId,
          sessionId: input.sessionId,
          runId,
          role: 'user',
          routeKind: route.type,
          routeAgentsJson: JSON.stringify(routeAgents),
          skillInvocationJson: input.skillInvocation ? JSON.stringify(input.skillInvocation) : null,
          routePendingAgentId: route.type === 'all' ? route.secondAgentId : null,
          sourceMessageId: input.sourceMessageId ?? null,
          originSideChatJson: effectiveOriginSideChat
            ? JSON.stringify(effectiveOriginSideChat)
            : null,
          content: input.content,
          state: 'complete',
          sequence: messageSequence,
          createdAt,
          updatedAt: createdAt,
        })
        .run()
      for (const [ordinal, image] of images.entries()) {
        transaction
          .insert(conversationMessageImages)
          .values({ messageId: userMessageId, ordinal, imageId: image.id })
          .run()
        transaction
          .update(conversationImageAssets)
          .set({ committed: true, pendingReceiptId: null, updatedAt: createdAt })
          .where(eq(conversationImageAssets.id, image.id))
          .run()
      }
      const liveAgentModelSettings =
        Boolean(input.receivedInputId) && input.settingsRevision !== session.settingsRevision
          ? (() => {
              const revRow = transaction
                .select()
                .from(sessionSettingsRevisions)
                .where(
                  and(
                    eq(sessionSettingsRevisions.sessionId, input.sessionId),
                    eq(sessionSettingsRevisions.revision, session.settingsRevision),
                  ),
                )
                .get()
              if (!revRow) return undefined
              return input.agentId === 'claude'
                ? { model: revRow.claudeModel, effort: revRow.claudeEffort }
                : input.agentId === 'codex'
                  ? { model: revRow.codexModel, effort: revRow.codexEffort }
                  : { model: revRow.agyModel, effort: revRow.agyEffort }
            })()
          : undefined
      transaction
        .insert(agentRuns)
        .values({
          id: runId,
          collaborationTaskId: input.collaboration?.id,
          collaborationKind: input.collaboration?.kind,
          collaborationStage: input.collaboration?.stage,
          sessionId: input.sessionId,
          userMessageId,
          agentId: input.agentId,
          status: 'starting',
          bindingGeneration:
            repo.nativeContext(input.sessionId, input.agentId)?.bindingGeneration ?? 1,
          nativeEffectsState: 'not_dispatched',
          attemptCount: 1,
          settingsRevision: effectiveSettingsRevision,
          ...repo.runSettingsAt(input.sessionId, input.agentId, effectiveSettingsRevision),
          model: liveAgentModelSettings ? liveAgentModelSettings.model : input.model,
          effort: liveAgentModelSettings ? liveAgentModelSettings.effort : input.effort,
          handoffSourceIds,
          handoffMessageCount: input.handoffSourceRefs?.length ?? 0,
          createdAt,
          updatedAt: createdAt,
        })
        .run()
      if (input.preparedInput) repo.finalizePreparedInputDispatch(input, runId, userMessageId)
      else
        repo.supersedePausedPreparedInput(input.sessionId, input.batchId ?? input.clientMessageId)
      const admittedAction = repo.admitCollaborationAction(
        input,
        handoff,
        runId,
        currentTask,
        undefined,
        approvedRelayScope,
      )
      const userAuthority = admittedAction?.userAuthority
      const received = input.receivedInputId
        ? repo.receivedCollaborationInput(input.sessionId)
        : undefined
      const askOnly =
        received?.id === input.receivedInputId &&
        received &&
        storedReceivedMetadata(received.metadataJson).replyIntentBasis?.kind === 'ask_only'
      const batch = repo.freezeInputBatch({
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId,
        commentsRevision: session.commentsRevision,
        actor: input.agentId,
        ...(input.batchId ? { batchId: input.batchId } : {}),
        ...(!askOnly &&
        input.collaboration &&
        (input.collaboration.taskMessageId === input.clientMessageId ||
          input.collaboration.stage === 'reply' ||
          input.collaboration.stage === 'collaborate' ||
          (input.collaboration.stage === 'code_review' && Boolean(input.receivedInputId)))
          ? { taskId: input.collaboration.id }
          : {}),
        runId,
        messageId: userMessageId,
        ...(input.receivedInputId
          ? { pendingReceiptId: input.receivedInputId }
          : input.originSideChat
            ? { pendingReceiptId: input.clientMessageId }
            : {}),
        preserveDraftComments: !freezeDrafts,
        ...(input.userInformation ? { userInformation: input.userInformation } : {}),
      })
      repo.sealInputBatchSources(batch.id, runId)
      repo.freezeRunSources(runId, input.handoffSourceRefs ?? [], Boolean(input.collaboration))
      if (userAuthority?.purpose === 'write_continuation' && currentTask?.pendingWork) {
        const original = repo.unfinishedWriteSource(currentTask, currentTask.pendingWork.runId)
        const source = repo.quotedSource(input.sessionId, original.run.userMessageId)
        if (source.batchId !== original.auth.inputBatchRef?.id)
          throw new RunOperationConflictError(
            'The original write input Batch could not be inherited.',
          )
        // Controller Batches from older versions need not belong to the task input cursor.
        // Carry their exact existing read grant forward without changing those frozen facts.
        transaction
          .insert(conversationRunSourceRefs)
          .values({ runId, ...source })
          .onConflictDoNothing()
          .run()
        transaction.run(sql`INSERT OR IGNORE INTO conversation_run_source_refs(run_id,source_message_id,source_revision,batch_id,documents_json)
            SELECT ${runId},source_message_id,source_revision,batch_id,documents_json
            FROM conversation_run_source_refs WHERE run_id=${original.run.id}`)
      }
      if (authoritySources) repo.freezeRelayWorkflowSources(runId, authoritySources)
      const sourceManifestRef = undefined
      if (input.collaboration)
        repo.freezeCollaborationAuthorization(
          {
            ...input.collaboration,
            runId,
            ...(currentTask?.planRevision && input.collaboration.stage === 'implement'
              ? { planRevision: undefined }
              : {}),
          },
          runId,
          batch,
          sourceManifestRef,
          userAuthority,
          admittedAction?.relayWorkRef,
          currentTask,
        )
      if (admittedAction?.relayWorkRef && approvedRelayScope) {
        for (const source of approvedRelayScope.sources)
          if (!repo.sourceDocumentAuthorized(runId, source.document))
            throw new RunOperationConflictError(
              'The complete approved scheduling sources could not be granted to this turn.',
            )
      }
      if (userAuthority)
        appendAgentEvent(transaction, {
          sessionId: input.sessionId,
          runId,
          eventType: 'collaboration.action_admitted',
          payload: JSON.stringify(userAuthority),
          createdAt,
        })
      if (handoff) {
        const claimed = scheduling.claimHandoff(
          repo.database,
          handoff,
          input.preparedInput
            ? `input:route_${input.agentId}`
            : `workflow:${input.collaboration!.stage}`,
          { runId },
        )
        if (!claimed.created)
          throw new RunOperationConflictError('This handoff was already dispatched.')
      }
      if (input.preparedInput)
        appendAgentEvent(transaction, {
          sessionId: input.sessionId,
          runId,
          eventType: 'scheduling.input_dispatch_adopted',
          payload: JSON.stringify({
            handoffId: handoff!.id,
            batchId: input.preparedInput.batchId,
            evaluationId: adoptedInputSelection?.evaluationId ?? null,
            candidateId: adoptedInputSelection?.candidateId ?? null,
            recipient: input.agentId,
            ...(initialTaskRoles ? { stageRoles: initialTaskRoles } : {}),
          }),
          createdAt,
        })
      if (adoptedInputSelection)
        scheduling.recordGuidanceAdoptionActivity(repo.database, adoptedInputSelection.evaluationId)
      if (freezeDrafts && draftCount > 0)
        transaction
          .update(anchoredComments)
          .set({ sentWithMessageId: userMessageId, pendingReceiptId: null, updatedAt: createdAt })
          .where(draftsCondition)
          .run()
      if (input.receivedInputId) {
        transaction
          .update(collaborationInputs)
          .set({ state: 'materialized', materializedRunId: runId, queueState: 'delivered' })
          .where(eq(collaborationInputs.id, input.receivedInputId))
          .run()
        transaction
          .update(conversationBodyInputs)
          .set({ committedMessageId: userMessageId, pendingReceiptId: null })
          .where(
            and(
              eq(conversationBodyInputs.pendingReceiptId, input.receivedInputId),
              eq(
                conversationBodyInputs.id,
                transaction
                  .select({ inputId: collaborationInputs.inputId })
                  .from(collaborationInputs)
                  .where(eq(collaborationInputs.id, input.receivedInputId))
                  .get()!.inputId,
              ),
            ),
          )
          .run()
        transaction
          .update(conversationImageAssets)
          .set({ pendingReceiptId: null })
          .where(
            and(
              eq(conversationImageAssets.pendingReceiptId, input.receivedInputId),
              input.imageIds?.length ? inArray(conversationImageAssets.id, input.imageIds) : sql`0`,
            ),
          )
          .run()
      }
      if (input.sourceProposalId) {
        transaction
          .update(agentRuns)
          .set({
            peerProposalState: 'accepted',
            peerProposalAcceptedMessageId: userMessageId,
            updatedAt: createdAt,
          })
          .where(eq(agentRuns.peerProposalId, input.sourceProposalId))
          .run()
      }
      transaction
        .update(sessions)
        .set({
          status: 'discussing',
          commentsRevision:
            freezeDrafts && !input.originSideChat
              ? session.commentsRevision + 1
              : session.commentsRevision,
          ...(input.suggestedTitle
            ? { title: input.suggestedTitle, titleSource: 'local' as const }
            : {}),
          updatedAt: createdAt,
        })
        .where(eq(sessions.id, input.sessionId))
        .run()
      if (input.syncMainOperationId && effectiveOriginSideChat) {
        finalizeMainSyncBackReceipt(transaction, {
          operationId: input.syncMainOperationId,
          sideChatId: effectiveOriginSideChat.sideChatId,
          parentSessionId: input.sessionId,
          cutoffId: effectiveOriginSideChat.cutoffId,
          disposition: 'sent',
          mainMessageId: userMessageId,
          queuedOperationId: null,
        })
      }
      appendAgentEvent(transaction, {
        sessionId: input.sessionId,
        runId,
        eventType: 'user.message',
        payload: JSON.stringify({
          message:
            Buffer.byteLength(input.content) <= CONVERSATION_PATCH_TEXT_BYTES
              ? { id: userMessageId, content: input.content }
              : {
                  id: userMessageId,
                  source: {
                    version: 1,
                    messageId: userMessageId,
                    revision: 0,
                    sha256: createHash('sha256').update(input.content).digest('hex'),
                    bytes: Buffer.byteLength(input.content),
                  },
                },
          route,
          ...(images.length ? { images } : {}),
          sourceMessageId: input.sourceMessageId ?? null,
          sourceProposalId: input.sourceProposalId ?? null,
          comments: [],
          freezeDrafts,
          inputBatchRef: batch,
          ...(input.replyToDecision ? { replyToDecision: input.replyToDecision } : {}),
          ...(input.replaceTask ? { replaceTask: input.replaceTask } : {}),
        }),
        createdAt,
      })
      return freezeDrafts && !input.originSideChat
        ? session.commentsRevision + 1
        : session.commentsRevision
    },
  )

  const run = findRun(repo, runId)
  if (!run) throw new Error('Agent Run was not created.')
  const sourceRun = input.sourceProposalId
    ? repo.database
        .select(publicRunColumns)
        .from(agentRuns)
        .where(eq(agentRuns.peerProposalId, input.sourceProposalId))
        .get()
    : undefined
  const supersededRuns =
    supersededProposalRunIds.length > 0
      ? repo.database
          .select(publicRunColumns)
          .from(agentRuns)
          .where(inArray(agentRuns.id, supersededProposalRunIds))
          .all()
          .map((entry) => repo.toRun(entry))
      : []
  // The mounted footer of the replaced task re-reads its ended state from this related Run.
  const endedRun = replacedTaskRunId ? findRun(repo, replacedTaskRunId) : undefined
  const relatedRuns = [
    ...(endedRun ? [endedRun] : []),
    ...(sourceRun ? [repo.toRun(sourceRun)] : []),
    ...supersededRuns,
  ]
  return {
    run,
    patch: repo.createPatch(input.sessionId, {
      resync: { messages: false, drafts: !input.originSideChat, activityRunIds: [] },
      messages: [repo.messageChange(userMessageId, 'replace', input.content)],
      runs: [run, ...relatedRuns.slice(0, 3)],
      ...(relatedRuns.length > 3
        ? { resync: { messages: true, drafts: !input.originSideChat, activityRunIds: [] } }
        : {}),
      comments: {
        revision: committedCommentsRevision,
        upserts: [],
        removedIds: [],
        ...(freezeDrafts &&
        !input.originSideChat &&
        input.commentIds.length > 0 &&
        input.commentIds.length <= MAX_COMMENTS_PER_MESSAGE
          ? { sent: { messageId: userMessageId, commentIds: input.commentIds } }
          : {}),
      },
    }),
    created: true,
  }
}

export function beginRoutedContinuation(
  repo: ConversationRepositoryHost,
  input: BeginRoutedContinuationInput,
): BeginRunResult {
  const handoffSourceIds = JSON.stringify(input.handoffSourceRefs ?? [])
  if (Buffer.byteLength(handoffSourceIds, 'utf8') > HANDOFF_SOURCE_IDS_BYTES)
    throw new HandoffTooLargeError('The required Agent context is too large to save safely.')
  const runId = randomUUID()
  const createdAt = new Date().toISOString()
  repo.nativeMetadataTransaction(input.sessionId, (transaction) => {
    assertSessionAvailable(transaction, input.sessionId)
    const message = transaction
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.id, input.userMessageId),
          eq(conversationMessages.sessionId, input.sessionId),
          eq(conversationMessages.role, 'user'),
        ),
      )
      .get()
    const route = message ? toMessageRoute(message)?.route : undefined
    if (
      !message ||
      route?.type !== 'all' ||
      route.secondAgentId !== input.agentId ||
      message.routePendingAgentId !== input.agentId
    )
      throw new RunOperationConflictError('This routed request has no pending peer stage.')
    const activeRun = transaction
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, input.sessionId),
          inArray(agentRuns.status, [...activeRunStatuses]),
          ne(agentRuns.controlDisposition, 'abandoned'),
          isNull(agentRuns.forkSourceRunId),
        ),
      )
      .get()
    if (activeRun) throw new RunOperationConflictError('This Session already has an active Run.')
    const first = transaction
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.userMessageId, input.userMessageId),
          eq(agentRuns.agentId, route.firstAgentId),
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(sql`rowid`))
      .limit(1)
      .get()
    if (first?.status !== 'completed')
      throw new RunOperationConflictError('The Primary stage has not completed.')
    const priorSecond = transaction
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.userMessageId, input.userMessageId), eq(agentRuns.agentId, input.agentId)),
      )
      .limit(1)
      .get()
    if (priorSecond) throw new RunOperationConflictError('The peer stage already exists.')

    transaction
      .insert(agentRuns)
      .values({
        id: runId,
        sessionId: input.sessionId,
        userMessageId: input.userMessageId,
        agentId: input.agentId,
        status: 'starting',
        bindingGeneration:
          repo.nativeContext(input.sessionId, input.agentId)?.bindingGeneration ?? 1,
        nativeEffectsState: 'not_dispatched',
        attemptCount: 1,
        settingsRevision: input.settingsRevision,
        ...repo.runSettingsAt(input.sessionId, input.agentId, input.settingsRevision),
        model: input.model,
        effort: input.effort,
        handoffSourceIds,
        handoffMessageCount: input.handoffSourceRefs?.length ?? 0,
        createdAt,
        updatedAt: createdAt,
      })
      .run()
    repo.freezeRunSources(runId, input.handoffSourceRefs ?? [], false)
    const userSource = repo.quotedSource(input.sessionId, input.userMessageId)
    transaction
      .insert(conversationRunSourceRefs)
      .values({ runId, ...userSource })
      .onConflictDoNothing()
      .run()

    transaction
      .update(conversationMessages)
      .set({ routePendingAgentId: null, updatedAt: createdAt })
      .where(eq(conversationMessages.id, input.userMessageId))
      .run()
    transaction
      .update(sessions)
      .set({ status: 'discussing', updatedAt: createdAt })
      .where(eq(sessions.id, input.sessionId))
      .run()
    appendAgentEvent(transaction, {
      sessionId: input.sessionId,
      runId,
      eventType: 'routed.secondary_started',
      payload: JSON.stringify({ userMessageId: input.userMessageId, agentId: input.agentId }),
      createdAt,
    })
  })
  const run = findRun(repo, runId)
  if (!run) throw new Error('The routed peer Run was not created.')
  const message = repo.internalMessage(input.userMessageId, input.sessionId)
  if (!message) throw new Error('The routed User Message is unavailable.')
  return {
    run,
    patch: repo.createPatch(input.sessionId, {
      messages: [repo.messageChange(message.id, 'metadata')],
      runs: [run],
    }),
    created: true,
  }
}

export function pendingRoutedContinuations(
  repo: ConversationRepositoryHost,
  scope?: WorkspaceArchiveScope,
): Array<{
  sessionId: string
  userMessageId: string
  agentId: RuntimeAgentId
}> {
  const query = repo.database
    .select({
      sessionId: conversationMessages.sessionId,
      userMessageId: conversationMessages.id,
      agentId: conversationMessages.routePendingAgentId,
    })
    .from(conversationMessages)
    .innerJoin(sessions, eq(sessions.id, conversationMessages.sessionId))
    .where(
      and(
        isNotNull(conversationMessages.routePendingAgentId),
        ne(sessions.status, 'archived'),
        isNull(sessions.archivedAt),
        scope?.kind === 'session'
          ? or(eq(sessions.id, scope.sessionId), eq(sessions.parentSessionId, scope.sessionId))
          : scope?.kind === 'project'
            ? eq(sessions.projectId, scope.projectId)
            : undefined,
      ),
    )
    .orderBy(asc(conversationMessages.sessionId), asc(conversationMessages.sequence))
  return (scope ? query.limit(6).all() : query.all()).flatMap((row) =>
    row.agentId
      ? [{ sessionId: row.sessionId, userMessageId: row.userMessageId, agentId: row.agentId }]
      : [],
  )
}

export function hasPendingRoutedContinuation(
  repo: ConversationRepositoryHost,
  sessionId: string,
): boolean {
  return Boolean(
    repo.database
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.sessionId, sessionId),
          isNotNull(conversationMessages.routePendingAgentId),
        ),
      )
      .limit(1)
      .get(),
  )
}

export function cancelPendingRoutedContinuation(
  repo: ConversationRepositoryHost,
  sessionId: string,
  reason = 'user_cancelled',
): ConversationPatch {
  const id = repo.database.transaction(() => retirePendingRoute(repo, sessionId, reason))
  return repo.createPatch(sessionId, { messages: id ? [repo.messageChange(id, 'metadata')] : [] })
}

/** Called inside the fact transaction: recovery must never leave queued User input behind. */
export function retirePendingRoute(
  repo: ConversationRepositoryHost,
  sessionId: string,
  reason: string,
): string | undefined {
  const pending = repo.database
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.sessionId, sessionId),
        isNotNull(conversationMessages.routePendingAgentId),
      ),
    )
    .orderBy(desc(conversationMessages.sequence))
    .limit(1)
    .get()
  if (!pending) return undefined
  const now = new Date().toISOString()
  const transaction = repo.database

  transaction
    .update(conversationMessages)
    .set({ routePendingAgentId: null, updatedAt: now })
    .where(eq(conversationMessages.id, pending.id))
    .run()
  appendAgentEvent(transaction, {
    sessionId,
    runId: `route:${pending.id}`,
    eventType: 'routed.secondary_cancelled',
    payload: JSON.stringify({ userMessageId: pending.id, reason }),
    createdAt: now,
  })
  transaction
    .update(sessions)
    .set({ status: 'paused', updatedAt: now })
    .where(eq(sessions.id, sessionId))
    .run()
  return pending.id
}

export function failPendingRoutedContinuation(
  repo: ConversationRepositoryHost,
  sessionId: string,
  userMessageId: string,
  agentId: RuntimeAgentId,
  message: string,
): ConversationPatch {
  const pending = repo.database
    .select({ agentId: conversationMessages.routePendingAgentId })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.id, userMessageId),
        eq(conversationMessages.sessionId, sessionId),
      ),
    )
    .get()
  if (pending?.agentId !== agentId) return repo.createPatch(sessionId)
  const now = new Date().toISOString()
  const systemMessageId = randomUUID()
  repo.database.transaction((transaction) => {
    const messageSequence = allocateSessionMessageSequence(transaction, sessionId)

    transaction
      .update(conversationMessages)
      .set({ routePendingAgentId: null, updatedAt: now })
      .where(eq(conversationMessages.id, userMessageId))
      .run()
    transaction
      .insert(conversationMessages)
      .values({
        id: systemMessageId,
        sessionId,
        role: 'system',
        content: message,
        state: 'complete',
        sequence: messageSequence,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    appendAgentEvent(transaction, {
      sessionId,
      runId: `route:${userMessageId}`,
      eventType: 'routed.secondary_failed',
      payload: JSON.stringify({ userMessageId, agentId, message }),
      createdAt: now,
    })
    transaction
      .update(sessions)
      .set({ status: 'paused', updatedAt: now })
      .where(eq(sessions.id, sessionId))
      .run()
  })
  return repo.createPatch(sessionId, {
    messages: [
      repo.messageChange(userMessageId, 'metadata'),
      repo.messageChange(systemMessageId, 'replace', message),
    ],
  })
}

export function dismissPeerProposal(
  repo: ConversationRepositoryHost,
  sessionId: string,
  proposalId: string,
): ConversationPatch {
  const run = repo.database
    .select({ id: agentRuns.id, state: agentRuns.peerProposalState })
    .from(agentRuns)
    .where(and(eq(agentRuns.sessionId, sessionId), eq(agentRuns.peerProposalId, proposalId)))
    .get()
  if (!run || run.state !== 'pending')
    throw new RunOperationConflictError('This peer request is no longer available.')
  repo.database
    .update(agentRuns)
    .set({ peerProposalState: 'dismissed', updatedAt: new Date().toISOString() })
    .where(eq(agentRuns.id, run.id))
    .run()
  const updated = findRun(repo, run.id)
  if (!updated) throw new Error('The peer request Run is unavailable.')
  return repo.createPatch(sessionId, { runs: [updated] })
}

export function peerProposal(
  repo: ConversationRepositoryHost,
  sessionId: string,
  proposalId: string,
): { run: AgentRun; sourceMessageId: string } | undefined {
  const row = repo.database
    .select({ run: publicRunColumns, sourceMessageId: conversationMessages.id })
    .from(agentRuns)
    .innerJoin(
      conversationMessages,
      and(
        eq(conversationMessages.runId, agentRuns.id),
        eq(conversationMessages.role, 'assistant'),
        eq(conversationMessages.isVisible, true),
      ),
    )
    .where(
      and(
        eq(agentRuns.sessionId, sessionId),
        eq(agentRuns.peerProposalId, proposalId),
        eq(agentRuns.status, 'completed'),
        ne(agentRuns.controlDisposition, 'abandoned'),
        isNull(agentRuns.forkSourceRunId),
        sql`NOT EXISTS (SELECT 1 FROM native_agent_contexts n WHERE n.session_id=${agentRuns.sessionId} AND n.agent_id=${agentRuns.agentId} AND n.binding_generation<>${agentRuns.bindingGeneration})`,
        eq(conversationMessages.state, 'complete'),
        eq(conversationMessages.agentId, agentRuns.agentId),
        sql`length(trim(${conversationMessages.content}, char(9) || char(10) || char(13) || ' ')) > 0`,
      ),
    )
    .orderBy(desc(conversationMessages.sequence))
    .limit(1)
    .get()
  return row ? { run: repo.toRun(row.run), sourceMessageId: row.sourceMessageId } : undefined
}

export function findRun(repo: ConversationRepositoryHost, runId: string): AgentRun | undefined {
  const run = repo.sourceQueries.run().get({ runId })
  return run ? repo.toRun(run) : undefined
}

export function recordWorkspaceChanges(
  repo: ConversationRepositoryHost,
  summary: WorkspaceChangeSet,
): ConversationPatch {
  const parsed = workspaceChangeSetSchema.parse(summary)
  const run = findRun(repo, parsed.runId)
  if (
    !run ||
    run.id !== parsed.id ||
    run.sessionId !== parsed.sessionId ||
    run.agentId !== parsed.agentId
  )
    throw new Error('Workspace changes do not belong to this Agent Run.')
  const payload = JSON.stringify(parsed)
  repo.database.transaction((transaction) => {
    const stored = transaction
      .select()
      .from(workspaceChangeSets)
      .where(eq(workspaceChangeSets.id, parsed.id))
      .get()
    if (!stored) throw new Error('Workspace changes do not exist.')
    const authoritative = buildWorkspaceChangeSetSummary(transaction, stored)
    const expected: Record<string, unknown> = { ...authoritative }
    if (parsed.countsAvailable === undefined) delete expected['countsAvailable']
    if (parsed.undoableFileCount === undefined) delete expected['undoableFileCount']
    if (JSON.stringify(workspaceChangeSetSchema.parse(expected)) !== payload)
      throw new Error('Workspace changes changed before publication.')
    const previous = transaction
      .select({ summary: agentRuns.workspaceChangesJson })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id))
      .get()
    transaction
      .update(workspaceChangeSets)
      .set({ projectionPending: false })
      .where(eq(workspaceChangeSets.id, parsed.id))
      .run()
    const taskId = run.collaboration?.taskId
    let collaborationChanged = false
    if (taskId) {
      const task = repo.collaboration(run.sessionId)
      if (task && task.id === taskId) {
        const turns = transaction
          .select({
            runId: workflowTurns.runId,
            stage: workflowTurns.stage,
            actor: workflowTurns.actor,
            verdict: workflowTurns.verdict,
            verdictConflict: workflowTurns.verdictConflict,
            reportBodyId: workflowTurns.reportBodyId,
            runStatus: agentRuns.status,
            taskRevision: workflowTurns.taskRevision,
            changeState: workspaceChangeSets.state,
            fileCount: workspaceChangeSets.fileCount,
          })
          .from(workflowTurns)
          .innerJoin(agentRuns, eq(agentRuns.id, workflowTurns.runId))
          .leftJoin(workspaceChangeSets, eq(workspaceChangeSets.runId, workflowTurns.runId))
          .where(and(eq(workflowTurns.taskId, taskId), eq(workflowTurns.applied, true)))
          .orderBy(
            desc(workflowTurns.taskRevision),
            desc(workflowTurns.createdAt),
            desc(workflowTurns.runId),
          )
          .limit(256)
          .all()
          .toReversed()
        const latestSettledCodeReviewIndex = turns.findLastIndex(
          (entry) =>
            entry.stage === 'code_review' &&
            entry.runStatus === 'completed' &&
            !entry.verdictConflict &&
            entry.reportBodyId !== null &&
            (entry.verdict === 'accepted' || entry.verdict === 'changes_requested'),
        )
        let latestActiveCodeTurn: (typeof turns)[number] | undefined
        let latestActiveCodeTurnIndex = -1
        for (let index = turns.length - 1; index >= 0; index -= 1) {
          const entry = turns[index]!
          if (
            ['collaborate', 'implement', 'repair'].includes(entry.stage) &&
            entry.changeState &&
            entry.changeState !== 'undone' &&
            ((entry.fileCount ?? 0) > 0 ||
              repo.runHasRecordedCodeChanges(run.sessionId, entry.runId))
          ) {
            latestActiveCodeTurn = entry
            latestActiveCodeTurnIndex = index
            break
          }
        }
        const nextCodeRunId = latestActiveCodeTurn?.runId
        const nextLastCodeActor = latestActiveCodeTurn?.actor ?? task.lastCodeActor
        const nextUnreviewedCodeActor =
          latestActiveCodeTurn && latestActiveCodeTurnIndex > latestSettledCodeReviewIndex
            ? latestActiveCodeTurn.actor
            : undefined
        const nextOpenMode = isCollaborationOpenMode(task) || Boolean(nextCodeRunId)
        if (
          task.codeRunId !== nextCodeRunId ||
          task.lastCodeActor !== nextLastCodeActor ||
          task.unreviewedCodeActor !== nextUnreviewedCodeActor ||
          (nextOpenMode && !task.openMode)
        ) {
          if (nextOpenMode) task.openMode = true
          task.codeRunId = nextCodeRunId
          task.lastCodeActor = nextLastCodeActor
          task.unreviewedCodeActor = nextUnreviewedCodeActor
          task.revision++
          repo.saveCollaboration(task)
          collaborationChanged = true
          if (task.runId === run.id && task.status !== 'running') {
            transaction
              .update(workflowTurns)
              .set({ stateJson: JSON.stringify(repo.storedCollaboration(task)) })
              .where(eq(workflowTurns.runId, run.id))
              .run()
          }
        }
      }
    }
    const shouldRetractOrOmit = parsed.fileCount === 0 && parsed.state !== 'recovery_required'
    const rawNow = new Date().toISOString()
    const now = rawNow === run.updatedAt ? new Date(Date.parse(rawNow) + 1).toISOString() : rawNow
    if (shouldRetractOrOmit) {
      if (previous?.summary == null) {
        if (collaborationChanged) {
          transaction
            .update(agentRuns)
            .set({ updatedAt: now })
            .where(eq(agentRuns.id, run.id))
            .run()
        }
        return
      }
      appendAgentEvent(transaction, {
        sessionId: run.sessionId,
        runId: run.id,
        eventType: 'workspace.changes_updated',
        payload,
        createdAt: now,
      })
      transaction
        .update(agentRuns)
        .set({ workspaceChangesJson: null, updatedAt: now })
        .where(eq(agentRuns.id, run.id))
        .run()
      return
    }
    if (previous?.summary === payload && !collaborationChanged) return
    if (previous?.summary === payload) {
      transaction.update(agentRuns).set({ updatedAt: now }).where(eq(agentRuns.id, run.id)).run()
      return
    }

    appendAgentEvent(transaction, {
      sessionId: run.sessionId,
      runId: run.id,
      eventType: 'workspace.changes_updated',
      payload,
      createdAt: now,
    })
    transaction
      .update(agentRuns)
      .set({ workspaceChangesJson: payload, updatedAt: now })
      .where(eq(agentRuns.id, run.id))
      .run()
  })
  const updated = findRun(repo, run.id)
  if (!updated) throw new Error('Agent Run does not exist.')
  return repo.createPatch(run.sessionId, { runs: [updated] })
}

export function recordWorkspaceRecordingUnavailable(
  repo: ConversationRepositoryHost,
  runId: string,
  reason: string,
): ConversationPatch {
  const run = findRun(repo, runId)
  if (!run) throw new RunOperationConflictError('The file recording owner is unavailable.')
  const message = reason.slice(0, 240)
  repo.database.transaction(() => {
    repo.database
      .update(agentRuns)
      .set({ workspaceRecordingUnavailableReason: message })
      .where(eq(agentRuns.id, runId))
      .run()
    repo.nativeFact(runId, 'workspace.recording_unavailable', { reason: message })
  })
  return repo.runPatch(runId)
}

export function updateAttempt(
  repo: ConversationRepositoryHost,
  runId: string,
  attemptCount: number,
  recovering: boolean,
): ConversationPatch {
  const updatedAt = new Date().toISOString()
  const run = findRun(repo, runId)
  if (!run) throw new Error('Agent Run does not exist.')
  repo.nativeMetadataTransaction(run.sessionId, (transaction) => {
    appendAgentEvent(transaction, {
      sessionId: run.sessionId,
      runId,
      eventType: 'run.attempt_started',
      payload: JSON.stringify({ attemptCount, recovering }),
      createdAt: updatedAt,
    })
    transaction
      .update(agentRuns)
      .set({
        attemptCount,
        status: recovering ? 'recovering' : 'running',
        ...(recovering ? { nativeTurnId: null } : {}),
        failureKind: null,
        failureMessage: null,
        updatedAt,
      })
      .where(eq(agentRuns.id, runId))
      .run()
    transaction
      .update(agentRuns)
      .set({ peerProposalState: 'superseded', updatedAt })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.peerProposalState, 'pending')))
      .run()
    transaction.update(sessions).set({ updatedAt }).where(eq(sessions.id, run.sessionId)).run()
  })
  const updated = findRun(repo, runId)
  if (!updated) throw new Error('Agent Run does not exist.')
  return repo.createPatch(run.sessionId, { runs: [updated] })
}
