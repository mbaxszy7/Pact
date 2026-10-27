import { z } from 'zod'

import { collaborationDocumentSchema } from './collaboration-documents.js'

export const agentSpeedSchema = z.enum(['native', 'standard', 'fast'])
export type AgentSpeed = z.infer<typeof agentSpeedSchema>
export const sessionPermissionModeSchema = z.enum(['native', 'ask', 'auto', 'full'])
export type SessionPermissionMode = z.infer<typeof sessionPermissionModeSchema>

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const nativeId = z.string().min(1).max(1024)
export const runRequestedExecutionSettingsSchema = z.strictObject({
  provider: z.enum(['codex', 'claude']),
  model: z.string().min(1).max(160).nullable(),
  effort: z.string().min(1).max(80).nullable(),
  speed: agentSpeedSchema,
  permissionMode: sessionPermissionModeSchema,
})
export type RunRequestedExecutionSettings = z.infer<typeof runRequestedExecutionSettingsSchema>

/** A missing receipt is unknown; known-null effort must never become a guessed default. */
export const runEffectiveExecutionSettingsSchema = z
  .strictObject({
    version: z.literal(1),
    provider: z.enum(['codex', 'claude']),
    model: z.string().min(1).max(160),
    effort: z.strictObject({ known: z.literal(true), value: z.string().min(1).max(80).nullable() }),
    speed: z.enum(['standard', 'fast']),
    permissionMode: sessionPermissionModeSchema,
    configurationSha256: digest,
    provenance: z.enum(['codex_thread_configuration', 'claude_applied_settings']),
  })
  .refine(
    (value) =>
      value.provenance ===
      (value.provider === 'codex' ? 'codex_thread_configuration' : 'claude_applied_settings'),
  )
export type RunEffectiveExecutionSettings = z.infer<typeof runEffectiveExecutionSettingsSchema>

export const confirmedUnsentBoundarySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host_before_root_start') }),
  z.strictObject({
    kind: z.literal('codex_root_frame_not_written'),
    requestId: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal('claude_root_not_yielded') }),
])
export type ConfirmedUnsentBoundary = z.infer<typeof confirmedUnsentBoundarySchema>
export const confirmedUnsentProofSchema = z
  .strictObject({
    version: z.literal(1),
    runId: z.string().uuid(),
    bindingGeneration: z.number().int().positive(),
    nativeGeneration: z.string().uuid(),
    executorId: nativeId,
    nativeSessionId: nativeId,
    inputSha256: digest,
    effectiveSettingsSha256: digest,
    boundary: confirmedUnsentBoundarySchema,
  })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength < 4096)
export type ConfirmedUnsentProof = z.infer<typeof confirmedUnsentProofSchema>

export const frozenExecutionInputSchema = z
  .strictObject({
    version: z.literal(1),
    runId: z.string().uuid(),
    document: collaborationDocumentSchema,
    inputSha256: digest,
  })
  .refine((value) => value.document.sha256 === value.inputSha256)
export type FrozenExecutionInput = z.infer<typeof frozenExecutionInputSchema>

export const reexecutionDispatchGuardSchema = z.strictObject({
  version: z.literal(1),
  settingsRevision: z.number().int().nonnegative(),
  queueRevision: z.number().int().nonnegative(),
  receivedInputId: z.string().uuid().nullable(),
  taskFingerprint: digest.nullable(),
})
