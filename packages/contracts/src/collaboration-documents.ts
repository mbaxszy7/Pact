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

/** Fixed native Tool schema. Authentication and the exclusive request forms are checked by its owner. */
export const collaborationSourceWireReadSchema = z.strictObject({
  sourceReference: z.string().min(1).max(2048).optional(),
  runId: z.string().uuid().optional(),
  grant: z.string().uuid().optional(),
  source: z.enum(['document', 'batch', 'inputs', 'handoff_sources']).optional(),
  document: collaborationDocumentSchema.optional(),
  batchId: z.string().uuid().optional(),
  offset: z.number().int().nonnegative(),
})
export type CollaborationSourceWireRead = z.infer<typeof collaborationSourceWireReadSchema>
/** Codex supplies caller identity through its request metadata, never through model arguments. */
export const collaborationSourceNativeReadSchema = z
  .strictObject({
    context: z.literal('native-root-v1'),
    source: z.enum([
      'document',
      'batch',
      'root_batch',
      'root_document',
      'inputs',
      'handoff_sources',
    ]),
    part: z.enum(['body', 'user_information', 'clarification_answer', 'comment']).optional(),
    ordinal: z.number().int().nonnegative().optional(),
    document: collaborationDocumentSchema.optional(),
    batchId: z.string().uuid().optional(),
    offset: z.number().int().nonnegative(),
  })
  .refine(
    (value) =>
      value.source === 'root_document'
        ? value.document === undefined &&
          value.batchId === undefined &&
          value.part !== undefined &&
          (value.part === 'comment' ? value.ordinal !== undefined : value.ordinal === undefined)
        : value.part === undefined &&
          value.ordinal === undefined &&
          (value.source === 'document'
            ? value.document !== undefined && value.batchId === undefined
            : value.source === 'batch'
              ? value.batchId !== undefined && value.document === undefined
              : value.document === undefined && value.batchId === undefined),
    'Supply only the explicit target for this native source selection.',
  )
export const codexCollaborationSourceWireReadSchema = collaborationSourceWireReadSchema.extend({
  context: z.literal('native-root-v1').optional(),
  source: z
    .enum(['document', 'batch', 'root_batch', 'root_document', 'inputs', 'handoff_sources'])
    .optional(),
  part: z.enum(['body', 'user_information', 'clarification_answer', 'comment']).optional(),
  ordinal: z.number().int().nonnegative().optional(),
})
export type CodexCollaborationSourceWireRead = z.infer<
  typeof codexCollaborationSourceWireReadSchema
>
export const collaborationSourceNativeRootSchema = z.strictObject({
  threadId: z.string().min(1).max(1024),
  turnId: z.string().min(1).max(1024),
})
export type CollaborationSourceNativeRoot = z.infer<typeof collaborationSourceNativeRootSchema>
export const collaborationSourceNativeProofSchema = z.strictObject({
  version: z.literal('pact-native-source-root-v1'),
  root: collaborationSourceNativeRootSchema,
  callerRunId: z.string().uuid(),
  grantSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  pageSha256: z.string().regex(/^[a-f0-9]{64}$/u),
})
export const collaborationSourceReferenceReadSchema = z.strictObject({
  sourceReference: z.string().min(1).max(2048),
  offset: z.number().int().nonnegative(),
})
export const collaborationSourceReferencePayloadSchema = z.strictObject({
  version: z.literal('pact-source-reference-v1'),
  request: collaborationSourceReadSchema.omit({ offset: true }),
})

const collaborationSourcePageShape = {
  source: z.enum(['document', 'batch', 'inputs', 'handoff_sources']),
  text: z.string(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  document: collaborationDocumentSchema.optional(),
}
export const collaborationSourceReadResultSchema = z
  .strictObject(collaborationSourcePageShape)
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= COLLABORATION_PAGE_BYTES,
    'Source page exceeds its byte budget.',
  )
export type CollaborationSourceReadResult = z.infer<typeof collaborationSourceReadResultSchema>

/** Direct navigation mirrors the legacy index text; it carries no new authority. */
export const collaborationSourceIndexNavigationSchema = z.strictObject({
  bodyRead: codexCollaborationSourceWireReadSchema.optional(),
  userInformationRead: codexCollaborationSourceWireReadSchema.optional(),
  clarificationAnswerRead: codexCollaborationSourceWireReadSchema.optional(),
  members: z
    .array(
      z.strictObject({
        commentId: z.string().uuid(),
        bodyRead: codexCollaborationSourceWireReadSchema,
      }),
    )
    .max(COLLABORATION_PAGE_ITEMS)
    .optional(),
  items: z
    .array(
      z.strictObject({
        batchRead: codexCollaborationSourceWireReadSchema.optional(),
        bodyRead: codexCollaborationSourceWireReadSchema.optional(),
        documents: z
          .array(
            z.strictObject({
              key: z.string(),
              read: codexCollaborationSourceWireReadSchema,
            }),
          )
          .optional(),
      }),
    )
    .max(COLLABORATION_PAGE_ITEMS)
    .optional(),
})
export type CollaborationSourceIndexNavigation = z.infer<
  typeof collaborationSourceIndexNavigationSchema
>

/** Pure bounded wire projection; the caller still owns page size and source authorization. */
export function collaborationSourceIndexNavigation(
  source: CollaborationSourceReadResult['source'],
  text: string,
): CollaborationSourceIndexNavigation {
  if (source === 'document') return {}
  const object = z.record(z.string(), z.unknown()),
    index = object.parse(JSON.parse(text))
  if (source === 'batch') {
    const members = z.array(object).parse(index['members'])
    return collaborationSourceIndexNavigationSchema.parse({
      ...(index['bodyRead'] === undefined ? {} : { bodyRead: index['bodyRead'] }),
      ...(index['userInformationRead'] === undefined
        ? {}
        : { userInformationRead: index['userInformationRead'] }),
      ...(index['clarificationAnswerRead'] === undefined
        ? {}
        : { clarificationAnswerRead: index['clarificationAnswerRead'] }),
      members: members.map((member) => ({
        commentId: member['commentId'],
        bodyRead: member['bodyRead'],
      })),
    })
  }
  const items = z.array(object).parse(index['items'])
  return collaborationSourceIndexNavigationSchema.parse({
    items: items.map((item) => {
      const value: Record<string, unknown> = {}
      if (item['batchRead'] !== undefined) value['batchRead'] = item['batchRead']
      if (item['bodyRead'] !== undefined) value['bodyRead'] = item['bodyRead']
      if (source === 'handoff_sources')
        value['documents'] = z
          .array(object)
          .parse(item['documents'])
          .map((document) => ({ key: document['key'], read: document['read'] }))
      return value
    }),
  })
}

/** Host facts are distinct from the fields the model actually submitted. */
export const collaborationSourceWireResultSchema = z
  .strictObject({
    ...collaborationSourcePageShape,
    ...collaborationSourceIndexNavigationSchema.shape,
    binding: z.strictObject({
      submitted: z.enum(['legacy', 'sourceReference', 'nativeRoot']),
      callerRunId: z.string().uuid(),
      grantSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      referenceSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .nullable(),
      nativeRoot: collaborationSourceNativeRootSchema.optional(),
    }),
    nextRead: codexCollaborationSourceWireReadSchema.optional(),
  })
  .refine(
    (value) =>
      (value.binding.submitted === 'nativeRoot') === (value.binding.nativeRoot !== undefined),
    'Only an authenticated native source page carries a Native Root binding.',
  )
  .superRefine((value, ctx) => {
    const actual = collaborationSourceIndexNavigationSchema.parse({
      ...(value.bodyRead === undefined ? {} : { bodyRead: value.bodyRead }),
      ...(value.userInformationRead === undefined
        ? {}
        : { userInformationRead: value.userInformationRead }),
      ...(value.clarificationAnswerRead === undefined
        ? {}
        : { clarificationAnswerRead: value.clarificationAnswerRead }),
      ...(value.members === undefined ? {} : { members: value.members }),
      ...(value.items === undefined ? {} : { items: value.items }),
    })
    if (Object.keys(actual).length === 0) return
    try {
      const expected = collaborationSourceIndexNavigation(value.source, value.text)
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        ctx.addIssue({
          code: 'custom',
          message: 'Direct Source navigation differs from the frozen index.',
        })
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Direct Source navigation requires its matching index.',
      })
    }
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= COLLABORATION_PAGE_BYTES,
    'Source page exceeds its byte budget.',
  )
export type CollaborationSourceWireResult = z.infer<typeof collaborationSourceWireResultSchema>

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
