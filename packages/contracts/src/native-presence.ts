import { z } from 'zod'
export type NativeResultSchema<Value> = z.ZodType<Value>

export const NATIVE_MENU_ITEMS = 5
export const NATIVE_MENU_BYTES = 32 * 1024
export const NATIVE_RECENT_CANDIDATES = 18
export const NATIVE_METADATA_TIMEOUT_MS = 5_000
export const NATIVE_QUIT_PREPARATION_MS = 15_000

export const nativePresenceVersionSchema = z.strictObject({
  incarnation: z.string().uuid(),
  revision: z.number().int().nonnegative(),
})

export const nativeSessionRowSchema = z.strictObject({
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().min(1).max(120),
  projectName: z.string().min(1).max(120),
  state: z.enum(['idle', 'preparing', 'running', 'recovering', 'approval', 'input', 'attention']),
  unread: z.boolean(),
  jumpListSuppressed: z.boolean(),
  jumpListRemovalObserved: z.boolean(),
})

export const nativePresenceSnapshotSchema = z.strictObject({
  version: nativePresenceVersionSchema,
  running: z.array(nativeSessionRowSchema).max(NATIVE_MENU_ITEMS),
  attention: z.array(nativeSessionRowSchema).max(NATIVE_MENU_ITEMS),
  recent: z.array(nativeSessionRowSchema).max(NATIVE_MENU_ITEMS),
  attentionTotal: z.number().int().nonnegative(),
})

export const nativeAttentionCursorSchema = z.strictObject({
  incarnation: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  liveOffset: z.number().int().min(0).max(8),
  after: z
    .strictObject({ ordinal: z.number().int().nonnegative(), id: z.string().uuid() })
    .optional(),
})
export const nativeAttentionReadInputSchema = z.strictObject({
  cursor: nativeAttentionCursorSchema.optional(),
})
export const nativeAttentionPageSchema = z.strictObject({
  version: nativePresenceVersionSchema,
  sessions: z.array(nativeSessionRowSchema).max(NATIVE_MENU_ITEMS),
  total: z.number().int().nonnegative(),
  nextCursor: nativeAttentionCursorSchema.optional(),
})
export const nativeSessionResolveInputSchema = z.strictObject({ sessionId: z.string().uuid() })
export const nativeSessionOpenInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  openingId: z.string().uuid(),
})
export const nativeJumpListSuppressionInputSchema = z.strictObject({
  removedSessionIds: z.array(z.string().uuid()).max(64),
  clearedSessionIds: z.array(z.string().uuid()).max(64),
})
export const nativeSessionOpenedResultSchema = z.strictObject({ recorded: z.literal(true) })
export const nativeJumpListSuppressionResultSchema = z.strictObject({ updated: z.literal(true) })

export const nativeQuitOperationInputSchema = z.strictObject({ operationId: z.string().uuid() })
export const nativeQuitPreparationSchema = z.strictObject({
  operationId: z.string().uuid(),
  state: z.enum(['idle_prepared', 'confirmation_required']),
  activeCount: z.number().int().nonnegative(),
  sessions: z.array(nativeSessionRowSchema).max(NATIVE_MENU_ITEMS),
})
export const nativeQuitCancelledResultSchema = z.strictObject({
  operationId: z.string().uuid(),
  cancelled: z.literal(true),
})
export const nativeQuitStateSchema = z.strictObject({
  operationId: z.string().uuid(),
  phase: z.enum(['confirming', 'cancelling', 'closing', 'unconfirmed']),
  unknown: z.boolean(),
  activeCount: z.number().int().nonnegative(),
  sessions: z.array(nativeSessionRowSchema).max(NATIVE_MENU_ITEMS),
  message: z.string().max(1024).optional(),
})
export const nativeQuitDecisionInputSchema = z.strictObject({
  operationId: z.string().uuid(),
  decision: z.enum(['cancel', 'exit']),
})
export const nativeQuitDecisionResultSchema = z.strictObject({ accepted: z.literal(true) })

export const nativeNavigationIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    navigationId: z.string().uuid(),
    kind: z.literal('session'),
    sessionId: z.string().uuid(),
  }),
  z.strictObject({ navigationId: z.string().uuid(), kind: z.literal('attention') }),
])
export const nativeNavigationAckInputSchema = z.strictObject({ navigationId: z.string().uuid() })
export const nativeNavigationAckResultSchema = z.strictObject({ acknowledged: z.literal(true) })

export type NativePresenceVersion = z.infer<typeof nativePresenceVersionSchema>
export type NativeVersion = NativePresenceVersion
export type NativeSessionRow = z.infer<typeof nativeSessionRowSchema>
export type NativePresenceSnapshot = z.infer<typeof nativePresenceSnapshotSchema>
export type NativeAttentionCursor = z.infer<typeof nativeAttentionCursorSchema>
export type NativeAttentionReadInput = z.infer<typeof nativeAttentionReadInputSchema>
export type NativeAttentionPage = z.infer<typeof nativeAttentionPageSchema>
export type NativeSessionResolveInput = z.infer<typeof nativeSessionResolveInputSchema>
export type NativeSessionOpenInput = z.infer<typeof nativeSessionOpenInputSchema>
export type NativeJumpListSuppressionInput = z.infer<typeof nativeJumpListSuppressionInputSchema>
export type NativeQuitOperationInput = z.infer<typeof nativeQuitOperationInputSchema>
export type NativeQuitPreparation = z.infer<typeof nativeQuitPreparationSchema>
export type NativeQuitState = z.infer<typeof nativeQuitStateSchema>
export type NativeQuitDecisionInput = z.infer<typeof nativeQuitDecisionInputSchema>
export type NativeNavigationIntent = z.infer<typeof nativeNavigationIntentSchema>
export type NativeNavigationAckInput = z.infer<typeof nativeNavigationAckInputSchema>
