import { describe, expect, it } from 'vitest'

import {
  RELAY_DECISION_BYTES,
  relayAnswerMatchesDecision,
  relayDecisionAnswerSchema,
  relayDecisionReceiptSchema,
  relaySchedulingDecisionProofSchema,
  relaySchedulingDecisionSchema,
  type RelayDecisionAnswer,
  type RelaySchedulingDecision,
} from './relay-decisions.js'

const randomUUID = () => crypto.randomUUID()

function card(): RelaySchedulingDecision {
  return {
    version: 'relay-decision-v2',
    sessionId: randomUUID(),
    decisionId: randomUUID(),
    revision: 3,
    handoffId: 'a'.repeat(64),
    title: 'Clarify the current Plan before review?',
    reason: 'Check the cancellation boundary against the cited original review.',
    consequence: 'One read-only author turn returns to the fixed reviewer.',
    sources: [{ id: 'review:1', label: 'Current review' }],
    request: {
      category: 'new_authorization',
      operation: {
        kind: 'supplement_plan',
        taskId: randomUUID(),
        afterRunId: randomUUID(),
        actor: 'codex',
        returnActor: 'claude',
        scopeFingerprint: 'b'.repeat(64),
      },
    },
  }
}

function answer(decision: RelaySchedulingDecision): RelayDecisionAnswer {
  return {
    reference: {
      sessionId: decision.sessionId,
      decisionId: decision.decisionId,
      revision: decision.revision,
    },
    clientOperationId: randomUUID(),
    answer: { kind: 'confirm' },
  }
}

describe('Relay scheduling decision v2 public contracts', () => {
  it('admits only the three typed scheduling categories and rejects executable or native-answer fields', () => {
    const decision = card()
    expect(relaySchedulingDecisionSchema.parse(decision)).toEqual(decision)
    expect(
      relaySchedulingDecisionSchema.safeParse({
        ...decision,
        request: { category: 'needs_user', prompt: 'Resolve the Agent technical dispute.' },
      }).success,
    ).toBe(false)
    expect(
      relaySchedulingDecisionSchema.safeParse({
        ...decision,
        request: { ...decision.request, command: 'execute arbitrary text' },
      }).success,
    ).toBe(false)
    const response = answer(decision)
    for (const extra of [{ requestId: randomUUID() }, { nativeAnswer: { approved: true } }])
      expect(relayDecisionAnswerSchema.safeParse({ ...response, ...extra }).success).toBe(false)
    expect(
      relaySchedulingDecisionSchema.safeParse({
        ...decision,
        request: {
          category: 'arrangement_change',
          operation: {
            kind: 'rebuild_native_context',
            agentId: 'codex',
            expectedGeneration: 2,
            expectedNativeSessionId: 'native:owned',
            expectedRunId: randomUUID(),
            expectedRebuildId: null,
            abandonOldWork: false,
          },
        },
      }).success,
    ).toBe(true)
  })

  it('requires the exact Session, decision and revision even when a confirmation is otherwise valid', () => {
    const decision = card(),
      response = answer(decision)
    expect(relayAnswerMatchesDecision(decision, response)).toBe(true)
    for (const reference of [
      { ...response.reference, sessionId: randomUUID() },
      { ...response.reference, decisionId: randomUUID() },
      { ...response.reference, revision: decision.revision + 1 },
    ])
      expect(relayAnswerMatchesDecision(decision, { ...response, reference })).toBe(false)
    expect(
      relayAnswerMatchesDecision(decision, {
        ...response,
        answer: { kind: 'text', fieldId: randomUUID(), text: 'I agree.' },
      }),
    ).toBe(false)
  })

  it('binds necessary information to one exact host field and bounded option or text input', () => {
    const decision = card(),
      fieldId = randomUUID(),
      optionId = randomUUID()
    decision.request = {
      category: 'necessary_information',
      consumer: {
        kind: 'prepared_input_clarification',
        batchId: randomUUID(),
        clientMessageId: randomUUID(),
        requestFingerprint: 'a'.repeat(64),
        sourceFingerprint: 'b'.repeat(64),
        defaultAgentId: 'codex',
      },
      field: {
        fieldId,
        prompt: 'Which already-defined Session arrangement should be used?',
        input: {
          kind: 'single',
          options: [
            { id: optionId, label: 'Keep the current arrangement' },
            { id: randomUUID(), label: 'Use the named alternative' },
          ],
        },
      },
    }
    expect(relaySchedulingDecisionSchema.safeParse(decision).success).toBe(true)
    const response = answer(decision)
    expect(relayAnswerMatchesDecision(decision, response)).toBe(false)
    response.answer = { kind: 'selection', fieldId, optionId }
    expect(relayAnswerMatchesDecision(decision, response)).toBe(true)
    expect(
      relayAnswerMatchesDecision(decision, {
        ...response,
        answer: { kind: 'selection', fieldId, optionId: randomUUID() },
      }),
    ).toBe(false)
    decision.request.field.input = { kind: 'text', maxLength: 8 }
    for (const [text, accepted] of [
      ['required', true],
      ['too much information', false],
    ] as const)
      expect(
        relayAnswerMatchesDecision(decision, {
          ...response,
          answer: { kind: 'text', fieldId, text },
        }),
      ).toBe(accepted)
    expect(
      relayAnswerMatchesDecision(decision, {
        ...response,
        answer: { kind: 'text', fieldId: randomUUID(), text: 'required' },
      }),
    ).toBe(false)
    expect(relayAnswerMatchesDecision(decision, { ...response, answer: { kind: 'cancel' } })).toBe(
      true,
    )
  })

  it('checks the complete UTF-8 card budget without truncating individually valid fields', () => {
    const decision = card()
    decision.reason = '汉'.repeat(512)
    decision.consequence = '汉'.repeat(512)
    decision.title = '汉'.repeat(160)
    expect(new TextEncoder().encode(JSON.stringify(decision)).byteLength).toBeGreaterThan(
      RELAY_DECISION_BYTES,
    )
    expect(relaySchedulingDecisionSchema.safeParse(decision).success).toBe(false)
    expect(decision.reason).toHaveLength(512)
    expect(
      relayDecisionAnswerSchema.safeParse({ ...answer(card()), clientOperationId: 'nonce' })
        .success,
    ).toBe(false)
  })

  it('requires execution freshness in durable proof and keeps receipts distinct from new authority', () => {
    const decision = card()
    const proof = {
      version: 'relay-decision-proof-v2',
      card: decision,
      handoff: {
        id: decision.handoffId,
        sessionId: decision.sessionId,
        budgetRoot: { kind: 'task', id: randomUUID() },
        budgetSubjectId: 'task:owned',
        eventId: 'stage:owned',
        slot: 'workflow_next',
        factFingerprint: 'b'.repeat(64),
        freshnessGuard: {
          taskRevision: 1,
          settingsRevision: 1,
          inputSequence: 0,
          runId: randomUUID(),
          bindingGeneration: 1,
          agentId: 'codex',
          stateFingerprint: 'c'.repeat(64),
        },
      },
      configurationGeneration: 1,
      evaluationId: randomUUID(),
      inputSha256: 'c'.repeat(64),
      sourceFingerprint: 'd'.repeat(64),
      candidateId: 'propose_supplement_plan',
      operationFingerprint: 'e'.repeat(64),
      executionFingerprint: 'f'.repeat(64),
    }
    expect(relaySchedulingDecisionProofSchema.safeParse(proof).success).toBe(true)
    expect(
      relaySchedulingDecisionProofSchema.safeParse({
        ...proof,
        executionFingerprint: undefined,
      }).success,
    ).toBe(false)
    expect(
      relayDecisionReceiptSchema.safeParse({
        sessionId: decision.sessionId,
        decisionId: decision.decisionId,
        clientOperationId: randomUUID(),
        disposition: 'confirmed',
        runId: null,
        rebuildId: null,
      }).success,
    ).toBe(true)
  })
})
