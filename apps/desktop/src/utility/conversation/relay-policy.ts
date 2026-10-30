import type {
  CollaborationDocument,
  CollaborationReviewVerdict,
  RuntimeAgentId,
} from '@pact/contracts'
import type { RelayWorkflowSnapshot, RelayWorkflowTurnSource } from '@pact/persistence'

import { DECISION_CANDIDATES, DECISION_INPUT_BYTES, DECISION_SOURCES } from '@pact/contracts'

export type RelaySourceRole =
  | 'task'
  | 'input'
  | 'comment'
  | 'anchor'
  | 'anchor_target'
  | 'plan'
  | 'review'
  | 'prior_review'
  | 'owner_response'
  | 'execution'
  | 'review_scope'
  | 'user_decision'

/** Compact facts about complete frozen material, never excerpts or model assertions. */
export type RelayPolicySource = {
  id: string
  sha256: string
  bytes: number
  roles: readonly RelaySourceRole[]
  actor: RuntimeAgentId | null
  complete: boolean | null
  settled: boolean | null
  frozen: boolean | null
}

export type RelayAction =
  | 'route_send'
  | 'continue_plan_review'
  | 'continue_plan_revision'
  | 'continue_code_review'
  | 'respond_to_code_review'
  | 'repair_code'

/** The existing owner checks exact scope, current authority and ordinary business limits. */
export type RelayLegalAction = {
  action: RelayAction
  actor: RuntimeAgentId
  authorizationId: string
  authorizationCurrent: boolean | null
  businessBudgetAvailable: boolean | null
}

export type RelayPolicyAdmission = {
  enabled: boolean | null
  modelSelected: boolean | null
  /** A cached observation only decides whether to attempt; native preparation proves authority. */
  runtimeAdmission: 'may_attempt' | 'known_unavailable' | 'cooldown' | 'busy'
  evaluationResourcesAvailable: boolean | null
  factAlreadyEvaluated: boolean | null
  pendingUserInput: boolean | null
  nativeInteraction: boolean | null
  newTaskDispatchProtected: boolean | null
}

export type RelayTaskFacts = {
  taskId: string
  owner: RuntimeAgentId
  reviewer: RuntimeAgentId
  inputSequence: number
}

export type RelayPlanFacts = {
  sourceId: string
  sha256: string
  actor: RuntimeAgentId
  inputSequence: number
}

/** Ordinals and reply bindings come from the durable workflow, not prose chronology. */
export type RelayTurnFacts = {
  taskId: string
  runId: string
  sourceId: string
  actor: RuntimeAgentId
  ordinal: number
  inputSequence: number
  complete: boolean | null
  effectsSettled: boolean | null
}

export type RelayPlanReviewFacts = RelayTurnFacts & {
  verdict: CollaborationReviewVerdict
  planSha256: string
}

export type RelayOwnerResponseFacts = RelayTurnFacts & {
  stage: 'plan' | 'respond' | 'repair'
  inReplyToRunId: string
}

export type RelayCodeReviewFacts = RelayTurnFacts & {
  verdict: CollaborationReviewVerdict
  scopeId: string
}

/** A concrete, unused user grant. Availability is re-reserved by beginRun atomically. */
export type RelayPlanSupplementGrant = {
  authorizationId: string
  userReceiptId: string
  taskId: string
  budgetSubjectId: string
  handoffId: string
  actor: RuntimeAgentId
  inputSequence: number
  planSourceId: string
  planSha256: string
  reviewSourceId: string
  scope: 'read_only_plan_supplement'
  returnStage: 'plan_review'
  returnActor: RuntimeAgentId
  state: 'available' | 'reserved' | 'consumed' | 'unknown'
  authorizationCurrent: boolean | null
  durableBudgetAvailable: boolean | null
  remainingTaskTurns: number
  remainingPlanTurns: number
}

export type RelayCodeFollowupGrant = {
  authorizationId: string
  userReceiptId: string
  taskId: string
  budgetSubjectId: string
  handoffId: string
  actor: RuntimeAgentId
  inputSequence: number
  reviewSourceId: string
  scopeId: string
  scopeSourceId: string
  action: 'respond_to_code_review' | 'repair_code'
  state: 'available' | 'reserved' | 'consumed' | 'unknown'
  authorizationCurrent: boolean | null
  businessBudgetAvailable: boolean | null
}

export type RelayCodeSupplementGrant = Omit<
  RelayCodeFollowupGrant,
  'action' | 'businessBudgetAvailable'
> & {
  scope: 'read_only_code_response'
  returnStage: 'code_review'
  returnActor: RuntimeAgentId
  durableBudgetAvailable: boolean | null
  /** The mandatory fixed-reviewer return still fits the original review-cycle limit. */
  returnReviewBudgetAvailable: boolean | null
  remainingTaskTurns: number
  remainingCodeTurns: number
}

/** A host-verified opportunity to ask for one repair, never an execution grant. */
export type RelayRepairOpportunity = {
  kind: 'repair'
  taskId: string
  afterRunId: string
  actor: RuntimeAgentId
  returnActor: RuntimeAgentId
  inputSequence: number
  sourceFingerprint: string
  budgetAvailable: boolean | null
}

type RelayNodeFacts =
  | {
      node: 'send'
      /** Workflow feedback retains its frozen recipient even when its route is implicit. */
      ordinary: boolean | null
      primary: RuntimeAgentId
      route: 'implicit' | 'agent' | 'command' | 'all'
      inputSourceId: string
      referencedSourceIds: readonly string[]
    }
  | {
      node: 'plan_to_review'
      task: RelayTaskFacts
      plan: RelayPlanFacts
      previousReview: RelayPlanReviewFacts | null
      processedDecision: {
        sourceId: string
        afterReviewRunId: string
        inputSequence: number
        handled: boolean | null
        incorporatedPlanSha256: string
      } | null
      frozenContextSourceIds: readonly string[]
    }
  | {
      node: 'plan_review_to_owner'
      task: RelayTaskFacts
      plan: RelayPlanFacts
      review: RelayPlanReviewFacts
      previousReview: RelayPlanReviewFacts | null
      interveningOwnerResponse: RelayOwnerResponseFacts | null
    }
  | {
      node: 'owner_to_review'
      task: RelayTaskFacts
      plan: RelayPlanFacts
      ownerResponse: RelayOwnerResponseFacts
      previousReview: RelayPlanReviewFacts
      earlierReview: RelayPlanReviewFacts | null
      interveningOwnerResponse: RelayOwnerResponseFacts | null
      retainedPlan: { explicit: boolean | null; sha256: string } | null
      supplementGrant: RelayPlanSupplementGrant | null
    }
  | {
      node: 'execution_to_review'
      task: RelayTaskFacts
      scopeId: string
      scopeSourceId: string
      execution: RelayTurnFacts & { stage: 'implement' | 'repair' }
      precedingResponse: (RelayOwnerResponseFacts & { scopeId: string }) | null
      continuation: {
        authorizationId: string
        originalRunId: string
        taskId: string
        actor: RuntimeAgentId
        scopeId: string
        stage: 'implement' | 'repair'
        authorizationCurrent: boolean | null
        durable: boolean | null
        oldExecutionSettled: boolean | null
      } | null
    }
  | {
      node: 'code_review_to_next'
      task: RelayTaskFacts
      scopeId: string
      scopeSourceId: string
      review: RelayCodeReviewFacts
      previousReview: RelayCodeReviewFacts | null
      interveningOwnerResponse: (RelayOwnerResponseFacts & { scopeId: string }) | null
      followupGrant: RelayCodeFollowupGrant | null
      supplementGrant: RelayCodeSupplementGrant | null
    }

/** Every fact belongs to one current host snapshot. Unknown booleans must remain null. */
export type RelayPolicyFacts = RelayNodeFacts & {
  informationOpportunity?:
    | {
        fieldId: string
        sourceId: string
        document: CollaborationDocument
        batchId: string
        clientMessageId: string
        requestFingerprint: string
        sourceFingerprint: string
        defaultAgentId: RuntimeAgentId
        handoffId: string
        unanswered: boolean | null
      }
    | undefined
  repairOpportunity?: RelayRepairOpportunity | undefined
  supplementOpportunity?:
    | {
        kind: 'supplement_plan' | 'supplement_code_response'
        taskId: string
        actor: RuntimeAgentId
        returnActor: RuntimeAgentId
        inputSequence: number
        sourceFingerprint: string
        budgetAvailable: boolean | null
      }
    | undefined
  handoffId: string
  budgetSubjectId: string
  admission: RelayPolicyAdmission
  materials: {
    /** The host has collected every necessary source and every frozen input dependency. */
    complete: boolean | null
    /** Complete serialized evaluator input, including envelope and candidate descriptions. */
    inputBytes: number
    sources: readonly RelayPolicySource[]
  }
  legalActions: readonly RelayLegalAction[]
}

export type RelayCandidateDescriptor =
  | {
      id: string
      action: RelayAction | 'supplement_plan' | 'supplement_code_response'
      actor: RuntimeAgentId
      authorizationId: string
      effect: 'select_recipient' | 'handoff_focus' | 'extra_plan_turn' | 'extra_code_turn'
    }
  | {
      id:
        | 'propose_supplement_plan'
        | 'propose_supplement_code_response'
        | 'propose_repair'
        | 'clarify_prepared_input'
      action:
        | 'propose_supplement_plan'
        | 'propose_supplement_code_response'
        | 'propose_repair'
        | 'clarify_prepared_input'
      actor: RuntimeAgentId
      authorizationId: null
      effect: 'request_user_decision'
    }

export type RelayPolicyResult =
  | {
      kind: 'skip'
      reason:
        | 'unavailable'
        | 'protected'
        | 'already_evaluated'
        | 'materials'
        | 'ineligible'
        | 'no_candidate'
        | 'awaiting_user_action'
    }
  | {
      kind: 'eligible'
      node: RelayPolicyFacts['node']
      candidates: readonly RelayCandidateDescriptor[]
      requiredSources: readonly { id: string; roles: readonly RelaySourceRole[] }[]
    }

const idValid = (value: string): boolean =>
  typeof value === 'string' && value.length > 0 && value.length <= 160
const digestValid = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value)
const agentValid = (value: RuntimeAgentId): boolean => value === 'codex' || value === 'claude'
const countValid = (value: number): boolean => Number.isSafeInteger(value) && value >= 0
const sameDocument = (left: CollaborationDocument, right: CollaborationDocument): boolean =>
  left.id === right.id &&
  left.sha256 === right.sha256 &&
  left.bytes === right.bytes &&
  left.chars === right.chars
const relayTurn = (value: RelayWorkflowTurnSource): RelayTurnFacts => ({
  taskId: value.taskId,
  runId: value.runId,
  sourceId: value.sourceId,
  actor: value.actor,
  ordinal: value.ordinal,
  inputSequence: value.inputSequence,
  complete: true,
  effectsSettled: true,
})
const relayPlanReview = (
  value: RelayWorkflowTurnSource | undefined,
): RelayPlanReviewFacts | null =>
  value && value.verdict !== null && value.planSha256 !== null
    ? { ...relayTurn(value), verdict: value.verdict, planSha256: value.planSha256 }
    : null
const relayCodeReview = (
  value: RelayWorkflowTurnSource | undefined,
): RelayCodeReviewFacts | null =>
  value && value.verdict !== null
    ? { ...relayTurn(value), verdict: value.verdict, scopeId: value.scopeId }
    : null
const relayOwnerResponse = (
  value: RelayWorkflowTurnSource | undefined,
): (RelayOwnerResponseFacts & { scopeId: string }) | null =>
  value &&
  value.inReplyToRunId !== null &&
  (value.stage === 'plan' || value.stage === 'respond' || value.stage === 'repair')
    ? {
        ...relayTurn(value),
        stage: value.stage,
        inReplyToRunId: value.inReplyToRunId,
        scopeId: value.scopeId,
      }
    : null

export type RelayWorkflowPolicyOptions = {
  repairOpportunity?: RelayRepairOpportunity | undefined
  supplementOpportunity?: RelayPolicyFacts['supplementOpportunity']
  handoffId: string
  admission: RelayPolicyAdmission
  legalActions: readonly RelayLegalAction[]
  /** The caller measures the complete evaluator envelope after bounded source collection. */
  inputBytes: number
  planSupplementGrant?: RelayPlanSupplementGrant | null
  codeFollowupGrant?: RelayCodeFollowupGrant | null
  codeSupplementGrant?: RelayCodeSupplementGrant | null
  continuation?: Extract<RelayPolicyFacts, { node: 'execution_to_review' }>['continuation']
}

/** Maps Repository-verified, sealed workflow evidence without deriving new execution authority. */
export function relayWorkflowPolicyFacts(
  snapshot: RelayWorkflowSnapshot,
  options: RelayWorkflowPolicyOptions,
): Exclude<RelayPolicyFacts, { node: 'send' }> | undefined {
  const { task, basis, producer } = snapshot
  if (
    basis.kind !== 'workflow' ||
    basis.input !== null ||
    basis.task.id !== task.id ||
    basis.task.inputSequence !== task.inputSequence ||
    basis.producerRunId !== task.runId ||
    producer.runId !== task.runId ||
    producer.inputSequence !== task.inputSequence ||
    producer.actor !== task.actor ||
    producer.stage !== task.stage ||
    task.status !== 'waiting' ||
    task.automation !== 'active' ||
    !task.taskDocument ||
    !countValid(task.inputSequence) ||
    !countValid(task.handledInputSequence) ||
    task.handledInputSequence > task.inputSequence ||
    snapshot.sources.length === 0 ||
    snapshot.sources.length > DECISION_SOURCES ||
    snapshot.reviews.length > 2 ||
    snapshot.responses.length > 1
  )
    return undefined
  if (
    basis.plan
      ? !task.planReference ||
        basis.plan.version !== task.planReference.version ||
        basis.plan.sourceRunId !== task.planReference.sourceRunId ||
        basis.plan.sourceMessageId !== task.planReference.sourceMessageId ||
        !sameDocument(basis.plan.document, task.planReference.document)
      : task.planReference !== undefined
  )
    return undefined
  const sources = new Map(snapshot.sources.map((source) => [source.id, source]))
  if (
    sources.size !== snapshot.sources.length ||
    snapshot.sources.some(
      (source) =>
        !Object.hasOwn(snapshot.sourceActors, source.id) ||
        (snapshot.sourceActors[source.id] !== null &&
          !agentValid(snapshot.sourceActors[source.id]!)),
    ) ||
    !snapshot.sources.some(
      (source) =>
        source.roles.includes('task') && sameDocument(source.document, task.taskDocument!),
    ) ||
    !sources.get(snapshot.scopeSourceId)?.roles.includes('review_scope')
  )
    return undefined
  const planning =
    snapshot.node === 'plan_to_review' ||
    snapshot.node === 'plan_review_to_owner' ||
    snapshot.node === 'owner_to_review'
  const planSource = snapshot.planSourceId ? sources.get(snapshot.planSourceId) : undefined
  if (
    basis.plan
      ? !planSource ||
        !planSource.roles.includes('plan') ||
        snapshot.sourceActors[planSource.id] !== task.owner ||
        !sameDocument(planSource.document, basis.plan.document)
      : snapshot.planSourceId !== null ||
        snapshot.sources.some((source) => source.roles.includes('plan'))
  )
    return undefined
  if (planning && (!basis.plan || !planSource || task.planInputSequence !== task.inputSequence))
    return undefined
  if (
    snapshot.retainedPlanSha256 !== null &&
    snapshot.retainedPlanSha256 !== basis.plan?.document.sha256
  )
    return undefined

  const turnValid = (turn: RelayWorkflowTurnSource, role: RelaySourceRole): boolean => {
    const source = sources.get(turn.sourceId)
    return Boolean(
      source &&
      source.roles.includes(role) &&
      sameDocument(source.document, turn.document) &&
      snapshot.sourceActors[turn.sourceId] === turn.actor &&
      (source.sourceRunId === undefined || source.sourceRunId === turn.runId) &&
      (source.messageId === undefined || source.messageId === turn.messageId) &&
      (source.inputSequence === undefined || source.inputSequence === turn.inputSequence) &&
      turn.taskId === task.id &&
      idValid(turn.runId) &&
      countValid(turn.ordinal) &&
      countValid(turn.inputSequence) &&
      turn.inputSequence <= task.inputSequence,
    )
  }
  const producerRole =
    snapshot.node === 'plan_review_to_owner' || snapshot.node === 'code_review_to_next'
      ? 'review'
      : snapshot.node === 'execution_to_review'
        ? 'execution'
        : 'owner_response'
  if (
    !turnValid(producer, producerRole) ||
    snapshot.reviews.some(
      (review, index) =>
        !turnValid(review, 'review') ||
        review.actor !== task.reviewer ||
        review.stage !== (planning ? 'plan_review' : 'code_review') ||
        review.verdict === null ||
        (planning && !digestValid(review.planSha256 ?? '')) ||
        review.ordinal >= (snapshot.reviews[index - 1]?.ordinal ?? producer.ordinal),
    ) ||
    snapshot.responses.some(
      (response) =>
        !turnValid(response, 'owner_response') ||
        response.actor !== task.owner ||
        (planning
          ? response.stage !== 'plan'
          : response.stage !== 'respond' && response.stage !== 'repair') ||
        response.inReplyToRunId === null ||
        response.ordinal >= producer.ordinal,
    )
  )
    return undefined
  const common = {
    handoffId: options.handoffId,
    budgetSubjectId: `task:${task.id}`,
    task: {
      taskId: task.id,
      owner: task.owner,
      reviewer: task.reviewer,
      inputSequence: task.inputSequence,
    },
    admission: options.admission,
    legalActions: options.legalActions,
    repairOpportunity: options.repairOpportunity,
    supplementOpportunity: options.supplementOpportunity,
    materials: {
      complete: true,
      inputBytes: options.inputBytes,
      sources: snapshot.sources.map((source) => ({
        id: source.id,
        sha256: source.document.sha256,
        bytes: source.document.bytes,
        roles: [...source.roles],
        actor: snapshot.sourceActors[source.id]!,
        complete: true,
        settled: true,
        frozen: true,
      })),
    },
  }
  const plan: RelayPlanFacts | undefined =
    basis.plan && planSource && task.planInputSequence !== undefined
      ? {
          sourceId: planSource.id,
          sha256: basis.plan.document.sha256,
          actor: task.owner,
          inputSequence: task.planInputSequence,
        }
      : undefined
  switch (snapshot.node) {
    case 'plan_to_review': {
      if (
        !plan ||
        producer.actor !== task.owner ||
        (producer.stage !== 'plan' &&
          !(producer.stage === 'reply' && task.kind === 'plan' && !task.codeRunId))
      )
        return undefined
      const decision = snapshot.processedDecision
      if (
        decision &&
        (!sources.get(decision.sourceId)?.roles.includes('user_decision') ||
          snapshot.sourceActors[decision.sourceId] !== null ||
          !countValid(decision.inputSequence) ||
          decision.inputSequence > task.handledInputSequence ||
          decision.incorporatedPlanSha256 !== plan.sha256)
      )
        return undefined
      return {
        ...common,
        node: snapshot.node,
        plan,
        previousReview: relayPlanReview(snapshot.reviews[0]),
        processedDecision: decision ? { ...decision, handled: true } : null,
        frozenContextSourceIds: snapshot.sources
          .filter((source) =>
            source.roles.some(
              (role) =>
                role === 'input' ||
                role === 'comment' ||
                role === 'anchor' ||
                role === 'anchor_target' ||
                role === 'user_decision',
            ),
          )
          .map((source) => source.id),
      }
    }
    case 'plan_review_to_owner': {
      const review = relayPlanReview(producer)
      if (!plan || !review || producer.actor !== task.reviewer || producer.stage !== 'plan_review')
        return undefined
      return {
        ...common,
        node: snapshot.node,
        plan,
        review,
        previousReview: relayPlanReview(snapshot.reviews[0]),
        interveningOwnerResponse: relayOwnerResponse(snapshot.responses[0]),
      }
    }
    case 'owner_to_review': {
      const ownerResponse = relayOwnerResponse(producer),
        previousReview = relayPlanReview(snapshot.reviews[0])
      if (
        !plan ||
        !ownerResponse ||
        !previousReview ||
        producer.actor !== task.owner ||
        producer.stage !== 'plan'
      )
        return undefined
      return {
        ...common,
        node: snapshot.node,
        plan,
        ownerResponse,
        previousReview,
        earlierReview: relayPlanReview(snapshot.reviews[1]),
        interveningOwnerResponse: relayOwnerResponse(snapshot.responses[0]),
        retainedPlan: snapshot.retainedPlanSha256
          ? { explicit: true, sha256: snapshot.retainedPlanSha256 }
          : null,
        supplementGrant: options.planSupplementGrant ?? null,
      }
    }
    case 'execution_to_review': {
      if (
        producer.actor !== task.owner ||
        (producer.stage !== 'implement' && producer.stage !== 'repair')
      )
        return undefined
      return {
        ...common,
        node: snapshot.node,
        scopeId: producer.scopeId,
        scopeSourceId: snapshot.scopeSourceId,
        execution: { ...relayTurn(producer), stage: producer.stage },
        precedingResponse: relayOwnerResponse(snapshot.responses[0]),
        continuation: options.continuation ?? null,
      }
    }
    case 'code_review_to_next': {
      const review = relayCodeReview(producer)
      if (!review || producer.actor !== task.reviewer || producer.stage !== 'code_review')
        return undefined
      return {
        ...common,
        node: snapshot.node,
        scopeId: producer.scopeId,
        scopeSourceId: snapshot.scopeSourceId,
        review,
        previousReview: relayCodeReview(snapshot.reviews[0]),
        interveningOwnerResponse: relayOwnerResponse(snapshot.responses[0]),
        followupGrant: options.codeFollowupGrant ?? null,
        supplementGrant: options.codeSupplementGrant ?? null,
      }
    }
  }
  return undefined
}

/**
 * Conversation calls this once for current authenticated facts. It owns source loading, dedup,
 * atomic reservations, dispatch, cancellation and restart. This function owns no state or I/O;
 * eligibility and descriptors are advice admission only, never a Run authorization or user gate.
 */
export function evaluateRelayPolicy(facts: RelayPolicyFacts): RelayPolicyResult {
  const admission = facts.admission
  if (
    admission.enabled !== true ||
    admission.modelSelected !== true ||
    admission.runtimeAdmission !== 'may_attempt' ||
    admission.evaluationResourcesAvailable !== true ||
    !idValid(facts.handoffId) ||
    !idValid(facts.budgetSubjectId)
  )
    return { kind: 'skip', reason: 'unavailable' }
  if (
    admission.pendingUserInput !== false ||
    admission.nativeInteraction !== false ||
    admission.newTaskDispatchProtected !== false
  )
    return { kind: 'skip', reason: 'protected' }
  if (admission.factAlreadyEvaluated !== false) return { kind: 'skip', reason: 'already_evaluated' }

  const material = facts.materials
  if (
    material.complete !== true ||
    !countValid(material.inputBytes) ||
    material.inputBytes === 0 ||
    material.inputBytes > DECISION_INPUT_BYTES ||
    material.sources.length === 0 ||
    material.sources.length > DECISION_SOURCES
  )
    return { kind: 'skip', reason: 'materials' }
  const sources = new Map<string, RelayPolicySource>()
  let sourceBytes = 0
  for (const source of material.sources) {
    if (
      !idValid(source.id) ||
      !digestValid(source.sha256) ||
      !countValid(source.bytes) ||
      source.complete !== true ||
      source.settled !== true ||
      source.frozen !== true ||
      source.roles.length === 0 ||
      source.roles.length > 12 ||
      new Set(source.roles).size !== source.roles.length ||
      sources.has(source.id) ||
      (source.actor !== null && !agentValid(source.actor))
    )
      return { kind: 'skip', reason: 'materials' }
    sourceBytes += source.bytes
    sources.set(source.id, source)
  }
  if (sourceBytes > material.inputBytes) return { kind: 'skip', reason: 'materials' }
  if (facts.legalActions.length > DECISION_CANDIDATES)
    return { kind: 'skip', reason: 'no_candidate' }

  const hasSource = (id: string, role: RelaySourceRole): boolean =>
    sources.get(id)?.roles.includes(role) === true
  const candidates: RelayCandidateDescriptor[] = []
  const add = (action: RelayAction, actor: RuntimeAgentId, authorizationId?: string): void => {
    const legal = facts.legalActions.filter(
      (entry) =>
        entry.action === action &&
        entry.actor === actor &&
        entry.authorizationCurrent === true &&
        entry.businessBudgetAvailable === true &&
        idValid(entry.authorizationId) &&
        (authorizationId === undefined || authorizationId === entry.authorizationId),
    )
    // Conflicting authority is not resolved by list order.
    if (legal.length !== 1) return
    candidates.push({
      id: action === 'route_send' ? `route_${actor}` : action,
      action,
      actor,
      authorizationId: legal[0]!.authorizationId,
      effect: action === 'route_send' ? 'select_recipient' : 'handoff_focus',
    })
  }
  const eligible = (): RelayPolicyResult =>
    candidates.length === 0
      ? { kind: 'skip', reason: 'no_candidate' }
      : {
          kind: 'eligible',
          node: facts.node,
          candidates,
          requiredSources: material.sources.map(({ id, roles }) => ({ id, roles: [...roles] })),
        }
  const ineligible: RelayPolicyResult = { kind: 'skip', reason: 'ineligible' }
  const proposeSupplement = (kind: 'supplement_plan' | 'supplement_code_response'): boolean => {
    const opportunity = facts.supplementOpportunity
    if (
      facts.node === 'send' ||
      !opportunity ||
      opportunity.kind !== kind ||
      opportunity.taskId !== facts.task.taskId ||
      opportunity.actor !== facts.task.owner ||
      opportunity.returnActor !== facts.task.reviewer ||
      opportunity.inputSequence !== facts.task.inputSequence ||
      opportunity.budgetAvailable !== true ||
      !digestValid(opportunity.sourceFingerprint)
    )
      return false
    const id =
      kind === 'supplement_plan' ? 'propose_supplement_plan' : 'propose_supplement_code_response'
    candidates.push({
      id,
      action: id,
      actor: facts.task.owner,
      authorizationId: null,
      effect: 'request_user_decision',
    })
    return true
  }
  const proposeRepair = (): boolean => {
    const opportunity = facts.repairOpportunity
    if (
      facts.node !== 'code_review_to_next' ||
      !opportunity ||
      opportunity.kind !== 'repair' ||
      opportunity.taskId !== facts.task.taskId ||
      opportunity.afterRunId !== facts.review.runId ||
      opportunity.actor !== facts.task.owner ||
      opportunity.returnActor !== facts.task.reviewer ||
      opportunity.inputSequence !== facts.task.inputSequence ||
      opportunity.budgetAvailable !== true ||
      !digestValid(opportunity.sourceFingerprint)
    )
      return false
    candidates.push({
      id: 'propose_repair',
      action: 'propose_repair',
      actor: facts.task.owner,
      authorizationId: null,
      effect: 'request_user_decision',
    })
    return true
  }

  if (facts.node === 'send') {
    if (
      facts.ordinary !== true ||
      facts.route !== 'implicit' ||
      !agentValid(facts.primary) ||
      !hasSource(facts.inputSourceId, 'input') ||
      facts.referencedSourceIds.length === 0 ||
      facts.referencedSourceIds.length > DECISION_SOURCES
    )
      return ineligible
    const referenced = new Set<RuntimeAgentId>()
    for (const id of facts.referencedSourceIds) {
      const source = sources.get(id)
      if (!source || source.actor === null) return ineligible
      referenced.add(source.actor)
    }
    if (referenced.size < 2 && referenced.has(facts.primary)) return ineligible
    for (const actor of ['codex', 'claude'] as const)
      if (actor === facts.primary || referenced.has(actor)) add('route_send', actor)
    const information = facts.informationOpportunity
    if (
      information &&
      information.unanswered === true &&
      information.handoffId === facts.handoffId &&
      facts.budgetSubjectId === `input:${information.clientMessageId}` &&
      information.defaultAgentId === facts.primary &&
      [information.fieldId, information.batchId, information.clientMessageId].every(idValid) &&
      digestValid(information.requestFingerprint) &&
      digestValid(information.sourceFingerprint) &&
      hasSource(information.sourceId, 'input') &&
      sources.get(information.sourceId)?.actor === null &&
      sources.get(information.sourceId)?.sha256 === information.document.sha256 &&
      sources.get(information.sourceId)?.bytes === information.document.bytes
    )
      candidates.push({
        id: 'clarify_prepared_input',
        action: 'clarify_prepared_input',
        actor: facts.primary,
        authorizationId: null,
        effect: 'request_user_decision',
      })
    return eligible()
  }

  const task = facts.task
  if (
    !idValid(task.taskId) ||
    facts.budgetSubjectId !== `task:${task.taskId}` ||
    !agentValid(task.owner) ||
    !agentValid(task.reviewer) ||
    task.owner === task.reviewer ||
    !countValid(task.inputSequence) ||
    !material.sources.some((source) => source.roles.includes('task'))
  )
    return ineligible
  const turnValid = (
    turn: RelayTurnFacts | null,
    actor: RuntimeAgentId,
    role: RelaySourceRole,
  ): turn is RelayTurnFacts =>
    turn !== null &&
    turn.taskId === task.taskId &&
    turn.actor === actor &&
    idValid(turn.runId) &&
    countValid(turn.ordinal) &&
    countValid(turn.inputSequence) &&
    turn.inputSequence <= task.inputSequence &&
    turn.complete === true &&
    turn.effectsSettled === true &&
    hasSource(turn.sourceId, role) &&
    sources.get(turn.sourceId)?.actor === actor
  const current = (turn: RelayTurnFacts): boolean => turn.inputSequence === task.inputSequence
  const planReviewValid = (review: RelayPlanReviewFacts | null): review is RelayPlanReviewFacts =>
    turnValid(review, task.reviewer, 'review') && digestValid(review.planSha256)
  const chain = (
    previous: RelayPlanReviewFacts | null,
    response: RelayOwnerResponseFacts | null,
    review: RelayPlanReviewFacts,
  ): boolean =>
    planReviewValid(previous) &&
    previous.verdict === 'changes_requested' &&
    review.verdict === 'changes_requested' &&
    turnValid(response, task.owner, 'owner_response') &&
    response.stage === 'plan' &&
    response.inReplyToRunId === previous.runId &&
    new Set([previous.runId, response.runId, review.runId]).size === 3 &&
    new Set([previous.sourceId, response.sourceId, review.sourceId]).size === 3 &&
    previous.ordinal < response.ordinal &&
    response.ordinal < review.ordinal &&
    previous.inputSequence <= response.inputSequence &&
    response.inputSequence <= review.inputSequence

  if ('plan' in facts) {
    const plan = facts.plan
    if (
      plan.actor !== task.owner ||
      plan.inputSequence !== task.inputSequence ||
      !hasSource(plan.sourceId, 'plan') ||
      sources.get(plan.sourceId)?.actor !== task.owner ||
      sources.get(plan.sourceId)?.sha256 !== plan.sha256
    )
      return ineligible
  }

  switch (facts.node) {
    case 'plan_to_review': {
      const decision = facts.processedDecision
      if (
        !planReviewValid(facts.previousReview) ||
        !decision ||
        decision.handled !== true ||
        decision.afterReviewRunId !== facts.previousReview.runId ||
        decision.inputSequence <= facts.previousReview.inputSequence ||
        decision.inputSequence > task.inputSequence ||
        !countValid(decision.inputSequence) ||
        decision.incorporatedPlanSha256 !== facts.plan.sha256 ||
        !hasSource(decision.sourceId, 'user_decision') ||
        sources.get(decision.sourceId)?.actor !== null ||
        facts.frozenContextSourceIds.length > DECISION_SOURCES ||
        new Set(facts.frozenContextSourceIds).size < 2 ||
        facts.frozenContextSourceIds.some(
          (id) =>
            !sources
              .get(id)
              ?.roles.some(
                (role) =>
                  role === 'input' ||
                  role === 'comment' ||
                  role === 'anchor' ||
                  role === 'anchor_target' ||
                  role === 'user_decision',
              ),
        )
      )
        return ineligible
      add('continue_plan_review', task.reviewer)
      return eligible()
    }
    case 'plan_review_to_owner': {
      if (
        !planReviewValid(facts.review) ||
        !current(facts.review) ||
        facts.review.planSha256 !== facts.plan.sha256 ||
        !chain(facts.previousReview, facts.interveningOwnerResponse, facts.review)
      )
        return ineligible
      add('continue_plan_revision', task.owner)
      return eligible()
    }
    case 'owner_to_review': {
      if (
        !turnValid(facts.ownerResponse, task.owner, 'owner_response') ||
        facts.ownerResponse.stage !== 'plan' ||
        !current(facts.ownerResponse) ||
        !planReviewValid(facts.previousReview) ||
        facts.previousReview.verdict !== 'changes_requested' ||
        facts.ownerResponse.inReplyToRunId !== facts.previousReview.runId ||
        facts.ownerResponse.runId === facts.previousReview.runId ||
        facts.ownerResponse.sourceId === facts.previousReview.sourceId ||
        facts.previousReview.ordinal >= facts.ownerResponse.ordinal ||
        facts.previousReview.inputSequence > facts.ownerResponse.inputSequence
      )
        return ineligible
      if (!chain(facts.earlierReview, facts.interveningOwnerResponse, facts.previousReview))
        return ineligible
      add('continue_plan_review', task.reviewer)
      const grant = facts.supplementGrant
      if (!grant) proposeSupplement('supplement_plan')
      if (
        grant &&
        idValid(grant.authorizationId) &&
        idValid(grant.userReceiptId) &&
        grant.taskId === task.taskId &&
        grant.budgetSubjectId === facts.budgetSubjectId &&
        grant.handoffId === facts.handoffId &&
        grant.actor === task.owner &&
        grant.inputSequence === task.inputSequence &&
        grant.planSourceId === facts.plan.sourceId &&
        grant.planSha256 === facts.plan.sha256 &&
        grant.reviewSourceId === facts.previousReview.sourceId &&
        grant.scope === 'read_only_plan_supplement' &&
        grant.returnStage === 'plan_review' &&
        grant.returnActor === task.reviewer &&
        grant.state === 'available' &&
        grant.authorizationCurrent === true &&
        grant.durableBudgetAvailable === true &&
        countValid(grant.remainingTaskTurns) &&
        grant.remainingTaskTurns > 0 &&
        grant.remainingTaskTurns <= 2 &&
        grant.remainingPlanTurns === 1 &&
        candidates.length > 0
      )
        candidates.push({
          id: 'supplement_plan',
          action: 'supplement_plan',
          actor: task.owner,
          authorizationId: grant.authorizationId,
          effect: 'extra_plan_turn',
        })
      return eligible()
    }
    case 'execution_to_review': {
      if (
        !idValid(facts.scopeId) ||
        !hasSource(facts.scopeSourceId, 'review_scope') ||
        !turnValid(facts.execution, task.owner, 'execution') ||
        !current(facts.execution)
      )
        return ineligible
      const response = facts.precedingResponse
      const afterResponse =
        facts.execution.stage === 'repair' &&
        turnValid(response, task.owner, 'owner_response') &&
        response.stage === 'respond' &&
        response.scopeId === facts.scopeId &&
        response.runId !== facts.execution.runId &&
        response.sourceId !== facts.execution.sourceId &&
        response.ordinal < facts.execution.ordinal
      const continuation = facts.continuation
      const continued =
        continuation !== null &&
        idValid(continuation.authorizationId) &&
        idValid(continuation.originalRunId) &&
        continuation.originalRunId !== facts.execution.runId &&
        continuation.taskId === task.taskId &&
        continuation.actor === task.owner &&
        continuation.scopeId === facts.scopeId &&
        continuation.stage === facts.execution.stage &&
        continuation.authorizationCurrent === true &&
        continuation.durable === true &&
        continuation.oldExecutionSettled === true
      if (!afterResponse && !continued) return ineligible
      add('continue_code_review', task.reviewer)
      return eligible()
    }
    case 'code_review_to_next': {
      const previous = facts.previousReview,
        response = facts.interveningOwnerResponse
      if (
        !idValid(facts.scopeId) ||
        !hasSource(facts.scopeSourceId, 'review_scope') ||
        !turnValid(facts.review, task.reviewer, 'review') ||
        !current(facts.review) ||
        facts.review.verdict !== 'changes_requested' ||
        facts.review.scopeId !== facts.scopeId ||
        !turnValid(previous, task.reviewer, 'review') ||
        previous.verdict !== 'changes_requested' ||
        previous.scopeId !== facts.scopeId ||
        !turnValid(response, task.owner, 'owner_response') ||
        (response.stage !== 'respond' && response.stage !== 'repair') ||
        response.scopeId !== facts.scopeId ||
        response.inReplyToRunId !== previous.runId ||
        new Set([previous.runId, response.runId, facts.review.runId]).size !== 3 ||
        new Set([previous.sourceId, response.sourceId, facts.review.sourceId]).size !== 3 ||
        previous.ordinal >= response.ordinal ||
        response.ordinal >= facts.review.ordinal ||
        previous.inputSequence > response.inputSequence ||
        response.inputSequence > facts.review.inputSequence
      )
        return ineligible
      const grantValid = (
        grant: RelayCodeFollowupGrant | RelayCodeSupplementGrant | null,
      ): boolean =>
        grant !== null &&
        idValid(grant.authorizationId) &&
        idValid(grant.userReceiptId) &&
        grant.taskId === task.taskId &&
        grant.budgetSubjectId === facts.budgetSubjectId &&
        grant.handoffId === facts.handoffId &&
        grant.actor === task.owner &&
        grant.inputSequence === task.inputSequence &&
        grant.reviewSourceId === facts.review.sourceId &&
        grant.scopeId === facts.scopeId &&
        grant.scopeSourceId === facts.scopeSourceId &&
        grant.state === 'available' &&
        grant.authorizationCurrent === true
      const grant = facts.followupGrant
      if (
        grant &&
        grantValid(grant) &&
        grant.businessBudgetAvailable === true &&
        (grant.action === 'respond_to_code_review' || grant.action === 'repair_code')
      )
        add(grant.action, task.owner, grant.authorizationId)
      const supplement = facts.supplementGrant
      if (
        supplement &&
        grantValid(supplement) &&
        supplement.scope === 'read_only_code_response' &&
        supplement.returnStage === 'code_review' &&
        supplement.returnActor === task.reviewer &&
        supplement.durableBudgetAvailable === true &&
        supplement.returnReviewBudgetAvailable === true &&
        countValid(supplement.remainingTaskTurns) &&
        supplement.remainingTaskTurns > 0 &&
        supplement.remainingTaskTurns <= 2 &&
        supplement.remainingCodeTurns === 1
      )
        candidates.push({
          id: 'supplement_code_response',
          action: 'supplement_code_response',
          actor: task.owner,
          authorizationId: supplement.authorizationId,
          effect: 'extra_code_turn',
        })
      const proposedSupplement =
        !grant && !supplement && proposeSupplement('supplement_code_response')
      const proposedRepair = !grant && !supplement && proposeRepair()
      if (!grantValid(grant) && !grantValid(supplement) && !proposedSupplement && !proposedRepair)
        return { kind: 'skip', reason: 'awaiting_user_action' }
      return eligible()
    }
  }
  return ineligible
}
