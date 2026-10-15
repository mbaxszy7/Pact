import { z } from 'zod'

export const WORKSPACE_ARCHIVE_TASK_LIMIT = 5
export const WORKSPACE_ARCHIVE_PREVIEW_MS = 120_000
export const WORKSPACE_ARCHIVE_STOP_MS = 15_000

export const workspaceArchiveScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: z.string().uuid() }),
  z.strictObject({ kind: z.literal('project'), projectId: z.string().uuid() }),
])
export type WorkspaceArchiveScope = z.infer<typeof workspaceArchiveScopeSchema>

export const workspaceArchivePrepareInputSchema = z.strictObject({
  operationId: z.string().uuid(),
  scope: workspaceArchiveScopeSchema,
})
export type WorkspaceArchivePrepareInput = z.infer<typeof workspaceArchivePrepareInputSchema>
export const workspaceArchiveOperationInputSchema = z.strictObject({
  operationId: z.string().uuid(),
})
export type WorkspaceArchiveOperationInput = z.infer<typeof workspaceArchiveOperationInputSchema>

export const workspaceArchiveTaskSchema = z.strictObject({
  sessionId: z.string().uuid(),
  title: z.string().min(1).max(120),
  state: z.enum(['running', 'preparing', 'continuing']),
  identity: z.string().min(1).max(512),
})
export type WorkspaceArchiveTask = z.infer<typeof workspaceArchiveTaskSchema>
export const workspaceArchivePreviewSchema = z.strictObject({
  operationId: z.string().uuid(),
  scope: workspaceArchiveScopeSchema,
  title: z.string().min(1).max(4096),
  projectId: z.string().uuid(),
  tasks: z.array(workspaceArchiveTaskSchema).max(WORKSPACE_ARCHIVE_TASK_LIMIT),
  blockedReason: z.string().max(1024).optional(),
  expiresAt: z.string().datetime(),
})
export type WorkspaceArchivePreview = z.infer<typeof workspaceArchivePreviewSchema>

export const workspaceArchiveReceiptSchema = z.strictObject({
  preview: workspaceArchivePreviewSchema,
  state: z.enum(['prepared', 'stopping', 'archived', 'cancelled', 'not_archived', 'unresolved']),
  tasks: z
    .array(
      z.strictObject({
        sessionId: z.string().uuid(),
        outcome: z.enum(['stopped', 'finished', 'failed', 'unresolved']),
      }),
    )
    .max(WORKSPACE_ARCHIVE_TASK_LIMIT),
  message: z.string().max(2048).optional(),
})
export type WorkspaceArchiveReceipt = z.infer<typeof workspaceArchiveReceiptSchema>
