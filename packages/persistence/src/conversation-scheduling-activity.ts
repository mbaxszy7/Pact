import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'

import {
  SCHEDULING_ACTIVITY_PAGE_ITEMS,
  confirmedUnsentProofSchema,
  frozenExecutionInputSchema,
  nativeInitializationWitnessSchema,
  runEffectiveExecutionSettingsSchema,
  relaySchedulingDecisionProofSchema,
  relayNativeRecoveryProofSchema,
  relayDecisionReceiptSchema,
  preparedInformationControlSchema,
  schedulingActivityActionResultSchema,
  schedulingActivityActionSchema,
  schedulingActivityPageSchema,
  schedulingActivityReadSchema,
  schedulingActivitySuggestionStateSchema,
  type SchedulingActivityAction,
  type SchedulingActivityActionResult,
  type SchedulingActivityRead,
  type SchedulingActivityRow,
  type SchedulingActivitySuggestionState,
  type RelayNativeRecoveryProof,
} from '@pact/contracts'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { RunOperationConflictError } from './conversation-errors.js'
import {
  agentRuns,
  conversationInputBatches,
  nativeRebuildOperations,
  projects,
  relayDecisions,
  runExecutionInputs,
  runReexecutionOperations,
  schedulingActivity,
  schedulingEvaluations,
  schedulingHandoffs,
  schedulingRecoveryFaults,
  sessions,
} from './schema/index.js'

type Fault = typeof schedulingRecoveryFaults.$inferSelect
type Change = {
  suggestionState?: SchedulingActivitySuggestionState
  action?: SchedulingActivityAction | null
  actionResult?: SchedulingActivityActionResult | null
}

const reasonFor = (slot: string): SchedulingActivityRow['reason'] => {
  switch (slot) {
    case 'workflow_next':
      return 'workflow'
    case 'input_dispatch':
      return 'input'
    case 'native_check':
      return 'native_check'
    case 'queue_check':
      return 'queue_check'
    case 'rebuild_check':
      return 'rebuild_check'
    default:
      return 'confirmed_resend'
  }
}
function actionFor(value: string | null): SchedulingActivityAction | null {
  const known: Record<string, SchedulingActivityAction> = {
    'workflow:plan': 'plan_revision',
    'workflow:plan_review': 'plan_review',
    'workflow:implement': 'implementation',
    'workflow:code_review': 'code_review',
    'workflow:respond': 'respond',
    'workflow:repair': 'repair',
    'workflow:reply': 'reply',
    'input:route_codex': 'route_codex',
    'input:route_claude': 'route_claude',
  }
  if (!value) return null
  return known[value] ?? schedulingActivityActionSchema.safeParse(value).data ?? null
}
function suggestionFor(candidate: string | null): string | null {
  const labels: Record<string, string> = {
    continue_plan_review: 'Continue the fixed Plan review.',
    continue_plan_revision: 'Continue the original author’s Plan revision.',
    continue_code_review: 'Continue the fixed code review.',
    respond_to_code_review: 'Use the authorized read-only response.',
    repair_code: 'Use the separately authorized repair.',
    propose_repair: 'Request one separately authorized repair.',
    supplement_plan: 'Add one read-only Plan clarification.',
    propose_supplement_plan: 'Request one read-only Plan clarification.',
    supplement_code_response: 'Add one read-only code-review response.',
    propose_supplement_code_response: 'Request one read-only code-review response.',
    route_codex: 'Route the input to Codex.',
    route_claude: 'Route the input to Claude Code.',
    clarify_prepared_input: 'Ask for one explicitly user-reserved detail.',
  }
  return candidate ? (labels[candidate] ?? null) : null
}
function relatedFault(db: PactDrizzleDatabase, subject: string | null) {
  if (!subject) return undefined
  const kind = subject.startsWith('run:')
    ? 'run'
    : subject.startsWith('queue:')
      ? 'queue'
      : subject.startsWith('rebuild:')
        ? 'rebuild'
        : undefined
  return kind
    ? db
        .select()
        .from(schedulingRecoveryFaults)
        .where(
          and(
            eq(schedulingRecoveryFaults.faultKind, kind),
            eq(schedulingRecoveryFaults.faultId, subject.slice(kind.length + 1)),
          ),
        )
        .get()
    : undefined
}
const unresolvedAction = (state: string | null) =>
  state === 'reserved' || state === 'dispatched' || state === 'unconfirmed'

/** Passive metadata only, matching Repository.hasCompleteResponse's first complete visible
 * answer plus its verified Plan-only alternative. No body or tool output is returned. */
const originalUnconfirmed = sql<boolean>`NOT coalesce(
  ${agentRuns.dispatchPhase} = 'ended' AND ${agentRuns.nativeEffectsState} = 'settled' AND
  (${agentRuns.nativeOutcome} IN ('failed','interrupted') OR
    (${agentRuns.nativeOutcome}='completed' AND
      (SELECT CASE WHEN EXISTS(
        SELECT 1 FROM conversation_messages n INDEXED BY conversation_messages_native_complete_idx
        WHERE n.run_id=${agentRuns.id} AND n.id=m.id AND n.role='assistant' AND n.is_visible=1
          AND n.state='complete' AND length(n.content)>0
      ) THEN 1 ELSE EXISTS(
        SELECT 1 FROM workflow_turns w JOIN conversation_body_inputs b ON b.id=w.plan_body_id
        WHERE w.run_id=${agentRuns.id} AND w.plan_native_id IS NOT NULL
          AND ${agentRuns.dispatchPhase}='ended' AND ${agentRuns.nativeOutcome}='completed'
          AND b.sealed=1 AND b.chars>0
      ) END FROM conversation_messages m
      WHERE m.run_id=${agentRuns.id} AND m.role='assistant' AND m.is_visible=1 AND m.state='complete' LIMIT 1)=1)), 0)`.mapWith(
  Boolean,
)

function faultUnconfirmed(db: PactDrizzleDatabase, fault: Pick<Fault, 'id' | 'runId'>): boolean {
  const replacement = db
    .select({ runId: runReexecutionOperations.replacementRunId })
    .from(runReexecutionOperations)
    .where(eq(runReexecutionOperations.faultId, fault.id))
    .get()
  const runId = replacement?.runId ?? fault.runId
  const row = db
    .select({
      value: originalUnconfirmed,
      phase: agentRuns.dispatchPhase,
      effects: agentRuns.nativeEffectsState,
      nativeTurnId: agentRuns.nativeTurnId,
      outcome: agentRuns.nativeOutcome,
      generation: agentRuns.bindingGeneration,
      input: runExecutionInputs.documentJson,
      effective: runExecutionInputs.effectiveJson,
      proof: runExecutionInputs.proofJson,
      nativeGeneration: runExecutionInputs.nativeGeneration,
      executorId: runExecutionInputs.executorId,
      nativeSessionId: runExecutionInputs.nativeSessionId,
    })
    .from(agentRuns)
    .leftJoin(runExecutionInputs, eq(runExecutionInputs.runId, agentRuns.id))
    .where(eq(agentRuns.id, runId))
    .get()
  if (!row || !row.value) return row?.value ?? true
  if (
    row.nativeTurnId ||
    row.outcome ||
    row.phase === 'accepted' ||
    row.phase === 'ended' ||
    !['settled', 'not_dispatched'].includes(row.effects) ||
    !row.input ||
    !row.effective ||
    !row.proof
  )
    return true
  if ([row.input, row.effective, row.proof].some((value) => Buffer.byteLength(value) >= 4096))
    return true
  try {
    const input = frozenExecutionInputSchema.parse(JSON.parse(row.input)),
      effective = runEffectiveExecutionSettingsSchema.parse(JSON.parse(row.effective)),
      proof = confirmedUnsentProofSchema.parse(JSON.parse(row.proof))
    return !(
      input.runId === runId &&
      proof.runId === runId &&
      proof.bindingGeneration === row.generation &&
      proof.nativeGeneration === row.nativeGeneration &&
      proof.executorId === row.executorId &&
      proof.nativeSessionId === row.nativeSessionId &&
      proof.inputSha256 === input.inputSha256 &&
      proof.effectiveSettingsSha256 ===
        createHash('sha256').update(JSON.stringify(effective)).digest('hex')
    )
  } catch {
    return true
  }
}
function put(db: PactDrizzleDatabase, row: typeof schedulingActivity.$inferInsert): void {
  if (Buffer.byteLength(JSON.stringify(row)) >= 4096)
    throw new RunOperationConflictError('The complete Relay activity metadata exceeds its budget.')
  db.insert(schedulingActivity)
    .values(row)
    .onConflictDoUpdate({ target: schedulingActivity.id, set: row })
    .run()
}

/** Derived facts only; the caller retains its existing admission/transaction owner. */
export function syncEvaluationActivity(
  db: PactDrizzleDatabase,
  evaluationId: string,
  change: Change = {},
): void {
  const evaluation = db
    .select()
    .from(schedulingEvaluations)
    .where(eq(schedulingEvaluations.id, evaluationId))
    .get()
  if (!evaluation) return
  const handoff = db
    .select()
    .from(schedulingHandoffs)
    .where(eq(schedulingHandoffs.id, evaluation.handoffId))
    .get()
  if (!handoff) return
  const fault = relatedFault(db, handoff.faultSubjectId),
    id = fault?.id ?? evaluation.id,
    prior = db.select().from(schedulingActivity).where(eq(schedulingActivity.id, id)).get()
  if (prior?.action === 'rebuild_native_context' && prior.decisionId) {
    recordRelayDecisionActivity(db, prior.decisionId)
    return
  }
  const state =
    change.suggestionState ??
    prior?.suggestionState ??
    (evaluation.called && evaluation.selectedCandidateId ? 'suggested' : 'none')
  const suggestionState =
    state === 'none' && evaluation.called && evaluation.selectedCandidateId ? 'suggested' : state
  const action =
      change.action === undefined ? actionFor(prior?.action ?? handoff.action) : change.action,
    actionResult =
      change.actionResult === undefined
        ? (prior?.actionResult ?? (handoff.runId ? 'reserved' : null))
        : change.actionResult
  put(db, {
    id,
    sessionId: evaluation.sessionId,
    evaluationId: evaluation.called || !prior?.evaluationId ? evaluation.id : prior.evaluationId,
    faultId: fault?.id ?? null,
    handoffId: evaluation.handoffId,
    reason: fault
      ? reasonFor(
          fault.latestAction === 'resend'
            ? 'confirmed_resend'
            : `${fault.faultKind === 'run' ? 'native' : fault.faultKind}_check`,
        )
      : reasonFor(handoff.slot),
    suggestionState,
    action,
    actionResult,
    unresolved:
      evaluation.active ||
      suggestionState === 'awaiting_user' ||
      unresolvedAction(actionResult) ||
      Boolean(fault && (fault.physicalUnconfirmed || faultUnconfirmed(db, fault))),
    activityAt: prior ? new Date().toISOString() : evaluation.createdAt,
  })
}

export function recordGuidanceAdoptionActivity(
  db: PactDrizzleDatabase,
  evaluationId: string,
): void {
  syncEvaluationActivity(db, evaluationId, { suggestionState: 'adopted' })
}

function recordNativeDecisionActivity(
  db: PactDrizzleDatabase,
  decision: typeof relayDecisions.$inferSelect,
  proof: RelayNativeRecoveryProof,
): void {
  if (proof.card.request.category !== 'arrangement_change') return
  const request = proof.card.request.operation
  const originFaultId = proof.originFaultId
  const fault = originFaultId
    ? db
        .select()
        .from(schedulingRecoveryFaults)
        .where(
          and(
            eq(schedulingRecoveryFaults.id, originFaultId),
            eq(schedulingRecoveryFaults.sessionId, decision.sessionId),
            eq(schedulingRecoveryFaults.agentId, request.agentId),
          ),
        )
        .get()
    : undefined
  const existing = db
      .select()
      .from(schedulingActivity)
      .where(eq(schedulingActivity.decisionId, decision.id))
      .get(),
    id = existing?.id ?? fault?.id ?? decision.id,
    previous =
      existing ?? db.select().from(schedulingActivity).where(eq(schedulingActivity.id, id)).get()
  if (previous?.decisionId && previous.decisionId !== decision.id && !decision.active) return
  let rebuildId: string | null = null
  try {
    const receipt = decision.resultJson
      ? relayDecisionReceiptSchema.safeParse(JSON.parse(decision.resultJson))
      : undefined
    if (
      receipt?.success &&
      receipt.data.disposition === 'confirmed' &&
      receipt.data.decisionId === decision.id &&
      receipt.data.sessionId === decision.sessionId &&
      receipt.data.clientOperationId === decision.answerNonce
    )
      rebuildId = receipt.data.rebuildId
  } catch {
    /* Invalid historical readback never identifies a native operation. */
  }
  const operation = rebuildId
    ? db
        .select({
          id: nativeRebuildOperations.id,
          sessionId: nativeRebuildOperations.sessionId,
          agentId: nativeRebuildOperations.agentId,
          generation: nativeRebuildOperations.oldGeneration,
          oldNativeSessionId: nativeRebuildOperations.oldNativeSessionId,
          nativeSessionId: nativeRebuildOperations.provisionalNativeSessionId,
          stage: nativeRebuildOperations.stage,
          work: nativeRebuildOperations.nativeWorkState,
          witness: nativeRebuildOperations.initializationWitnessJson,
        })
        .from(nativeRebuildOperations)
        .where(eq(nativeRebuildOperations.id, rebuildId))
        .get()
    : undefined
  const exact =
    operation &&
    operation.sessionId === decision.sessionId &&
    operation.agentId === request.agentId &&
    operation.oldNativeSessionId === request.expectedNativeSessionId &&
    operation.generation === request.expectedGeneration
  const initialized =
    exact &&
    (operation.agentId === 'claude' ||
      (() => {
        if (!operation.witness || Buffer.byteLength(operation.witness) >= 4096) return false
        try {
          const witness = nativeInitializationWitnessSchema.safeParse(JSON.parse(operation.witness))
          return witness.success && witness.data.nativeSessionId === operation.nativeSessionId
        } catch {
          return false
        }
      })())
  const awaiting = decision.state === 'awaiting_answer',
    accepted = decision.state === 'bound' || decision.state === 'available'
  let result: SchedulingActivityActionResult | null = awaiting
    ? null
    : decision.state === 'cancelled'
      ? 'cancelled'
      : accepted
        ? 'unconfirmed'
        : 'not_sent'
  if (accepted && exact)
    result =
      operation.stage === 'completed' && operation.work === 'settled' && initialized
        ? 'completed'
        : operation.stage === 'failed'
          ? 'failed'
          : operation.stage === 'superseded'
            ? 'superseded'
            : operation.stage === 'unconfirmed' || operation.stage === 'completed'
              ? 'unconfirmed'
              : operation.stage === 'preparing'
                ? 'reserved'
                : 'dispatched'
  const evaluationActive = previous?.evaluationId
    ? db
        .select({ active: schedulingEvaluations.active })
        .from(schedulingEvaluations)
        .where(eq(schedulingEvaluations.id, previous.evaluationId))
        .get()?.active
    : false
  const physical = Boolean(
    evaluationActive ||
    fault?.physicalUnconfirmed ||
    (exact && (operation.work === 'pending' || operation.work === 'unknown')),
  )
  const original =
    !fault && request.expectedRunId
      ? db
          .select({ unconfirmed: originalUnconfirmed, effects: agentRuns.nativeEffectsState })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, request.expectedRunId),
              eq(agentRuns.sessionId, decision.sessionId),
              eq(agentRuns.agentId, request.agentId),
            ),
          )
          .get()
      : undefined
  put(db, {
    id,
    sessionId: decision.sessionId,
    evaluationId: previous?.evaluationId ?? null,
    faultId: fault?.id ?? null,
    handoffId: previous?.handoffId ?? null,
    decisionId: decision.id,
    rebuildId: exact ? operation.id : null,
    reason: 'native_rebuild',
    suggestionState: awaiting ? 'awaiting_user' : accepted ? 'adopted' : 'discarded',
    action: 'rebuild_native_context',
    actionResult: result,
    unresolved:
      awaiting ||
      unresolvedAction(result) ||
      physical ||
      original?.unconfirmed ||
      original?.effects === 'pending' ||
      original?.effects === 'unknown' ||
      Boolean(fault && faultUnconfirmed(db, fault)),
    activityAt:
      previous && previous.activityAt > new Date().toISOString()
        ? previous.activityAt
        : new Date().toISOString(),
  })
}

export function recordRelayDecisionActivity(db: PactDrizzleDatabase, decisionId: string): void {
  const decision = db.select().from(relayDecisions).where(eq(relayDecisions.id, decisionId)).get()
  if (!decision || decision.formatVersion !== 2) return
  const value: unknown = (() => {
    try {
      return JSON.parse(decision.proofJson)
    } catch {
      return undefined
    }
  })()
  const native = relayNativeRecoveryProofSchema.safeParse(value)
  if (native.success) {
    recordNativeDecisionActivity(db, decision, native.data)
    return
  }
  const proof = relaySchedulingDecisionProofSchema.safeParse(value)
  if (!proof?.success) {
    if (decision.handoffId && ['invalid', 'cancelled', 'closed'].includes(decision.state))
      db.update(schedulingActivity)
        .set({
          suggestionState: 'discarded',
          actionResult: 'not_sent',
          activityAt: new Date().toISOString(),
          unresolved: sql<boolean>`EXISTS(SELECT 1 FROM scheduling_evaluations e WHERE e.id=${schedulingActivity.evaluationId} AND e.active=1)`,
        })
        .where(
          and(
            eq(schedulingActivity.handoffId, decision.handoffId),
            eq(schedulingActivity.suggestionState, 'awaiting_user'),
            sql`${schedulingActivity.faultId} IS NULL`,
            sql`NOT EXISTS(SELECT 1 FROM scheduling_handoffs h WHERE h.id=${schedulingActivity.handoffId} AND h.run_id IS NOT NULL)`,
          ),
        )
        .run()
    return
  }
  const previous = db
    .select({ decisionId: schedulingActivity.decisionId, action: schedulingActivity.action })
    .from(schedulingActivity)
    .where(eq(schedulingActivity.evaluationId, proof.data.evaluationId))
    .get()
  if (
    previous?.action === 'rebuild_native_context' &&
    previous.decisionId !== decision.id &&
    !decision.active
  )
    return
  const action =
    proof.data.card.request.category === 'new_authorization'
      ? proof.data.card.request.operation.kind
      : proof.data.card.request.category === 'necessary_information'
        ? 'clarify_prepared_input'
        : null
  const awaiting = decision.state === 'awaiting_answer',
    accepted = decision.state === 'available' || decision.state === 'bound'
  syncEvaluationActivity(db, proof.data.evaluationId, {
    suggestionState: awaiting ? 'awaiting_user' : accepted ? 'adopted' : 'discarded',
    action,
    actionResult: awaiting
      ? null
      : accepted
        ? 'reserved'
        : decision.state === 'cancelled'
          ? 'cancelled'
          : 'not_sent',
  })
  db.update(schedulingActivity)
    .set({ decisionId })
    .where(eq(schedulingActivity.evaluationId, proof.data.evaluationId))
    .run()
}

export function recordNativeRebuildActivity(db: PactDrizzleDatabase, rebuildId: string): void {
  const row = db
    .select({ decisionId: schedulingActivity.decisionId })
    .from(schedulingActivity)
    .where(eq(schedulingActivity.rebuildId, rebuildId))
    .get()
  if (row?.decisionId) recordRelayDecisionActivity(db, row.decisionId)
}

/** Startup reprojects only live native-operation obligations, retaining the source owner's
 * transaction. Advancing timestamps cannot re-enter the descending keyset traversal. */
export function refreshNativeRebuildActivityForRecovery(
  db: PactDrizzleDatabase,
  sessionIds: string[],
): void {
  if (sessionIds.length > 25)
    throw new RunOperationConflictError('The native recovery activity page exceeds its budget.')
  if (!sessionIds.length) return
  let cursor: { createdAt: string; id: string } | undefined
  for (;;) {
    const page = db
      .select({
        id: schedulingActivity.id,
        createdAt: schedulingActivity.activityAt,
        rebuildId: schedulingActivity.rebuildId,
      })
      .from(schedulingActivity)
      .where(
        and(
          eq(schedulingActivity.unresolved, true),
          inArray(schedulingActivity.sessionId, sessionIds),
          isNotNull(schedulingActivity.rebuildId),
          cursor
            ? or(
                lt(schedulingActivity.activityAt, cursor.createdAt),
                and(
                  eq(schedulingActivity.activityAt, cursor.createdAt),
                  lt(schedulingActivity.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schedulingActivity.activityAt), desc(schedulingActivity.id))
      .limit(25)
      .all()
    if (!page.length) break
    for (const row of page) if (row.rebuildId) recordNativeRebuildActivity(db, row.rebuildId)
    cursor = page.at(-1)!
  }
}

/** A default handoff and an adopted suggestion share the same actual dispatch receipt. */
export function recordHandoffActivity(db: PactDrizzleDatabase, handoffId: string): void {
  const evaluation = db
    .select({ id: schedulingEvaluations.id })
    .from(schedulingEvaluations)
    .where(eq(schedulingEvaluations.handoffId, handoffId))
    .orderBy(desc(schedulingEvaluations.createdAt), desc(schedulingEvaluations.id))
    .limit(1)
    .get()
  if (!evaluation) return
  const previous = db
    .select()
    .from(schedulingActivity)
    .where(eq(schedulingActivity.evaluationId, evaluation.id))
    .get()
  const handoff = db
    .select({ action: schedulingHandoffs.action })
    .from(schedulingHandoffs)
    .where(eq(schedulingHandoffs.id, handoffId))
    .get()
  syncEvaluationActivity(db, evaluation.id, {
    suggestionState: previous?.suggestionState === 'adopted' ? 'adopted' : 'fallback',
    action:
      previous?.suggestionState === 'adopted'
        ? actionFor(previous.action)
        : actionFor(handoff?.action ?? null),
    actionResult: 'reserved',
  })
}

export function syncRecoveryActivity(
  db: PactDrizzleDatabase,
  faultId: string,
  handoffId?: string,
): void {
  const fault = db
    .select()
    .from(schedulingRecoveryFaults)
    .where(eq(schedulingRecoveryFaults.id, faultId))
    .get()
  if (!fault) return
  const prior = db
    .select()
    .from(schedulingActivity)
    .where(eq(schedulingActivity.id, fault.id))
    .get()
  if (prior?.action === 'rebuild_native_context' && prior.decisionId) {
    recordRelayDecisionActivity(db, prior.decisionId)
    return
  }
  const action =
    fault.latestAction === 'resend'
      ? 'confirmed_resend'
      : fault.faultKind === 'queue'
        ? 'queue_check'
        : fault.faultKind === 'rebuild'
          ? 'rebuild_check'
          : 'native_check'
  const result =
    fault.latestAction === 'resend' &&
    (prior?.actionResult === 'completed' || prior?.actionResult === 'failed')
      ? prior.actionResult
      : fault.result === 'possibly_sent'
        ? 'unconfirmed'
        : fault.result
  put(db, {
    id: fault.id,
    sessionId: fault.sessionId,
    faultId: fault.id,
    evaluationId: prior?.evaluationId ?? null,
    handoffId: handoffId ?? prior?.handoffId ?? null,
    reason: action,
    suggestionState: prior?.suggestionState ?? 'none',
    action,
    actionResult: result,
    unresolved:
      fault.physicalUnconfirmed || unresolvedAction(result) || faultUnconfirmed(db, fault),
    activityAt: prior && prior.activityAt > fault.activityAt ? prior.activityAt : fault.activityAt,
  })
}

/** Business completion is supplied by the existing response owner, never inferred from
 * a model's recommendation or a transport ending without its canonical output. */
export function recordBusinessActivity(
  db: PactDrizzleDatabase,
  runId: string,
  completeResponse: boolean,
): void {
  const run = db
    .select({
      phase: agentRuns.dispatchPhase,
      effects: agentRuns.nativeEffectsState,
      outcome: agentRuns.nativeOutcome,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .get()
  if (!run) return
  const result: SchedulingActivityActionResult =
    run.phase === 'ended' && run.effects === 'settled'
      ? run.outcome === 'completed'
        ? completeResponse
          ? 'completed'
          : 'unconfirmed'
        : run.outcome === 'failed' || run.outcome === 'interrupted'
          ? 'failed'
          : 'unconfirmed'
      : run.phase === 'accepted' || run.phase === 'possibly_sent'
        ? 'dispatched'
        : run.phase === 'rejected'
          ? 'not_sent'
          : 'reserved'
  const handoff = db
    .select({ id: schedulingHandoffs.id })
    .from(schedulingHandoffs)
    .where(eq(schedulingHandoffs.runId, runId))
    .get()
  if (handoff)
    db.update(schedulingActivity)
      .set({
        actionResult: result,
        unresolved: sql<boolean>`${unresolvedAction(result) ? 1 : 0} OR EXISTS(SELECT 1 FROM scheduling_evaluations e WHERE e.id=${schedulingActivity.evaluationId} AND e.active=1)`,
        activityAt: new Date().toISOString(),
      })
      .where(eq(schedulingActivity.handoffId, handoff.id))
      .run()
  const batch = db
    .select({ information: conversationInputBatches.dispatchInformationJson })
    .from(conversationInputBatches)
    .where(eq(conversationInputBatches.runId, runId))
    .get()
  if (batch?.information) {
    const control = preparedInformationControlSchema.parse(JSON.parse(batch.information)),
      decision = db
        .select()
        .from(relayDecisions)
        .where(eq(relayDecisions.id, control.decisionId))
        .get()
    if (
      decision?.kind === 'scheduling_information' &&
      decision.formatVersion === 2 &&
      decision.afterRunId === runId
    ) {
      const proof = relaySchedulingDecisionProofSchema.parse(JSON.parse(decision.proofJson)),
        fallback = control.continuation?.kind === 'default'
      syncEvaluationActivity(db, proof.evaluationId, {
        actionResult: result,
        suggestionState: fallback ? 'fallback' : 'adopted',
        action:
          fallback && proof.card.request.category === 'necessary_information'
            ? proof.card.request.consumer.defaultAgentId === 'codex'
              ? 'route_codex'
              : 'route_claude'
            : 'clarify_prepared_input',
      })
    }
  }
  let cursor: string | undefined
  for (;;) {
    const faults = db
      .select({ id: schedulingRecoveryFaults.id })
      .from(schedulingRecoveryFaults)
      .where(
        and(
          eq(schedulingRecoveryFaults.runId, runId),
          cursor ? gt(schedulingRecoveryFaults.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(schedulingRecoveryFaults.id))
      .limit(SCHEDULING_ACTIVITY_PAGE_ITEMS)
      .all()
    for (const fault of faults) syncRecoveryActivity(db, fault.id)
    if (faults.length < SCHEDULING_ACTIVITY_PAGE_ITEMS) break
    cursor = faults.at(-1)!.id
  }
  const replacement = db
    .select({ faultId: runReexecutionOperations.faultId })
    .from(runReexecutionOperations)
    .where(eq(runReexecutionOperations.replacementRunId, runId))
    .get()
  if (replacement) syncRecoveryActivity(db, replacement.faultId)
}

/** Two indexed 26-item ranges; joined source rows are bounded primary-key metadata.
 * The display window never deletes original facts or projects diagnostic JSONL. */
export function readActivity(db: PactDrizzleDatabase, raw: SchedulingActivityRead) {
  const { cursor, direction } = schedulingActivityReadSchema.parse(raw),
    newer = direction === 'newer',
    compare = newer ? gt : lt,
    order = newer ? asc : desc,
    asOf = cursor?.asOf ?? new Date().toISOString(),
    cutoff = new Date(Date.parse(asOf) - 30 * 86400_000).toISOString()
  const edge = cursor
    ? or(
        compare(schedulingActivity.activityAt, cursor.createdAt),
        and(
          eq(schedulingActivity.activityAt, cursor.createdAt),
          compare(schedulingActivity.id, cursor.id),
        ),
      )
    : undefined
  const query = (unresolved: boolean) =>
    db
      .select({
        id: schedulingActivity.id,
        createdAt: schedulingActivity.activityAt,
        project: projects.name,
        session: sessions.title,
        provider: schedulingEvaluations.provider,
        model: schedulingEvaluations.model,
        called: schedulingEvaluations.called,
        evaluationResult: schedulingEvaluations.outcome,
        evaluationActive: schedulingEvaluations.active,
        selectedCandidateId: schedulingEvaluations.selectedCandidateId,
        reason: schedulingActivity.reason,
        suggestionState: schedulingActivity.suggestionState,
        action: schedulingActivity.action,
        actionResult: schedulingActivity.actionResult,
        faultResult: schedulingRecoveryFaults.result,
        faultPhysical: schedulingRecoveryFaults.physicalUnconfirmed,
        faultId: schedulingRecoveryFaults.id,
        faultRunId: schedulingRecoveryFaults.runId,
        rebuildWork: nativeRebuildOperations.nativeWorkState,
        originalEffects: agentRuns.nativeEffectsState,
        originalUnconfirmed:
          sql<boolean>`CASE WHEN ${agentRuns.id} IS NULL THEN 0 ELSE ${originalUnconfirmed} END`.mapWith(
            Boolean,
          ),
      })
      .from(schedulingActivity)
      .innerJoin(sessions, eq(sessions.id, schedulingActivity.sessionId))
      .innerJoin(projects, eq(projects.id, sessions.projectId))
      .leftJoin(
        schedulingEvaluations,
        eq(schedulingEvaluations.id, schedulingActivity.evaluationId),
      )
      .leftJoin(
        nativeRebuildOperations,
        eq(nativeRebuildOperations.id, schedulingActivity.rebuildId),
      )
      .leftJoin(
        schedulingRecoveryFaults,
        eq(schedulingRecoveryFaults.id, schedulingActivity.faultId),
      )
      .leftJoin(
        runReexecutionOperations,
        eq(runReexecutionOperations.faultId, schedulingRecoveryFaults.id),
      )
      .leftJoin(relayDecisions, eq(relayDecisions.id, schedulingActivity.decisionId))
      .leftJoin(
        agentRuns,
        eq(
          agentRuns.id,
          sql<string>`coalesce(${runReexecutionOperations.replacementRunId}, ${schedulingRecoveryFaults.runId}, CASE WHEN ${schedulingActivity.reason}='native_rebuild' AND json_valid(${relayDecisions.proofJson}) THEN json_extract(${relayDecisions.proofJson}, '$.card.request.operation.expectedRunId') END)`,
        ),
      )
      .where(
        and(
          edge,
          lte(schedulingActivity.activityAt, asOf),
          unresolved
            ? and(
                eq(schedulingActivity.unresolved, true),
                lt(schedulingActivity.activityAt, cutoff),
              )
            : gte(schedulingActivity.activityAt, cutoff),
        ),
      )
      .orderBy(order(schedulingActivity.activityAt), order(schedulingActivity.id))
      .limit(SCHEDULING_ACTIVITY_PAGE_ITEMS + 1)
      .all()
  const records = [...query(false), ...query(true)].toSorted(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  )
  const visible = newer
    ? records.toReversed().slice(0, SCHEDULING_ACTIVITY_PAGE_ITEMS).toReversed()
    : records.slice(0, SCHEDULING_ACTIVITY_PAGE_ITEMS)
  const rows: SchedulingActivityRow[] = visible.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    project: row.project,
    session: row.session,
    provider: row.called && row.reason !== 'native_rebuild' ? row.provider : null,
    model: row.called && row.reason !== 'native_rebuild' ? row.model : null,
    called: row.reason !== 'native_rebuild' && (row.called ?? false),
    reason: row.reason,
    result: row.faultResult ?? row.evaluationResult ?? 'not_sent',
    physicalUnconfirmed:
      row.evaluationActive ||
      row.faultPhysical ||
      row.rebuildWork === 'pending' ||
      row.rebuildWork === 'unknown' ||
      (row.reason === 'native_rebuild' &&
        (row.originalEffects === 'pending' || row.originalEffects === 'unknown')),
    suggestion:
      row.called && row.reason !== 'native_rebuild' ? suggestionFor(row.selectedCandidateId) : null,
    suggestionState: schedulingActivitySuggestionStateSchema.parse(row.suggestionState),
    action: actionFor(row.action),
    actionResult: row.actionResult
      ? schedulingActivityActionResultSchema.parse(row.actionResult)
      : null,
    originalUnconfirmed:
      row.originalUnconfirmed && row.faultId && row.faultRunId
        ? faultUnconfirmed(db, { id: row.faultId, runId: row.faultRunId })
        : row.originalUnconfirmed,
  }))
  const last = newer ? rows[0] : rows.at(-1)
  return schedulingActivityPageSchema.parse({
    rows,
    asOf,
    nextCursor:
      records.length > SCHEDULING_ACTIVITY_PAGE_ITEMS && last
        ? { asOf, createdAt: last.createdAt, id: last.id }
        : null,
  })
}
