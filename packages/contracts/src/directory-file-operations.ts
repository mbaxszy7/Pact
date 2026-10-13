import { z } from 'zod'

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
export const directoryFileOperationInputSchema = z.strictObject({
  operation: z.enum(['capture', 'stash', 'install', 'absent']),
  rootPath: z.string().min(1).max(4096),
  rootDevice: z.string().regex(/^\d{1,40}$/u),
  rootInode: z.string().regex(/^\d{1,40}$/u),
  directories: z.array(component).max(128),
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
