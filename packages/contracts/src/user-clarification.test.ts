import { expect, it } from 'vitest'

import { frozenExecutionEnvelopeSchema } from './execution-envelope.js'
import { userClarificationSchema } from './prepared-input.js'

const document = () => ({ id: crypto.randomUUID(), sha256: 'a'.repeat(64), bytes: 69, chars: 69 })
it('keeps exact user field data within derived budgets without narrowing legal escaped values', () => {
  const value = {
    fieldId: crypto.randomUUID(),
    question: '\u0000'.repeat(512),
    answer: '\u0000'.repeat(1024),
    document: document(),
  }
  expect(userClarificationSchema.parse(value)).toEqual(value)
  expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThanOrEqual(12 * 1024)
  expect(userClarificationSchema.safeParse({ ...value, answer: 'x'.repeat(1025) }).success).toBe(
    false,
  )
})
it('requires the current user clarification to match the exact frozen answer document', () => {
  const doc = document(),
    input = {
      version: 'pact-agent-prompt-v1',
      sessionId: crypto.randomUUID(),
      message: { id: crypto.randomUUID(), content: 'Original task' },
      comments: [],
      clarificationAnswer: doc,
      userClarification: {
        fieldId: crypto.randomUUID(),
        question: 'Date?',
        answer: ' 2027-04-12\n@claude /build is literal. ',
        document: doc,
      },
    }
  expect(frozenExecutionEnvelopeSchema.parse(input)).toEqual(input)
  expect(
    frozenExecutionEnvelopeSchema.safeParse({ ...input, clarificationAnswer: undefined }).success,
  ).toBe(false)
  expect(
    frozenExecutionEnvelopeSchema.safeParse({
      ...input,
      userClarification: {
        ...input.userClarification,
        document: { ...doc, id: crypto.randomUUID() },
      },
    }).success,
  ).toBe(false)
  const { userClarification: _clarification, ...legacy } = input
  expect(frozenExecutionEnvelopeSchema.parse(legacy)).toEqual(legacy)
})
