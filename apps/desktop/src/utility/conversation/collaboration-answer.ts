import {
  collaborationEnvelopeSchema,
  collaborationAnswerFormatSchema,
  collaborationSubmission,
  type CollaborationResult,
  type CollaborationAnswerFormat,
  type CollaborationTask,
  type CollaborationTurnAuthorization,
  type NormalizedAgentEvent,
} from '@pact/contracts'

import { freezeNativeJsonFrame } from './native-json-encoder'
import { NativeWorkingMemory } from './native-working-memory'

export type { CollaborationAnswerFormat } from '@pact/contracts'

/** One versioned pure projection owns live, stored, cold and Fork answer bytes. */
export function readCollaborationAnswer(
  value: unknown,
  _format: CollaborationAnswerFormat = collaborationAnswerFormatSchema.value,
): string | undefined {
  if (value == null) return undefined
  const note =
    typeof value === 'object' && !Array.isArray(value) ? Reflect.get(value, 'answer') : undefined
  const answer = typeof note === 'string' ? note : ''
  // Display is never submission authority; rejected protocol material remains private.
  return answer.trim() ? answer : undefined
}

export function readCollaborationEnvelopeText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Invalid native protocol stays private; this is display filtering, never result decoding. */
export function collaborationNaturalFallback(text: string): string | undefined {
  const candidate = text.trimStart()
  const encoded = candidate.startsWith('{') || /^```(?:json)?\s*\{/u.test(candidate)
  const pactCarrier =
    /"version"\s*:\s*"pact-collaboration-envelope-|"(?:todoDeltas|inputResponses)"\s*:/u.test(
      candidate,
    )
  return encoded && pactCarrier ? undefined : text
}

/** Recovery preserves submitted material; this does not grant stage or plan authority. */
export function readSubmittedCollaborationReport(
  value: unknown,
  format?: CollaborationAnswerFormat,
): CollaborationResult | undefined {
  if (!format || value == null) return undefined
  const reservation = new NativeWorkingMemory().reserve(4096 + freezeNativeJsonFrame(value) * 4)
  try {
    const parsed = collaborationEnvelopeSchema.safeParse(value)
    return parsed.success ? parsed.data.result : undefined
  } finally {
    reservation.release()
  }
}

/** null selects a missing Claude attachment; undefined selects the last Codex root final item. */
export function projectCollaborationAnswer(
  items: readonly { id: string; text: string; phase?: unknown }[],
  answerFormat?: CollaborationAnswerFormat,
  structuredOutput?: unknown,
): string {
  if (!answerFormat)
    return items
      .map((item) => item.text)
      .filter(Boolean)
      .join('\n\n')
  const carrier =
    structuredOutput !== undefined
      ? structuredOutput
      : readCollaborationEnvelopeText(
          items.findLast((item) => item.phase !== 'commentary')?.text ?? '',
        )
  return (
    readCollaborationAnswer(carrier, answerFormat) ??
    items
      .filter(
        (item) =>
          item.phase === 'commentary' ||
          (readCollaborationEnvelopeText(item.text) == null &&
            collaborationNaturalFallback(item.text) !== undefined),
      )
      .map((item) => item.text)
      .filter(Boolean)
      .join('\n\n')
  )
}

/** A native completed final carrier never borrows acceptance from visible prose. */
export function collaborationResultEvent(
  value: unknown,
  task: CollaborationTask,
  turnId: string,
  _format: CollaborationAnswerFormat = collaborationAnswerFormatSchema.value,
  authorization?: CollaborationTurnAuthorization,
): NormalizedAgentEvent {
  const parsed = collaborationEnvelopeSchema.safeParse(value)
  if (
    parsed.success &&
    parsed.data.result.submission === (authorization?.duty ?? collaborationSubmission(task)) &&
    (!authorization || (authorization.taskId === task.id && authorization.actor === task.actor))
  )
    return { agentId: task.actor, type: 'collaboration.result', turnId, result: parsed.data.result }
  return {
    agentId: task.actor,
    type: 'collaboration.result_incomplete',
    turnId,
    reason: value == null ? 'missing' : 'invalid',
  }
}
