import { z } from 'zod'

import { nativePermissionActionSchema } from './native-permissions.js'

export const NATIVE_INPUT_FIELDS = 32
export const NATIVE_INPUT_BYTES = 32 * 1024
export const nativeInputValueSchema = z.union([
  z.string().max(8192),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(8192)).max(32),
])
export const nativeInputValuesSchema = z
  .record(z.string().min(1).max(512), nativeInputValueSchema)
  .refine(
    (values) =>
      Object.keys(values).length <= NATIVE_INPUT_FIELDS &&
      new TextEncoder().encode(JSON.stringify(values)).byteLength <= NATIVE_INPUT_BYTES,
    'Native answers exceed the response budget.',
  )
export type NativeInputValues = z.infer<typeof nativeInputValuesSchema>

export const nativeInputFieldSchema = z.strictObject({
  id: z.string().min(1).max(512),
  label: z.string().min(1).max(4096),
  description: z.string().max(4096).optional(),
  type: z.enum(['text', 'secret', 'number', 'integer', 'boolean', 'select', 'multi-select']),
  required: z.boolean(),
  allowOther: z.boolean().optional(),
  options: z
    .array(
      z.strictObject({
        value: z.string().max(1024),
        label: z.string().max(1024),
        description: z.string().max(4096).optional(),
      }),
    )
    .max(64)
    .optional(),
  default: nativeInputValueSchema.optional(),
})
export type NativeInputField = z.infer<typeof nativeInputFieldSchema>

export const nativeInputDetailsSchema = z
  .strictObject({
    kind: z.enum(['questions', 'form', 'url']),
    title: z.string().min(1).max(240),
    message: z.string().max(8192),
    fields: z.array(nativeInputFieldSchema).max(NATIVE_INPUT_FIELDS),
    url: z.string().max(8192).optional(),
  })
  .refine(
    (details) => new TextEncoder().encode(JSON.stringify(details)).byteLength <= NATIVE_INPUT_BYTES,
    'Native input details exceed the display budget.',
  )
export type NativeInputDetails = z.infer<typeof nativeInputDetailsSchema>

/** Complete live approval facts use the existing transient interaction reader. */
export const nativeApprovalDetailsSchema = z
  .strictObject({
    kind: z.literal('approval'),
    title: z.string().min(1).max(240),
    detail: z.string().max(4096),
    actions: z.array(nativePermissionActionSchema).min(1).max(8),
    defaultToNo: z.boolean().optional(),
  })
  .refine(
    (details) => new TextEncoder().encode(JSON.stringify(details)).byteLength <= 4096,
    'Native approval details exceed the display budget.',
  )
export type NativeApprovalDetails = z.infer<typeof nativeApprovalDetailsSchema>
export const nativeInteractionDetailsSchema = z.union([
  nativeInputDetailsSchema,
  nativeApprovalDetailsSchema,
])
export type NativeInteractionDetails = z.infer<typeof nativeInteractionDetailsSchema>

/** Enforces the displayed native field types before answers cross back into a provider. */
export function validateNativeInputValues(
  fields: NativeInputField[],
  values: NativeInputValues,
): boolean {
  const shape = Object.fromEntries(
    fields.map((field) => {
      let schema: z.ZodType =
        field.type === 'boolean'
          ? z.boolean()
          : field.type === 'integer'
            ? z.number().int()
            : field.type === 'number'
              ? z.number().finite()
              : field.type === 'multi-select'
                ? z
                    .array(z.string().min(1).max(8192))
                    .min(field.required ? 1 : 0)
                    .max(32)
                : z
                    .string()
                    .min(field.required ? 1 : 0)
                    .max(8192)
      if (field.options && !field.allowOther) {
        const choices = new Set(field.options.map((option) => option.value))
        schema = schema.refine((value) =>
          (Array.isArray(value) ? value : [value]).every(
            (entry) => typeof entry === 'string' && choices.has(entry),
          ),
        )
      }
      return [field.id, field.required ? schema : schema.optional()]
    }),
  )
  return z.strictObject(shape).safeParse(values).success
}

export interface NativeUserInputRequest extends NativeInputDetails {
  /** Adapter-validated provisional identity; never accepted from the Renderer. */
  nativeSessionId?: string
  /** Raw native schema is private to Utility; Zod validates form answers, not the Renderer. */
  requestedSchema?: Record<string, unknown>
}
export interface NativeUserInputResult {
  action: 'accept' | 'decline' | 'cancel'
  values?: NativeInputValues
}
export const nativeInputReadSchema = z.strictObject({
  operationId: z.string().uuid(),
  requestId: z.string().uuid(),
})
export type NativeInputRead = z.infer<typeof nativeInputReadSchema>
export const nativeInputRespondSchema = nativeInputReadSchema.extend({
  action: z.enum(['accept', 'decline', 'cancel']),
  values: nativeInputValuesSchema.optional(),
})
export type NativeInputRespond = z.infer<typeof nativeInputRespondSchema>

/** Uses the existing mature validator; no external refs or executable patterns are admitted. */
export function compileNativeFormValidator(
  requestedSchema: Record<string, unknown>,
): (values: NativeInputValues) => boolean {
  const text = JSON.stringify(requestedSchema)
  if (
    new TextEncoder().encode(text).byteLength > NATIVE_INPUT_BYTES ||
    /"(?:\$ref|pattern|patternProperties)"\s*:/u.test(text)
  )
    throw new Error('The native form requires unsupported or unbounded schema validation.')
  const schema = z.fromJSONSchema(requestedSchema)
  return (values) => schema.safeParse(values).success
}
