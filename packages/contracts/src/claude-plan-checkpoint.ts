import { z } from 'zod'

import { collaborationPlanReferenceSchema } from './collaboration.js'

/** A host-authenticated published plan, bound to one later native planning root. */
export const claudePlanCheckpointSchema = z.strictObject({
  targetRunId: z.string().uuid(),
  targetNativeTurnId: z.string().uuid(),
  nativeSessionId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  basis: collaborationPlanReferenceSchema,
  sourceNativeTurnId: z.string().uuid(),
  sourceNativeId: z.string().min(1).max(1024),
})
export type ClaudePlanCheckpoint = z.infer<typeof claudePlanCheckpointSchema>

/** Host assembly, UTF-8 validation and Worker transport copies, in the existing owner budget. */
export function claudePlanCheckpointWorkingBytes(checkpoint: ClaudePlanCheckpoint): number {
  return 4096 + checkpoint.basis.document.bytes * 8 + checkpoint.basis.document.chars * 8
}

export const claudePlanCheckpointRequestSchema = z.strictObject({
  type: z.literal('plan_checkpoint_request'),
})
export const claudePlanCheckpointReplySchema = z.strictObject({
  type: z.literal('plan_checkpoint_body'),
  text: z.string(),
})
