import { and, eq, sql, asc, gt, isNull } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'

import {
  schedulingHandoffSchema,
  schedulingBudgetSchema,
  schedulingUsageSchema,
  type SchedulingHandoff,
  type SchedulingBudget,
  type SchedulingUsage,
  schedulingSettingsSchema,
  schedulingSettingsSaveSchema,
  type SchedulingSettingsSave,
  decisionPhysicalWitnessSchema,
  decisionPhysicalWitnessExtends,
  decisionNativeStageSchema,
  type DecisionNativeStage,
  type DecisionPhysicalWitness,
  DECISION_PHYSICAL_RECEIPT_ITEMS,
  DECISION_PHYSICAL_RECEIPT_BYTES,
  schedulingCheckPhysicalOwnerSchema,
  collaborationActionBasisSchema,
  collaborationTurnAuthorizationSchema,
  confirmedUnsentProofSchema,
  frozenExecutionInputSchema,
  runEffectiveExecutionSettingsSchema,
  relaySchedulingDecisionProofSchema,
} from '@pact/contracts'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { appendAgentEvent } from './agent-event-journal.js'
import { RunOperationConflictError } from './conversation-errors.js'
import {
  recordHandoffActivity,
  syncEvaluationActivity,
  syncRecoveryActivity,
} from './conversation-scheduling-activity.js'
import {
  schedulingHandoffs,
  schedulingBudgetCounters,
  schedulingEvaluations,
  schedulingBudgetReservations,
  collaborationTasks,
  collaborationActionReceipts,
  relayDecisions,
  collaborationInputs,
  conversationMessages,
  conversationBodyInputs,
  conversationInputBatches,
  agentRuns,
  conversationQueueOperations,
  nativeRebuildOperations,
  schedulingSettings,
  schedulingRuntimeOwners,
  schedulingPhysicalReceipts,
  schedulingRecoveryFaults,
  schedulingRecoveryAttempts,
  runExecutionInputs,
  runReexecutionOperations,
  workflowTurns,
} from './schema/index.js'

export {
  readActivity,
  recordBusinessActivity,
  recordGuidanceAdoptionActivity,
  recordNativeRebuildActivity,
  refreshNativeRebuildActivityForRecovery,
  recordRelayDecisionActivity,
  syncRecoveryActivity,
} from './conversation-scheduling-activity.js'

export function readSettings(db: PactDrizzleDatabase) {
  const row = db.select().from(schedulingSettings).where(eq(schedulingSettings.id, 1)).get()
  return schedulingSettingsSchema.parse({
    enabled: row?.enabled ?? false,
    selection: row?.selectionJson ? JSON.parse(row.selectionJson) : null,
    showIndicator: row?.showIndicator ?? true,
    revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt ?? new Date(0).toISOString(),
  })
}

export function configurationGeneration(db: PactDrizzleDatabase): number {
  return (
    db
      .select({ generation: schedulingSettings.configurationGeneration })
      .from(schedulingSettings)
      .where(eq(schedulingSettings.id, 1))
      .get()?.generation ?? 0
  )
}

export function saveSettings(db: PactDrizzleDatabase, raw: SchedulingSettingsSave) {
  const input = schedulingSettingsSaveSchema.parse(raw),
    current = readSettings(db)
  if (input.expectedRevision !== current.revision)
    throw new RunOperationConflictError('Scheduling settings changed. Refresh before saving again.')
  const selection = input.selection === undefined ? current.selection : input.selection
  const changed =
    (input.enabled ?? current.enabled) !== current.enabled ||
    JSON.stringify(selection) !== JSON.stringify(current.selection)
  const generation = configurationGeneration(db) + (changed ? 1 : 0)
  if (!Number.isSafeInteger(generation))
    throw new RunOperationConflictError('Scheduling configuration generation is unavailable.')
  db.insert(schedulingSettings)
    .values({
      id: 1,
      enabled: input.enabled ?? current.enabled,
      selectionJson: selection ? JSON.stringify(selection) : null,
      showIndicator: input.showIndicator ?? current.showIndicator,
      revision: current.revision + 1,
      configurationGeneration: generation,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schedulingSettings.id,
      set: {
        enabled: input.enabled ?? current.enabled,
        selectionJson: selection ? JSON.stringify(selection) : null,
        showIndicator: input.showIndicator ?? current.showIndicator,
        revision: current.revision + 1,
        configurationGeneration: generation,
        updatedAt: new Date().toISOString(),
      },
      setWhere: eq(schedulingSettings.revision, input.expectedRevision),
    })
    .run()
  return readSettings(db)
}

export const fingerprint = (facts: unknown): string =>
  createHash('sha256').update(JSON.stringify(facts)).digest('hex')

export function recordRecoveryFault(
  db: PactDrizzleDatabase,
  input: { epoch: string; node: SchedulingHandoff; originSequence: number },
): void {
  const settings = readSettings(db),
    node = schedulingHandoffSchema.parse(input.node)
  if (
    !settings.enabled ||
    !settings.selection ||
    !node.fault ||
    !node.freshnessGuard.runId ||
    !node.freshnessGuard.agentId
  )
    return
  const existing = db
    .select({ id: schedulingRecoveryFaults.id })
    .from(schedulingRecoveryFaults)
    .where(
      and(
        eq(schedulingRecoveryFaults.faultKind, node.fault.kind),
        eq(schedulingRecoveryFaults.faultId, node.fault.id),
      ),
    )
    .get()
  if (existing) return
  const now = new Date().toISOString()
  db.update(schedulingRecoveryFaults)
    .set({ active: false })
    .where(
      and(
        eq(schedulingRecoveryFaults.sessionId, node.sessionId),
        eq(schedulingRecoveryFaults.agentId, node.freshnessGuard.agentId),
        eq(schedulingRecoveryFaults.faultKind, node.fault.kind),
        eq(schedulingRecoveryFaults.active, true),
      ),
    )
    .run()
  db.insert(schedulingRecoveryFaults)
    .values({
      id: randomUUID(),
      sessionId: node.sessionId,
      faultKind: node.fault.kind,
      faultId: node.fault.id,
      runId: node.freshnessGuard.runId,
      agentId: node.freshnessGuard.agentId,
      utilityEpoch: input.epoch,
      configurationGeneration: configurationGeneration(db),
      originSequence: input.originSequence,
      observedFingerprint: node.factFingerprint,
      createdAt: now,
      activityAt: now,
    })
    .run()
}

export function reserveRecoveryCheck(
  db: PactDrizzleDatabase,
  input: { faultId: string; epoch: string; handoff: SchedulingHandoff; utilityPid: number },
) {
  const fault = db
    .select()
    .from(schedulingRecoveryFaults)
    .where(eq(schedulingRecoveryFaults.id, input.faultId))
    .get()
  const settings = readSettings(db),
    generation = configurationGeneration(db),
    node = schedulingHandoffSchema.parse(input.handoff)
  if (
    !fault ||
    !fault.active ||
    fault.utilityEpoch !== input.epoch ||
    fault.configurationGeneration !== generation ||
    !settings.enabled ||
    !settings.selection ||
    fault.consideredFingerprint !== node.factFingerprint ||
    node.fault?.id !== fault.faultId ||
    node.fault.kind !== fault.faultKind ||
    activeRuntimeOwner(db)
  )
    return undefined
  if (
    !Number.isSafeInteger(input.utilityPid) ||
    input.utilityPid <= 0 ||
    Buffer.byteLength(JSON.stringify(node)) >= 4096
  )
    throw new RunOperationConflictError('The bounded native check identity is unavailable.')
  const reserved = reserveBudget(db, { handoff: node, budget: 'automatic_check' })
  if (reserved.status !== 'reserved') return undefined
  const id = randomUUID(),
    now = new Date().toISOString(),
    deadline = new Date(Date.now() + 10_000).toISOString()
  const run = db
    .select({ model: agentRuns.model })
    .from(agentRuns)
    .where(eq(agentRuns.id, fault.runId))
    .get()
  db.insert(schedulingRuntimeOwners)
    .values({
      id,
      kind: 'check',
      sessionId: fault.sessionId,
      provider: fault.agentId,
      model: run?.model ?? 'native',
      configurationFingerprint: fingerprint([input.epoch, generation]),
      createdAt: now,
      deadline,
    })
    .run()
  const attempt = db
    .insert(schedulingRecoveryAttempts)
    .values({
      id,
      faultId: fault.id,
      reservationId: reserved.reservation.id,
      handoffJson: JSON.stringify(node),
      utilityPid: input.utilityPid,
      physicalOwnerJson: JSON.stringify({
        kind: fault.agentId === 'claude' ? 'utility_io' : 'inspection_pending',
      }),
      createdAt: now,
      deadline,
    })
    .returning()
    .get()
  db.update(schedulingRecoveryFaults)
    .set({ result: 'reserved', physicalUnconfirmed: true, latestAction: 'check', activityAt: now })
    .where(eq(schedulingRecoveryFaults.id, fault.id))
    .run()
  syncRecoveryActivity(db, fault.id)
  return attempt
}

export function startRecoveryCheck(db: PactDrizzleDatabase, id: string): void {
  const attempt = db
    .select()
    .from(schedulingRecoveryAttempts)
    .where(eq(schedulingRecoveryAttempts.id, id))
    .get()
  if (!attempt || attempt.started || attempt.physicalReleased) return
  settleBudget(db, attempt.reservationId, 'possibly_sent')
  db.update(schedulingRecoveryAttempts)
    .set({ started: true, result: 'possibly_sent' })
    .where(eq(schedulingRecoveryAttempts.id, id))
    .run()
  db.update(schedulingRuntimeOwners)
    .set({ phase: 'running' })
    .where(eq(schedulingRuntimeOwners.id, id))
    .run()
  db.update(schedulingRecoveryFaults)
    .set({ result: 'possibly_sent', activityAt: new Date().toISOString() })
    .where(eq(schedulingRecoveryFaults.id, attempt.faultId))
    .run()
  syncRecoveryActivity(db, attempt.faultId)
}

export function recordRecoveryCheckPhysicalOwner(
  db: PactDrizzleDatabase,
  id: string,
  value: unknown,
): void {
  const owner = schedulingCheckPhysicalOwnerSchema.parse(value),
    json = JSON.stringify(owner)
  if (Buffer.byteLength(json) >= 4096)
    throw new RunOperationConflictError(
      'The complete readback ownership proof exceeds its metadata budget.',
    )
  if (owner.kind === 'inspection_group' && owner.witness.ownerId !== id)
    throw new RunOperationConflictError('The readback group belongs to another check.')
  db.update(schedulingRecoveryAttempts)
    .set({ physicalOwnerJson: json })
    .where(
      and(
        eq(schedulingRecoveryAttempts.id, id),
        eq(schedulingRecoveryAttempts.physicalReleased, false),
      ),
    )
    .run()
}

export function settleRecoveryCheck(
  db: PactDrizzleDatabase,
  id: string,
  input: { ok: boolean; physicalReleased: boolean; retire?: boolean },
): void {
  const attempt = db
    .select()
    .from(schedulingRecoveryAttempts)
    .where(eq(schedulingRecoveryAttempts.id, id))
    .get()
  if (!attempt || attempt.physicalReleased) return
  const result =
    attempt.result === 'completed' || attempt.result === 'failed' || attempt.result === 'not_sent'
      ? attempt.result
      : !attempt.started
        ? 'not_sent'
        : input.ok
          ? 'completed'
          : 'failed'
  db.update(schedulingRecoveryAttempts)
    .set({ result, physicalReleased: input.physicalReleased })
    .where(eq(schedulingRecoveryAttempts.id, id))
    .run()
  db.update(schedulingRuntimeOwners)
    .set({
      phase: input.physicalReleased ? 'released' : 'cleanup_unconfirmed',
      active: !input.physicalReleased,
      ...(input.physicalReleased ? { settledAt: new Date().toISOString() } : {}),
    })
    .where(and(eq(schedulingRuntimeOwners.id, id), eq(schedulingRuntimeOwners.kind, 'check')))
    .run()
  db.update(schedulingRecoveryFaults)
    .set({
      result,
      physicalUnconfirmed: !input.physicalReleased,
      activityAt: new Date().toISOString(),
      ...(input.retire ? { active: false } : {}),
    })
    .where(eq(schedulingRecoveryFaults.id, attempt.faultId))
    .run()
  if (input.physicalReleased)
    settleBudget(db, attempt.reservationId, attempt.started ? 'settled' : 'not_sent')
  syncRecoveryActivity(db, attempt.faultId)
}

export function handoff(
  input: Omit<SchedulingHandoff, 'id' | 'budgetSubjectId'>,
): SchedulingHandoff {
  const budgetSubjectId = `${input.budgetRoot.kind}:${input.budgetRoot.id}`
  return schedulingHandoffSchema.parse({
    ...input,
    budgetSubjectId,
    id: fingerprint([budgetSubjectId, input.eventId, input.slot]),
  })
}

/** All functions run under ConversationRepository's transaction; no separate store or owner. */
export function ensureHandoff(db: PactDrizzleDatabase, raw: SchedulingHandoff) {
  const node = schedulingHandoffSchema.parse(raw)
  if (node.id !== handoff(node).id || node.budgetSubjectId !== handoff(node).budgetSubjectId)
    throw new RunOperationConflictError('The handoff identity is invalid.')
  const root =
    'kind' in node.freshnessGuard && node.freshnessGuard.kind === 'prepared_input'
      ? db
          .select({ sessionId: conversationInputBatches.sessionId })
          .from(conversationInputBatches)
          .innerJoin(
            conversationBodyInputs,
            eq(conversationBodyInputs.id, conversationInputBatches.inputId),
          )
          .where(
            and(
              eq(conversationInputBatches.id, node.freshnessGuard.batchId),
              eq(conversationInputBatches.clientMessageId, node.budgetRoot.id),
              sql`${conversationInputBatches.dispatchState} IN ('prepared', 'dispatched', 'cancelled')`,
              eq(conversationBodyInputs.sealed, true),
            ),
          )
          .get()
      : node.budgetRoot.kind === 'task'
        ? db
            .select({ sessionId: collaborationTasks.sessionId })
            .from(collaborationTasks)
            .where(eq(collaborationTasks.id, node.budgetRoot.id))
            .get()
        : db
            .select({ sessionId: conversationMessages.sessionId })
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.id, node.budgetRoot.id),
                eq(conversationMessages.role, 'user'),
              ),
            )
            .get()
  if (
    root?.sessionId !== node.sessionId &&
    !(node.budgetRoot.kind === 'input' && node.fault?.kind === 'queue')
  )
    throw new RunOperationConflictError('The persistent budget subject is unavailable.')
  if (node.fault) assertFaultRoot(db, node)
  db.insert(schedulingHandoffs)
    .values({
      id: node.id,
      sessionId: node.sessionId,
      budgetSubjectId: node.budgetSubjectId,
      eventId: node.eventId,
      slot: node.slot,
      faultSubjectId: node.fault ? `${node.fault.kind}:${node.fault.id}` : null,
      factFingerprint: node.factFingerprint,
      freshnessGuardJson: JSON.stringify(node.freshnessGuard),
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run()
  const saved = db
    .select()
    .from(schedulingHandoffs)
    .where(eq(schedulingHandoffs.id, node.id))
    .get()!
  if (
    saved.sessionId !== node.sessionId ||
    saved.faultSubjectId !== (node.fault ? `${node.fault.kind}:${node.fault.id}` : null)
  )
    throw new RunOperationConflictError('The original handoff fault cannot be replaced.')
  return saved
}

function assertFaultRoot(db: PactDrizzleDatabase, node: SchedulingHandoff): void {
  const fault = node.fault!
  let runId: string | null | undefined
  if (fault.kind === 'run') runId = fault.id
  else if (fault.kind === 'rebuild') {
    const operation = db
      .select()
      .from(nativeRebuildOperations)
      .where(eq(nativeRebuildOperations.id, fault.id))
      .get()
    if (operation?.sessionId === node.sessionId) runId = operation.oldRunId
  } else {
    const operation = db
      .select()
      .from(conversationQueueOperations)
      .where(eq(conversationQueueOperations.id, fault.id))
      .get()
    if (operation?.sessionId === node.sessionId) {
      const input = operation.inputId
        ? db
            .select()
            .from(collaborationInputs)
            .where(eq(collaborationInputs.id, operation.inputId))
            .get()
        : undefined
      if (input && node.budgetRoot.kind === 'task' && input.taskId === node.budgetRoot.id) return
      if (input && node.budgetRoot.kind === 'input') {
        const body = db
          .select({ clientMessageId: conversationBodyInputs.clientMessageId })
          .from(conversationBodyInputs)
          .where(eq(conversationBodyInputs.id, input.inputId))
          .get()
        if (body?.clientMessageId === node.budgetRoot.id) return
      }
      runId = operation.targetRunId ?? input?.anchorRunId
    }
  }
  const run = runId ? db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get() : undefined
  if (
    !run ||
    run.sessionId !== node.sessionId ||
    (node.budgetRoot.kind === 'task'
      ? run.collaborationTaskId !== node.budgetRoot.id
      : run.userMessageId !== node.budgetRoot.id)
  )
    throw new RunOperationConflictError(
      'The fault does not belong to this original budget subject.',
    )
  // A failed replacement remains charged to its original fault rather than opening a new allowance.
  const origin = db
    .select({ fault: schedulingHandoffs.faultSubjectId })
    .from(schedulingHandoffs)
    .where(eq(schedulingHandoffs.runId, run.id))
    .get()
  if (origin?.fault && origin.fault !== `${fault.kind}:${fault.id}`)
    throw new RunOperationConflictError('Recovery must retain the original fault identity.')
}

export function claimHandoff(
  db: PactDrizzleDatabase,
  node: SchedulingHandoff,
  action: string,
  target: { runId: string } | { operationId: string },
) {
  if (!action || action.length > 80)
    throw new RunOperationConflictError('The handoff action is invalid.')
  const saved = ensureHandoff(db, node)
  if (saved.action) return { receipt: saved, created: false }
  db.update(schedulingHandoffs)
    .set({
      action,
      ...target,
      factFingerprint: node.factFingerprint,
      freshnessGuardJson: JSON.stringify(node.freshnessGuard),
    })
    .where(and(eq(schedulingHandoffs.id, node.id), sql`${schedulingHandoffs.action} IS NULL`))
    .run()
  const journalRunId = 'runId' in target ? target.runId : node.freshnessGuard.runId
  if (journalRunId)
    appendAgentEvent(db, {
      sessionId: node.sessionId,
      runId: journalRunId,
      eventType: 'scheduling.handoff_claimed',
      payload: JSON.stringify({
        handoffId: node.id,
        budgetSubjectId: node.budgetSubjectId,
        action,
        ...target,
      }),
      createdAt: new Date().toISOString(),
    })
  recordHandoffActivity(db, node.id)
  return {
    receipt: db.select().from(schedulingHandoffs).where(eq(schedulingHandoffs.id, node.id)).get()!,
    created: true,
  }
}

function counter(db: PactDrizzleDatabase, sessionId: string, subjectId: string) {
  db.insert(schedulingBudgetCounters).values({ sessionId, subjectId }).onConflictDoNothing().run()
  return db
    .select()
    .from(schedulingBudgetCounters)
    .where(eq(schedulingBudgetCounters.subjectId, subjectId))
    .get()!
}

const evaluationFact = (node: SchedulingHandoff) =>
  and(
    eq(schedulingEvaluations.budgetSubjectId, node.budgetSubjectId),
    eq(schedulingEvaluations.factFingerprint, node.factFingerprint),
  )

/** Durable same-fact deduplication precedes physical admission, including terminal receipts. */
export function readEvaluationReceipt(db: PactDrizzleDatabase, node: SchedulingHandoff) {
  return db
    .select({ id: schedulingEvaluations.id })
    .from(schedulingEvaluations)
    .where(evaluationFact(node))
    .get()
}

export function reserveEvaluation(
  db: PactDrizzleDatabase,
  input: {
    handoff: SchedulingHandoff
    provider: 'codex' | 'claude'
    model: string
    configurationFingerprint: string
    inputSha256?: string
    deadlineAt?: number
  },
) {
  const node = input.handoff,
    saved = ensureHandoff(db, node)
  const existing = db.select().from(schedulingEvaluations).where(evaluationFact(node)).get()
  if (existing) return { status: 'duplicate' as const, evaluation: existing }
  if (saved.action) return { status: 'claimed' as const }
  if (activeRuntimeOwner(db)) return { status: 'busy' as const }
  if (
    !['codex', 'claude'].includes(input.provider) ||
    !input.model.trim() ||
    Buffer.byteLength(input.model) > 256 ||
    !/^[a-f0-9]{64}$/u.test(input.configurationFingerprint)
  )
    throw new RunOperationConflictError('An exact provider, model and configuration are required.')
  if (input.inputSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(input.inputSha256))
    throw new RunOperationConflictError('The complete evaluation input identity is invalid.')
  const now = Date.now()
  const deadlineAt = input.deadlineAt ?? now + 15_000
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= now || deadlineAt > now + 15_000)
    throw new RunOperationConflictError('The evaluation deadline is unavailable.')
  const evaluation = db
    .insert(schedulingEvaluations)
    .values({
      id: randomUUID(),
      sessionId: node.sessionId,
      handoffId: node.id,
      budgetSubjectId: node.budgetSubjectId,
      factFingerprint: node.factFingerprint,
      provider: input.provider,
      model: input.model,
      configurationFingerprint: input.configurationFingerprint,
      inputSha256: input.inputSha256 ?? null,
      handoffJson: JSON.stringify(node),
      outcome: 'reserved',
      createdAt: new Date(now).toISOString(),
      deadline: new Date(deadlineAt).toISOString(),
    })
    .returning()
    .get()
  assertEvaluationMetadata(evaluation)
  db.insert(schedulingRuntimeOwners)
    .values({
      id: evaluation.id,
      kind: 'evaluation',
      sessionId: node.sessionId,
      evaluationId: evaluation.id,
      provider: input.provider,
      model: input.model,
      configurationFingerprint: input.configurationFingerprint,
      createdAt: evaluation.createdAt,
      deadline: evaluation.deadline,
    })
    .run()
  syncEvaluationActivity(db, evaluation.id)
  return { status: 'reserved' as const, evaluation }
}

export function activeRuntimeOwner(db: PactDrizzleDatabase) {
  return db
    .select()
    .from(schedulingRuntimeOwners)
    .where(eq(schedulingRuntimeOwners.active, true))
    .get()
}

/** Reserve before any native construction. A missing witness after restart stays unresolved. */
export function reserveRuntimeProbe(
  db: PactDrizzleDatabase,
  input: {
    id: string
    sessionId: string | null
    provider: 'codex' | 'claude'
    model: string
    configurationFingerprint: string
    deadlineAt: number
  },
) {
  if (activeRuntimeOwner(db)) return false
  if (
    !/^[a-f0-9-]{36}$/u.test(input.id) ||
    !/^[a-f0-9]{64}$/u.test(input.configurationFingerprint) ||
    !input.model.trim() ||
    Buffer.byteLength(input.model) > 256 ||
    !Number.isSafeInteger(input.deadlineAt) ||
    input.deadlineAt <= Date.now() ||
    input.deadlineAt > Date.now() + 15_000
  )
    throw new RunOperationConflictError('The native probe identity is unavailable.')
  // A completed probe has no semantic history. Retain only its latest physical receipt.
  db.delete(schedulingRuntimeOwners)
    .where(
      and(
        eq(schedulingRuntimeOwners.kind, 'probe'),
        eq(schedulingRuntimeOwners.active, false),
        sql`NOT EXISTS (SELECT 1 FROM ${schedulingPhysicalReceipts} r WHERE r.runtime_owner_id = ${schedulingRuntimeOwners.id})`,
      ),
    )
    .run()
  db.insert(schedulingRuntimeOwners)
    .values({
      id: input.id,
      kind: 'probe',
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
      configurationFingerprint: input.configurationFingerprint,
      createdAt: new Date().toISOString(),
      deadline: new Date(input.deadlineAt).toISOString(),
    })
    .run()
  return true
}

const PHYSICAL_RECEIPT_RECORD_BYTES = 2 * 1024

function receiptUsage(db: PactDrizzleDatabase) {
  return db.get<{ items: number; bytes: number }>(
    sql`SELECT count(*) AS items, coalesce(sum(entry_bytes),0) AS bytes FROM scheduling_physical_receipts`,
  )
}

export function hasPhysicalReceipts(db: PactDrizzleDatabase): boolean {
  return (
    db
      .select({ id: schedulingPhysicalReceipts.receiptId })
      .from(schedulingPhysicalReceipts)
      .limit(1)
      .get() !== undefined
  )
}

/** The next file is accounted before native construction; a preparing intention is not a file. */
export function physicalReceiptCapacityAvailable(db: PactDrizzleDatabase): boolean {
  const used = receiptUsage(db)
  const owner = activeRuntimeOwner(db)
  const current = owner?.physicalWitnessJson
    ? decisionPhysicalWitnessSchema.safeParse(JSON.parse(owner.physicalWitnessJson))
    : undefined
  if (current && !current.success) return false
  const activeItems = current?.success && current.data.platform === 'win32' ? 1 : 0
  return (
    Number.isSafeInteger(used.items) &&
    Number.isSafeInteger(used.bytes) &&
    used.items >= 0 &&
    used.bytes >= 0 &&
    used.items + activeItems + 1 <= DECISION_PHYSICAL_RECEIPT_ITEMS &&
    used.bytes + (activeItems + 1) * PHYSICAL_RECEIPT_RECORD_BYTES <=
      DECISION_PHYSICAL_RECEIPT_BYTES
  )
}

/** Only direct physical completion reaches this transaction; an unknown witness never enters cleanup. */
function retainClosedReceipt(
  db: PactDrizzleDatabase,
  owner: typeof schedulingRuntimeOwners.$inferSelect,
): void {
  if (!owner.physicalWitnessJson) return
  const witness = decisionPhysicalWitnessSchema.parse(JSON.parse(owner.physicalWitnessJson))
  if (witness.platform !== 'win32') return
  const entry = {
    receiptId: witness.receipt.id,
    runtimeOwnerId: owner.id,
    nativeGeneration: owner.nativeGeneration,
    witnessJson: JSON.stringify(witness),
    state: 'pending' as const,
    entryBytes: PHYSICAL_RECEIPT_RECORD_BYTES,
  }
  const existing = db
    .select()
    .from(schedulingPhysicalReceipts)
    .where(eq(schedulingPhysicalReceipts.receiptId, entry.receiptId))
    .get()
  if (existing) {
    if (
      existing.runtimeOwnerId !== entry.runtimeOwnerId ||
      existing.nativeGeneration !== entry.nativeGeneration ||
      existing.witnessJson !== entry.witnessJson
    )
      throw new RunOperationConflictError('The closed physical receipt identity changed.')
    return
  }
  entry.entryBytes = Buffer.byteLength(JSON.stringify({ ...entry, state: 'retiring' }))
  const used = receiptUsage(db)
  if (
    entry.entryBytes > PHYSICAL_RECEIPT_RECORD_BYTES ||
    used.items >= DECISION_PHYSICAL_RECEIPT_ITEMS ||
    used.bytes + entry.entryBytes > DECISION_PHYSICAL_RECEIPT_BYTES
  )
    throw new RunOperationConflictError('The closed physical receipt budget is full.')
  db.insert(schedulingPhysicalReceipts).values(entry).run()
}

export function claimPhysicalReceipt(db: PactDrizzleDatabase, after?: string) {
  const saved = db
    .select()
    .from(schedulingPhysicalReceipts)
    .where(after ? gt(schedulingPhysicalReceipts.receiptId, after) : undefined)
    .orderBy(asc(schedulingPhysicalReceipts.receiptId))
    .limit(1)
    .get()
  if (!saved) return undefined
  const witness = decisionPhysicalWitnessSchema.parse(JSON.parse(saved.witnessJson))
  if (
    witness.platform !== 'win32' ||
    witness.receipt.id !== saved.receiptId ||
    saved.entryBytes <= 0 ||
    saved.entryBytes > PHYSICAL_RECEIPT_RECORD_BYTES ||
    Buffer.byteLength(JSON.stringify(saved)) > saved.entryBytes
  )
    throw new RunOperationConflictError('The closed physical receipt metadata is invalid.')
  db.update(schedulingPhysicalReceipts)
    .set({ state: 'retiring' })
    .where(eq(schedulingPhysicalReceipts.receiptId, saved.receiptId))
    .run()
  return { ...saved, state: 'retiring' as const, witness }
}

/** Acknowledges only the exact committed retirement. Absence is a file fact, never process proof. */
export function acknowledgePhysicalReceipt(
  db: PactDrizzleDatabase,
  receiptId: string,
  expectedWitness: string,
): boolean {
  return (
    db
      .delete(schedulingPhysicalReceipts)
      .where(
        and(
          eq(schedulingPhysicalReceipts.receiptId, receiptId),
          eq(schedulingPhysicalReceipts.witnessJson, expectedWitness),
          eq(schedulingPhysicalReceipts.state, 'retiring'),
        ),
      )
      .run().changes === 1
  )
}

export function recordRuntimeWitness(
  db: PactDrizzleDatabase,
  id: string,
  value: {
    witness: DecisionPhysicalWitness
    configurationFingerprint?: string
    nativeGeneration?: number
  },
) {
  const witness = decisionPhysicalWitnessSchema.parse(value.witness)
  const saved = db
    .select()
    .from(schedulingRuntimeOwners)
    .where(eq(schedulingRuntimeOwners.id, id))
    .get()
  if (!saved?.active) throw new RunOperationConflictError('The native reservation is unavailable.')
  if ((value.nativeGeneration ?? 0) !== saved.nativeGeneration)
    throw new RunOperationConflictError('The native witness belongs to an older physical stage.')
  if (value.configurationFingerprint && !/^[a-f0-9]{64}$/u.test(value.configurationFingerprint))
    throw new RunOperationConflictError('Invalid native configuration identity.')
  if (saved.physicalWitnessJson) {
    const previous = decisionPhysicalWitnessSchema.parse(JSON.parse(saved.physicalWitnessJson))
    if (!decisionPhysicalWitnessExtends(previous, witness))
      throw new RunOperationConflictError('The native physical owner changed.')
  }
  db.update(schedulingRuntimeOwners)
    .set({
      phase: saved.phase === 'cleanup_unconfirmed' ? 'cleanup_unconfirmed' : 'running',
      physicalWitnessJson: JSON.stringify(witness),
      ...(value.configurationFingerprint
        ? { configurationFingerprint: value.configurationFingerprint }
        : {}),
    })
    .where(eq(schedulingRuntimeOwners.id, id))
    .run()
}

/** An invocation keeps its one admission while independently witnessed native stages change. */
export function beginNativeStage(
  db: PactDrizzleDatabase,
  id: string,
  input: {
    expectedGeneration: number
    stage: DecisionNativeStage
    previousWitness: DecisionPhysicalWitness | null
    previousPhysicalReleased: boolean
  },
): number {
  const stage = decisionNativeStageSchema.parse(input.stage)
  const owner = db
    .select()
    .from(schedulingRuntimeOwners)
    .where(eq(schedulingRuntimeOwners.id, id))
    .get()
  if (
    !owner?.active ||
    !['claude', 'codex'].includes(owner.provider) ||
    !input.previousPhysicalReleased ||
    !Number.isSafeInteger(input.expectedGeneration) ||
    input.expectedGeneration !== owner.nativeGeneration ||
    owner.nativeGeneration >= 4 ||
    Date.parse(owner.deadline) <= Date.now() ||
    owner.phase === 'cleanup_unconfirmed'
  )
    throw new RunOperationConflictError('The native stage is no longer eligible.')
  if (owner.nativeGeneration === 0) {
    if (
      stage !== 'host_metadata' ||
      owner.phase !== 'reserved' ||
      owner.nativeStage !== null ||
      owner.physicalWitnessJson !== null ||
      input.previousWitness !== null
    )
      throw new RunOperationConflictError('The initial native stage is not empty.')
  } else {
    const witness =
      input.previousWitness && decisionPhysicalWitnessSchema.parse(input.previousWitness)
    if (
      owner.phase !== 'running' ||
      !witness ||
      !owner.physicalWitnessJson ||
      JSON.stringify(witness) !== owner.physicalWitnessJson
    )
      throw new RunOperationConflictError(
        'The previous native stage has not been physically confirmed.',
      )
    const next =
      owner.nativeStage === 'host_metadata'
        ? owner.provider === 'claude' && owner.sessionId
          ? 'project_metadata'
          : 'guarded_context'
        : owner.nativeStage === 'project_metadata'
          ? 'guarded_context'
          : owner.nativeStage === 'guarded_context' && owner.kind === 'evaluation'
            ? 'project_verification'
            : null
    if (stage !== next) throw new RunOperationConflictError('The native stage order is invalid.')
  }
  retainClosedReceipt(db, owner)
  const generation = owner.nativeGeneration + 1
  db.update(schedulingRuntimeOwners)
    .set({
      nativeGeneration: generation,
      nativeStage: stage,
      phase: 'preparing',
      physicalWitnessJson: null,
    })
    .where(eq(schedulingRuntimeOwners.id, id))
    .run()
  return generation
}

/** Caller supplies direct runtime settlement or matching persisted-witness proof, never a timeout. */
export function settleRuntimeProbe(db: PactDrizzleDatabase, id: string, physicalReleased: boolean) {
  const saved = db
    .select()
    .from(schedulingRuntimeOwners)
    .where(eq(schedulingRuntimeOwners.id, id))
    .get()
  if (!saved || saved.kind !== 'probe')
    throw new RunOperationConflictError('The native probe is unavailable.')
  if (!saved.active) return
  if (physicalReleased) retainClosedReceipt(db, saved)
  db.update(schedulingRuntimeOwners)
    .set({
      active: !physicalReleased,
      phase: physicalReleased ? 'released' : 'cleanup_unconfirmed',
      ...(physicalReleased ? { settledAt: new Date().toISOString() } : {}),
    })
    .where(eq(schedulingRuntimeOwners.id, id))
    .run()
}

/** Includes inherited handoff/fingerprints and worst-case later usage/settlement metadata. */
function assertEvaluationMetadata(row: typeof schedulingEvaluations.$inferSelect): void {
  const future = {
    ...row,
    outcome: 'possibly_sent',
    selectedCandidateId: 'x'.repeat(160),
    called: false,
    active: false,
    usageJson: JSON.stringify({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: Number.MAX_SAFE_INTEGER,
    }),
    settledAt: '9999-12-31T23:59:59.999Z',
  }
  if (Buffer.byteLength(JSON.stringify(future)) >= 4 * 1024)
    throw new RunOperationConflictError('Evaluation metadata capacity is full.')
}

export function recordEvaluationPhysicalWitness(
  db: PactDrizzleDatabase,
  id: string,
  value: {
    witness: DecisionPhysicalWitness
    configurationFingerprint: string
    nativeGeneration?: number
  },
) {
  const witness = decisionPhysicalWitnessSchema.parse(value.witness)
  if (!/^[a-f0-9]{64}$/u.test(value.configurationFingerprint))
    throw new RunOperationConflictError('Invalid native configuration identity.')
  const saved = db
    .select()
    .from(schedulingEvaluations)
    .where(eq(schedulingEvaluations.id, id))
    .get()
  if (!saved?.active)
    throw new RunOperationConflictError('The evaluation reservation is unavailable.')
  const owner = db
    .select()
    .from(schedulingRuntimeOwners)
    .where(eq(schedulingRuntimeOwners.id, id))
    .get()
  if (owner?.nativeGeneration && owner.nativeStage !== 'guarded_context')
    throw new RunOperationConflictError(
      'Only the inference stage may record evaluation provenance.',
    )
  if (saved.physicalWitnessJson) {
    const previous = decisionPhysicalWitnessSchema.parse(JSON.parse(saved.physicalWitnessJson))
    if (
      !decisionPhysicalWitnessExtends(previous, witness) ||
      saved.configurationFingerprint !== value.configurationFingerprint
    )
      throw new RunOperationConflictError('The evaluation physical owner changed.')
  }
  const next = {
    ...saved,
    physicalWitnessJson: JSON.stringify(witness),
    configurationFingerprint: value.configurationFingerprint,
  }
  assertEvaluationMetadata(next)
  recordRuntimeWitness(db, id, value)
  const result = db
    .update(schedulingEvaluations)
    .set({
      physicalWitnessJson: next.physicalWitnessJson,
      configurationFingerprint: next.configurationFingerprint,
    })
    .where(eq(schedulingEvaluations.id, id))
    .returning()
    .get()
  syncEvaluationActivity(db, id)
  return result
}

export function settleEvaluation(
  db: PactDrizzleDatabase,
  id: string,
  input: {
    outcome: 'possibly_sent' | 'completed' | 'failed' | 'not_sent'
    physicalReleased: boolean
    selectedCandidateId?: string | null
    usage?: SchedulingUsage
  },
) {
  const saved = db
    .select()
    .from(schedulingEvaluations)
    .where(eq(schedulingEvaluations.id, id))
    .get()
  if (!saved) throw new RunOperationConflictError('The evaluation reservation is unavailable.')
  if (saved.called && input.outcome === 'not_sent')
    throw new RunOperationConflictError('A possibly sent evaluation cannot be refunded.')
  if (input.physicalReleased && input.outcome === 'possibly_sent')
    throw new RunOperationConflictError('Physical release requires a terminal evaluation outcome.')
  const usage = input.usage ? schedulingUsageSchema.parse(input.usage) : undefined
  if (
    input.selectedCandidateId !== undefined &&
    input.selectedCandidateId !== null &&
    (!/^[\w.:-]{1,160}$/u.test(input.selectedCandidateId) || input.outcome !== 'completed')
  )
    throw new RunOperationConflictError('The selected decision candidate is invalid.')
  if (!saved.active) return saved
  if (
    ['completed', 'failed', 'not_sent'].includes(saved.outcome) &&
    saved.outcome !== input.outcome
  )
    throw new RunOperationConflictError('A terminal evaluation outcome cannot be reopened.')
  if (
    saved.outcome === 'completed' &&
    input.selectedCandidateId !== undefined &&
    saved.selectedCandidateId !== input.selectedCandidateId
  )
    throw new RunOperationConflictError('A settled decision candidate cannot be replaced.')
  if (!saved.called && input.outcome !== 'not_sent')
    throw new RunOperationConflictError(
      'Record the evaluation invocation before settling its result.',
    )
  const owner = db
    .select()
    .from(schedulingRuntimeOwners)
    .where(eq(schedulingRuntimeOwners.id, id))
    .get()
  if (!owner?.active || owner.evaluationId !== id)
    throw new RunOperationConflictError('The evaluation physical reservation is unavailable.')
  if (input.physicalReleased) retainClosedReceipt(db, owner)
  db.update(schedulingRuntimeOwners)
    .set({
      active: !input.physicalReleased,
      phase: input.physicalReleased ? 'released' : 'cleanup_unconfirmed',
      ...(input.physicalReleased ? { settledAt: new Date().toISOString() } : {}),
    })
    .where(eq(schedulingRuntimeOwners.id, id))
    .run()
  const result = db
    .update(schedulingEvaluations)
    .set({
      outcome: input.outcome,
      ...(input.selectedCandidateId !== undefined
        ? { selectedCandidateId: input.selectedCandidateId }
        : {}),
      active: !input.physicalReleased,
      ...(usage ? { usageJson: JSON.stringify(usage) } : {}),
      ...(input.physicalReleased ? { settledAt: new Date().toISOString() } : {}),
    })
    .where(eq(schedulingEvaluations.id, id))
    .returning()
    .get()
  syncEvaluationActivity(db, id)
  return result
}

/** Synchronous invocation receipt: its winner alone may invoke the exact configured provider. */
export function dispatchEvaluation(db: PactDrizzleDatabase, id: string) {
  const saved = db
    .select()
    .from(schedulingEvaluations)
    .where(eq(schedulingEvaluations.id, id))
    .get()
  if (!saved) throw new RunOperationConflictError('The evaluation reservation is unavailable.')
  if (saved.called) return { evaluation: saved, created: false }
  if (!saved.active || saved.outcome !== 'reserved' || Date.parse(saved.deadline) <= Date.now())
    throw new RunOperationConflictError('The evaluation invocation is no longer eligible.')
  const node = schedulingHandoffSchema.parse(JSON.parse(saved.handoffJson))
  if (
    db
      .select({ action: schedulingHandoffs.action })
      .from(schedulingHandoffs)
      .where(eq(schedulingHandoffs.id, saved.handoffId))
      .get()?.action
  )
    throw new RunOperationConflictError('The handoff already advanced without this evaluation.')
  counter(db, saved.sessionId, saved.budgetSubjectId)
  db.update(schedulingBudgetCounters)
    .set({ evaluationCalls: sql`${schedulingBudgetCounters.evaluationCalls} + 1` })
    .where(eq(schedulingBudgetCounters.subjectId, saved.budgetSubjectId))
    .run()
  if (node.freshnessGuard.runId)
    appendAgentEvent(db, {
      sessionId: saved.sessionId,
      runId: node.freshnessGuard.runId,
      eventType: 'scheduling.evaluation_called',
      payload: JSON.stringify({ evaluationId: id, handoffId: saved.handoffId }),
      createdAt: new Date().toISOString(),
    })
  const evaluation = db
    .update(schedulingEvaluations)
    .set({ called: true, outcome: 'possibly_sent' })
    .where(eq(schedulingEvaluations.id, id))
    .returning()
    .get()
  syncEvaluationActivity(db, id)
  return { evaluation, created: true }
}

const budgetColumn = {
  extra_plan_turn: 'extraPlanTurns',
  extra_code_turn: 'extraCodeTurns',
  automatic_check: 'automaticChecks',
  automatic_resend: 'automaticResends',
} as const

/** Only the concrete, confirmed Relay repair card may spend the extra code allowance.
 * An ordinary manual Repair receipt has no such provenance. */
function relayRepairGrantMatches(
  decision: typeof relayDecisions.$inferSelect | undefined,
  grant: typeof collaborationActionReceipts.$inferSelect,
  generation: number,
): boolean {
  if (
    !decision ||
    decision.kind !== 'repair' ||
    decision.formatVersion !== 2 ||
    decision.id !== grant.decisionId ||
    decision.sessionId !== grant.sessionId ||
    decision.taskId !== grant.taskId ||
    decision.handoffId !== grant.handoffId ||
    decision.answerNonce !== grant.clientNonce ||
    decision.answerDigest !== grant.requestDigest ||
    decision.answerJson !== JSON.stringify({ kind: 'confirm' }) ||
    Buffer.byteLength(decision.proofJson) >= 4096
  )
    return false
  try {
    const proof = relaySchedulingDecisionProofSchema.parse(JSON.parse(decision.proofJson)),
      request = proof.card.request
    return (
      request.category === 'new_authorization' &&
      request.operation.kind === 'repair' &&
      proof.card.decisionId === decision.id &&
      proof.card.sessionId === grant.sessionId &&
      proof.card.revision === decision.revision &&
      proof.card.handoffId === grant.handoffId &&
      proof.configurationGeneration === generation &&
      proof.handoff.id === grant.handoffId &&
      proof.handoff.sessionId === grant.sessionId &&
      proof.handoff.budgetRoot.kind === 'task' &&
      proof.handoff.budgetRoot.id === grant.taskId &&
      proof.handoff.budgetSubjectId === `task:${grant.taskId}` &&
      request.operation.taskId === grant.taskId &&
      request.operation.actor === grant.actor &&
      request.operation.returnActor !== grant.actor &&
      request.operation.afterRunId === proof.handoff.freshnessGuard.runId &&
      request.operation.scopeFingerprint === proof.sourceFingerprint &&
      proof.operationFingerprint === fingerprint(request.operation)
    )
  } catch {
    return false
  }
}

/** Accounting reserves capacity only. It never grants business or native authorization. */
export function reserveBudget(
  db: PactDrizzleDatabase,
  input: {
    handoff: SchedulingHandoff
    budget: SchedulingBudget
    authorizationId?: string
  },
) {
  const budget = schedulingBudgetSchema.parse(input.budget),
    node = input.handoff
  if (!node.freshnessGuard.runId)
    throw new RunOperationConflictError(
      'A prepared Send cannot reserve a business or recovery budget.',
    )
  ensureHandoff(db, node)
  const existing = db
    .select()
    .from(schedulingBudgetReservations)
    .where(
      and(
        eq(schedulingBudgetReservations.handoffId, node.id),
        eq(schedulingBudgetReservations.budget, budget),
        isNull(schedulingBudgetReservations.replacesReservationId),
      ),
    )
    .get()
  if (existing) return { status: 'duplicate' as const, reservation: existing }
  const extra = budget === 'extra_plan_turn' || budget === 'extra_code_turn'
  if (
    extra &&
    (node.budgetRoot.kind !== 'task' ||
      !input.authorizationId ||
      !/^[a-f0-9-]{36}$/u.test(input.authorizationId))
  )
    throw new RunOperationConflictError(
      'An extra Turn needs a task and explicit authorization identity.',
    )
  if (!extra && !node.fault)
    throw new RunOperationConflictError('Automatic recovery requires its original fault identity.')
  if (extra) {
    const grant = db
      .select()
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.id, input.authorizationId!))
      .get()
    const decision = grant?.decisionId
      ? db.select().from(relayDecisions).where(eq(relayDecisions.id, grant.decisionId)).get()
      : undefined
    const relayRepair =
      budget === 'extra_code_turn' &&
      grant?.action === 'repair' &&
      relayRepairGrantMatches(decision, grant, configurationGeneration(db))
    if (
      !grant ||
      !decision ||
      grant.state !== 'available' ||
      !grant.active ||
      grant.boundRunId ||
      grant.sessionId !== node.sessionId ||
      grant.taskId !== node.budgetRoot.id ||
      grant.handoffId !== node.id ||
      grant.action !==
        (relayRepair
          ? 'repair'
          : budget === 'extra_plan_turn'
            ? 'supplement_plan'
            : 'supplement_code_response') ||
      decision.state !== 'available' ||
      !decision.active ||
      decision.handoffId !== node.id
    )
      throw new RunOperationConflictError(
        'The extra Turn has no current, concrete single-use user grant.',
      )
  }
  const root = counter(db, node.sessionId, node.budgetSubjectId)
  const field = budgetColumn[budget],
    maximum = extra
      ? 1
      : budget === 'automatic_check'
        ? node.budgetRoot.kind === 'task'
          ? 4
          : 2
        : node.budgetRoot.kind === 'task'
          ? 2
          : 1
  if (root[field] >= maximum) return { status: 'exhausted' as const }
  const faultSubjectId = node.fault ? `${node.fault.kind}:${node.fault.id}` : null
  if (faultSubjectId) {
    const duplicate = db
      .select()
      .from(schedulingBudgetReservations)
      .where(
        and(
          eq(schedulingBudgetReservations.faultSubjectId, faultSubjectId),
          eq(schedulingBudgetReservations.budget, budget),
          eq(schedulingBudgetReservations.factFingerprint, node.factFingerprint),
        ),
      )
      .get()
    if (duplicate) return { status: 'duplicate' as const, reservation: duplicate }
    if (
      counter(db, node.sessionId, faultSubjectId)[field] >= (budget === 'automatic_check' ? 2 : 1)
    )
      return { status: 'exhausted' as const }
  }
  const reservation = db
    .insert(schedulingBudgetReservations)
    .values({
      id: randomUUID(),
      sessionId: node.sessionId,
      handoffId: node.id,
      budgetSubjectId: node.budgetSubjectId,
      faultSubjectId,
      factFingerprint: node.factFingerprint,
      budget,
      authorizationId: input.authorizationId,
      state: 'reserved',
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get()
  for (const subjectId of [node.budgetSubjectId, ...(faultSubjectId ? [faultSubjectId] : [])])
    db.update(schedulingBudgetCounters)
      .set({ [field]: sql`${schedulingBudgetCounters[field]} + 1` })
      .where(eq(schedulingBudgetCounters.subjectId, subjectId))
      .run()
  appendAgentEvent(db, {
    sessionId: node.sessionId,
    runId: node.freshnessGuard.runId,
    eventType: 'scheduling.budget_reserved',
    payload: JSON.stringify({
      reservationId: reservation.id,
      handoffId: node.id,
      budgetSubjectId: node.budgetSubjectId,
      faultSubjectId,
      budget,
    }),
    createdAt: reservation.createdAt,
  })
  return { status: 'reserved' as const, reservation }
}

const unsentExtraTurnConflict = () =>
  new RunOperationConflictError('The original unsent extra Turn allowance is no longer eligible.')

/** Reacquire only the refunded original extra Turn allowance inside the caller's
 * reexecution transaction. The old grant and decision are never reopened here. */
export function reacquireUnsentExtraTurnBudget(
  db: PactDrizzleDatabase,
  originalReservationId: string,
  operationId: string,
) {
  const original = db
      .select()
      .from(schedulingBudgetReservations)
      .where(eq(schedulingBudgetReservations.id, originalReservationId))
      .get(),
    operation = db
      .select()
      .from(runReexecutionOperations)
      .where(eq(runReexecutionOperations.id, operationId))
      .get()
  if (
    !original ||
    !operation ||
    original.state !== 'not_sent' ||
    original.replacesReservationId ||
    original.faultSubjectId ||
    !original.authorizationId ||
    (original.budget !== 'extra_plan_turn' && original.budget !== 'extra_code_turn')
  )
    throw unsentExtraTurnConflict()
  const grant = db
      .select()
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.id, original.authorizationId))
      .get(),
    source = db.select().from(agentRuns).where(eq(agentRuns.id, operation.originalRunId)).get(),
    replacement = db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, operation.replacementRunId))
      .get(),
    fault = db
      .select()
      .from(schedulingRecoveryFaults)
      .where(eq(schedulingRecoveryFaults.id, operation.faultId))
      .get(),
    handoffRow = db
      .select()
      .from(schedulingHandoffs)
      .where(eq(schedulingHandoffs.id, original.handoffId))
      .get(),
    turn = db
      .select({ authorization: workflowTurns.authorizationJson })
      .from(workflowTurns)
      .where(eq(workflowTurns.runId, operation.originalRunId))
      .get()
  const repair = original.budget === 'extra_code_turn' && grant?.action === 'repair',
    action = repair
      ? 'repair'
      : original.budget === 'extra_plan_turn'
        ? 'supplement_plan'
        : 'supplement_code_response',
    stage = repair ? 'repair' : action === 'supplement_plan' ? 'plan' : 'respond'
  if (
    !grant ||
    !source ||
    !replacement ||
    !fault ||
    !handoffRow ||
    !turn ||
    grant.id !== original.authorizationId ||
    grant.handoffId !== original.handoffId ||
    grant.action !== action ||
    grant.sessionId !== original.sessionId ||
    original.budgetSubjectId !== `task:${grant.taskId}` ||
    source.sessionId !== original.sessionId ||
    source.collaborationTaskId !== grant.taskId ||
    source.collaborationStage !== stage ||
    source.agentId !== grant.actor ||
    replacement.reexecutedFromRunId !== source.id ||
    replacement.reexecutionOperationId !== operation.id ||
    replacement.sessionId !== source.sessionId ||
    replacement.userMessageId !== source.userMessageId ||
    replacement.agentId !== source.agentId ||
    replacement.collaborationTaskId !== source.collaborationTaskId ||
    replacement.collaborationStage !== source.collaborationStage ||
    replacement.settingsRevision !== source.settingsRevision ||
    fault.faultKind !== 'run' ||
    fault.faultId !== source.id ||
    fault.runId !== source.id ||
    fault.sessionId !== source.sessionId ||
    fault.agentId !== source.agentId ||
    handoffRow.runId !== source.id ||
    handoffRow.sessionId !== source.sessionId ||
    handoffRow.budgetSubjectId !== original.budgetSubjectId
  )
    throw unsentExtraTurnConflict()
  if (repair) {
    const decision = grant.decisionId
      ? db.select().from(relayDecisions).where(eq(relayDecisions.id, grant.decisionId)).get()
      : undefined
    if (!relayRepairGrantMatches(decision, grant, fault.configurationGeneration))
      throw unsentExtraTurnConflict()
  }
  if (
    [turn.authorization, grant.basisJson, operation.handoffJson].some(
      (value) => Buffer.byteLength(value) >= 4096,
    )
  )
    throw unsentExtraTurnConflict()
  let authority, basis, recovery
  try {
    authority = collaborationTurnAuthorizationSchema.parse(JSON.parse(turn.authorization))
    basis = collaborationActionBasisSchema.parse(JSON.parse(grant.basisJson))
    recovery = schedulingHandoffSchema.parse(JSON.parse(operation.handoffJson))
  } catch {
    throw unsentExtraTurnConflict()
  }
  if (
    authority.runId !== source.id ||
    authority.taskId !== grant.taskId ||
    authority.actor !== grant.actor ||
    authority.stage !== stage ||
    authority.userAuthority?.receiptId !== grant.id ||
    authority.userAuthority.rootReceiptId !== grant.rootReceiptId ||
    authority.userAuthority.purpose !== (repair ? 'action' : action) ||
    (repair
      ? authority.userAuthority.returnStage !== undefined ||
        authority.userAuthority.returnActor !== undefined
      : authority.userAuthority.returnStage !==
          (action === 'supplement_plan' ? 'plan_review' : 'code_review') ||
        !authority.userAuthority.returnActor ||
        authority.userAuthority.returnActor === grant.actor) ||
    basis.taskId !== grant.taskId ||
    basis.actor !== grant.actor ||
    basis.stage !== stage ||
    basis.handoff.id !== original.handoffId ||
    basis.handoff.budgetSubjectId !== original.budgetSubjectId ||
    recovery.slot !== 'confirmed_resend' ||
    recovery.fault?.kind !== 'run' ||
    recovery.fault.id !== source.id ||
    recovery.sessionId !== source.sessionId ||
    recovery.budgetRoot.kind !== 'task' ||
    recovery.budgetRoot.id !== grant.taskId ||
    recovery.budgetSubjectId !== original.budgetSubjectId ||
    recovery.freshnessGuard.runId !== source.id
  )
    throw unsentExtraTurnConflict()
  const linked = db
    .select()
    .from(schedulingBudgetReservations)
    .where(eq(schedulingBudgetReservations.replacesReservationId, original.id))
    .get()
  // A Run has one immutable run fault and that fault has one replacement operation.
  // Those unique source identities bind duplicate readback even after the receipt is rebound.
  if (linked) {
    if (
      linked.sessionId !== original.sessionId ||
      linked.handoffId !== original.handoffId ||
      linked.authorizationId !== grant.id ||
      linked.budgetSubjectId !== original.budgetSubjectId ||
      linked.budget !== original.budget ||
      linked.faultSubjectId ||
      (grant.budgetReservationId !== original.id && grant.budgetReservationId !== linked.id) ||
      (grant.boundRunId !== source.id && grant.boundRunId !== replacement.id)
    )
      throw unsentExtraTurnConflict()
    return linked
  }
  const settings = readSettings(db),
    captured = db
      .select()
      .from(runExecutionInputs)
      .where(eq(runExecutionInputs.runId, source.id))
      .get(),
    resend = db
      .select()
      .from(schedulingBudgetReservations)
      .where(eq(schedulingBudgetReservations.id, operation.budgetReservationId))
      .get()
  if (
    !settings.enabled ||
    !settings.selection ||
    !fault.active ||
    fault.configurationGeneration !== configurationGeneration(db) ||
    !captured?.effectiveJson ||
    !captured.proofJson ||
    captured.utilityEpoch !== fault.utilityEpoch ||
    captured.configurationGeneration !== fault.configurationGeneration ||
    source.automaticRecoveryRevoked ||
    source.reexecutedFromRunId ||
    source.forkSourceRunId ||
    source.controlDisposition === 'abandoned' ||
    !['failed', 'interrupted'].includes(source.status) ||
    source.nativeTurnId ||
    source.nativeOutcome ||
    ['accepted', 'ended'].includes(source.dispatchPhase) ||
    !['not_dispatched', 'settled'].includes(source.nativeEffectsState) ||
    operation.result !== 'reserved' ||
    replacement.status !== 'starting' ||
    replacement.nativeTurnId ||
    replacement.nativeOutcome ||
    replacement.dispatchPhase !== 'not_sent' ||
    replacement.nativeEffectsState !== 'not_dispatched' ||
    grant.state !== 'not_sent' ||
    grant.active ||
    grant.boundRunId !== source.id ||
    grant.budgetReservationId !== original.id ||
    grant.reviewState !== (repair ? null : 'not_required') ||
    grant.reviewRunId ||
    !resend ||
    resend.budget !== 'automatic_resend' ||
    resend.state !== 'reserved' ||
    resend.handoffId !== recovery.id ||
    resend.sessionId !== source.sessionId ||
    resend.budgetSubjectId !== original.budgetSubjectId ||
    resend.faultSubjectId !== `run:${source.id}`
  )
    throw unsentExtraTurnConflict()
  if (
    [captured.documentJson, captured.effectiveJson, captured.proofJson].some(
      (value) => Buffer.byteLength(value) >= 4096,
    )
  )
    throw unsentExtraTurnConflict()
  let input, effective, proof
  try {
    input = frozenExecutionInputSchema.parse(JSON.parse(captured.documentJson))
    effective = runEffectiveExecutionSettingsSchema.parse(JSON.parse(captured.effectiveJson))
    proof = confirmedUnsentProofSchema.parse(JSON.parse(captured.proofJson))
  } catch {
    throw unsentExtraTurnConflict()
  }
  if (
    input.runId !== source.id ||
    proof.runId !== source.id ||
    proof.bindingGeneration !== source.bindingGeneration ||
    proof.nativeGeneration !== captured.nativeGeneration ||
    proof.executorId !== captured.executorId ||
    proof.nativeSessionId !== captured.nativeSessionId ||
    proof.inputSha256 !== input.inputSha256 ||
    proof.effectiveSettingsSha256 !== fingerprint(effective) ||
    effective.provider !== grant.actor ||
    (grant.actor === 'codex' && proof.boundary.kind === 'claude_root_not_yielded') ||
    (grant.actor === 'claude' && proof.boundary.kind === 'codex_root_frame_not_written')
  )
    throw unsentExtraTurnConflict()
  const root = db
      .select()
      .from(schedulingBudgetCounters)
      .where(eq(schedulingBudgetCounters.subjectId, original.budgetSubjectId))
      .get(),
    field = budgetColumn[original.budget]
  if (!root || root.sessionId !== source.sessionId || root[field] >= 1)
    throw unsentExtraTurnConflict()
  const reservation = db
    .insert(schedulingBudgetReservations)
    .values({
      id: randomUUID(),
      sessionId: original.sessionId,
      handoffId: original.handoffId,
      budgetSubjectId: original.budgetSubjectId,
      faultSubjectId: null,
      factFingerprint: original.factFingerprint,
      budget: original.budget,
      authorizationId: original.authorizationId,
      replacesReservationId: original.id,
      state: 'reserved',
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get()
  db.update(schedulingBudgetCounters)
    .set({ [field]: sql`${schedulingBudgetCounters[field]} + 1` })
    .where(eq(schedulingBudgetCounters.subjectId, root.subjectId))
    .run()
  appendAgentEvent(db, {
    sessionId: source.sessionId,
    runId: replacement.id,
    eventType: 'scheduling.extra_turn_budget_reacquired',
    payload: JSON.stringify({
      originalReservationId: original.id,
      reservationId: reservation.id,
      operationId: operation.id,
      handoffId: original.handoffId,
      authorizationId: grant.id,
      budget: original.budget,
    }),
    createdAt: reservation.createdAt,
  })
  return reservation
}

export function settleBudget(
  db: PactDrizzleDatabase,
  id: string,
  state: 'possibly_sent' | 'settled' | 'not_sent',
) {
  const saved = db
    .select()
    .from(schedulingBudgetReservations)
    .where(eq(schedulingBudgetReservations.id, id))
    .get()
  if (!saved) throw new RunOperationConflictError('The budget reservation is unavailable.')
  if (saved.state === state) return saved
  if (
    saved.state === 'settled' ||
    saved.state === 'not_sent' ||
    (state === 'not_sent' && saved.state === 'possibly_sent')
  )
    throw new RunOperationConflictError(
      'Possibly sent or settled budget cannot be refunded or reused.',
    )
  if (state === 'not_sent') {
    const field = budgetColumn[saved.budget]
    for (const subjectId of [
      saved.budgetSubjectId,
      ...(saved.faultSubjectId ? [saved.faultSubjectId] : []),
    ])
      db.update(schedulingBudgetCounters)
        .set({ [field]: sql`${schedulingBudgetCounters[field]} - 1` })
        .where(
          and(
            eq(schedulingBudgetCounters.subjectId, subjectId),
            sql`${schedulingBudgetCounters[field]} > 0`,
          ),
        )
        .run()
  }
  return db
    .update(schedulingBudgetReservations)
    .set({ state })
    .where(eq(schedulingBudgetReservations.id, id))
    .returning()
    .get()
}
