import { describe, expect, it } from 'vitest'

import type { CollaborationTask, RelaySource, RuntimeAgentId } from '@pact/contracts'
import type { RelayWorkflowSnapshot, RelayWorkflowTurnSource } from '@pact/persistence'

import type {
  RelayAction,
  RelayCodeFollowupGrant,
  RelayCodeSupplementGrant,
  RelayLegalAction,
  RelayOwnerResponseFacts,
  RelayPlanReviewFacts,
  RelayPlanSupplementGrant,
  RelayPolicyFacts,
  RelayPolicyResult,
  RelayPolicySource,
  RelayRepairOpportunity,
  RelaySourceRole,
  RelayTurnFacts,
  RelayWorkflowPolicyOptions,
} from './relay-policy.js'

import { evaluateRelayPolicy, relayWorkflowPolicyFacts } from './relay-policy.js'

const planSha256 = 'a'.repeat(64)
const otherSha256 = 'b'.repeat(64)
const owner = 'claude',
  reviewer = 'codex'
type Facts<N extends RelayPolicyFacts['node']> = Extract<RelayPolicyFacts, { node: N }>

function source(
  id: string,
  roles: RelaySourceRole[],
  actor: RuntimeAgentId | null,
): RelayPolicySource {
  return {
    id,
    roles,
    actor,
    sha256: planSha256,
    bytes: 100,
    complete: true,
    settled: true,
    frozen: true,
  }
}

function legal(action: RelayAction, actor: RuntimeAgentId): RelayLegalAction {
  return {
    action,
    actor,
    authorizationId: `authorization:${action}`,
    authorizationCurrent: true,
    businessBudgetAvailable: true,
  }
}

function common() {
  return {
    handoffId: 'handoff-1',
    budgetSubjectId: 'task:task-1',
    admission: {
      enabled: true,
      modelSelected: true,
      runtimeAdmission: 'may_attempt' as const,
      evaluationResourcesAvailable: true,
      factAlreadyEvaluated: false,
      pendingUserInput: false,
      nativeInteraction: false,
      newTaskDispatchProtected: false,
    },
    materials: {
      complete: true,
      inputBytes: 4096,
      sources: [
        source('task', ['task'], null),
        source('input', ['input'], null),
        source('input-2', ['input'], null),
        source('decision', ['user_decision'], null),
        source('plan', ['plan'], owner),
        source('review', ['review'], reviewer),
        source('prior-review', ['review', 'prior_review'], reviewer),
        source('response', ['owner_response'], owner),
        source('prior-response', ['owner_response'], owner),
        source('execution', ['execution'], owner),
        source('scope', ['review_scope'], null),
      ],
    },
    legalActions: [
      legal('continue_plan_review', reviewer),
      legal('continue_plan_revision', owner),
      legal('continue_code_review', reviewer),
      legal('respond_to_code_review', owner),
      legal('repair_code', owner),
    ],
  }
}

function task() {
  return { taskId: 'task-1', owner, reviewer, inputSequence: 3 } as const
}
function plan() {
  return { sourceId: 'plan', sha256: planSha256, actor: owner, inputSequence: 3 } as const
}
function turn(sourceId: string, actor: RuntimeAgentId, ordinal: number): RelayTurnFacts {
  return {
    taskId: 'task-1',
    runId: `run:${sourceId}`,
    sourceId,
    actor,
    ordinal,
    inputSequence: 3,
    complete: true,
    effectsSettled: true,
  }
}
function review(sourceId: string, ordinal: number): RelayPlanReviewFacts {
  return { ...turn(sourceId, reviewer, ordinal), verdict: 'changes_requested', planSha256 }
}
function response(
  sourceId: string,
  ordinal: number,
  prior = 'prior-review',
): RelayOwnerResponseFacts {
  return { ...turn(sourceId, owner, ordinal), stage: 'plan', inReplyToRunId: `run:${prior}` }
}

function send(): Facts<'send'> {
  return {
    ...common(),
    node: 'send',
    ordinary: true,
    budgetSubjectId: 'input-1',
    primary: owner,
    route: 'implicit',
    inputSourceId: 'input',
    referencedSourceIds: ['review', 'response'],
    legalActions: [legal('route_send', owner), legal('route_send', reviewer)],
  }
}
function initialPlan(): Facts<'plan_to_review'> {
  return {
    ...common(),
    node: 'plan_to_review',
    task: task(),
    plan: plan(),
    previousReview: { ...review('prior-review', 1), inputSequence: 1 },
    processedDecision: {
      sourceId: 'decision',
      afterReviewRunId: 'run:prior-review',
      inputSequence: 2,
      handled: true,
      incorporatedPlanSha256: planSha256,
    },
    frozenContextSourceIds: ['input', 'input-2'],
  }
}
function planReview(): Facts<'plan_review_to_owner'> {
  return {
    ...common(),
    node: 'plan_review_to_owner',
    task: task(),
    plan: plan(),
    review: review('review', 3),
    previousReview: review('prior-review', 1),
    interveningOwnerResponse: response('response', 2),
  }
}
function ownerResponse(): Facts<'owner_to_review'> {
  return {
    ...common(),
    node: 'owner_to_review',
    task: task(),
    plan: plan(),
    ownerResponse: response('response', 4, 'review'),
    previousReview: review('review', 3),
    earlierReview: review('prior-review', 1),
    interveningOwnerResponse: response('prior-response', 2),
    retainedPlan: null,
    supplementGrant: null,
  }
}
function execution(): Facts<'execution_to_review'> {
  return {
    ...common(),
    node: 'execution_to_review',
    task: task(),
    scopeId: 'scope-1',
    scopeSourceId: 'scope',
    execution: { ...turn('execution', owner, 4), stage: 'repair' },
    precedingResponse: { ...response('response', 2), stage: 'respond', scopeId: 'scope-1' },
    continuation: null,
  }
}
function codeGrant(): RelayCodeFollowupGrant {
  return {
    authorizationId: 'authorization:respond_to_code_review',
    userReceiptId: 'user-action-1',
    taskId: 'task-1',
    budgetSubjectId: 'task:task-1',
    handoffId: 'handoff-1',
    actor: owner,
    inputSequence: 3,
    reviewSourceId: 'review',
    scopeId: 'scope-1',
    scopeSourceId: 'scope',
    action: 'respond_to_code_review',
    state: 'available',
    authorizationCurrent: true,
    businessBudgetAvailable: true,
  }
}
function codeReview(): Facts<'code_review_to_next'> {
  return {
    ...common(),
    node: 'code_review_to_next',
    task: task(),
    scopeId: 'scope-1',
    scopeSourceId: 'scope',
    review: { ...review('review', 3), scopeId: 'scope-1' },
    previousReview: { ...review('prior-review', 1), scopeId: 'scope-1' },
    interveningOwnerResponse: { ...response('response', 2), stage: 'respond', scopeId: 'scope-1' },
    followupGrant: codeGrant(),
    supplementGrant: null,
  }
}
function repairReview(): Facts<'code_review_to_next'> {
  const facts = codeReview()
  facts.followupGrant = null
  facts.repairOpportunity = {
    kind: 'repair',
    taskId: facts.task.taskId,
    afterRunId: facts.review.runId,
    actor: facts.task.owner,
    returnActor: facts.task.reviewer,
    inputSequence: facts.task.inputSequence,
    sourceFingerprint: 'f'.repeat(64),
    budgetAvailable: true,
  }
  return facts
}
function planGrant(): RelayPlanSupplementGrant {
  return {
    authorizationId: 'supplement-1',
    userReceiptId: 'user-action-1',
    taskId: 'task-1',
    budgetSubjectId: 'task:task-1',
    handoffId: 'handoff-1',
    actor: owner,
    inputSequence: 3,
    planSourceId: 'plan',
    planSha256,
    reviewSourceId: 'review',
    scope: 'read_only_plan_supplement',
    returnStage: 'plan_review',
    returnActor: reviewer,
    state: 'available',
    authorizationCurrent: true,
    durableBudgetAvailable: true,
    remainingTaskTurns: 2,
    remainingPlanTurns: 1,
  }
}
function codeSupplement(): RelayCodeSupplementGrant {
  const { action: _action, businessBudgetAvailable: _budget, ...grant } = codeGrant()
  return {
    ...grant,
    authorizationId: 'supplement-code-1',
    scope: 'read_only_code_response',
    returnStage: 'code_review',
    returnActor: reviewer,
    durableBudgetAvailable: true,
    returnReviewBudgetAvailable: true,
    remainingTaskTurns: 1,
    remainingCodeTurns: 1,
  }
}
function selected(result: RelayPolicyResult) {
  expect(result.kind).toBe('eligible')
  if (result.kind !== 'eligible') throw Error(`Unexpected skip: ${result.reason}`)
  return result
}

const normalNodes: [string, () => RelayPolicyFacts, string[]][] = [
  ['unrouted Send', send, ['route_codex', 'route_claude']],
  ['plan with processed decision', initialPlan, ['continue_plan_review']],
  ['repeated plan review', planReview, ['continue_plan_revision']],
  ['owner rereview', ownerResponse, ['continue_plan_review']],
  ['repair following Respond', execution, ['continue_code_review']],
  ['repeated code review with user Respond grant', codeReview, ['respond_to_code_review']],
]

describe('normal Relay policy', () => {
  it.each(normalNodes)(
    'admits %s using only the existing role and authorized candidates',
    (_label, create, ids) => {
      const facts = create(),
        before = structuredClone(facts)
      const result = selected(evaluateRelayPolicy(facts))
      expect(result.candidates.map((candidate) => candidate.id)).toEqual(ids)
      expect(result.requiredSources).toEqual(
        facts.materials.sources.map(({ id, roles }) => ({ id, roles })),
      )
      expect(facts).toEqual(before)
      expect(evaluateRelayPolicy(facts)).toEqual(result)
    },
  )

  it.each(normalNodes)(
    'preserves %s when resources or the same-fact claim are unavailable',
    (_label, create) => {
      const facts = create()
      facts.admission.evaluationResourcesAvailable = false
      expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'unavailable' })
      facts.admission.evaluationResourcesAvailable = true
      facts.admission.factAlreadyEvaluated = true
      expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'already_evaluated' })
    },
  )

  it.each(['known_unavailable', 'cooldown', 'busy'] as const)(
    'does not attempt a runtime marked %s by the current host',
    (runtimeAdmission) => {
      const facts = planReview()
      facts.admission.runtimeAdmission = runtimeAdmission
      expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'unavailable' })
    },
  )
  it.each(['enabled', 'modelSelected'] as const)('requires explicit current %s', (field) => {
    const facts = planReview()
    facts.admission[field] = false
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    // Unknown host facts cannot accidentally pass a truthiness default.
    Reflect.deleteProperty(facts.admission, field)
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
  })
  it.each(['pendingUserInput', 'nativeInteraction', 'newTaskDispatchProtected'] as const)(
    'does not cross %s protection',
    (field) => {
      const facts = planReview()
      facts.admission[field] = true
      expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'protected' })
      Reflect.deleteProperty(facts.admission, field)
      expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    },
  )

  it('admits complete material at 128 KiB and 12 sources, and never truncates over-budget input', () => {
    const facts = planReview()
    facts.materials.inputBytes = 128 * 1024
    facts.materials.sources = [...facts.materials.sources, source('comment', ['comment'], null)]
    selected(evaluateRelayPolicy(facts))
    facts.materials.inputBytes++
    expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'materials' })
    facts.materials.inputBytes--
    facts.materials.sources = [...facts.materials.sources, source('comment-2', ['comment'], null)]
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    expect(facts.materials.sources).toHaveLength(13)
  })

  it.each(['complete', 'settled', 'frozen'] as const)(
    'requires every frozen dependency to be %s',
    (field) => {
      const facts = planReview()
      facts.materials.sources[1]![field] = false
      expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'materials' })
    },
  )
  it('rejects incomplete collection, duplicate identities and understated byte counts', () => {
    const facts = planReview()
    facts.materials.complete = false
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.materials.complete = true
    facts.materials.sources[1]!.id = facts.materials.sources[0]!.id
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.materials.sources[1]!.id = 'input'
    facts.materials.inputBytes = 100
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
  })

  it('keeps fixed independent roles and rejects missing, exhausted or conflicting action authority', () => {
    const facts = planReview()
    facts.task.reviewer = owner
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.task.reviewer = reviewer
    facts.legalActions = [legal('continue_plan_revision', reviewer)]
    expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'no_candidate' })
    facts.legalActions = [
      { ...legal('continue_plan_revision', owner), businessBudgetAvailable: false },
    ]
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.legalActions = [
      { ...legal('continue_plan_revision', owner), authorizationCurrent: false },
    ]
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.legalActions = [
      legal('continue_plan_revision', owner),
      legal('continue_plan_revision', owner),
    ]
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
  })

  it('does not reset task budgets or accept a response from another task or actor', () => {
    const facts = planReview()
    facts.budgetSubjectId = 'new-run'
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.budgetSubjectId = 'task:task-1'
    facts.interveningOwnerResponse!.taskId = 'other-task'
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.interveningOwnerResponse!.taskId = 'task-1'
    facts.interveningOwnerResponse!.actor = reviewer
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
  })
})

describe('ordinary Send', () => {
  it('preserves the fixed recipient of workflow feedback even with implicit routing', () => {
    expect(evaluateRelayPolicy({ ...send(), ordinary: false }).kind).toBe('skip')
    expect(evaluateRelayPolicy({ ...send(), ordinary: null }).kind).toBe('skip')
  })
  it('admits a sole non-Primary source without granting Build or broadcasting', () => {
    const facts = send()
    facts.referencedSourceIds = ['review']
    expect(selected(evaluateRelayPolicy(facts)).candidates.map(({ action }) => action)).toEqual([
      'route_send',
      'route_send',
    ])
    facts.legalActions = [legal('route_send', reviewer), legal('repair_code', owner)]
    expect(selected(evaluateRelayPolicy(facts)).candidates.map(({ actor }) => actor)).toEqual([
      reviewer,
    ])
  })
  it.each(['agent', 'command', 'all'] as const)('skips explicit %s routing', (route) => {
    expect(evaluateRelayPolicy({ ...send(), route }).kind).toBe('skip')
  })
  it('skips no references, duplicate Primary references and missing Agent sources', () => {
    for (const referencedSourceIds of [
      [],
      ['response'],
      ['response', 'response'],
      ['input'],
      ['missing'],
    ])
      expect(evaluateRelayPolicy({ ...send(), referencedSourceIds }).kind).toBe('skip')
  })
})

describe('Plan handoffs', () => {
  it('skips a first plan, unprocessed decision or one frozen source', () => {
    expect(
      evaluateRelayPolicy({ ...initialPlan(), previousReview: null, processedDecision: null }).kind,
    ).toBe('skip')
    const facts = initialPlan()
    facts.processedDecision!.handled = false
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.processedDecision!.handled = true
    facts.frozenContextSourceIds = ['input', 'input']
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.frozenContextSourceIds = ['task', 'plan']
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
  })
  it('binds the processed user decision to the preceding review and current plan', () => {
    for (const patch of [
      { afterReviewRunId: 'other-run' },
      { inputSequence: 1 },
      { inputSequence: 4 },
      { incorporatedPlanSha256: otherSha256 },
    ]) {
      const facts = initialPlan()
      Object.assign(facts.processedDecision!, patch)
      expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    }
  })
  it('does not mistake first changes_requested for a repeated review chain', () => {
    expect(
      evaluateRelayPolicy({ ...planReview(), previousReview: null, interveningOwnerResponse: null })
        .kind,
    ).toBe('skip')
    const facts = planReview()
    facts.previousReview!.verdict = 'accepted'
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
  })
  it('requires a distinct, complete, settled response between the two reviews', () => {
    for (const patch of [
      { complete: false },
      { effectsSettled: false },
      { ordinal: 4 },
      { inReplyToRunId: 'unrelated-review' },
      { runId: 'run:prior-review' },
      { inputSequence: 4 },
    ]) {
      const facts = planReview()
      Object.assign(facts.interveningOwnerResponse!, patch)
      expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    }
    const facts = planReview()
    facts.review.planSha256 = otherSha256
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
  })
  it('requires the repeated review chain even when the exact Plan is explicitly retained', () => {
    const facts = ownerResponse()
    facts.earlierReview = null
    facts.interveningOwnerResponse = null
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.retainedPlan = { explicit: true, sha256: planSha256 }
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.previousReview.planSha256 = otherSha256
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.previousReview.planSha256 = planSha256
    facts.retainedPlan.explicit = false
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    const repeated = ownerResponse()
    repeated.retainedPlan = { explicit: true, sha256: planSha256 }
    selected(evaluateRelayPolicy(repeated))
    repeated.retainedPlan = null
    selected(evaluateRelayPolicy(repeated))
  })
  it('keeps the necessary reviewer and offers an extra owner Turn only with a complete specific grant', () => {
    const facts = ownerResponse()
    facts.supplementGrant = planGrant()
    expect(selected(evaluateRelayPolicy(facts)).candidates).toEqual([
      {
        id: 'continue_plan_review',
        action: 'continue_plan_review',
        actor: reviewer,
        authorizationId: 'authorization:continue_plan_review',
        effect: 'handoff_focus',
      },
      {
        id: 'supplement_plan',
        action: 'supplement_plan',
        actor: owner,
        authorizationId: 'supplement-1',
        effect: 'extra_plan_turn',
      },
    ])
    facts.legalActions = []
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
  })
  it.each([
    { userReceiptId: '' },
    { taskId: 'other-task' },
    { budgetSubjectId: 'run-2' },
    { handoffId: 'other-handoff' },
    { actor: reviewer },
    { inputSequence: 2 },
    { planSourceId: 'other-plan' },
    { planSha256: otherSha256 },
    { reviewSourceId: 'prior-review' },
    { returnActor: owner },
    { state: 'consumed' },
    { authorizationCurrent: false },
    { durableBudgetAvailable: false },
    { remainingTaskTurns: 0 },
    { remainingPlanTurns: 0 },
  ] satisfies Partial<RelayPlanSupplementGrant>[])(
    'ignores an invalid or exhausted extra-plan grant %j',
    (patch) => {
      const facts = ownerResponse()
      facts.supplementGrant = { ...planGrant(), ...patch }
      expect(selected(evaluateRelayPolicy(facts)).candidates.map(({ id }) => id)).toEqual([
        'continue_plan_review',
      ])
    },
  )
})

describe('implementation and code handoffs', () => {
  it('skips simple first Build and accepts same-scope Repair only after a complete Respond', () => {
    const facts = execution()
    facts.execution.stage = 'implement'
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.execution.stage = 'repair'
    facts.precedingResponse!.scopeId = 'different-scope'
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.precedingResponse!.scopeId = facts.scopeId
    facts.precedingResponse!.effectsSettled = false
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
  })
  it('requires durable continuation authority and old execution settlement', () => {
    const facts = execution()
    facts.execution.stage = 'implement'
    facts.precedingResponse = null
    facts.continuation = {
      authorizationId: 'original-write-grant',
      originalRunId: 'old-run',
      taskId: 'task-1',
      actor: owner,
      scopeId: 'scope-1',
      stage: 'implement',
      authorizationCurrent: true,
      durable: true,
      oldExecutionSettled: true,
    }
    selected(evaluateRelayPolicy(facts))
    for (const patch of [
      { durable: false },
      { oldExecutionSettled: false },
      { authorizationCurrent: false },
      { scopeId: 'other-scope' },
      { originalRunId: facts.execution.runId },
    ]) {
      const copy = structuredClone(facts)
      Object.assign(copy.continuation!, patch)
      expect(evaluateRelayPolicy(copy).kind).toBe('skip')
    }
  })
  it.each(['accepted', 'incomplete', 'needs_user'] as const)(
    'skips a current %s code verdict',
    (verdict) => {
      const facts = codeReview()
      facts.review.verdict = verdict
      expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    },
  )
  it('skips first review and incomplete, unrelated or later owner work', () => {
    expect(evaluateRelayPolicy({ ...codeReview(), previousReview: null }).kind).toBe('skip')
    for (const patch of [
      { complete: false },
      { scopeId: 'other-scope' },
      { ordinal: 4 },
      { inReplyToRunId: 'other-review' },
    ]) {
      const facts = codeReview()
      Object.assign(facts.interveningOwnerResponse!, patch)
      expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    }
  })
  it('waits for a real user action, then cannot convert Respond authority into Repair', () => {
    const facts = codeReview()
    facts.followupGrant = null
    expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'awaiting_user_action' })
    facts.followupGrant = codeGrant()
    expect(selected(evaluateRelayPolicy(facts)).candidates.map(({ action }) => action)).toEqual([
      'respond_to_code_review',
    ])
    facts.followupGrant = {
      ...codeGrant(),
      action: 'repair_code',
      authorizationId: 'authorization:repair_code',
    }
    facts.interveningOwnerResponse!.stage = 'repair'
    expect(selected(evaluateRelayPolicy(facts)).candidates.map(({ action }) => action)).toEqual([
      'repair_code',
    ])
  })
  it.each([
    { userReceiptId: '' },
    { handoffId: 'stale-handoff' },
    { inputSequence: 2 },
    { actor: reviewer },
    { reviewSourceId: 'prior-review' },
    { scopeId: 'other-scope' },
    { scopeSourceId: 'other-source' },
    { state: 'reserved' },
    { authorizationCurrent: false },
    { businessBudgetAvailable: false },
  ] satisfies Partial<RelayCodeFollowupGrant>[])(
    'rejects an unbound or unavailable code followup grant %j',
    (patch) => {
      expect(
        evaluateRelayPolicy({ ...codeReview(), followupGrant: { ...codeGrant(), ...patch } }).kind,
      ).toBe('skip')
    },
  )
  it('supports separately granted read-only code supplementation with its own task budget', () => {
    const facts = codeReview()
    facts.followupGrant = null
    facts.supplementGrant = codeSupplement()
    expect(selected(evaluateRelayPolicy(facts)).candidates).toEqual([
      {
        id: 'supplement_code_response',
        action: 'supplement_code_response',
        actor: owner,
        authorizationId: 'supplement-code-1',
        effect: 'extra_code_turn',
      },
    ])
    facts.supplementGrant.remainingCodeTurns = 0
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.supplementGrant.remainingCodeTurns = 1
    facts.supplementGrant.returnReviewBudgetAvailable = false
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.supplementGrant.returnReviewBudgetAvailable = true
    facts.supplementGrant.returnActor = owner
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.supplementGrant.returnActor = reviewer
    facts.supplementGrant.remainingTaskTurns = 0
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
  })
})

describe('grounded repair proposals', () => {
  it('offers only a user decision at the qualified repeated review and preserves the zero-extra-Turn fallback', () => {
    const facts = repairReview(),
      before = structuredClone(facts)
    const result = selected(evaluateRelayPolicy(facts))
    expect(result.candidates).toEqual([
      {
        id: 'propose_repair',
        action: 'propose_repair',
        actor: owner,
        authorizationId: null,
        effect: 'request_user_decision',
      },
    ])
    expect(result.requiredSources).toEqual(
      facts.materials.sources.map(({ id, roles }) => ({ id, roles })),
    )
    expect(facts).toEqual(before)
    expect(evaluateRelayPolicy(facts)).toEqual(result)
    facts.repairOpportunity = undefined
    expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'awaiting_user_action' })
  })

  it('offers both grounded requests without turning either proposal into execution authority', () => {
    const facts = repairReview()
    facts.supplementOpportunity = {
      kind: 'supplement_code_response',
      taskId: facts.task.taskId,
      actor: owner,
      returnActor: reviewer,
      inputSequence: facts.task.inputSequence,
      sourceFingerprint: 'e'.repeat(64),
      budgetAvailable: true,
    }
    facts.legalActions = []
    const result = selected(evaluateRelayPolicy(facts))
    expect(
      result.candidates.map(({ id, authorizationId, effect }) => ({ id, authorizationId, effect })),
    ).toEqual([
      {
        id: 'propose_supplement_code_response',
        authorizationId: null,
        effect: 'request_user_decision',
      },
      { id: 'propose_repair', authorizationId: null, effect: 'request_user_decision' },
    ])
  })

  it.each([
    { taskId: 'other-task' },
    { afterRunId: 'run:prior-review' },
    { actor: reviewer },
    { returnActor: owner },
    { inputSequence: 2 },
    { sourceFingerprint: '' },
    { sourceFingerprint: 'F'.repeat(64) },
    { budgetAvailable: false },
    { budgetAvailable: null },
  ] satisfies Partial<RelayRepairOpportunity>[])(
    'rejects an unavailable or unrelated host repair opportunity %j',
    (patch) => {
      const facts = repairReview()
      Object.assign(facts.repairOpportunity!, patch)
      expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'awaiting_user_action' })
    },
  )

  it('does not infer an opportunity kind or budget from absent host facts', () => {
    const facts = repairReview()
    Reflect.deleteProperty(facts.repairOpportunity!, 'budgetAvailable')
    expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'awaiting_user_action' })
    facts.repairOpportunity!.budgetAvailable = true
    Reflect.set(facts.repairOpportunity!, 'kind', 'supplement_code_response')
    expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'awaiting_user_action' })
  })

  it.each(['respond_to_code_review', 'repair_code'] as const)(
    'preserves a current manual %s grant without adding another question',
    (action) => {
      const facts = repairReview()
      facts.followupGrant = {
        ...codeGrant(),
        action,
        authorizationId: `authorization:${action}`,
      }
      expect(selected(evaluateRelayPolicy(facts)).candidates.map(({ id }) => id)).toEqual([action])
    },
  )

  it.each(['reserved', 'consumed', 'unknown'] as const)(
    'does not replace a %s manual claim with a new repair proposal',
    (state) => {
      const facts = repairReview()
      facts.followupGrant = { ...codeGrant(), state }
      expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'awaiting_user_action' })
    },
  )

  it('preserves the separately granted code supplement instead of replacing its owner', () => {
    const facts = repairReview()
    facts.supplementGrant = codeSupplement()
    expect(selected(evaluateRelayPolicy(facts)).candidates.map(({ id }) => id)).toEqual([
      'supplement_code_response',
    ])
  })

  it.each(['complete', 'settled', 'frozen'] as const)(
    'requires a known %s current source before proposing repair',
    (field) => {
      const facts = repairReview()
      facts.materials.sources.find((entry) => entry.id === 'review')![field] = null
      expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'materials' })
    },
  )

  it.each(['task', 'review', 'prior-review', 'response', 'scope'])(
    'requires the complete %s source at the same trust boundary as code supplementation',
    (id) => {
      const facts = repairReview()
      facts.materials.sources = facts.materials.sources.filter((entry) => entry.id !== id)
      expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'ineligible' })
    },
  )

  it.each([
    (facts: Facts<'code_review_to_next'>) => {
      facts.previousReview = null
    },
    (facts: Facts<'code_review_to_next'>) => {
      facts.interveningOwnerResponse = null
    },
    (facts: Facts<'code_review_to_next'>) => {
      facts.review.actor = owner
    },
    (facts: Facts<'code_review_to_next'>) => {
      facts.task.reviewer = owner
    },
    (facts: Facts<'code_review_to_next'>) => {
      facts.review.verdict = 'needs_user'
    },
    (facts: Facts<'code_review_to_next'>) => {
      facts.previousReview!.verdict = 'accepted'
    },
    (facts: Facts<'code_review_to_next'>) => {
      facts.review.scopeId = 'new-scope'
    },
    (facts: Facts<'code_review_to_next'>) => {
      facts.interveningOwnerResponse!.inReplyToRunId = 'other-review'
    },
    (facts: Facts<'code_review_to_next'>) => {
      facts.interveningOwnerResponse!.ordinal = facts.review.ordinal
    },
    (facts: Facts<'code_review_to_next'>) => {
      facts.materials.sources.find((entry) => entry.id === 'review')!.actor = owner
    },
  ])(
    'preserves the existing repeated-review, role, scope and chronology obligations %#',
    (alter) => {
      const facts = repairReview()
      alter(facts)
      expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'ineligible' })
    },
  )

  it('does not add a repair question to another otherwise eligible workflow node', () => {
    const facts = planReview()
    facts.repairOpportunity = repairReview().repairOpportunity
    expect(selected(evaluateRelayPolicy(facts)).candidates.map(({ id }) => id)).toEqual([
      'continue_plan_revision',
    ])
  })
})

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`

function workflowSnapshot(
  node: RelayWorkflowSnapshot['node'] = 'plan_review_to_owner',
): RelayWorkflowSnapshot {
  const planning =
    node === 'plan_to_review' || node === 'plan_review_to_owner' || node === 'owner_to_review'
  const taskId = uuid(100),
    scopeId = 'c'.repeat(64)
  const document = (index: number) => ({
    id: uuid(index + 1),
    sha256: planSha256,
    bytes: 100,
    chars: 100,
  })
  const makeTurn = (
    index: number,
    stage: CollaborationTask['stage'],
    ordinal: number,
  ): RelayWorkflowTurnSource => ({
    taskId,
    runId: uuid(index + 200),
    actor: stage === 'plan_review' || stage === 'code_review' ? reviewer : owner,
    stage,
    inputSequence: 3,
    ordinal,
    sourceId: `s${index}`,
    document: document(index),
    messageId: uuid(index + 300),
    sourceRevision: 1,
    inReplyToRunId:
      stage === 'plan' || stage === 'respond' || stage === 'repair' ? uuid(204) : null,
    verdict: stage === 'plan_review' || stage === 'code_review' ? 'changes_requested' : null,
    planSha256: planning ? planSha256 : null,
    scopeId,
  })
  const producer = makeTurn(
    3,
    node === 'execution_to_review'
      ? 'repair'
      : node === 'code_review_to_next'
        ? 'code_review'
        : node === 'plan_review_to_owner'
          ? 'plan_review'
          : 'plan',
    node === 'plan_review_to_owner' || node === 'code_review_to_next' ? 3 : 4,
  )
  const previous = makeTurn(
    4,
    planning ? 'plan_review' : 'code_review',
    node === 'owner_to_review' ? 3 : 1,
  )
  if (node === 'plan_to_review') previous.inputSequence = 1
  const earlier = makeTurn(6, planning ? 'plan_review' : 'code_review', 1)
  const ownerTurn = makeTurn(5, planning ? 'plan' : 'respond', 2)
  if (node === 'owner_to_review') ownerTurn.inReplyToRunId = earlier.runId
  const reviews = node === 'owner_to_review' ? [previous, earlier] : [previous]
  const responses = node === 'plan_to_review' ? [] : [ownerTurn]
  const sources: RelaySource[] = [],
    sourceActors: RelayWorkflowSnapshot['sourceActors'] = {}
  const add = (
    index: number,
    roles: RelaySource['roles'],
    actor: RuntimeAgentId | null,
    evidence?: RelayWorkflowTurnSource,
  ) => {
    sources.push({
      id: `s${index}`,
      roles,
      document: document(index),
      evaluatedSha256: planSha256,
      ...(evidence
        ? {
            sourceRunId: evidence.runId,
            messageId: evidence.messageId,
            inputSequence: evidence.inputSequence,
          }
        : {}),
    })
    sourceActors[`s${index}`] = actor
  }
  add(0, ['task', 'input'], null)
  add(1, ['input', 'user_decision'], null)
  if (planning) add(2, ['plan'], owner)
  add(
    3,
    [
      node === 'execution_to_review'
        ? 'execution'
        : node === 'plan_review_to_owner' || node === 'code_review_to_next'
          ? 'review'
          : 'owner_response',
    ],
    producer.actor,
    producer,
  )
  add(4, ['review', 'prior_review'], reviewer, previous)
  if (responses.length) add(5, ['owner_response'], owner, ownerTurn)
  if (reviews.length > 1) add(6, ['review'], reviewer, earlier)
  add(7, ['review_scope'], null)
  const planReference = planning
    ? { version: 1, sourceRunId: uuid(90), sourceMessageId: uuid(91), document: document(2) }
    : undefined
  const workflowTask: CollaborationTask = {
    protocol: 'native-workflow-v1',
    id: taskId,
    sessionId: uuid(101),
    kind: planning ? 'plan' : 'build',
    revision: producer.ordinal,
    owner,
    reviewer,
    task: 'Verify the frozen workflow.',
    taskDocument: document(0),
    taskMessageId: uuid(102),
    stage: producer.stage,
    actor: producer.actor,
    status: 'waiting',
    automation: 'active',
    runId: producer.runId,
    inputSequence: 3,
    handledInputSequence: 3,
    planVersion: planning ? 1 : 0,
    ...(planReference ? { planReference, planInputSequence: 3 } : {}),
    discussionRounds: 2,
    reviewCycles: 2,
    repairAttempts: 1,
  }
  return {
    task: workflowTask,
    basis: {
      kind: 'workflow',
      task: { id: workflowTask.id, inputSequence: workflowTask.inputSequence },
      producerRunId: producer.runId,
      plan: planReference ?? null,
      input: null,
    },
    node,
    producer,
    reviews,
    responses,
    sources,
    sourceGrants: [],
    sourceActors,
    planSourceId: planning ? 's2' : null,
    scopeSourceId: 's7',
    sourceFingerprint: 'f'.repeat(64),
    retainedPlanSha256: null,
    processedDecision:
      node === 'plan_to_review'
        ? {
            sourceId: 's1',
            afterReviewRunId: previous.runId,
            inputSequence: 2,
            incorporatedPlanSha256: planSha256,
          }
        : null,
  }
}

function mappingOptions(
  options: Partial<RelayWorkflowPolicyOptions> = {},
): RelayWorkflowPolicyOptions {
  return {
    handoffId: 'd'.repeat(64),
    admission: common().admission,
    legalActions: common().legalActions,
    inputBytes: 4096,
    ...options,
  }
}

function mapped(snapshot: RelayWorkflowSnapshot, options = mappingOptions()) {
  const facts = relayWorkflowPolicyFacts(snapshot, options)
  expect(facts).toBeDefined()
  if (!facts) throw Error('Missing workflow policy facts')
  return facts
}

function snapshotCodeGrant(snapshot: RelayWorkflowSnapshot): RelayCodeFollowupGrant {
  return {
    ...codeGrant(),
    taskId: snapshot.task.id,
    budgetSubjectId: `task:${snapshot.task.id}`,
    handoffId: mappingOptions().handoffId,
    reviewSourceId: snapshot.producer.sourceId,
    scopeId: snapshot.producer.scopeId,
    scopeSourceId: snapshot.scopeSourceId,
  }
}

describe('Repository workflow snapshot mapping', () => {
  it('forwards an exact host repair opportunity with its current producer and fixed roles', () => {
    const snapshot = workflowSnapshot('code_review_to_next'),
      opportunity: RelayRepairOpportunity = {
        kind: 'repair',
        taskId: snapshot.task.id,
        afterRunId: snapshot.producer.runId,
        actor: snapshot.task.owner,
        returnActor: snapshot.task.reviewer,
        inputSequence: snapshot.task.inputSequence,
        sourceFingerprint: snapshot.sourceFingerprint,
        budgetAvailable: true,
      },
      options = mappingOptions({ repairOpportunity: opportunity }),
      before = structuredClone({ snapshot, options })
    const facts = mapped(snapshot, options)
    expect(facts.repairOpportunity).toEqual(opportunity)
    expect(selected(evaluateRelayPolicy(facts)).candidates).toEqual([
      {
        id: 'propose_repair',
        action: 'propose_repair',
        actor: owner,
        authorizationId: null,
        effect: 'request_user_decision',
      },
    ])
    expect({ snapshot, options }).toEqual(before)
    snapshot.sourceActors[snapshot.producer.sourceId] = owner
    expect(relayWorkflowPolicyFacts(snapshot, options)).toBeUndefined()
  })

  it.each([
    'plan_to_review',
    'plan_review_to_owner',
    'owner_to_review',
    'execution_to_review',
  ] as const)(
    'maps complete %s facts through the existing policy without mutating the snapshot',
    (node) => {
      const snapshot = workflowSnapshot(node),
        before = structuredClone(snapshot)
      const facts = mapped(snapshot),
        result = selected(evaluateRelayPolicy(facts))
      expect(result.node).toBe(node)
      expect(facts.budgetSubjectId).toBe(`task:${snapshot.task.id}`)
      expect(facts.handoffId).toBe(mappingOptions().handoffId)
      expect(facts.materials.inputBytes).toBe(4096)
      expect(
        facts.materials.sources.map(({ id, actor, sha256 }) => ({ id, actor, sha256 })),
      ).toEqual(
        snapshot.sources.map((entry) => ({
          id: entry.id,
          actor: snapshot.sourceActors[entry.id],
          sha256: entry.document.sha256,
        })),
      )
      expect(snapshot).toEqual(before)
      expect(relayWorkflowPolicyFacts(snapshot, mappingOptions())).toEqual(facts)
    },
  )

  it.each([
    'plan_to_review',
    'plan_review_to_owner',
    'owner_to_review',
    'execution_to_review',
    'code_review_to_next',
  ] as const)('keeps a simple first %s path ineligible', (node) => {
    const snapshot = workflowSnapshot(node)
    snapshot.responses = []
    if (node === 'owner_to_review') snapshot.reviews.splice(1)
    else snapshot.reviews = []
    snapshot.processedDecision = null
    if (node === 'execution_to_review') {
      snapshot.producer.stage = 'implement'
      snapshot.task.stage = 'implement'
    }
    expect(evaluateRelayPolicy(mapped(snapshot)).kind).toBe('skip')
  })

  it('maps the two-review Plan chain and refuses an unrelated response or changed reviewed Plan', () => {
    const snapshot = workflowSnapshot()
    const facts = mapped(snapshot)
    if (facts.node !== 'plan_review_to_owner') throw Error('Wrong node')
    expect(facts.previousReview?.runId).toBe(snapshot.reviews[0]!.runId)
    expect(facts.interveningOwnerResponse?.runId).toBe(snapshot.responses[0]!.runId)
    expect(selected(evaluateRelayPolicy(facts)).candidates.map(({ id }) => id)).toEqual([
      'continue_plan_revision',
    ])
    snapshot.responses[0]!.inReplyToRunId = uuid(999)
    expect(evaluateRelayPolicy(mapped(snapshot)).kind).toBe('skip')
    snapshot.responses[0]!.inReplyToRunId = snapshot.reviews[0]!.runId
    snapshot.producer.planSha256 = otherSha256
    expect(evaluateRelayPolicy(mapped(snapshot)).kind).toBe('skip')
  })

  it('requires durable handled input evidence and retains all distinct frozen context sources', () => {
    const snapshot = workflowSnapshot('plan_to_review')
    const facts = mapped(snapshot)
    if (facts.node !== 'plan_to_review') throw Error('Wrong node')
    expect(facts.processedDecision).toEqual({ ...snapshot.processedDecision, handled: true })
    expect(facts.frozenContextSourceIds).toEqual(['s0', 's1'])
    snapshot.task.handledInputSequence = 1
    expect(relayWorkflowPolicyFacts(snapshot, mappingOptions())).toBeUndefined()
    snapshot.task.handledInputSequence = 3
    snapshot.processedDecision!.incorporatedPlanSha256 = otherSha256
    expect(relayWorkflowPolicyFacts(snapshot, mappingOptions())).toBeUndefined()
  })

  it('preserves exact native retention but requires repeated reviews before any supplement option', () => {
    const snapshot = workflowSnapshot('owner_to_review')
    snapshot.reviews.splice(1)
    snapshot.responses = []
    expect(evaluateRelayPolicy(mapped(snapshot)).kind).toBe('skip')
    snapshot.retainedPlanSha256 = planSha256
    const facts = mapped(snapshot)
    if (facts.node !== 'owner_to_review') throw Error('Wrong node')
    expect(facts.retainedPlan).toEqual({ explicit: true, sha256: planSha256 })
    expect(facts.supplementGrant).toBeNull()
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    const grant = {
      ...planGrant(),
      taskId: snapshot.task.id,
      budgetSubjectId: `task:${snapshot.task.id}`,
      handoffId: mappingOptions().handoffId,
      planSourceId: snapshot.planSourceId!,
      reviewSourceId: snapshot.reviews[0]!.sourceId,
    }
    expect(
      evaluateRelayPolicy(mapped(snapshot, mappingOptions({ planSupplementGrant: grant }))).kind,
    ).toBe('skip')
    const repeated = workflowSnapshot('owner_to_review')
    repeated.retainedPlanSha256 = planSha256
    const repeatedGrant = {
      ...grant,
      taskId: repeated.task.id,
      planSourceId: repeated.planSourceId!,
      reviewSourceId: repeated.reviews[0]!.sourceId,
    }
    const result = selected(
      evaluateRelayPolicy(mapped(repeated, mappingOptions({ planSupplementGrant: repeatedGrant }))),
    )
    expect(result.candidates.map(({ id }) => id)).toEqual([
      'continue_plan_review',
      'supplement_plan',
    ])
    snapshot.retainedPlanSha256 = otherSha256
    expect(relayWorkflowPolicyFacts(snapshot, mappingOptions())).toBeUndefined()
  })

  it('supports code review without a Plan and never converts a Respond grant to Repair', () => {
    const snapshot = workflowSnapshot('code_review_to_next')
    expect(snapshot.basis.plan).toBeNull()
    const facts = mapped(snapshot)
    if (facts.node !== 'code_review_to_next') throw Error('Wrong node')
    expect(facts.followupGrant).toBeNull()
    expect(facts.supplementGrant).toBeNull()
    expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'awaiting_user_action' })
    const grant = snapshotCodeGrant(snapshot)
    const allowed = selected(
      evaluateRelayPolicy(mapped(snapshot, mappingOptions({ codeFollowupGrant: grant }))),
    )
    expect(allowed.candidates.map(({ action }) => action)).toEqual(['respond_to_code_review'])
    grant.action = 'repair_code'
    expect(
      evaluateRelayPolicy(mapped(snapshot, mappingOptions({ codeFollowupGrant: grant }))).kind,
    ).toBe('skip')
  })

  it('maps separate code supplementation without creating an ordinary code action', () => {
    const snapshot = workflowSnapshot('code_review_to_next')
    const {
      action: _action,
      businessBudgetAvailable: _budget,
      ...binding
    } = snapshotCodeGrant(snapshot)
    const grant: RelayCodeSupplementGrant = {
      ...binding,
      authorizationId: 'code-supplement',
      scope: 'read_only_code_response',
      returnStage: 'code_review',
      returnActor: reviewer,
      durableBudgetAvailable: true,
      returnReviewBudgetAvailable: true,
      remainingTaskTurns: 1,
      remainingCodeTurns: 1,
    }
    const result = selected(
      evaluateRelayPolicy(mapped(snapshot, mappingOptions({ codeSupplementGrant: grant }))),
    )
    expect(result.candidates.map(({ id }) => id)).toEqual(['supplement_code_response'])
  })

  it('uses explicit continuation evidence only, without inferring it from pending work', () => {
    const snapshot = workflowSnapshot('execution_to_review')
    expect(snapshot.basis.plan).toBeNull()
    selected(evaluateRelayPolicy(mapped(snapshot)))
    snapshot.responses = []
    snapshot.task.pendingWork = { stage: 'repair', runId: uuid(999), inputSequence: 3 }
    const facts = mapped(snapshot)
    if (facts.node !== 'execution_to_review') throw Error('Wrong node')
    expect(facts.continuation).toBeNull()
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    const continuation: NonNullable<RelayWorkflowPolicyOptions['continuation']> = {
      authorizationId: 'continuation-grant',
      originalRunId: uuid(999),
      taskId: snapshot.task.id,
      actor: owner,
      scopeId: snapshot.producer.scopeId,
      stage: 'repair',
      authorizationCurrent: true,
      durable: true,
      oldExecutionSettled: true,
    }
    selected(evaluateRelayPolicy(mapped(snapshot, mappingOptions({ continuation }))))
    continuation.oldExecutionSettled = false
    expect(evaluateRelayPolicy(mapped(snapshot, mappingOptions({ continuation }))).kind).toBe(
      'skip',
    )
  })

  it.each([
    (value: RelayWorkflowSnapshot) => {
      value.basis.task.id = uuid(999)
    },
    (value: RelayWorkflowSnapshot) => {
      value.basis.producerRunId = uuid(999)
    },
    (value: RelayWorkflowSnapshot) => {
      value.producer.taskId = uuid(999)
    },
    (value: RelayWorkflowSnapshot) => {
      value.producer.document = { ...value.producer.document, sha256: otherSha256 }
    },
    (value: RelayWorkflowSnapshot) => {
      value.producer.stage = 'implement'
    },
    (value: RelayWorkflowSnapshot) => {
      value.planSourceId = null
    },
    (value: RelayWorkflowSnapshot) => {
      value.task.planInputSequence = 2
    },
    (value: RelayWorkflowSnapshot) => {
      Reflect.deleteProperty(value.sourceActors, value.producer.sourceId)
    },
    (value: RelayWorkflowSnapshot) => {
      value.sources.find((entry) => entry.id === value.producer.sourceId)!.sourceRunId = uuid(999)
    },
    (value: RelayWorkflowSnapshot) => {
      value.reviews[0]!.verdict = null
    },
    (value: RelayWorkflowSnapshot) => {
      value.reviews[0]!.actor = owner
    },
    (value: RelayWorkflowSnapshot) => {
      value.responses[0]!.ordinal = value.producer.ordinal + 1
    },
  ])('refuses contradictory or missing host facts %#', (alter) => {
    const snapshot = workflowSnapshot()
    alter(snapshot)
    expect(relayWorkflowPolicyFacts(snapshot, mappingOptions())).toBeUndefined()
  })
})

describe('host-declared ordinary information admission', () => {
  function declared() {
    const facts = send()
    facts.budgetSubjectId = 'input:original-input'
    facts.materials.sources = [
      ...facts.materials.sources,
      source('declared-field', ['input'], null),
    ]
    facts.informationOpportunity = {
      fieldId: 'user-field',
      sourceId: 'declared-field',
      document: { id: 'declared-document', sha256: planSha256, bytes: 100, chars: 100 },
      batchId: 'original-batch',
      clientMessageId: 'original-input',
      requestFingerprint: otherSha256,
      sourceFingerprint: otherSha256,
      defaultAgentId: owner,
      handoffId: facts.handoffId,
      unanswered: true,
    }
    return facts
  }
  it('offers only the registered unanswered field and retains both legal recipients', () => {
    const result = evaluateRelayPolicy(declared())
    if (result.kind !== 'eligible') throw Error('Expected the original qualified route.')
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      'route_codex',
      'route_claude',
      'clarify_prepared_input',
    ])
  })
  it.each([
    'missing',
    'answered',
    'foreign-handoff',
    'foreign-input',
    'foreign-source',
    'wrong-hash',
    'wrong-recipient',
  ] as const)(
    'does not admit an information candidate when %s, while keeping the original routing path',
    (change) => {
      const facts = declared(),
        information = facts.informationOpportunity!
      if (change === 'missing') facts.informationOpportunity = undefined
      if (change === 'answered') information.unanswered = false
      if (change === 'foreign-handoff') information.handoffId = 'another-handoff'
      if (change === 'foreign-input') information.clientMessageId = 'another-input'
      if (change === 'foreign-source') information.sourceId = 'not-present'
      if (change === 'wrong-hash') information.document.sha256 = otherSha256
      if (change === 'wrong-recipient') information.defaultAgentId = reviewer
      const result = evaluateRelayPolicy(facts)
      if (result.kind !== 'eligible') throw Error('The legal original route must remain available.')
      expect(result.candidates.map((candidate) => candidate.id)).toEqual([
        'route_codex',
        'route_claude',
      ])
    },
  )
})
