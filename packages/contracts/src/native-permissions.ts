import { z } from 'zod'

export const NATIVE_PERMISSION_TIMEOUT_MS = 10 * 60 * 1000
export const NATIVE_PERMISSION_REQUESTS = 8
/** Opaque identity of one action offered by this native request, never a global permission mode. */
export const nativePermissionDecisionSchema = z.string().min(1).max(80)
export type NativePermissionDecision = z.infer<typeof nativePermissionDecisionSchema>

export const nativePermissionActionSchema = z.strictObject({
  id: nativePermissionDecisionSchema,
  label: z.string().min(1).max(120),
  kind: z.enum(['allow', 'decline', 'cancel', 'rule']),
  scope: z.string().min(1).max(1024).optional(),
  confirmation: z.string().min(1).max(1024).optional(),
})

/** Public display facts only. Native arguments, credentials and rule objects stay in Utility. */
export const nativePermissionRequestSchema = z
  .strictObject({
    id: z.string().uuid(),
    operationId: z.string().uuid().optional(),
    kind: z.enum(['approval', 'questions', 'form', 'url']).optional(),
    title: z.string().min(1).max(240),
    detail: z.string().max(4096),
    actions: z.array(nativePermissionActionSchema).min(1).max(8).optional(),
    defaultToNo: z.boolean().optional(),
    // Legacy display only; it never creates an action or authorizes a response.
    sessionScope: z.string().min(1).max(1024).optional(),
    createdAt: z.string().datetime(),
  })
  .refine(
    (request) =>
      request.actions == null ||
      new Set(request.actions.map((action) => action.id)).size === request.actions.length,
    'Native actions must have unique identities.',
  )
  .refine(
    (request) => new TextEncoder().encode(JSON.stringify(request)).byteLength <= 4096,
    'Native approval display exceeds its serialized budget.',
  )
export type NativePermissionRequest = z.infer<typeof nativePermissionRequestSchema>
export const nativePermissionRespondInputSchema = z.strictObject({
  operationId: z.string().uuid(),
  permissionId: z.string().uuid(),
  decision: nativePermissionDecisionSchema,
})
export type NativePermissionRespondInput = z.infer<typeof nativePermissionRespondInputSchema>
