import { z } from 'zod'

export const WORKSPACE_CHANGE_FILES = 256
export const WORKSPACE_CHANGE_PAGE_FILES = 20
export const WORKSPACE_EVIDENCE_BYTES = 64 * 1024 * 1024
export const WORKSPACE_FILE_BYTES = 64 * 1024 * 1024
export const WORKSPACE_ROUND_BYTES = 1024 * 1024 * 1024
export const WORKSPACE_STORAGE_BYTES = 10 * 1024 * 1024 * 1024
export const WORKSPACE_OPERATION_TIMEOUT_MS = 30_000
export const WORKSPACE_PREVIEW_BYTES = 1024 * 1024
export const workspaceStorageRootSchema = z.string().min(1).max(4096)

export const workspaceFileVersionSchema = z.strictObject({
  hash: z
    .string()
    .regex(/^[a-f\d]{64}$/u)
    .nullable(),
  bytes: z.number().int().nonnegative().max(WORKSPACE_FILE_BYTES),
  mode: z.number().int().nonnegative(),
})
export type WorkspaceFileVersion = z.infer<typeof workspaceFileVersionSchema>

export const workspaceChangeSetSchema = z.strictObject({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  agentId: z.enum(['claude', 'codex']),
  state: z.enum(['recording', 'ready', 'mixed', 'undone', 'recovery_required']),
  revision: z.number().int().positive().optional(),
  fileCount: z.number().int().nonnegative().max(WORKSPACE_CHANGE_FILES),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  countsAvailable: z.boolean().optional(),
  undoUnavailableReason: z.string().max(1024).nullable(),
  effectsUncertain: z.boolean().optional(),
  createdAt: z.string().datetime(),
  finalizedAt: z.string().datetime().nullable(),
})
export type WorkspaceChangeSet = z.infer<typeof workspaceChangeSetSchema>

export const workspaceFileChangeSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  previousPath: z.string().min(1).max(4096).nullable(),
  kind: z.enum(['added', 'modified', 'deleted', 'renamed']),
  before: workspaceFileVersionSchema,
  after: workspaceFileVersionSchema,
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  hidden: z.boolean(),
  reason: z.string().max(1024).nullable(),
  beforeAvailable: z.boolean().optional(),
  afterAvailable: z.boolean().optional(),
  /** Native text snapshots need not provide historical filesystem metadata. */
  modeKnown: z.boolean().optional(),
  undoStrategy: z.enum(['three_way', 'patch', 'unavailable']).optional(),
  patchVersions: z.array(workspaceFileVersionSchema).max(64).optional(),
})
export type WorkspaceFileChange = z.infer<typeof workspaceFileChangeSchema>

export const workspaceChangesReadInputSchema = z.strictObject({
  changeSetId: z.string().uuid(),
  afterPath: z.string().min(1).max(4096).optional(),
})
export type WorkspaceChangesReadInput = z.infer<typeof workspaceChangesReadInputSchema>
export const workspaceChangesPageSchema = z
  .strictObject({
    changeSet: workspaceChangeSetSchema,
    files: z.array(workspaceFileChangeSchema).max(WORKSPACE_CHANGE_PAGE_FILES),
    nextPath: z.string().nullable(),
  })
  .refine(
    (page) => new TextEncoder().encode(JSON.stringify(page)).byteLength <= 256 * 1024,
    'Workspace metadata exceeds the page byte limit.',
  )
export type WorkspaceChangesPage = z.infer<typeof workspaceChangesPageSchema>

export const workspaceChangeFileReadInputSchema = z
  .strictObject({
    changeSetId: z.string().uuid(),
    path: z.string().min(1).max(4096),
    side: z.enum(['before', 'after', 'patch']),
    patchIndex: z.number().int().min(0).max(63).optional(),
  })
  .refine((input) => input.side === 'patch' || input.patchIndex === undefined, {
    message: 'A patch index is only valid when reading a recorded patch.',
    path: ['patchIndex'],
  })
export type WorkspaceChangeFileReadInput = z.infer<typeof workspaceChangeFileReadInputSchema>

export const workspaceChangesUndoInputSchema = z.strictObject({
  changeSetId: z.string().uuid(),
})
export type WorkspaceChangesUndoInput = z.infer<typeof workspaceChangesUndoInputSchema>
