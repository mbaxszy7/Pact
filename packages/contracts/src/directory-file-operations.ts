import { z } from 'zod'

export const PROJECT_FILE_PREVIEW_BYTES = 1024 * 1024
export const PROJECT_FILE_PREVIEW_TIMEOUT_MS = 5_000
export const MAX_DIRECTORY_DEPTH = 128
export const MAX_DIRECTORY_REQUEST_BYTES = 64 * 1024

export const directoryIdentitySchema = z.strictObject({
  path: z.string().min(1).max(4096),
  device: z.string().regex(/^\d{1,40}$/u),
  inode: z.string().regex(/^\d{1,40}$/u),
})
export type DirectoryIdentity = z.infer<typeof directoryIdentitySchema>

const component = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== '.' &&
      value !== '..' &&
      !value.includes('/') &&
      !value.includes('\\') &&
      value.split('').every((character) => character.charCodeAt(0) >= 32),
    'Invalid file-name component.',
  )
const directoryFileMutationInputSchema = z.strictObject({
  operation: z.enum(['capture', 'stash', 'install', 'absent', 'mkdir_parents', 'inspect_parents']),
  rootPath: z.string().min(1).max(4096),
  rootDevice: z.string().regex(/^\d{1,40}$/u),
  rootInode: z.string().regex(/^\d{1,40}$/u),
  directories: z.array(component).max(MAX_DIRECTORY_DEPTH),
  name: component,
  auxiliaryPath: z.string().min(1).max(4096).optional(),
  /** Only a durable Pact intent may identify this private installation candidate. */
  linkedCandidatePath: z.string().min(1).max(4096).optional(),
  maximumBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024)
    .optional(),
})
const directoryFileRemoveDirInputSchema = z.strictObject({
  operation: z.literal('rmdir_verified'),
  rootPath: z.string().min(1).max(4096),
  rootDevice: z.string().regex(/^\d{1,40}$/u),
  rootInode: z.string().regex(/^\d{1,40}$/u),
  directories: z.array(component).max(MAX_DIRECTORY_DEPTH - 1),
  name: component,
  expectedDevice: z.string().regex(/^\d{1,40}$/u),
  expectedInode: z.string().regex(/^\d{1,40}$/u),
})
const previewComponent = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\0'),
    'Invalid preview file-name component.',
  )
const directoryFilePreviewInputSchema = z.strictObject({
  operation: z.literal('preview'),
  rootPath: z.string().min(1).max(4096),
  rootDevice: z.string().regex(/^\d{1,40}$/u),
  rootInode: z.string().regex(/^\d{1,40}$/u),
  directories: z.array(previewComponent).max(MAX_DIRECTORY_DEPTH),
  name: previewComponent,
  deadlineAt: z.number().int().positive(),
})
export const directoryFileOperationInputSchema = z.discriminatedUnion('operation', [
  directoryFileMutationInputSchema,
  directoryFileRemoveDirInputSchema,
  directoryFilePreviewInputSchema,
])
export type DirectoryFileOperationInput = z.infer<typeof directoryFileOperationInputSchema>

export const directoryFileOperationResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    existed: z.boolean(),
    hash: z
      .string()
      .regex(/^[a-f\d]{64}$/u)
      .nullable(),
    bytes: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
    device: z
      .string()
      .regex(/^\d{1,40}$/u)
      .optional(),
    inode: z
      .string()
      .regex(/^\d{1,40}$/u)
      .optional(),
    parentDirs: z.array(directoryIdentitySchema).max(MAX_DIRECTORY_DEPTH).optional(),
    missingDirs: z.array(z.string().min(1).max(4096)).max(MAX_DIRECTORY_DEPTH).optional(),
    preview: z
      .strictObject({
        content: z.string().max(PROJECT_FILE_PREVIEW_BYTES),
        updatedAt: z.string().datetime(),
      })
      .optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['PATH_CHANGED', 'UNSUPPORTED', 'TOO_LARGE', 'IO', 'CANCELLED']),
    message: z.string().max(1024),
  }),
])
export type DirectoryFileOperationResult = z.infer<typeof directoryFileOperationResultSchema>

export const directoryFileOperationMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('workspace.directory.request'),
    requestId: z.string().uuid(),
    input: directoryFileOperationInputSchema,
  }),
  z.strictObject({ type: z.literal('workspace.directory.cancel'), requestId: z.string().uuid() }),
  z.strictObject({
    type: z.literal('workspace.directory.response'),
    requestId: z.string().uuid(),
    result: directoryFileOperationResultSchema,
  }),
])
export type DirectoryFileOperationMessage = z.infer<typeof directoryFileOperationMessageSchema>
