import { describe, expect, it } from 'vitest'

import type { RuntimeAgentId } from '@pact/contracts'

import type {
  RelayAction,
  RelayLegalAction,
  RelayPolicyFacts,
  RelayPolicyResult,
  RelayPolicySource,
  RelaySourceRole,
} from './relay-policy.js'

import { evaluateRelayPolicy } from './relay-policy.js'

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
    budgetSubjectId: 'input-1',
    admission: {
      enabled: true,
      keyConfigured: true,
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
    legalActions: [legal('route_send', owner), legal('route_send', reviewer)],
  }
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
function selected(result: RelayPolicyResult) {
  expect(result.kind).toBe('eligible')
  if (result.kind !== 'eligible') throw Error(`Unexpected skip: ${result.reason}`)
  return result
}

describe('normal Relay policy', () => {
  it('admits an unrouted Send using only the existing role and authorized candidates', () => {
    const facts = send(),
      before = structuredClone(facts)
    const result = selected(evaluateRelayPolicy(facts))
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      'route_codex',
      'route_claude',
    ])
    expect(result.requiredSources).toEqual(
      facts.materials.sources.map(({ id, roles }) => ({ id, roles })),
    )
    expect(facts).toEqual(before)
    expect(evaluateRelayPolicy(facts)).toEqual(result)
  })

  it('preserves the input when resources or the same-fact claim are unavailable', () => {
    const facts = send()
    facts.admission.evaluationResourcesAvailable = false
    expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'unavailable' })
    facts.admission.evaluationResourcesAvailable = true
    facts.admission.factAlreadyEvaluated = true
    expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'already_evaluated' })
  })

  it.each(['known_unavailable', 'busy'] as const)(
    'does not attempt a runtime marked %s by the current host',
    (runtimeAdmission) => {
      const facts = send()
      facts.admission.runtimeAdmission = runtimeAdmission
      expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'unavailable' })
    },
  )
  it.each(['enabled', 'keyConfigured'] as const)('requires explicit current %s', (field) => {
    const facts = send()
    facts.admission[field] = false
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    // Unknown host facts cannot accidentally pass a truthiness default.
    Reflect.deleteProperty(facts.admission, field)
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
  })
  it.each(['pendingUserInput', 'nativeInteraction', 'newTaskDispatchProtected'] as const)(
    'does not cross %s protection',
    (field) => {
      const facts = send()
      facts.admission[field] = true
      expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'protected' })
      Reflect.deleteProperty(facts.admission, field)
      expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    },
  )

  it('admits complete material at 128 KiB and 12 sources, and never truncates over-budget input', () => {
    const facts = send()
    facts.materials.inputBytes = 128 * 1024
    facts.materials.sources = [...facts.materials.sources, source('input-3', ['input'], null)]
    selected(evaluateRelayPolicy(facts))
    facts.materials.inputBytes++
    expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'materials' })
    facts.materials.inputBytes--
    facts.materials.sources = [...facts.materials.sources, source('input-4', ['input'], null)]
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    expect(facts.materials.sources).toHaveLength(13)
  })

  it.each(['complete', 'settled', 'frozen'] as const)(
    'requires every frozen dependency to be %s',
    (field) => {
      const facts = send()
      facts.materials.sources[1]![field] = false
      expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'materials' })
    },
  )
  it('rejects incomplete collection, duplicate identities and understated byte counts', () => {
    const facts = send()
    facts.materials.complete = false
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.materials.complete = true
    facts.materials.sources[1]!.id = facts.materials.sources[0]!.id
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.materials.sources[1]!.id = 'input'
    facts.materials.inputBytes = 100
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
  })

  it('rejects missing, exhausted or conflicting route authority', () => {
    const facts = send()
    facts.legalActions = [legal('route_send', reviewer)]
    expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'no_candidate' })
    facts.legalActions = [
      { ...legal('route_send', owner), businessBudgetAvailable: false },
      legal('route_send', reviewer),
    ]
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.legalActions = [
      { ...legal('route_send', owner), authorizationCurrent: false },
      legal('route_send', reviewer),
    ]
    expect(evaluateRelayPolicy(facts).kind).toBe('skip')
    facts.legalActions = [
      legal('route_send', owner),
      legal('route_send', owner),
      legal('route_send', reviewer),
    ]
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
    facts.legalActions = [legal('route_send', reviewer)]
    expect(evaluateRelayPolicy(facts)).toEqual({ kind: 'skip', reason: 'no_candidate' })
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
  it('retains a declared field as the meaningful alternative for a single recipient', () => {
    const facts = declared()
    facts.legalActions = [legal('route_send', owner)]
    expect(
      selected(evaluateRelayPolicy(facts)).candidates.map((candidate) => candidate.id),
    ).toEqual(['route_claude', 'clarify_prepared_input'])
  })
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
