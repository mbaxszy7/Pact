import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  DECISION_HTTP_OWNER_BYTES,
  decisionHttpOwnerSchema,
  decisionRemoteOutcomeSchema,
  relayCredentialReceiptSchema,
  relayCredentialWriteSchema,
  schedulingHandoffSchema,
  type ConversationPatch,
  type SchedulingHandoff,
} from '@pact/contracts'

import type { ConversationRepositoryHost } from './context.js'

import * as scheduling from '../conversation-scheduling.js'
import {
  agentEventJournal,
  agentRuns,
  relayCredentialReceipts,
  relayCredentials,
  runReexecutionOperations,
  schedulingBudgetCounters,
  schedulingEvaluations,
  schedulingHandoffs,
  schedulingRecoveryAttempts,
  schedulingRecoveryFaults,
  schedulingRuntimeOwners,
  schedulingSettings as schedulingSettingsTable,
} from '../schema/index.js'
import { canonicalCiphertext } from './helpers.js'
import { activeRunStatuses, RunOperationConflictError } from './types.js'

export function beginSchedulingRecoveryEpoch(
  repo: ConversationRepositoryHost,
  epoch: string,
): void {
  if (!/^[a-f0-9-]{36}$/u.test(epoch))
    throw new RunOperationConflictError('The recovery epoch is invalid.')
  repo.schedulingRecoveryEpoch = epoch
}

export function recordSchedulingRecoveryOrigin(
  repo: ConversationRepositoryHost,
  fault: NonNullable<SchedulingHandoff['fault']>,
): void {
  if (!repo.schedulingRecoveryEpoch) return
  const settings = repo.schedulingSettings()
  if (!settings.enabled) return
  if (fault.kind === 'run') {
    const replacement = repo.database
      .select({ faultId: runReexecutionOperations.faultId })
      .from(runReexecutionOperations)
      .where(eq(runReexecutionOperations.replacementRunId, fault.id))
      .get()
    const original =
      replacement &&
      repo.database
        .select()
        .from(schedulingRecoveryFaults)
        .where(eq(schedulingRecoveryFaults.id, replacement.faultId))
        .get()
    if (original) {
      refreshSchedulingRecoveryFacts(repo, original.sessionId)
      return
    }
  }
  let node: SchedulingHandoff
  try {
    node = repo.recoveryHandoff(fault)
  } catch (error) {
    if (error instanceof RunOperationConflictError) return
    throw error
  }
  const run = repo.findRun(node.freshnessGuard.runId!)
  if (
    !run ||
    run.forkSourceRunId ||
    run.controlDisposition === 'abandoned' ||
    run.failureKind === 'user_stopped'
  )
    return
  const sequence = repo.database
    .select({ sequence: agentEventJournal.sequence })
    .from(agentEventJournal)
    .where(eq(agentEventJournal.sessionId, node.sessionId))
    .orderBy(desc(agentEventJournal.sequence))
    .limit(1)
    .get()?.sequence
  if (sequence === undefined) return
  scheduling.recordRecoveryFault(repo.database, {
    epoch: repo.schedulingRecoveryEpoch,
    node,
    originSequence: sequence,
  })
}

export function refreshSchedulingRecoveryFacts(
  repo: ConversationRepositoryHost,
  sessionId: string,
): void {
  if (!repo.schedulingRecoveryEpoch) return
  const rows = repo.database
    .select()
    .from(schedulingRecoveryFaults)
    .where(
      and(
        eq(schedulingRecoveryFaults.sessionId, sessionId),
        eq(schedulingRecoveryFaults.utilityEpoch, repo.schedulingRecoveryEpoch),
        eq(
          schedulingRecoveryFaults.configurationGeneration,
          schedulingConfigurationGeneration(repo),
        ),
        eq(schedulingRecoveryFaults.active, true),
      ),
    )
    .limit(25)
    .all()
  for (const row of rows) {
    try {
      const node = repo.recoveryHandoff({ kind: row.faultKind, id: row.faultId })
      if (node.factFingerprint !== row.observedFingerprint)
        repo.database
          .update(schedulingRecoveryFaults)
          .set({ observedFingerprint: node.factFingerprint, pending: row.armed })
          .where(eq(schedulingRecoveryFaults.id, row.id))
          .run()
    } catch {
      repo.database
        .update(schedulingRecoveryFaults)
        .set({ active: false, pending: false })
        .where(eq(schedulingRecoveryFaults.id, row.id))
        .run()
    }
  }
}

export function takeSchedulingRecoveryFaults(repo: ConversationRepositoryHost) {
  if (!repo.schedulingRecoveryEpoch) return []
  return repo.database.transaction(() => {
    const rows = repo.database
      .select()
      .from(schedulingRecoveryFaults)
      .where(
        and(
          eq(schedulingRecoveryFaults.utilityEpoch, repo.schedulingRecoveryEpoch!),
          eq(
            schedulingRecoveryFaults.configurationGeneration,
            schedulingConfigurationGeneration(repo),
          ),
          eq(schedulingRecoveryFaults.active, true),
          eq(schedulingRecoveryFaults.pending, true),
        ),
      )
      .orderBy(asc(schedulingRecoveryFaults.id))
      .limit(25)
      .all()
    return rows.flatMap((row) => {
      repo.database
        .update(schedulingRecoveryFaults)
        .set({ pending: false, consideredFingerprint: row.observedFingerprint })
        .where(eq(schedulingRecoveryFaults.id, row.id))
        .run()
      try {
        return [
          { fault: row, node: repo.recoveryHandoff({ kind: row.faultKind, id: row.faultId }) },
        ]
      } catch {
        return []
      }
    })
  })
}

export function armSchedulingRecoveryFaults(
  repo: ConversationRepositoryHost,
  sessionId: string,
): void {
  if (!repo.schedulingRecoveryEpoch) return
  repo.database
    .update(schedulingRecoveryFaults)
    .set({ armed: true, pending: true })
    .where(
      and(
        eq(schedulingRecoveryFaults.sessionId, sessionId),
        eq(schedulingRecoveryFaults.utilityEpoch, repo.schedulingRecoveryEpoch),
        eq(
          schedulingRecoveryFaults.configurationGeneration,
          schedulingConfigurationGeneration(repo),
        ),
        eq(schedulingRecoveryFaults.active, true),
        eq(schedulingRecoveryFaults.armed, false),
      ),
    )
    .run()
}

export function cancelSchedulingRecoveryFaults(
  repo: ConversationRepositoryHost,
  sessionId: string,
): void {
  repo.discardUnansweredRelaySchedulingDecision(sessionId)
  repo.database
    .update(agentRuns)
    .set({ automaticRecoveryRevoked: true })
    .where(
      and(eq(agentRuns.sessionId, sessionId), inArray(agentRuns.status, [...activeRunStatuses])),
    )
    .run()
  repo.database
    .update(schedulingRecoveryFaults)
    .set({ active: false, pending: false })
    .where(
      and(
        eq(schedulingRecoveryFaults.sessionId, sessionId),
        eq(schedulingRecoveryFaults.active, true),
      ),
    )
    .run()
}

export function reserveSchedulingRecoveryCheck(
  repo: ConversationRepositoryHost,
  faultId: string,
  node: SchedulingHandoff,
  utilityPid: number,
) {
  if (!repo.schedulingRecoveryEpoch) return undefined
  const result = repo.database.transaction(() => {
    assertSchedulingFreshness(repo, node)
    return scheduling.reserveRecoveryCheck(repo.database, {
      faultId,
      epoch: repo.schedulingRecoveryEpoch!,
      handoff: node,
      utilityPid,
    })
  })
  if (result) schedulingChanged(repo)
  return result
}

export function startSchedulingRecoveryCheck(repo: ConversationRepositoryHost, id: string): void {
  repo.database.transaction(() => scheduling.startRecoveryCheck(repo.database, id))
  schedulingChanged(repo)
}

export function recordSchedulingCheckPhysicalOwner(
  repo: ConversationRepositoryHost,
  id: string,
  owner: unknown,
): void {
  repo.database.transaction(() =>
    scheduling.recordRecoveryCheckPhysicalOwner(repo.database, id, owner),
  )
}

export function settleSchedulingRecoveryCheck(
  repo: ConversationRepositoryHost,
  id: string,
  input: Parameters<typeof scheduling.settleRecoveryCheck>[2],
): void {
  repo.database.transaction(() => scheduling.settleRecoveryCheck(repo.database, id, input))
  schedulingChanged(repo)
}

export function schedulingRecoveryAttempt(repo: ConversationRepositoryHost, id: string) {
  return repo.database
    .select()
    .from(schedulingRecoveryAttempts)
    .where(eq(schedulingRecoveryAttempts.id, id))
    .get()
}

export function subscribeSchedulingChanges(
  repo: ConversationRepositoryHost,
  listener: () => void,
): () => void {
  if (repo.schedulingListeners.size >= 1)
    throw new Error('Scheduling already has its Utility subscriber.')
  repo.schedulingListeners.add(listener)
  return () => {
    repo.schedulingListeners.delete(listener)
  }
}

export function schedulingChanged(repo: ConversationRepositoryHost): void {
  for (const listener of repo.schedulingListeners) {
    try {
      listener()
    } catch {
      // A disposable projection notification cannot change a committed scheduling receipt.
    }
  }
}

export function recordSchedulingBusinessActivity(
  repo: ConversationRepositoryHost,
  runId: string,
  completeResponse: boolean,
): void {
  const operation = repo.database
    .select()
    .from(runReexecutionOperations)
    .where(eq(runReexecutionOperations.replacementRunId, runId))
    .get()
  const run = operation && repo.findRun(runId)
  if (operation && run) {
    const physicalUnconfirmed =
      run.nativeEffectsState === 'pending' || run.nativeEffectsState === 'unknown'
    const unsent = Boolean(
      repo.executionInput(runId)?.proof &&
      !run.nativeTurnId &&
      !run.nativeOutcome &&
      !['accepted', 'ended'].includes(run.dispatchPhase ?? '') &&
      !physicalUnconfirmed,
    )
    const result = unsent
      ? 'not_sent'
      : run.dispatchPhase === 'ended' &&
          !physicalUnconfirmed &&
          (run.nativeOutcome !== 'completed' || completeResponse)
        ? run.nativeOutcome === 'completed'
          ? 'completed'
          : 'failed'
        : ['possibly_sent', 'accepted', 'ended'].includes(run.dispatchPhase ?? '')
          ? 'possibly_sent'
          : operation.result
    if (result === 'possibly_sent')
      scheduling.settleBudget(repo.database, operation.budgetReservationId, 'possibly_sent')
    if (result === 'completed' || result === 'failed' || result === 'not_sent')
      scheduling.settleBudget(
        repo.database,
        operation.budgetReservationId,
        result === 'not_sent' ? 'not_sent' : 'settled',
      )
    const now = new Date().toISOString()
    repo.database
      .update(runReexecutionOperations)
      .set({ result, updatedAt: now })
      .where(eq(runReexecutionOperations.id, operation.id))
      .run()
    repo.database
      .update(schedulingRecoveryFaults)
      .set({
        latestAction: 'resend',
        result,
        physicalUnconfirmed,
        activityAt: now,
        ...(['completed', 'not_sent'].includes(result) ? { active: false, pending: false } : {}),
      })
      .where(eq(schedulingRecoveryFaults.id, operation.faultId))
      .run()
    scheduling.syncRecoveryActivity(repo.database, operation.faultId)
  }
  scheduling.recordBusinessActivity(repo.database, runId, completeResponse)
}

export function schedulingSettings(repo: ConversationRepositoryHost) {
  return scheduling.readSettings(repo.database)
}

export function schedulingConfigurationFingerprint(repo: ConversationRepositoryHost): string {
  return scheduling.decisionConfigurationFingerprint(repo.database)
}

export function schedulingConfigurationGeneration(repo: ConversationRepositoryHost): number {
  return scheduling.configurationGeneration(repo.database)
}

export function saveSchedulingSettings(
  repo: ConversationRepositoryHost,
  input: Parameters<typeof scheduling.saveSettings>[1],
  publishInvalidated?: (patch: ConversationPatch) => void,
) {
  const generation = schedulingConfigurationGeneration(repo)
  const result = repo.database.transaction(() => scheduling.saveSettings(repo.database, input))
  if (schedulingConfigurationGeneration(repo) !== generation)
    repo.retireRelayDecisionGates(publishInvalidated)
  schedulingChanged(repo)
  return result
}

export function readSchedulingActivity(
  repo: ConversationRepositoryHost,
  input: Parameters<typeof scheduling.readActivity>[1],
) {
  return scheduling.readActivity(repo.database, input)
}

/** Internal Utility read: the ciphertext leaves storage only for Main-side decryption. */
export function readRelayCredential(repo: ConversationRepositoryHost): {
  ciphertext: string | null
  revision: number
} {
  const row = repo.database
    .select({ ciphertext: relayCredentials.ciphertext, revision: relayCredentials.revision })
    .from(relayCredentials)
    .where(eq(relayCredentials.id, 1))
    .get()
  return { ciphertext: row?.ciphertext ?? null, revision: row?.revision ?? 0 }
}

export function writeRelayCredential(
  repo: ConversationRepositoryHost,
  input: import('@pact/contracts').RelayCredentialWrite,
  publishInvalidated?: (patch: ConversationPatch) => void,
): import('@pact/contracts').RelayCredentialReceipt {
  const parsed = relayCredentialWriteSchema.safeParse(input)
  if (!parsed.success || Date.now() >= parsed.data.deadlineAt)
    throw new RunOperationConflictError('The credential request is no longer current.')
  const request = parsed.data
  const ciphertext = request.operation === 'save' ? request.ciphertext : null
  if (ciphertext !== null) canonicalCiphertext(ciphertext)
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        request.operation,
        request.expectedRevision,
        ciphertext ?? '',
        request.nonce,
      ]),
    )
    .digest('hex')
  let configurationChanged = false
  const receipt = repo.database.transaction(() => {
    const generation = schedulingConfigurationGeneration(repo)
    if (!Number.isSafeInteger(generation + 1) || Date.now() >= request.deadlineAt)
      throw new RunOperationConflictError('The credential request is no longer current.')
    const prior = repo.database
      .select()
      .from(relayCredentialReceipts)
      .where(eq(relayCredentialReceipts.nonce, request.nonce))
      .get()
    if (prior) {
      if (prior.requestFingerprint !== fingerprint)
        throw new RunOperationConflictError('The credential request is no longer current.')
      return {
        nonce: prior.nonce,
        operation: prior.operation,
        revision: prior.revision,
        configured: prior.configured,
      } as const
    }
    const stored = readRelayCredential(repo)
    if (request.expectedRevision !== stored.revision || !Number.isSafeInteger(stored.revision + 1))
      throw new RunOperationConflictError(
        'Scheduling settings changed. Refresh before saving again.',
      )
    const revision = stored.revision + 1,
      now = new Date().toISOString()
    if (Date.now() >= request.deadlineAt)
      throw new RunOperationConflictError('The credential request is no longer current.')
    const credentialChange = repo.database
      .insert(relayCredentials)
      .values({ id: 1, ciphertext, revision, updatedAt: now })
      .onConflictDoUpdate({
        target: relayCredentials.id,
        set: { ciphertext, revision, updatedAt: now },
        setWhere: eq(relayCredentials.revision, request.expectedRevision),
      })
      .run()
    if (credentialChange.changes !== 1)
      throw new RunOperationConflictError(
        'Scheduling settings changed. Refresh before saving again.',
      )
    const settings = repo.database
      .select()
      .from(schedulingSettingsTable)
      .where(eq(schedulingSettingsTable.id, 1))
      .get()
    if (settings && !Number.isSafeInteger(settings.revision + 1))
      throw new RunOperationConflictError(
        'Scheduling settings changed. Refresh before saving again.',
      )
    const settingsChange = repo.database
      .insert(schedulingSettingsTable)
      .values({
        id: 1,
        enabled: settings?.enabled ?? false,
        showIndicator: settings?.showIndicator ?? true,
        revision: (settings?.revision ?? 0) + 1,
        configurationGeneration: generation + 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schedulingSettingsTable.id,
        set: {
          revision: (settings?.revision ?? 0) + 1,
          configurationGeneration: generation + 1,
          updatedAt: now,
        },
        setWhere: eq(schedulingSettingsTable.revision, settings?.revision ?? 0),
      })
      .run()
    if (settingsChange.changes !== 1)
      throw new RunOperationConflictError(
        'Scheduling settings changed. Refresh before saving again.',
      )
    const receiptRow = {
      nonce: request.nonce,
      operation: request.operation,
      expectedRevision: request.expectedRevision,
      revision,
      configured: ciphertext !== null,
      requestFingerprint: fingerprint,
      createdAt: now,
    }
    repo.database.insert(relayCredentialReceipts).values(receiptRow).run()
    configurationChanged = true
    return {
      nonce: request.nonce,
      operation: request.operation,
      revision,
      configured: ciphertext !== null,
    } as const
  })
  if (configurationChanged) repo.retireRelayDecisionGates(publishInvalidated)
  schedulingChanged(repo)
  return receipt
}

export function readRelayCredentialReceipt(
  repo: ConversationRepositoryHost,
  nonce: string,
): import('@pact/contracts').RelayCredentialReceipt | undefined {
  const row = repo.database
    .select()
    .from(relayCredentialReceipts)
    .where(eq(relayCredentialReceipts.nonce, nonce))
    .get()
  if (!row) return undefined
  return relayCredentialReceiptSchema.parse({
    nonce: row.nonce,
    operation: row.operation,
    revision: row.revision,
    configured: row.configured,
  })
}

/** Exact CAS rotation after OS re-encryption; never an authority or generation change. */
export function rotateRelayCredentialCiphertext(
  repo: ConversationRepositoryHost,
  revision: number,
  expectedCiphertext: string,
  ciphertext: string,
): boolean {
  if (!Number.isSafeInteger(revision)) return false
  try {
    canonicalCiphertext(expectedCiphertext)
    canonicalCiphertext(ciphertext)
  } catch {
    return false
  }
  const changed = repo.database.transaction(() => {
    const stored = repo.database
      .select({ ciphertext: relayCredentials.ciphertext, revision: relayCredentials.revision })
      .from(relayCredentials)
      .where(eq(relayCredentials.id, 1))
      .get()
    if (
      !stored?.ciphertext ||
      stored.revision !== revision ||
      stored.ciphertext !== expectedCiphertext
    )
      return false
    const rotated = repo.database
      .update(relayCredentials)
      .set({ ciphertext, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(relayCredentials.id, 1),
          eq(relayCredentials.revision, revision),
          eq(relayCredentials.ciphertext, expectedCiphertext),
        ),
      )
      .run()
    return rotated.changes === 1
  })
  if (changed) schedulingChanged(repo)
  return changed
}

export function assertSchedulingFreshness(
  repo: ConversationRepositoryHost,
  node: SchedulingHandoff,
): void {
  const task = node.budgetRoot.kind === 'task' ? repo.collaboration(node.sessionId) : undefined
  const current =
    'kind' in node.freshnessGuard && node.freshnessGuard.kind === 'prepared_input'
      ? repo.preparedInputHandoff(node.freshnessGuard.batchId)
      : node.freshnessGuard.agentId &&
          (node.slot === 'workflow_next' || node.slot === 'input_dispatch') &&
          task?.id === node.budgetRoot.id
        ? repo.workflowHandoff(
            task,
            node.freshnessGuard.agentId,
            node.slot === 'input_dispatch' &&
              repo.receivedCollaborationInput(node.sessionId)?.id === node.eventId
              ? node.eventId
              : undefined,
          )
        : node.fault
          ? repo.recoveryHandoff(node.fault)
          : undefined
  if (
    !current ||
    current.id !== node.id ||
    current.factFingerprint !== node.factFingerprint ||
    !isDeepStrictEqual(current.freshnessGuard, node.freshnessGuard)
  )
    throw new RunOperationConflictError('The handoff facts changed before admission.')
}

export function evaluationIsCurrent(
  repo: ConversationRepositoryHost,
  node: SchedulingHandoff,
): boolean {
  try {
    assertSchedulingFreshness(repo, node)
    return true
  } catch {
    return false
  }
}

export function decisionEvaluationReceipt(
  repo: ConversationRepositoryHost,
  handoff: SchedulingHandoff,
): { id: string } | undefined {
  return scheduling.readEvaluationReceipt(repo.database, handoff)
}

export function activeEvaluation(repo: ConversationRepositoryHost) {
  return repo.database
    .select({
      id: schedulingEvaluations.id,
      sessionId: schedulingEvaluations.sessionId,
      called: schedulingEvaluations.called,
      outcome: schedulingEvaluations.outcome,
      physicalWitnessJson: schedulingRuntimeOwners.physicalWitnessJson,
    })
    .from(schedulingEvaluations)
    .innerJoin(
      schedulingRuntimeOwners,
      eq(schedulingRuntimeOwners.evaluationId, schedulingEvaluations.id),
    )
    .where(eq(schedulingRuntimeOwners.active, true))
    .limit(1)
    .get()
}

export function activeSchedulingRuntimeOwner(repo: ConversationRepositoryHost) {
  return scheduling.activeRuntimeOwner(repo.database)
}

export function schedulingPhysicalReceiptCapacityAvailable(
  repo: ConversationRepositoryHost,
): boolean {
  return scheduling.physicalReceiptCapacityAvailable(repo.database)
}

export function hasSchedulingPhysicalReceipts(repo: ConversationRepositoryHost): boolean {
  return scheduling.hasPhysicalReceipts(repo.database)
}

export function claimSchedulingPhysicalReceipt(repo: ConversationRepositoryHost, after?: string) {
  return repo.database.transaction(() => scheduling.claimPhysicalReceipt(repo.database, after))
}

export function acknowledgeSchedulingPhysicalReceipt(
  repo: ConversationRepositoryHost,
  receiptId: string,
  expectedWitness: string,
): boolean {
  return repo.database.transaction(() =>
    scheduling.acknowledgePhysicalReceipt(repo.database, receiptId, expectedWitness),
  )
}

export function settleSchedulingOwnerAfterPhysicalProof(
  repo: ConversationRepositoryHost,
  id: string,
  expectedWitnessJson: string,
  expectedGeneration = 0,
): boolean {
  const released = repo.database.transaction(() => {
    const owner = scheduling.activeRuntimeOwner(repo.database)
    if (
      !expectedWitnessJson ||
      !owner?.physicalWitnessJson ||
      owner.id !== id ||
      owner.nativeGeneration !== expectedGeneration ||
      owner.physicalWitnessJson !== expectedWitnessJson
    )
      return false
    if (owner.kind === 'probe') scheduling.settleRuntimeProbe(repo.database, id, true)
    else {
      const evaluation = repo.database
        .select()
        .from(schedulingEvaluations)
        .where(eq(schedulingEvaluations.id, owner.evaluationId!))
        .get()
      if (!evaluation) throw new RunOperationConflictError('The evaluation receipt is unavailable.')
      scheduling.settleNativeEvaluationAfterProof(repo.database, evaluation.id, {
        outcome: !evaluation.called
          ? 'not_sent'
          : evaluation.outcome === 'completed'
            ? 'completed'
            : 'failed',
      })
    }
    return true
  })
  if (released) schedulingChanged(repo)
  return released
}

export function reserveEvaluation(
  repo: ConversationRepositoryHost,
  input: Parameters<typeof scheduling.reserveEvaluation>[1],
) {
  const result = repo.database.transaction(() => {
    assertSchedulingFreshness(repo, input.handoff)
    return scheduling.reserveEvaluation(repo.database, input)
  })
  schedulingChanged(repo)
  return result
}

export function settleEvaluationAfterPhysicalProof(
  repo: ConversationRepositoryHost,
  id: string,
  expectedWitnessJson: string,
): boolean {
  return settleSchedulingOwnerAfterPhysicalProof(repo, id, expectedWitnessJson)
}

/**
 * Utility releases a prior HTTP owner only after a positive OS absence proof.
 * The stored request identity, never a timeout or epoch, authorizes the release.
 */
export function settleSchedulingHttpOwnerAfterExit(
  repo: ConversationRepositoryHost,
  id: string,
  expectedOwnerJson: string,
): boolean {
  const released = repo.database.transaction(() => {
    const owner = scheduling.activeRuntimeOwner(repo.database)
    if (
      !expectedOwnerJson ||
      Buffer.byteLength(expectedOwnerJson) > DECISION_HTTP_OWNER_BYTES ||
      !owner?.httpOwnerJson ||
      owner.id !== id ||
      owner.evaluationId !== id ||
      owner.kind !== 'evaluation' ||
      owner.provider !== 'openai' ||
      owner.httpOwnerJson !== expectedOwnerJson
    )
      return false
    let proof: unknown
    try {
      proof = JSON.parse(expectedOwnerJson)
    } catch {
      return false
    }
    const parsed = decisionHttpOwnerSchema.safeParse(proof)
    if (!parsed.success || parsed.data.requestId !== id) return false
    const evaluation = repo.database
      .select()
      .from(schedulingEvaluations)
      .where(eq(schedulingEvaluations.id, owner.evaluationId))
      .get()
    if (!evaluation) throw new RunOperationConflictError('The evaluation receipt is unavailable.')
    // A malformed stored remote state retains the owner; it is never repaired or invented.
    const remoteOutcome = decisionRemoteOutcomeSchema.safeParse(evaluation.remoteOutcome)
    if (!remoteOutcome.success) return false
    scheduling.settleEvaluation(repo.database, evaluation.id, {
      outcome:
        evaluation.outcome === 'completed' ||
        evaluation.outcome === 'failed' ||
        evaluation.outcome === 'not_sent'
          ? evaluation.outcome
          : evaluation.called
            ? 'failed'
            : 'not_sent',
      physicalReleased: true,
      httpOwner: parsed.data,
      remoteOutcome: remoteOutcome.data,
    })
    return true
  })
  if (released) schedulingChanged(repo)
  return released
}

export function settleEvaluation(
  repo: ConversationRepositoryHost,
  id: string,
  input: Parameters<typeof scheduling.settleEvaluation>[2],
) {
  const result = repo.database.transaction(() =>
    scheduling.settleEvaluation(repo.database, id, input),
  )
  schedulingChanged(repo)
  return result
}

export function dispatchEvaluation(
  repo: ConversationRepositoryHost,
  id: string,
  httpOwner: import('@pact/contracts').DecisionHttpOwner,
) {
  const result = repo.database.transaction(() => {
    const evaluation = repo.database
      .select()
      .from(schedulingEvaluations)
      .where(eq(schedulingEvaluations.id, id))
      .get()
    if (!evaluation)
      throw new RunOperationConflictError('The evaluation reservation is unavailable.')
    // A duplicate is readback only, including after a configuration change or restart.
    if (
      !evaluation.called &&
      evaluation.configurationFingerprint !==
        scheduling.decisionConfigurationFingerprint(repo.database)
    )
      throw new RunOperationConflictError('The evaluation configuration is no longer current.')
    if (!evaluation.called)
      assertSchedulingFreshness(
        repo,
        schedulingHandoffSchema.parse(JSON.parse(evaluation.handoffJson)),
      )
    return scheduling.dispatchEvaluation(repo.database, id, httpOwner)
  })
  schedulingChanged(repo)
  return result
}

export function reserveSchedulingBudget(
  repo: ConversationRepositoryHost,
  input: Parameters<typeof scheduling.reserveBudget>[1],
) {
  return repo.database.transaction(() => {
    assertSchedulingFreshness(repo, input.handoff)
    return scheduling.reserveBudget(repo.database, input)
  })
}

export function settleSchedulingBudget(
  repo: ConversationRepositoryHost,
  id: string,
  state: Parameters<typeof scheduling.settleBudget>[2],
) {
  return repo.database.transaction(() => scheduling.settleBudget(repo.database, id, state))
}

export function schedulingBudget(repo: ConversationRepositoryHost, subjectId: string) {
  return repo.database
    .select()
    .from(schedulingBudgetCounters)
    .where(eq(schedulingBudgetCounters.subjectId, subjectId))
    .get()
}

export function handoffReceipt(repo: ConversationRepositoryHost, id: string) {
  return repo.database.select().from(schedulingHandoffs).where(eq(schedulingHandoffs.id, id)).get()
}
