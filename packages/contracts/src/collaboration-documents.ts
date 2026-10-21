import { z } from 'zod'

/** Transport limits apply to each physical page, never to complete durable content. */
export const COLLABORATION_PAGE_ITEMS = 24
export const COLLABORATION_PAGE_BYTES = 48 * 1024
export const COLLABORATION_DISPLAY_TEXT_RULES =
  'Explain the task, plan version, findings and user decisions in natural language. Keep private source identities, grants, hashes and protocol fields out of user-facing prose. Cite checked file/line or source evidence when relevant.'

export const collaborationDocumentSchema = z.strictObject({
  id: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
})
export type CollaborationDocument = z.infer<typeof collaborationDocumentSchema>

export const collaborationInputBatchReferenceSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
})
export type CollaborationInputBatchReference = z.infer<
  typeof collaborationInputBatchReferenceSchema
>

/** The current host-owned root selects its frozen sources; the model supplies no authority. */
export const collaborationSourceReadSchema = z.strictObject({
  runId: z.string().uuid(),
  grant: z.string().uuid(),
  source: z.enum(['document', 'batch', 'inputs', 'handoff_sources']).default('document'),
  document: collaborationDocumentSchema.optional(),
  batchId: z.string().uuid().optional(),
  offset: z.number().int().nonnegative(),
})
export type CollaborationSourceRead = z.infer<typeof collaborationSourceReadSchema>
export const collaborationSourceReadResultSchema = z
  .strictObject({
    source: z.enum(['document', 'batch', 'inputs', 'handoff_sources']),
    text: z.string(),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    document: collaborationDocumentSchema.optional(),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= COLLABORATION_PAGE_BYTES,
    'Source page exceeds its byte budget.',
  )
export type CollaborationSourceReadResult = z.infer<typeof collaborationSourceReadResultSchema>

export interface CollaborationMarkdownNode {
  type: 'root' | 'element' | 'text'
  tagName?: string | undefined
  value?: string | undefined
  properties?: Record<string, string | number | boolean | string[]> | undefined
  children?: CollaborationMarkdownNode[] | undefined
}
export const collaborationMarkdownNodeSchema: z.ZodType<CollaborationMarkdownNode> = z.lazy(() =>
  z.strictObject({
    type: z.enum(['root', 'element', 'text']),
    tagName: z
      .enum([
        'a',
        'p',
        'span',
        'strong',
        'em',
        'del',
        'code',
        'pre',
        'blockquote',
        'ol',
        'ul',
        'li',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'hr',
        'br',
        'img',
        'input',
      ])
      .optional(),
    value: z.string().optional(),
    properties: z
      .partialRecord(
        z.enum([
          'href',
          'title',
          'alt',
          'src',
          'className',
          'start',
          'align',
          'type',
          'checked',
          'disabled',
          'data-pact-node-id',
          'data-pact-projection-start',
          'data-pact-projection-end',
        ]),
        z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
      )
      .optional(),
    children: z.array(collaborationMarkdownNodeSchema).optional(),
  }),
)
export function collaborationMarkdownTreeWithinBudget(root: CollaborationMarkdownNode): boolean {
  const stack: Array<{ node: CollaborationMarkdownNode; depth: number }> = [
    { node: root, depth: 0 },
  ]
  let count = 0
  while (stack.length) {
    const item = stack.pop()!
    if (++count > 512 || item.depth > 64) return false
    for (const node of item.node.children ?? []) {
      if (stack.length >= 512) return false
      stack.push({ node, depth: item.depth + 1 })
    }
  }
  return true
}
export const collaborationMarkdownPageSchema = z
  .strictObject({
    ordinal: z.number().int().nonnegative(),
    visibleStart: z.number().int().nonnegative(),
    visibleEnd: z.number().int().nonnegative(),
    tree: collaborationMarkdownNodeSchema,
    visibleText: z.string().max(4096),
  })
  .refine(
    (page) => collaborationMarkdownTreeWithinBudget(page.tree),
    'Markdown projection exceeds its node or stack budget.',
  )
