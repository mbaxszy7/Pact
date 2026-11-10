import type { CollaborationDocument, RuntimeAgentId } from '@pact/contracts'

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

export type RelayAction = 'route_send'

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
  keyConfigured: boolean | null
  /** Current credential/capacity facts; connection observations never gate a fresh attempt. */
  runtimeAdmission: 'may_attempt' | 'known_unavailable' | 'busy'
  evaluationResourcesAvailable: boolean | null
  factAlreadyEvaluated: boolean | null
  pendingUserInput: boolean | null
  nativeInteraction: boolean | null
  newTaskDispatchProtected: boolean | null
}

type RelayNodeFacts = {
  node: 'send'
  /** Workflow feedback retains its frozen recipient even when its route is implicit. */
  ordinary: boolean | null
  primary: RuntimeAgentId
  route: 'implicit' | 'agent' | 'command' | 'all'
  inputSourceId: string
  referencedSourceIds: readonly string[]
}

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
  handoffId: string
  budgetSubjectId: string
  admission: RelayPolicyAdmission
  materials: {
    /** The host has collected every necessary source and every frozen input dependency. */
    complete: boolean | null
    /** Complete serialized DecisionInput, including host metadata and candidate descriptions. */
    inputBytes: number
    sources: readonly RelayPolicySource[]
  }
  legalActions: readonly RelayLegalAction[]
}

export type RelayCandidateDescriptor =
  | {
      id: string
      action: RelayAction
      actor: RuntimeAgentId
      authorizationId: string
      effect: 'select_recipient'
    }
  | {
      id: 'clarify_prepared_input'
      action: 'clarify_prepared_input'
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
export function evaluateRelayPolicy(facts: RelayPolicyFacts): RelayPolicyResult {
  const admission = facts.admission
  if (
    admission.enabled !== true ||
    admission.keyConfigured !== true ||
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
      effect: 'select_recipient',
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
  // A single lawful recipient is no choice at all; only a declared user field
  // makes one candidate meaningful.
  if (
    candidates.filter((entry) => entry.effect === 'select_recipient').length < 2 &&
    !candidates.some((entry) => entry.action === 'clarify_prepared_input')
  )
    return { kind: 'skip', reason: 'no_candidate' }
  return eligible()
}
