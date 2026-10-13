import { z } from 'zod'

export const IMAGE_IO_BYTES = 32 * 1024
export const IMAGE_REQUEST_BYTES = 64 * 1024
export const IMAGE_REFERENCE_ITEMS = 128
export const IMAGE_ORIGINAL_WORK_BYTES = 64 * 1024 * 1024
export const IMAGE_PREVIEW_PIXELS = 48 * 1024 * 1024
export const IMAGE_PREVIEW_WORK_BYTES = 256 * 1024 * 1024
export const imageMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp'])
export const conversationImageSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  mediaType: imageMediaTypeSchema,
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
})
export type ConversationImage = z.infer<typeof conversationImageSchema>
export const conversationImagesSchema = z.array(conversationImageSchema).max(IMAGE_REFERENCE_ITEMS)
export const imageWriteInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('begin'),
    sessionId: z.string().uuid(),
    clientImageId: z.string().uuid(),
    name: z.string().min(1).max(255),
  }),
  z.strictObject({
    type: z.literal('append'),
    sessionId: z.string().uuid(),
    imageId: z.string().uuid(),
    offset: z.number().int().nonnegative(),
    data: z
      .string()
      .min(1)
      .max(Math.ceil(IMAGE_IO_BYTES / 3) * 4),
  }),
  z.strictObject({
    type: z.literal('seal'),
    sessionId: z.string().uuid(),
    imageId: z.string().uuid(),
  }),
  z.strictObject({
    type: z.literal('release'),
    sessionId: z.string().uuid(),
    imageId: z.string().uuid(),
  }),
])
export type ImageWriteInput = z.infer<typeof imageWriteInputSchema>
export const imageWriteStateSchema = z.strictObject({
  imageId: z.string().uuid(),
  offset: z.number().int().nonnegative(),
  ready: z.boolean(),
  image: conversationImageSchema.optional(),
})
export type ImageWriteState = z.infer<typeof imageWriteStateSchema>
export const imageReadInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  imageId: z.string().uuid(),
  offset: z.number().int().nonnegative(),
  variant: z.enum(['original', 'thumbnail']).default('original'),
})
export type ImageReadInput = z.infer<typeof imageReadInputSchema>
export const imageReadPartSchema = z.strictObject({
  imageId: z.string().uuid(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  mediaType: imageMediaTypeSchema,
  data: z.string().max(Math.ceil(IMAGE_IO_BYTES / 3) * 4),
  hasMore: z.boolean(),
})
export type ImageReadPart = z.infer<typeof imageReadPartSchema>
export const imageChooseInputSchema = z.strictObject({ sessionId: z.string().uuid() })
export type ImageChooseInput = z.infer<typeof imageChooseInputSchema>

/** Private codec Worker trust seam, never exposed as a Renderer image path API. */
export const imageCodecInputSchema = z.strictObject({
  source: z.string().min(1).max(4096),
  thumbnail: z.string().min(1).max(4096),
})
export const imageCodecResultSchema = conversationImageSchema
  .pick({ mediaType: true, width: true, height: true })
  .extend({
    thumbnailBytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024),
  })
