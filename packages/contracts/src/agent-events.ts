import { z } from 'zod'

/** Only the title is supplied by the Model; Session and Run identity remain host-owned. */
export const sessionTitleInputShape = {
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^(?!\[Pact\] )[^\r\n\p{Cc}]+$/u),
}
export const sessionTitleInputSchema = z.strictObject(sessionTitleInputShape)

import { collaborationResultSchema } from './collaboration.js'

const agentId = z.enum(['claude', 'codex'])
const opaqueId = z.string().min(1)

// These are Pact facts, not Claude or Codex wire messages. The owning AgentSession
// supplies the Session context; a future Journal assigns durable IDs and order.
const agentEvent = { agentId }
// Codex can supply a native Turn ID; an Adapter assigns a stable Pact Turn ID
// when its selected provider stream has no equivalent.
const turnEvent = { ...agentEvent, turnId: opaqueId }

export const normalizedAgentEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...turnEvent,
    type: z.literal('collaboration.result_incomplete'),
    reason: z.enum(['missing', 'invalid']),
  }),
  z.strictObject({
    ...turnEvent,
    type: z.literal('collaboration.result'),
    result: collaborationResultSchema,
  }),
  z.strictObject({ ...agentEvent, type: z.literal('session.started'), nativeSessionId: opaqueId }),
  z.strictObject({
    ...agentEvent,
    type: z.literal('run.model.resolved'),
    model: z.string().trim().min(1).max(160),
    effort: z.string().trim().min(1).max(80).nullable().optional(),
  }),
  z.strictObject({
    ...agentEvent,
    type: z.literal('session.title.updated'),
    title: z.string().trim().min(1).max(120),
    origin: z.literal('turn_result').optional(),
  }),
  z.strictObject({ ...turnEvent, type: z.literal('turn.started') }),
  z.strictObject({
    ...turnEvent,
    type: z.literal('peer.assistance.requested'),
    proposalId: z.string().uuid(),
    targetAgentId: agentId,
    kind: z.enum(['supplement', 'fact_check', 'challenge', 'review']),
    reason: z.string().trim().min(1).max(240).optional(),
  }),
  z.strictObject({
    ...turnEvent,
    type: z.literal('reasoning.summary.delta'),
    activityId: opaqueId,
    text: z.string(),
  }),
  z.strictObject({
    ...turnEvent,
    type: z.literal('reasoning.summary.completed'),
    activityId: opaqueId,
    text: z.string(),
  }),
  z.strictObject({
    ...turnEvent,
    type: z.literal('tool.started'),
    toolCallId: opaqueId,
    toolName: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(160),
    detail: z.string().trim().max(500).optional(),
  }),
  z.strictObject({
    ...turnEvent,
    type: z.literal('tool.completed'),
    toolCallId: opaqueId,
    toolName: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(160),
    detail: z.string().trim().max(500).optional(),
    outcome: z.enum(['completed', 'failed']),
  }),
  z.strictObject({
    ...turnEvent,
    type: z.literal('text.delta'),
    // Stable Pact identity for the Run's one logical visible answer.
    outputId: opaqueId,
    text: z.string(),
  }),
  z.strictObject({
    ...turnEvent,
    type: z.literal('text.completed'),
    outputId: opaqueId,
    // Authoritative snapshot of the whole logical answer. Adapters merge
    // provider-native assistant items before crossing this seam.
    text: z.string(),
  }),
  z.strictObject({
    ...turnEvent,
    type: z.literal('interaction.requested'),
    // Codex request ID when present; otherwise assigned by the Adapter.
    requestId: opaqueId,
    category: z.enum(['approval', 'question']),
  }),
  z.strictObject({
    ...turnEvent,
    type: z.literal('turn.completed'),
    outcome: z.enum(['completed', 'interrupted', 'failed']),
  }),
  z.strictObject({
    ...agentEvent,
    type: z.literal('unrecognized'),
    nativeType: opaqueId,
    turnId: opaqueId.optional(),
  }),
])

export type NormalizedAgentEvent = z.infer<typeof normalizedAgentEventSchema>

/** Projection identity shared by stream coalescing and atomic-batch validation. */
export function conversationStreamDeltaKey(
  event: Extract<NormalizedAgentEvent, { type: 'text.delta' | 'reasoning.summary.delta' }>,
): string {
  return event.type === 'text.delta' ? 'text' : `reasoning:${event.activityId}`
}
